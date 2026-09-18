/**
 * The durable record of what Jev was asked and what it answered.
 *
 * Shadow mode is only worth running if the answers survive to be compared
 * against what Cove's existing owners decided. That comparison is the evidence
 * that decides whether a feature is ever allowed to act, so the assessment row
 * carries the baseline decision alongside Jev's answer rather than the answer
 * on its own.
 *
 * Attempts are recorded separately from assessments because a call that failed
 * still consumed a lease and still counts against the day's ceiling. An attempt
 * whose usage never came back is stored as unknown, never as zero.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openLocalDatabase } from "../local/database";
import { estimateJevCostUsd, type JevFeature, type JevMode } from "./settings";
import type { JevAnswer, JevFailureCode, JevUsage } from "./client";

export { JEV_LEDGER_SCHEMA } from "./schema";

export type JevAttemptRecord = {
  feature: JevFeature;
  /** "ok", or the failure code the transport returned. */
  outcome: "ok" | JevFailureCode;
  status?: number;
  usage?: JevUsage;
  /** Used when usage never came back, so spend is over- rather than
   *  under-counted. */
  reservedInputTokens: number;
  latencyMs: number;
  model?: string;
  occurredAt?: string;
};

export type JevAssessmentRecord = {
  feature: JevFeature;
  mode: JevMode;
  refKind: string;
  refId: string;
  questionKey: string;
  answer: JevAnswer;
  /** What Cove's existing owner already decided, in that owner's own terms. */
  baseline?: string | null;
  /** Whether Jev's answer matched the baseline, when that is comparable. */
  agreed?: boolean | null;
  detail?: Record<string, unknown>;
  model: string;
  occurredAt?: string;
};

function withDatabase<T>(
  dbPath: string | undefined,
  db: Database.Database | undefined,
  run: (handle: Database.Database) => T,
): T {
  if (db) return run(db);
  const handle = openLocalDatabase(dbPath);
  try {
    return run(handle);
  } finally {
    handle.close();
  }
}

export function recordJevAttempt(input: JevAttemptRecord & {
  dbPath?: string;
  db?: Database.Database;
}): string {
  const id = randomUUID();
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const known = Boolean(input.usage);
  const inputTokens = input.usage?.inputTokens ?? null;
  // An unknown call still cost something. Reserve the estimate rather than
  // recording a zero that would quietly raise the day's remaining ceiling.
  const cost = estimateJevCostUsd(input.usage?.inputTokens ?? input.reservedInputTokens);
  withDatabase(input.dbPath, input.db, (db) => {
    db.prepare(
      `INSERT INTO cove_jev_attempts (
        id, feature, outcome, status, usage_known, input_tokens, output_tokens,
        estimated_cost_usd, latency_ms, model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.feature,
      input.outcome,
      input.status ?? null,
      known ? 1 : 0,
      inputTokens,
      input.usage?.outputTokens ?? null,
      cost,
      Math.max(0, Math.round(input.latencyMs)),
      input.model ?? null,
      occurredAt,
    );
  });
  return id;
}

export function recordJevAssessments(input: {
  assessments: readonly JevAssessmentRecord[];
  dbPath?: string;
  db?: Database.Database;
}): number {
  if (input.assessments.length === 0) return 0;
  return withDatabase(input.dbPath, input.db, (db) => {
    const statement = db.prepare(
      `INSERT INTO cove_jev_assessments (
        id, feature, mode, ref_kind, ref_id, question_key, answer_kind,
        choice, noul, confidence, baseline, agreed, detail_json, model, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insert = db.transaction((rows: readonly JevAssessmentRecord[]) => {
      for (const row of rows) {
        statement.run(
          randomUUID(),
          row.feature,
          row.mode,
          row.refKind.slice(0, 80),
          row.refId.slice(0, 500),
          row.questionKey.slice(0, 80),
          row.answer.type,
          row.answer.type === "choice" ? row.answer.choice : null,
          row.answer.type === "noul" ? row.answer.noul : null,
          // Noul answers carry no confidence, and inventing one here would
          // make an uncertain probability look like a measured certainty.
          row.answer.type === "choice" ? row.answer.confidence : null,
          row.baseline ?? null,
          row.agreed === undefined || row.agreed === null ? null : row.agreed ? 1 : 0,
          JSON.stringify(row.detail ?? {}).slice(0, 20_000),
          row.model.slice(0, 80),
          row.occurredAt ?? new Date().toISOString(),
        );
      }
    });
    insert(input.assessments);
    return input.assessments.length;
  });
}

export type JevSpendWindow = {
  attempts: number;
  estimatedCostUsd: number;
};

export function readJevSpendSince(input: {
  since: string;
  dbPath?: string;
  db?: Database.Database;
}): JevSpendWindow {
  return withDatabase(input.dbPath, input.db, (db) => {
    const row = db.prepare(
      `SELECT COUNT(*) AS attempts, COALESCE(SUM(estimated_cost_usd), 0) AS cost
         FROM cove_jev_attempts WHERE created_at >= ?`,
    ).get(input.since) as { attempts: number; cost: number };
    return {
      attempts: Number(row.attempts) || 0,
      estimatedCostUsd: Number(row.cost) || 0,
    };
  });
}

export type JevAssessmentRow = {
  id: string;
  feature: string;
  mode: string;
  refKind: string;
  refId: string;
  questionKey: string;
  answerKind: "choice" | "noul";
  choice: string | null;
  noul: number | null;
  confidence: number | null;
  baseline: string | null;
  agreed: boolean | null;
  detail: unknown;
  model: string;
  createdAt: string;
};

export function readJevAssessments(input: {
  feature?: JevFeature;
  refKind?: string;
  refId?: string;
  limit?: number;
  dbPath?: string;
  db?: Database.Database;
}): JevAssessmentRow[] {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 2_000);
  const filters: string[] = [];
  const values: unknown[] = [];
  if (input.feature) {
    filters.push("feature = ?");
    values.push(input.feature);
  }
  if (input.refKind) {
    filters.push("ref_kind = ?");
    values.push(input.refKind);
  }
  if (input.refId) {
    filters.push("ref_id = ?");
    values.push(input.refId);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return withDatabase(input.dbPath, input.db, (db) => {
    const rows = db.prepare(
      `SELECT id, feature, mode, ref_kind, ref_id, question_key, answer_kind,
              choice, noul, confidence, baseline, agreed, detail_json, model, created_at
         FROM cove_jev_assessments ${where}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...values, limit) as Record<string, unknown>[];
    return rows.map((row) => {
      let detail: unknown = {};
      try {
        detail = JSON.parse(String(row.detail_json));
      } catch {
        detail = { raw: String(row.detail_json) };
      }
      return {
        id: String(row.id),
        feature: String(row.feature),
        mode: String(row.mode),
        refKind: String(row.ref_kind),
        refId: String(row.ref_id),
        questionKey: String(row.question_key),
        answerKind: row.answer_kind === "choice" ? "choice" : "noul",
        choice: row.choice === null ? null : String(row.choice),
        noul: row.noul === null ? null : Number(row.noul),
        confidence: row.confidence === null ? null : Number(row.confidence),
        baseline: row.baseline === null ? null : String(row.baseline),
        agreed: row.agreed === null ? null : Number(row.agreed) === 1,
        detail,
        model: String(row.model),
        createdAt: String(row.created_at),
      };
    });
  });
}

/**
 * Assessment detail is evidence with a shelf life; usage metadata outlives it
 * so spend history stays readable after the detail is gone.
 */
export function pruneJevLedger(input: {
  now: Date;
  assessmentRetentionDays: number;
  usageRetentionDays: number;
  dbPath?: string;
  db?: Database.Database;
}): { assessments: number; attempts: number } {
  const assessmentCutoff = new Date(
    input.now.getTime() - input.assessmentRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const usageCutoff = new Date(
    input.now.getTime() - input.usageRetentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  return withDatabase(input.dbPath, input.db, (db) => {
    const assessments = db.prepare(
      "DELETE FROM cove_jev_assessments WHERE created_at < ?",
    ).run(assessmentCutoff).changes;
    const attempts = db.prepare(
      "DELETE FROM cove_jev_attempts WHERE created_at < ?",
    ).run(usageCutoff).changes;
    return { assessments, attempts };
  });
}
