/**
 * Factual readiness projection for the Current and `/api/health`.
 *
 * Configuration, first-run evidence, freshness, and hard failure are separate
 * states. This module reports what Cove can prove from local records and files;
 * it never turns the presence of a config file into a healthy integration.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { openLocalDatabase } from "../local/database";
import { isClaudeWorkerAvailable } from "../claude-execution/trigger";
import { workspaceConfigPath } from "../workspace";

const EMAIL_FRESH_MS = 24 * 60 * 60 * 1000;
const BRIEF_FRESH_MS = 48 * 60 * 60 * 1000;

export type ReadinessState =
  | "ready"
  | "stale"
  | "unavailable"
  | "not_configured"
  | "waiting";

export type CoveReadiness = {
  checkedAt: string;
  email: { state: ReadinessState; lastSuccessAt: string | null; lastRunOutcome: string | null };
  writer: {
    state: ReadinessState;
    lastSuccessAt: string | null;
    label: string;
  };
  worker: { state: ReadinessState };
  jobs: { queued: number; failed: number; dead: number };
};

function ageState(value: string | null, now: Date, freshForMs: number): ReadinessState {
  if (!value) return "unavailable";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unavailable";
  return now.getTime() - timestamp <= freshForMs ? "ready" : "stale";
}

export function currentCoveReadiness(input: {
  dbPath?: string;
  dataDir?: string;
  now?: Date;
  workerAvailable?: boolean;
} = {}): CoveReadiness {
  const now = input.now ?? new Date();
  const dataDir = input.dataDir ?? (input.dbPath ? path.dirname(input.dbPath) : undefined);
  const emailConfigured = existsSync(workspaceConfigPath(dataDir));
  const db = openLocalDatabase(input.dbPath);
  try {
    const tableExists = (name: string) => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(name));
    const latestTriage = db.prepare(
      `SELECT outcome, finished_at FROM cove_receipts
       WHERE source = 'email-triage'
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    ).get() as { outcome: string; finished_at: string } | undefined;
    const lastEmailSuccess = db.prepare(
      `SELECT finished_at FROM cove_receipts
       WHERE source = 'email-triage' AND outcome IN ('success','partial')
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    ).pluck().get() as string | undefined;
    const latestBrief = (tableExists("day_plan_briefs")
      ? db.prepare(
        `SELECT COALESCE(finished_at, updated_at) AS finished_at,
                model_alias, brief_json
         FROM day_plan_briefs
         WHERE status = 'succeeded'
         ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC LIMIT 1`,
      ).get()
      : undefined) as {
      finished_at: string;
      model_alias: string;
      brief_json: string | null;
    } | undefined;
    const latestBriefAttempt = (tableExists("day_plan_briefs")
      ? db.prepare(
        `SELECT status FROM day_plan_briefs
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
      ).get()
      : undefined) as { status: string } | undefined;
    let writer: "codex" | "claude" | undefined;
    try {
      const parsed = JSON.parse(latestBrief?.brief_json ?? "{}");
      writer = parsed.writer === "codex" || parsed.writer === "claude"
        ? parsed.writer
        : undefined;
    } catch {
      writer = undefined;
    }
    const count = (status: string) => Number(db.prepare(
      "SELECT COUNT(*) FROM cove_jobs WHERE status = ?",
    ).pluck().get(status) ?? 0);
    const emailAgeState = ageState(lastEmailSuccess ?? null, now, EMAIL_FRESH_MS);
    const emailState: ReadinessState = !emailConfigured
      ? "not_configured"
      : !latestTriage
        ? "waiting"
        : latestTriage.outcome !== "success" && latestTriage.outcome !== "partial"
          ? "unavailable"
          : emailAgeState;
    const writerState: ReadinessState = latestBrief
      ? ageState(latestBrief.finished_at, now, BRIEF_FRESH_MS)
      : latestBriefAttempt?.status === "failed"
        ? "unavailable"
        : "waiting";
    return {
      checkedAt: now.toISOString(),
      email: {
        state: emailState,
        lastSuccessAt: lastEmailSuccess ?? null,
        lastRunOutcome: latestTriage?.outcome ?? null,
      },
      writer: {
        state: writerState,
        lastSuccessAt: latestBrief?.finished_at ?? null,
        label: writer === "codex"
          ? latestBrief?.model_alias ?? "Codex"
          : writer === "claude"
            ? latestBrief?.model_alias ?? "Claude"
            : "Brief writer",
      },
      worker: {
        state: (input.workerAvailable ?? isClaudeWorkerAvailable())
          ? "ready"
          : "unavailable",
      },
      jobs: {
        queued: count("queued") + count("leased"),
        failed: count("failed"),
        dead: count("dead"),
      },
    };
  } finally {
    db.close();
  }
}
