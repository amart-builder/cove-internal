/**
 * Collects the exact evidence envelope used to write a Morning Brief.
 *
 * Each source is resolved through an explicit policy, normalized, bounded,
 * labeled with freshness and coverage, and recorded in the manifest. Optional
 * sources degrade honestly. Required sources may be trimmed but must never
 * disappear silently. Source text is untrusted data even when it came from the
 * operator's own files.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  groundworkCheckinDue,
  readCoveAutonomySettings,
  recordGroundworkCheckinPresentation,
} from "../autonomy/settings";
import type { Commitment, CommitmentKind } from "../data/types";
import { countSpooledEvents } from "../intake/inbox";
import { readProgressDigestRelays } from "../progress/relay";
import {
  LEGACY_BLOCKED_TASK_COLUMN_NAMES,
  taskColumnKeyForName,
} from "../tasks/columns";
import {
  coveDataDir,
  loadOperatorProfile,
  operatorName,
  operatorProfilePath,
  operatorTimezone,
  type OperatorProfile,
} from "../operator";
import type { DayPlanStore, SessionDigest } from "./store";
import type { DayDump } from "./types";
import {
  localDateInTimezone,
  morningBriefFromArtifact,
  type BriefSourceInput,
} from "./brief";
import { buildSettlementSummary, readDumpRelay, readSettlementRelay } from "./brief-relay";
import { contentQuotaGap, followUpsDue, staleOpenItems } from "./gap-detectors";
import { localDateFor } from "./candidates";
import { coveEnv } from "../env";
import { LocalCRMBackend } from "../crm/local";
import { isOpenPipelineStage, PIPELINE_STAGE_LABELS, followUpStatus } from "../crm/pipeline";
import { LocalPipelineStore } from "../crm/pipeline-store";
import { localDatabasePath } from "../local/database";
import {
  normalizeMachineIdentity,
  resolveMachineIdentity,
} from "../machine-identity.mjs";
import { recurringRhythmSnapshot } from "../tasks/recurrence";
import { detectStaleTasks } from "../tasks/stale";
import { getRuntimeMode } from "../runtime/mode";
import { buildReceiptDigest } from "../reliability/receipts";
import {
  createGoogleWorkspaceGateway,
  workspaceConfigPath,
  type WorkspaceGateway,
} from "../workspace";

const EXTERNAL_FETCH_TIMEOUT_MS = 10_000;
// The operator's own zone, not a fixed one: this is the fallback used when
// no caller or env var pinned a timezone, and a wrong fallback silently
// targets the wrong calendar day. Read per call, because the profile that
// supplies it is written during setup, after this module first loads.
const defaultBriefTimezone = () => operatorTimezone();

export type BriefFileSourcePolicyEntry = {
  path: string;
  required: boolean;
  format?: "operator-profile-json";
};

export type BriefFileSourcePolicy = {
  goals: BriefFileSourcePolicyEntry;
  operator_profile: BriefFileSourcePolicyEntry;
  leadup: BriefFileSourcePolicyEntry;
  sprint_memo: BriefFileSourcePolicyEntry;
};

type BriefFileSourcePolicyOptions = {
  dataDir?: string;
  homeDir?: string;
  goalsPath?: string;
  operatorProfilePath?: string;
  leadupPath?: string;
  sprintMemoPath?: string;
};

function nonEmptyEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function legacyBrainPath(homeDir: string, filename: string): string {
  return path.join(homeDir, "Atlas", "brain", filename);
}

export function resolveBriefFileSourcePolicy(
  options: BriefFileSourcePolicyOptions = {},
): BriefFileSourcePolicy {
  const dataDir = coveDataDir(options.dataDir);
  const homeDir = options.homeDir ?? homedir();
  const legacyGoals = legacyBrainPath(homeDir, "GOALS.md");
  const clientGoals = path.join(dataDir, "brief", "goals.md");
  const clientSprintMemo = path.join(dataDir, "brief", "sprint-memo.md");
  const clientOperatorProfile = path.join(dataDir, "brief", "operator-profile.md");
  const clientLeadup = path.join(dataDir, "brief", "leadup.md");
  const legacySprintMemo = legacyBrainPath(homeDir, "path-to-30k-2026-07.md");
  const legacyOperatorProfile = legacyBrainPath(homeDir, "operator-profile.md");
  const legacyLeadup = legacyBrainPath(homeDir, "brief-leadup.md");
  const jsonProfile = operatorProfilePath(dataDir);

  const explicitGoals = options.goalsPath?.trim();
  const envGoals = nonEmptyEnv("COVE_BRIEF_GOALS_PATH");
  const explicitSprintMemo = options.sprintMemoPath?.trim();
  const envSprintMemo = nonEmptyEnv("COVE_BRIEF_SPRINT_MEMO_PATH");
  const explicitOperatorProfile = options.operatorProfilePath?.trim();
  const envOperatorProfile = nonEmptyEnv("COVE_BRIEF_OPERATOR_PROFILE_PATH");
  const explicitLeadup = options.leadupPath?.trim();
  const envLeadup = nonEmptyEnv("COVE_BRIEF_LEADUP_PATH");

  const operatorPath = explicitOperatorProfile || envOperatorProfile ||
    (existsSync(clientOperatorProfile)
      ? clientOperatorProfile
      : existsSync(jsonProfile)
        ? jsonProfile
        : legacyOperatorProfile);

  return {
    goals: {
      path: explicitGoals || envGoals ||
        (existsSync(clientGoals) ? clientGoals : legacyGoals),
      required: true,
    },
    sprint_memo: {
      path: explicitSprintMemo || envSprintMemo ||
        (existsSync(clientSprintMemo) ? clientSprintMemo : legacySprintMemo),
      required: Boolean(explicitSprintMemo || envSprintMemo),
    },
    operator_profile: {
      path: operatorPath,
      required: false,
      ...(!explicitOperatorProfile && !envOperatorProfile && operatorPath === jsonProfile
        ? { format: "operator-profile-json" as const }
        : {}),
    },
    leadup: {
      path: explicitLeadup || envLeadup ||
        (existsSync(clientLeadup) ? clientLeadup : legacyLeadup),
      required: false,
    },
  };
}

export function briefCheckpointSources(
  options: BriefFileSourcePolicyOptions = {},
): Record<string, { path: string; required: boolean }> {
  return Object.fromEntries(
    Object.entries(resolveBriefFileSourcePolicy(options)).map(([id, source]) => [
      id,
      { path: source.path, required: source.required },
    ]),
  );
}

// Opt-in only. No two machines are laid out the same way, so guessing a folder
// would silently feed the brief some other repo's pipeline counts; an
// unconfigured install just reports the source as unavailable.
export function defaultSupernovaDir(): string | undefined {
  return nonEmptyEnv("COVE_SUPERNOVA_DIR");
}

// Cove installs on port 3200 (see scripts/install-cove-local.sh), so the
// task-snapshot fetch must default there or every installed brief would fail
// with required_source_missing:task_snapshot.
export function defaultBriefWebBase(): string {
  return coveEnv("BRIEF_WEB_BASE") ?? "http://127.0.0.1:3200";
}

// Per-source staleness thresholds in hours, each overridable through the
// environment (for example COVE_BRIEF_STALE_HOURS_GOALS=2160). Past the
// threshold the source is reported "stale" in the manifest, the model is told,
// and the freshness state participates in the input hash.
function staleThresholdHours(id: string, fallback: number): number {
  const override = Number(process.env[`COVE_BRIEF_STALE_HOURS_${id.toUpperCase()}`]);
  return Number.isFinite(override) && override > 0 ? override : fallback;
}

export type CollectedBriefSources = {
  sources: BriefSourceInput[];
  // Open task ids seen in the snapshot; generation-time validation drops brief
  // candidates that reference anything else.
  knownTaskIds: Set<string>;
  taskUpdatedAtById?: Map<string, string>;
  recurringTaskIds?: Set<string>;
};

export type MorningBriefSourceOptions = {
  store: DayPlanStore;
  homeDir?: string;
  goalsPath?: string;
  operatorProfilePath?: string;
  leadupPath?: string;
  sprintMemoPath?: string;
  memoryDecisionsPath?: string;
  targetLocalDate?: string;
  targetTimezone?: string;
  now?: Date;
  // Loopback base URL of the Cove web app; the task snapshot goes through the
  // same cove-rest surface the UI uses, so local and Supabase runtimes both work.
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  // Overrides the relay data directory (defaults to the cove.db directory).
  // Tests point this at a temp dir to exercise the settlement relay fallback.
  dataDir?: string;
  machineIdentity?: {
    id: string;
    hostname: string;
  };
  workspaceGateway?: Pick<WorkspaceGateway, "calendar">;
};

function readKeyFile(filePath: string): string | null {
  try {
    const resolved = filePath.startsWith("~/")
      ? path.join(homedir(), filePath.slice(2))
      : filePath;
    return readFileSync(resolved, "utf8").trim() || null;
  } catch {
    return null;
  }
}

type TaskRow = {
  id?: string;
  column_id?: string | null;
  title?: string;
  description?: string;
  priority?: string;
  project?: string;
  due_at?: string | null;
  status?: string;
  updated_at?: string;
  position?: number;
  tags?: unknown;
  recurring_template_id?: string | null;
};

function taskTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type ColumnRow = { id?: string; name?: string };

function columnBucket(name: string | undefined): string | undefined {
  const key = taskColumnKeyForName(name);
  if (key === "today") return "today";
  if (key === "in-progress" || (name && LEGACY_BLOCKED_TASK_COLUMN_NAMES.has(name))) {
    return "in_flight";
  }
  if (key === "not-started") return "not_started";
  return undefined;
}

function fileSource(
  id: string,
  label: string,
  filePath: string,
  options: {
    required: boolean;
    maxChars: number;
    priority: number;
    freshnessThresholdHours?: number;
  },
): BriefSourceInput {
  try {
    const content = readFileSync(filePath, "utf8");
    const asOf = statSync(filePath).mtime.toISOString();
    return { id, label, ...options, content, asOf, note: filePath };
  } catch {
    return { id, label, ...options, note: `unreadable:${filePath}` };
  }
}

// Whitelist for the rendered OPERATOR_PROFILE block. self_emails and
// memory_hub_url are deliberately excluded: they are wiring the runtime reads
// (own-record CRM filter, memory hub address), not context the brief should
// ever quote back at the operator.
const OPERATOR_PROFILE_FIELDS = [
  "name",
  "timezone",
  "workday",
  "responsibilities",
  "ninety_day_outcomes",
  "protected_time",
  "work_sources",
  "jarvis_may_carry",
  "jarvis_must_return",
  "failure_patterns",
  "communication_style",
  "never_drop",
  "key_people",
  "money",
] as const;

function readableLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableProfileValue(value: unknown, indent = ""): string[] {
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed ? [`${indent}${trimmed}`] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [`${indent}${String(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const lines = readableProfileValue(item, `${indent}  `);
      if (lines.length === 0) return [];
      return [
        `${indent}- ${lines[0].trimStart().replace(/^-\s*/, "")}`,
        ...lines.slice(1),
      ];
    });
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, item]) => {
    const lines = readableProfileValue(item, `${indent}  `);
    if (lines.length === 0) return [];
    if (lines.length === 1) {
      return [`${indent}- ${readableLabel(key)}: ${lines[0].trimStart()}`];
    }
    return [`${indent}- ${readableLabel(key)}:`, ...lines];
  });
}

export function renderOperatorProfile(profile: OperatorProfile, maxChars = 6000): string {
  const lines = OPERATOR_PROFILE_FIELDS.flatMap((field) => {
    const valueLines = readableProfileValue(profile[field]);
    if (valueLines.length === 0) return [];
    return valueLines.length === 1 && !Array.isArray(profile[field]) &&
      !asRecord(profile[field])
      ? [`${readableLabel(field)}: ${valueLines[0].trimStart()}`]
      : [`${readableLabel(field)}:`, ...valueLines];
  });
  return lines.join("\n").slice(0, maxChars);
}

function operatorProfileJsonSource(
  sourcePath: string,
  options: {
    required: boolean;
    maxChars: number;
    priority: number;
  },
): BriefSourceInput {
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
    const profile = asRecord(parsed);
    if (!profile) throw new Error("profile_not_object");
    const content = renderOperatorProfile(profile, options.maxChars);
    if (!content) throw new Error("profile_empty");
    const asOf = statSync(sourcePath).mtime.toISOString();
    return {
      id: "operator_profile",
      label: "OPERATOR_PROFILE",
      ...options,
      content,
      asOf,
      note: sourcePath,
    };
  } catch {
    return {
      id: "operator_profile",
      label: "OPERATOR_PROFILE",
      ...options,
      note: `unreadable:${sourcePath}`,
    };
  }
}

function compactLine(value: string | undefined, maximum: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

const GOALS_TRIM_MARKER = "[... middle trimmed by Cove ...]";

export function preserveGoalsNeverSections(
  content: string,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error("goals_max_chars_invalid");
  }

  const headings = [...content.matchAll(/^## [^\r\n]*\r?$/gm)];
  const neverSections = headings.flatMap((heading, index) => {
    if (!heading[0].startsWith("## Never ")) return [];
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? content.length;
    return [{ start, text: content.slice(start, end) }];
  });
  const preservedTail = neverSections.map((section) => section.text).join("");
  const suffix = preservedTail
    ? `\n${GOALS_TRIM_MARKER}\n${preservedTail}`
    : `\n${GOALS_TRIM_MARKER}`;
  if (suffix.length > maxChars) {
    throw new Error("goals_never_sections_exceed_cap");
  }

  // Stopping before the first preserved section avoids duplicating it when an
  // unusually early Never heading falls inside the available head budget.
  const headBoundary = neverSections[0]?.start ?? content.length;
  const head = content.slice(0, Math.min(headBoundary, maxChars - suffix.length));
  return `${head}${suffix}`;
}

export async function fetchRows(
  fetchImpl: typeof fetch,
  baseUrl: string,
  table: string,
  timeoutMs: number,
  query = "select=*&order=position.asc",
): Promise<unknown[]> {
  const response = await fetchImpl(
    `${baseUrl}/api/cove-rest/${table}?${query}`,
    { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`cove-rest ${table} ${response.status}`);
  const rows = (await response.json()) as unknown;
  if (!Array.isArray(rows)) throw new Error(`cove-rest ${table} shape`);
  return rows;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function errorNote(error: unknown, fallback: string): string {
  const reason = error instanceof Error ? error.message : fallback;
  const bounded = reason.replace(/\s+/g, " ").trim().slice(0, 160);
  return `error:${bounded || fallback}`;
}

function inboundAge(createdAt: unknown, now: Date): string {
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return "unknown";
  const minutes = Math.max(0, Math.floor((now.getTime() - created) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function inboundVerbatim(value: unknown): string {
  if (typeof value !== "string") return "\"\"";
  return JSON.stringify(value.slice(0, 120));
}

function backgroundLaneInstalled(
  dataDir: string | undefined,
  lane: "meeting_watch" | "progress_reconcile",
  machineIdentity: { id: string; hostname: string },
): boolean {
  const markerPath = path.join(
    coveDataDir(dataDir),
    "intake",
    "installed-lanes.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    const machines = asRecord(asRecord(parsed)?.machines);
    const machine = asRecord(machines?.[machineIdentity.id]);
    return Boolean(asRecord(machine?.[lane])?.installed_at);
  } catch {
    return false;
  }
}

type BackgroundLaneOwner = {
  id: string;
  hostnameAtClaim: string;
};

function backgroundLaneOwner(
  dataDir: string | undefined,
  lane: "meeting_watch" | "progress",
): BackgroundLaneOwner | undefined {
  try {
    const ownerPath = path.join(coveDataDir(dataDir), "cove-lane-owners.json");
    const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
    const entry = asRecord(asRecord(asRecord(parsed)?.lanes)?.[lane]);
    if (
      typeof entry?.id !== "string" ||
      typeof entry?.hostname_at_claim !== "string"
    ) {
      return undefined;
    }
    const normalized = normalizeMachineIdentity({
      id: entry.id,
      hostname: entry.hostname_at_claim,
    });
    return {
      id: normalized.id,
      hostnameAtClaim: normalized.hostname,
    };
  } catch {
    return undefined;
  }
}

function machineHeartbeat(
  parsed: unknown,
  machineId: string,
  lane: "meeting_watch" | "progress_reconcile",
): UnknownRecord | undefined {
  const machines = asRecord(asRecord(parsed)?.machines);
  return asRecord(asRecord(machines?.[machineId])?.[lane]);
}

function localStandDownSuffix(
  localHeartbeat: UnknownRecord | undefined,
  owner: BackgroundLaneOwner | undefined,
  machineIdentity: { id: string; hostname: string },
): string {
  if (
    !owner ||
    owner.id === machineIdentity.id ||
    localHeartbeat?.standing_down !== true ||
    localHeartbeat?.owner_id !== owner.id
  ) {
    return "";
  }
  return ` Local Mac standing down: ${owner.hostnameAtClaim} owns this lane.`;
}

function briefMachineIdentity(
  dataDir: string | undefined,
  homeDir: string | undefined,
  supplied: { id: string; hostname: string } | undefined,
): { id: string; hostname: string } | undefined {
  if (supplied) return normalizeMachineIdentity(supplied);
  const resolvedDataDir = coveDataDir(dataDir);
  const hasBackgroundState = [
    path.join(resolvedDataDir, "cove-lane-owners.json"),
    path.join(resolvedDataDir, "intake", "installed-lanes.json"),
    path.join(resolvedDataDir, "intake", "heartbeats.json"),
  ].some((file) => existsSync(file));
  return hasBackgroundState
    ? resolveMachineIdentity({ homeDir })
    : undefined;
}

function meetingWatchHeartbeat(
  dataDir: string | undefined,
  now: Date,
  machineIdentity: { id: string; hostname: string } | undefined,
): { line: string; warning?: string } {
  if (!machineIdentity) {
    return { line: "Meeting watcher is not installed on this Mac." };
  }
  const installed = backgroundLaneInstalled(
    dataDir,
    "meeting_watch",
    machineIdentity,
  );
  const owner = backgroundLaneOwner(dataDir, "meeting_watch");
  const heartbeatPath = path.join(
    coveDataDir(dataDir),
    "intake",
    "heartbeats.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown;
    const heartbeat = machineHeartbeat(
      parsed,
      owner?.id ?? machineIdentity.id,
      "meeting_watch",
    );
    const localHeartbeat = machineHeartbeat(
      parsed,
      machineIdentity.id,
      "meeting_watch",
    );
    const standDown = localStandDownSuffix(
      localHeartbeat,
      owner,
      machineIdentity,
    );
    if (!heartbeat && !installed && !owner) {
      return { line: "Meeting watcher is not installed on this Mac." };
    }
    if (heartbeat?.disabled === true) {
      return {
        line: `WARNING: meeting watcher DISABLED.${standDown}`,
        warning: "meeting_watch_disabled",
      };
    }
    const lastRunAt = typeof heartbeat?.last_run_at === "string"
      ? heartbeat.last_run_at
      : undefined;
    const lastRun = lastRunAt
      ? Date.parse(lastRunAt)
      : Number.NaN;
    if (!Number.isFinite(lastRun)) {
      return {
        line: `WARNING: meeting watcher heartbeat is missing.${standDown}`,
        warning: "meeting_watch_heartbeat_missing",
      };
    }
    const elapsedMs = Math.max(0, now.getTime() - lastRun);
    const counts = [
      `examined=${Number.isFinite(Number(heartbeat?.examined)) ? Number(heartbeat?.examined) : "unknown"}`,
      `matched=${Number.isFinite(Number(heartbeat?.matched)) ? Number(heartbeat?.matched) : "unknown"}`,
      `processed=${Number.isFinite(Number(heartbeat?.processed)) ? Number(heartbeat?.processed) : "unknown"}`,
      `errors=${Number.isFinite(Number(heartbeat?.errors)) ? Number(heartbeat?.errors) : "unknown"}`,
      `dead_letters=${Number.isFinite(Number(heartbeat?.dead_letters)) ? Number(heartbeat?.dead_letters) : "unknown"}`,
    ].join(" ");
    const errorCount = Number(heartbeat?.errors);
    const deadLetterCount = Number(heartbeat?.dead_letters);
    if (Number.isFinite(deadLetterCount) && deadLetterCount > 0) {
      return {
        line: `WARNING: meeting watcher has ${deadLetterCount} dead letter${deadLetterCount === 1 ? "" : "s"} (age=${inboundAge(lastRunAt, now)} ${counts}).${standDown}`,
        warning: "meeting_watch_dead_letters",
      };
    }
    if (elapsedMs > 60 * 60_000) {
      return {
        line: `WARNING: meeting watcher heartbeat is stale (age=${inboundAge(lastRunAt, now)} ${counts}).${standDown}`,
        warning: "meeting_watch_heartbeat_stale",
      };
    }
    if (Number.isFinite(errorCount) && errorCount > 0) {
      return {
        line: `WARNING: meeting watcher last run reported errors (age=${inboundAge(lastRunAt, now)} ${counts}).${standDown}`,
        warning: "meeting_watch_errors",
      };
    }
    return {
      line: `Meeting watcher heartbeat: age=${inboundAge(lastRunAt, now)} ${counts}.${standDown}`,
    };
  } catch (error) {
    if (!installed && !owner && !existsSync(heartbeatPath)) {
      return { line: "Meeting watcher is not installed on this Mac." };
    }
    const warning = existsSync(heartbeatPath)
      ? errorNote(error, "meeting_watch_heartbeat_invalid").replace(/^error:/, "")
      : "meeting_watch_heartbeat_missing";
    return {
      line: `WARNING: meeting watcher heartbeat unavailable (${warning}).`,
      warning,
    };
  }
}

function meetingWatchOperatorSetupLine(
  dataDir: string | undefined,
  machineIdentity: { id: string; hostname: string } | undefined,
): string | undefined {
  if (!machineIdentity) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path.join(
      coveDataDir(dataDir),
      "intake",
      "heartbeats.json",
    ), "utf8")) as unknown;
    const owner = backgroundLaneOwner(dataDir, "meeting_watch");
    const heartbeat = machineHeartbeat(
      parsed,
      owner?.id ?? machineIdentity.id,
      "meeting_watch",
    );
    return heartbeat?.operator_unconfigured === true
      ? "Set your name in Setup so meeting follow-ups route to you."
      : undefined;
  } catch {
    return undefined;
  }
}

function progressReconcileHeartbeat(
  dataDir: string | undefined,
  now: Date,
  machineIdentity: { id: string; hostname: string } | undefined,
): { line: string; warning?: string } {
  if (!machineIdentity) {
    return { line: "Progress reconciler is not installed on this Mac." };
  }
  const installed = backgroundLaneInstalled(
    dataDir,
    "progress_reconcile",
    machineIdentity,
  );
  const owner = backgroundLaneOwner(dataDir, "progress");
  const heartbeatPath = path.join(
    coveDataDir(dataDir),
    "intake",
    "heartbeats.json",
  );
  try {
    const parsed = JSON.parse(readFileSync(heartbeatPath, "utf8")) as unknown;
    const heartbeat = machineHeartbeat(
      parsed,
      owner?.id ?? machineIdentity.id,
      "progress_reconcile",
    );
    const localHeartbeat = machineHeartbeat(
      parsed,
      machineIdentity.id,
      "progress_reconcile",
    );
    const standDown = localStandDownSuffix(
      localHeartbeat,
      owner,
      machineIdentity,
    );
    if (!heartbeat && !installed && !owner) {
      return { line: "Progress reconciler is not installed on this Mac." };
    }
    const lastRunAt = typeof heartbeat?.last_run_at === "string"
      ? heartbeat.last_run_at
      : undefined;
    const lastRun = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
    if (!Number.isFinite(lastRun)) {
      return {
        line: `WARNING: progress reconciler heartbeat is missing.${standDown}`,
        warning: "progress_reconcile_heartbeat_missing",
      };
    }
    const counts = [
      `projects=${Number.isFinite(Number(heartbeat?.projects_active)) ? Number(heartbeat?.projects_active) : "unknown"}`,
      `digests=${Number.isFinite(Number(heartbeat?.digests_written)) ? Number(heartbeat?.digests_written) : "unknown"}`,
      `suggestions=${Number.isFinite(Number(heartbeat?.suggestions_filed)) ? Number(heartbeat?.suggestions_filed) : "unknown"}`,
      `no_new_evidence=${Number.isFinite(Number(heartbeat?.skipped_no_new_evidence)) ? Number(heartbeat?.skipped_no_new_evidence) : "unknown"}`,
      `malformed_pings=${Number.isFinite(Number(heartbeat?.malformed_ping_lines)) ? Number(heartbeat?.malformed_ping_lines) : "unknown"}`,
      `errors=${Number.isFinite(Number(heartbeat?.errors)) ? Number(heartbeat?.errors) : "unknown"}`,
    ].join(" ");
    const age = inboundAge(lastRunAt, now);
    if (Math.max(0, now.getTime() - lastRun) > 2 * 60 * 60_000) {
      return {
        line: `WARNING: progress reconciler heartbeat is stale (age=${age} ${counts}).${standDown}`,
        warning: "progress_reconcile_heartbeat_stale",
      };
    }
    if (Number(heartbeat?.errors) > 0) {
      return {
        line: `WARNING: progress reconciler last run reported errors (age=${age} ${counts}).${standDown}`,
        warning: "progress_reconcile_errors",
      };
    }
    return {
      line: `Progress reconciler heartbeat: age=${age} ${counts}.${standDown}`,
    };
  } catch (error) {
    if (!installed && !owner && !existsSync(heartbeatPath)) {
      return { line: "Progress reconciler is not installed on this Mac." };
    }
    const warning = existsSync(heartbeatPath)
      ? errorNote(error, "progress_reconcile_heartbeat_invalid").replace(/^error:/, "")
      : "progress_reconcile_heartbeat_missing";
    return {
      line: `WARNING: progress reconciler heartbeat unavailable (${warning}).`,
      warning,
    };
  }
}

async function inboundSource(input: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  dataDir?: string;
  now: Date;
  machineIdentity?: { id: string; hostname: string };
}): Promise<BriefSourceInput> {
  const source = {
    id: "untriaged_inbound",
    label: "UNTRIAGED_INBOUND",
    required: false,
    maxChars: 60_000,
    priority: 0,
  } as const;
  let rows: unknown[] | undefined;
  let fetchWarning: string | undefined;
  try {
    rows = await fetchRows(
      input.fetchImpl,
      input.baseUrl,
      "inbound_events",
      input.timeoutMs,
      "select=source,raw_text,state,created_at" +
        "&state=in.(pending,failed)&order=created_at.asc&limit=50",
    );
  } catch (error) {
    fetchWarning = errorNote(error, "inbound_events_failed").replace(/^error:/, "");
  }
  let spoolCount: number | undefined;
  let spoolWarning: string | undefined;
  try {
    spoolCount = countSpooledEvents(input.dataDir);
  } catch (error) {
    spoolWarning = errorNote(error, "inbound_spool_failed").replace(/^error:/, "");
  }
  const unresolved = (rows ?? [])
    .map(asRecord)
    .filter((row): row is UnknownRecord =>
      Boolean(row && (row.state === "pending" || row.state === "failed"))
    );
  const lines = unresolved.map((row) => {
    const state = row.state === "failed" ? "failed" : "pending";
    const sourceName = typeof row.source === "string" ? row.source : "unknown";
    return `- [${state}] source=${sourceName} age=${inboundAge(row.created_at, input.now)} text=${inboundVerbatim(row.raw_text)}`;
  });
  if (fetchWarning) {
    lines.unshift(`WARNING: inbound inbox unavailable (${fetchWarning}).`);
  } else if (lines.length === 0) {
    lines.push("No pending or failed inbound events.");
  }
  if (spoolWarning) {
    lines.push(`WARNING: inbound spool unavailable (${spoolWarning}).`);
  } else {
    lines.push(`Spool lines waiting: ${spoolCount ?? 0}.`);
  }
  const heartbeat = meetingWatchHeartbeat(
    input.dataDir,
    input.now,
    input.machineIdentity,
  );
  lines.push(heartbeat.line);
  const operatorSetupLine = meetingWatchOperatorSetupLine(
    input.dataDir,
    input.machineIdentity,
  );
  if (operatorSetupLine) lines.push(operatorSetupLine);
  return {
    ...source,
    content: lines.join("\n"),
    asOf: input.now.toISOString(),
    ...(fetchWarning || spoolWarning || heartbeat.warning
      ? {
          note: `error:${
            [fetchWarning, spoolWarning, heartbeat.warning].filter(Boolean).join(";")
          }`,
        }
      : {}),
  };
}

function recurringRhythmSource(input: {
  dataDir?: string;
  targetLocalDate: string;
  targetTimezone: string;
  now: Date;
}): BriefSourceInput {
  const base = {
    id: "recurring_rhythm",
    label: "RECURRING_RHYTHM",
    required: false,
    maxChars: 5000,
    priority: 5,
  } as const;
  try {
    const rhythms = recurringRhythmSnapshot({
      dbPath: path.join(coveDataDir(input.dataDir), "cove.db"),
      now: input.now,
      timezone: input.targetTimezone,
      localDate: input.targetLocalDate,
    });
    return {
      ...base,
      content: rhythms.length > 0
        ? rhythms.map((rhythm) =>
            `- ${compactLine(rhythm.title, 160)}` +
            ` | cadence=${rhythm.cadence}` +
            ` | current_streak=${rhythm.currentStreak}` +
            ` | recent_misses=${rhythm.recentMisses.length > 0
              ? rhythm.recentMisses.join(",")
              : "none"}`
          ).join("\n")
        : "No active recurring rhythms.",
      asOf: input.now.toISOString(),
    };
  } catch (error) {
    return { ...base, note: errorNote(error, "recurring_rhythm_failed") };
  }
}

function recentActivitySource(input: {
  dataDir?: string;
  now: Date;
}): BriefSourceInput {
  const base = {
    id: "recent_activity",
    label: "RECENT_ACTIVITY",
    required: false,
    maxChars: 500,
    priority: 4,
  } as const;
  try {
    const digest = buildReceiptDigest({
      dbPath: path.join(coveDataDir(input.dataDir), "cove.db"),
    });
    return {
      ...base,
      content: digest.content,
      asOf: input.now.toISOString(),
    };
  } catch (error) {
    return { ...base, note: errorNote(error, "recent_activity_failed") };
  }
}

function staleTasksSource(input: {
  dataDir?: string;
  now: Date;
}): BriefSourceInput {
  const base = {
    id: "stale_tasks",
    label: "STALE_TASKS",
    required: false,
    maxChars: 5000,
    priority: 5,
  } as const;
  try {
    const tasks = detectStaleTasks({
      dbPath: path.join(coveDataDir(input.dataDir), "cove.db"),
      dataDir: input.dataDir,
      now: input.now,
    });
    return {
      ...base,
      content: tasks.length > 0
        ? tasks.map((task) =>
            `- id=${task.id} age_days=${task.ageDays}` +
            ` column=${task.column} "${compactLine(task.title, 160)}"`
          ).join("\n")
        : "No stale tasks.",
      asOf: input.now.toISOString(),
    };
  } catch (error) {
    return { ...base, note: errorNote(error, "stale_tasks_failed") };
  }
}

function projectProgressSource(input: {
  store: DayPlanStore;
  dataDir?: string;
  targetLocalDate: string;
  targetTimezone: string;
  now: Date;
  machineIdentity?: { id: string; hostname: string };
}): BriefSourceInput {
  const source = {
    id: "project_progress",
    label: "PROJECT_PROGRESS",
    required: false,
    maxChars: 18_000,
    priority: 1,
  } as const;
  const heartbeat = progressReconcileHeartbeat(
    input.dataDir,
    input.now,
    input.machineIdentity,
  );
  const previousDate = addCalendarDays(input.targetLocalDate, -1);
  const since = calendarDayBounds(previousDate, input.targetTimezone).timeMin;
  const until = calendarDayBounds(
    addCalendarDays(input.targetLocalDate, 1),
    input.targetTimezone,
  ).timeMin;
  const warnings: string[] = [];
  const byId = new Map<string, SessionDigest>();
  try {
    const listDigests = input.store.listSessionDigests;
    if (typeof listDigests !== "function") {
      throw new Error("session_digest_store_unavailable");
    }
    for (const digest of listDigests({ since, until, limit: 100 })) {
      byId.set(digest.id, digest);
    }
  } catch (error) {
    warnings.push(errorNote(error, "project_progress_store_failed").replace(/^error:/, ""));
  }
  try {
    for (
      const digest of readProgressDigestRelays({
        dataDir: input.dataDir,
        since,
        until,
        perProjectLimit: 20,
        totalLimit: 100,
      })
    ) {
      if (!byId.has(digest.id)) byId.set(digest.id, digest);
    }
  } catch (error) {
    warnings.push(errorNote(error, "project_progress_relay_failed").replace(/^error:/, ""));
  }
  try {
    const perProject = new Map<string, number>();
    const digests = [...byId.values()]
      .sort((left, right) => right.runAt.localeCompare(left.runAt))
      .filter((digest) => {
        const count = perProject.get(digest.project) ?? 0;
        if (count >= 3) return false;
        perProject.set(digest.project, count + 1);
        return true;
      })
      .slice(0, 30);
    const summaries = digests.map(
      (digest) =>
        `- ${compactLine(digest.project, 100)}: ${compactLine(digest.summary, 360)}`,
    );
    const taskNotes = digests.flatMap((digest) =>
      digest.perTask
        .filter((item) => item.progress !== "none" || item.scope_changed)
        .map((item) =>
          `- project=${compactLine(digest.project, 100)}` +
          ` task_id=${item.task_id}` +
          ` progress=${item.progress}` +
          ` scope_changed=${item.scope_changed}` +
          ` note=${JSON.stringify(compactLine(item.note, 200))}` +
          ` evidence=${JSON.stringify(compactLine(item.evidence_quote, 240))}`,
        )
    );
    const content = [
      "PROJECT SUMMARIES",
      ...(summaries.length > 0 ? summaries : ["No project progress digests for yesterday or today."]),
      "",
      "TASK-LEVEL NOTES",
      ...(taskNotes.length > 0 ? taskNotes : ["None."]),
      "",
      heartbeat.line,
    ].join("\n");
    return {
      ...source,
      content,
      asOf: digests[0]?.runAt ?? input.now.toISOString(),
      ...(warnings.length > 0 || heartbeat.warning
        ? {
            note: `error:${[...warnings, heartbeat.warning].filter(Boolean).join(";")}`,
          }
        : {}),
    };
  } catch (error) {
    const warning = errorNote(error, "project_progress_failed").replace(/^error:/, "");
    return {
      ...source,
      content: [
        `WARNING: project progress unavailable (${warning}).`,
        heartbeat.line,
      ].join("\n"),
      asOf: input.now.toISOString(),
      note: `error:${[warning, heartbeat.warning].filter(Boolean).join(";")}`,
    };
  }
}

export function autonomyCheckinSource(input: {
  dataDir?: string;
  now: Date;
}): BriefSourceInput | undefined {
  const source = {
    id: "autonomy_checkin",
    label: "AUTONOMY_CHECK_IN",
    required: false,
    maxChars: 800,
    priority: 1,
  } as const;
  try {
    const settings = readCoveAutonomySettings({
      dataDir: input.dataDir,
      createIfMissing: false,
    });
    if (!settings || !groundworkCheckinDue(settings, input.now)) return undefined;
    recordGroundworkCheckinPresentation({ dataDir: input.dataDir });
    return {
      ...source,
      content:
        "Groundwork has been running for two weeks. Want Cove to try completing whole tasks (you still review everything), or keep it at groundwork? Edit data/cove-autonomy.json: set checkin_answered true, and level stays 'groundwork' or, when full-task mode ships, 'full'. This appears in at most three briefs; editing checkin_answered to false and checkin_presented_count to 0 re-opens it.",
      asOf: settings.first_groundwork_at ?? input.now.toISOString(),
    };
  } catch (error) {
    return {
      ...source,
      content: `WARNING: Cove autonomy setting is unreadable (${
        errorNote(error, "cove_autonomy_invalid").replace(/^error:/, "")
      }).`,
      asOf: input.now.toISOString(),
      note: "error:cove_autonomy_invalid",
    };
  }
}

const COMMITMENT_KIND_ORDER: CommitmentKind[] = [
  "follow_up",
  "promise",
  "waiting_on",
  "open_decision",
  "overnight_request",
  "idea",
];

function commitmentRow(value: unknown): Commitment | undefined {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.kind !== "string" ||
    !COMMITMENT_KIND_ORDER.includes(row.kind as CommitmentKind) ||
    typeof row.title !== "string" ||
    row.status !== "open"
  ) {
    return undefined;
  }
  const optionalString = (candidate: unknown) => typeof candidate === "string" ? candidate : null;
  const confidence = row.confidence === "low" || row.confidence === "medium"
    ? row.confidence
    : "high";
  return {
    id: row.id,
    kind: row.kind as CommitmentKind,
    title: row.title,
    details: optionalString(row.details),
    counterparty: optionalString(row.counterparty),
    contact_id: optionalString(row.contact_id),
    source_kind: ["brain_dump", "manual", "chat", "detector", "brief"].includes(String(row.source_kind))
      ? row.source_kind as Commitment["source_kind"]
      : "manual",
    source_quote: optionalString(row.source_quote),
    source_ref: optionalString(row.source_ref),
    due_at: optionalString(row.due_at),
    review_at: optionalString(row.review_at),
    confidence,
    confirmed: row.confirmed === true || row.confirmed === 1,
    status: "open",
    evidence: optionalString(row.evidence),
    created_at: optionalString(row.created_at) ?? "",
    updated_at: optionalString(row.updated_at) ?? "",
  };
}

function commitmentDate(commitment: Commitment): number {
  const values = [commitment.due_at, commitment.review_at]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  // Undated items still sort behind dated ones, but MAX_SAFE_INTEGER instead of
  // Infinity keeps the subtraction finite so the recency tiebreaker below runs.
  // Infinity - Infinity is NaN, which would silently skip it.
  return values.length > 0 ? Math.min(...values) : Number.MAX_SAFE_INTEGER;
}

// Tiebreaker for items sharing a date, and the only ordering undated items get.
// Everything a brain dump creates lands undated, so without this the newest
// commitments pile up at the end of the section and are exactly what the
// character cap removes first. Newest survives.
function commitmentRecency(commitment: Commitment): number {
  const created = Date.parse(commitment.created_at);
  return Number.isFinite(created) ? created : 0;
}

function commitmentLine(
  commitment: Commitment,
  dueSoonIds: ReadonlySet<string>,
  staleIds: ReadonlySet<string>,
  updatedFromNotesIds: ReadonlySet<string>,
): string {
  const parts = [`- ${compactLine(commitment.title, 120)}`];
  if (commitment.counterparty) parts.push(`counterparty=${compactLine(commitment.counterparty, 80)}`);
  if (commitment.due_at) parts.push(`due=${commitment.due_at}`);
  if (commitment.review_at) parts.push(`review=${commitment.review_at}`);
  if (dueSoonIds.has(commitment.id)) parts.push("due_or_review_by_tomorrow");
  if (staleIds.has(commitment.id)) parts.push("stale_open_over_7d");
  if (commitment.source_quote) parts.push(`source="${compactLine(commitment.source_quote, 180)}"`);
  if (updatedFromNotesIds.has(commitment.id)) parts.push("updated_from_your_notes");
  return parts.join(" | ");
}

function commitmentEvidence(value: string | null | undefined): UnknownRecord | undefined {
  if (!value?.trim()) return undefined;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function recentEvidenceTimestamp(
  evidence: UnknownRecord | undefined,
  key: string,
  nowEpoch: number,
): boolean {
  const timestamp = typeof evidence?.[key] === "string" ? Date.parse(evidence[key]) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp <= nowEpoch && timestamp >= nowEpoch - 36 * 60 * 60 * 1000;
}

async function commitmentsSource(input: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  targetLocalDate: string;
  now: Date;
}): Promise<BriefSourceInput> {
  const base: BriefSourceInput = {
    id: "commitments",
    label: "OPEN_COMMITMENTS_AND_GAPS",
    required: false,
    // 4500 fit roughly a dozen items. One evening brain dump can add thirteen
    // at once, and the overflow was silently dropping the newest of them.
    maxChars: 9000,
    priority: 5,
    freshness: "current",
  };
  const [openResult, resolvedResult] = await Promise.allSettled([
    fetchRows(
      input.fetchImpl,
      input.baseUrl,
      "commitments",
      input.timeoutMs,
      "select=*&status=eq.open&order=due_at.asc.nullslast",
    ),
    fetchRows(
      input.fetchImpl,
      input.baseUrl,
      "commitments",
      input.timeoutMs,
      "select=*&status=eq.done&order=updated_at.desc&limit=20",
    ),
  ]);
  if (openResult.status === "rejected" && resolvedResult.status === "rejected") {
    return { ...base, note: errorNote(openResult.reason, "commitments_failed") };
  }
  try {
    const commitments = (openResult.status === "fulfilled" ? openResult.value : [])
      .map(commitmentRow)
      .filter((row): row is Commitment => Boolean(row))
      .sort((left, right) =>
        commitmentDate(left) - commitmentDate(right) ||
        commitmentRecency(right) - commitmentRecency(left) ||
        left.id.localeCompare(right.id));
    const nowEpoch = input.now.getTime();
    const evidenceById = new Map(
      commitments.map((commitment) => [commitment.id, commitmentEvidence(commitment.evidence)]),
    );
    const dueSoonIds = new Set(followUpsDue(commitments, input.targetLocalDate).map((item) => item.id));
    const staleIds = new Set(staleOpenItems(commitments, input.now).map((item) => item.id));
    const updatedFromNotesIds = new Set(
      commitments
        .filter((commitment) => {
          const evidence = evidenceById.get(commitment.id);
          return evidence?.updated_by === "day_dump" &&
            recentEvidenceTimestamp(evidence, "updated_at", nowEpoch);
        })
        .map((commitment) => commitment.id),
    );
    const groups = COMMITMENT_KIND_ORDER.flatMap((kind) => {
      const group = commitments.filter((commitment) => commitment.kind === kind);
      return group.length > 0
        ? [
            `${kind.toUpperCase()}:`,
            ...group.map((item) => commitmentLine(item, dueSoonIds, staleIds, updatedFromNotesIds)),
          ]
        : [];
    });
    const proposedIds = new Set<string>();
    const proposedClarifications = commitments.flatMap((commitment) => {
      const proposal = asRecord(evidenceById.get(commitment.id)?.proposed_resolution);
      if (
        !proposal ||
        (proposal.action !== "done" && proposal.action !== "update") ||
        typeof proposal.quote !== "string" ||
        !proposal.quote.trim()
      ) {
        return [];
      }
      proposedIds.add(commitment.id);
      return [
        `- ${compactLine(commitment.title, 120)}` +
          ` | you said: "${compactLine(proposal.quote, 140)}"` +
          ` | proposed: ${proposal.action === "done" ? "close" : "update"}`,
      ];
    });
    const lowConfidenceClarifications = commitments
      .filter(
        (commitment) =>
          commitment.confidence === "low" &&
          !commitment.confirmed &&
          !proposedIds.has(commitment.id),
      )
      .map((item) => `- ${compactLine(item.title, 120)} | confidence=low | confirmed=false`);
    const clarificationLines = [...lowConfidenceClarifications, ...proposedClarifications];
    const resolvedFromNotes = (resolvedResult.status === "fulfilled" ? resolvedResult.value : [])
      .flatMap((value) => {
        const row = asRecord(value);
        const evidence = commitmentEvidence(typeof row?.evidence === "string" ? row.evidence : null);
        if (
          !row ||
          row.status !== "done" ||
          typeof row.title !== "string" ||
          evidence?.resolved_by !== "day_dump" ||
          typeof evidence.quote !== "string" ||
          !recentEvidenceTimestamp(evidence, "resolved_at", nowEpoch)
        ) {
          return [];
        }
        return [{
          line: `- ${compactLine(row.title, 120)} | you said: "${compactLine(evidence.quote, 140)}"`,
          updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
        }];
      });
    const quotaValue = Number(coveEnv("CONTENT_QUOTA_POSTS"));
    const quota = Number.isFinite(quotaValue) && quotaValue >= 0 ? quotaValue : 2;
    const supernovaDir = defaultSupernovaDir();
    const quotaGap = supernovaDir
      ? contentQuotaGap({
          engineDir: supernovaDir,
          targetLocalDate: input.targetLocalDate,
          quota,
        })
      : null;
    const overnight = commitments.filter((commitment) => commitment.kind === "overnight_request");
    const content = [
      "OPEN COMMITMENTS",
      ...(openResult.status === "rejected"
        ? ["Unavailable (fetch failed)."]
        : groups.length > 0
          ? groups
          : ["None."]),
      "",
      "NEEDS CLARIFICATION",
      ...(clarificationLines.length > 0 ? clarificationLines : ["None."]),
      ...(resolvedFromNotes.length > 0
        ? [
            "",
            "RESOLVED FROM YOUR NOTES",
            ...resolvedFromNotes.map((item) => item.line),
          ]
        : []),
      "",
      "CONTENT QUOTA",
      quotaGap
        ? `scheduled=${quotaGap.scheduled} | posted=${quotaGap.posted} | awaiting_approval=${quotaGap.awaitingApproval} | quota=${quotaGap.quota} | gap=${quotaGap.gap}`
        : "Unavailable: content engine pipeline directories could not be read.",
      "",
      "OVERNIGHT REQUESTS",
      ...(overnight.length > 0
        ? overnight.map((item) => `- ${compactLine(item.title, 120)} | recorded; overnight execution not yet live`)
        : ["None recorded. Overnight execution is not yet live."]),
    ].join("\n");
    const newestUpdate = commitments.reduce(
      (newest, item) => item.updated_at > newest ? item.updated_at : newest,
      resolvedFromNotes.reduce(
        (newest, item) => item.updatedAt > newest ? item.updatedAt : newest,
        "",
      ),
    );
    const notes = [
      openResult.status === "rejected" ? errorNote(openResult.reason, "open_commitments_failed") : undefined,
      resolvedResult.status === "rejected" ? errorNote(resolvedResult.reason, "resolved_commitments_failed") : undefined,
      quotaGap ? undefined : "content_engine_unavailable",
    ].filter((note): note is string => Boolean(note));
    return {
      ...base,
      content,
      asOf: newestUpdate || input.now.toISOString(),
      note: notes.length > 0 ? notes.join(";") : undefined,
    };
  } catch (error) {
    return { ...base, note: errorNote(error, "commitments_failed") };
  }
}

type EmailQueueItem = {
  id: string;
  threadId?: string;
  classification?: string;
  status: string;
  senderName?: string;
  senderEmail?: string;
  subject?: string;
  summary?: string;
  recommendedAction?: string;
  priority?: number;
  receivedAt?: string;
};

type EmailQueueDraft = {
  id: string;
  emailItemId?: string;
  status: "needs_review" | "approved" | "edited";
};

function emailQueueItem(value: unknown): EmailQueueItem | undefined {
  const row = asRecord(value);
  if (!row || typeof row.id !== "string" || typeof row.status !== "string") {
    return undefined;
  }
  const priority = Number(row.priority);
  return {
    id: row.id,
    threadId: typeof row.thread_id === "string" ? row.thread_id : undefined,
    classification: typeof row.classification === "string" ? row.classification : undefined,
    status: row.status,
    senderName: typeof row.sender_name === "string" ? row.sender_name : undefined,
    senderEmail: typeof row.sender_email === "string" ? row.sender_email : undefined,
    subject: typeof row.subject === "string" ? row.subject : undefined,
    summary: typeof row.summary === "string" ? row.summary : undefined,
    recommendedAction:
      typeof row.recommended_action === "string" ? row.recommended_action : undefined,
    priority: Number.isFinite(priority) ? priority : undefined,
    receivedAt: typeof row.received_at === "string" ? row.received_at : undefined,
  };
}

function emailQueueDraft(value: unknown): EmailQueueDraft | undefined {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== "string" ||
    (row.status !== "needs_review" && row.status !== "approved" && row.status !== "edited")
  ) {
    return undefined;
  }
  return {
    id: row.id,
    emailItemId: typeof row.email_item_id === "string" ? row.email_item_id : undefined,
    status: row.status,
  };
}

export async function emailQueueSource(input: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  now: Date;
}): Promise<BriefSourceInput> {
  const base: BriefSourceInput = {
    id: "email_queue",
    label: "EMAIL_DECISION_QUEUE",
    required: false,
    maxChars: 12_000,
    priority: 7,
    freshness: "current",
  };
  try {
    // These tables have no position column. Explicit queries keep cove-rest
    // from applying its default position ordering to columns that do not exist.
    const [itemRows, draftRows] = await Promise.all([
      fetchRows(
        input.fetchImpl,
        input.baseUrl,
        "email_items",
        input.timeoutMs,
        "select=id,thread_id,classification,status,sender_name,sender_email,subject,summary,recommended_action,priority,received_at&status=in.(pending,reviewed)&order=received_at.desc",
      ),
      fetchRows(
        input.fetchImpl,
        input.baseUrl,
        "drafts",
        input.timeoutMs,
        "select=id,email_item_id,status&status=in.(needs_review,approved,edited)&order=updated_at.desc",
      ),
    ]);
    const items = itemRows
      .map(emailQueueItem)
      .filter((item): item is EmailQueueItem => Boolean(item))
      .sort((left, right) => {
        const classification =
          Number(right.classification === "action_item") -
          Number(left.classification === "action_item");
        if (classification !== 0) return classification;
        const priority = (left.priority ?? Number.MAX_SAFE_INTEGER) -
          (right.priority ?? Number.MAX_SAFE_INTEGER);
        if (priority !== 0) return priority;
        const leftReceived = left.receivedAt ? Date.parse(left.receivedAt) : 0;
        const rightReceived = right.receivedAt ? Date.parse(right.receivedAt) : 0;
        return rightReceived - leftReceived || left.id.localeCompare(right.id);
      });
    if (items.length === 0) {
      return { ...base, content: "No open email items." };
    }

    // Draft rows arrive newest first. Keep the first state for each item and
    // ignore orphan rows because email_item_id has no enforced foreign key.
    const itemIds = new Set(items.map((item) => item.id));
    const draftByItemId = new Map<string, EmailQueueDraft["status"]>();
    for (const draft of draftRows
      .map(emailQueueDraft)
      .filter((entry): entry is EmailQueueDraft => Boolean(entry))) {
      if (
        draft.emailItemId &&
        itemIds.has(draft.emailItemId) &&
        !draftByItemId.has(draft.emailItemId)
      ) {
        draftByItemId.set(draft.emailItemId, draft.status);
      }
    }

    const waitingCount = items.filter((item) => draftByItemId.has(item.id)).length;
    const displayedItems = items.slice(0, 25);
    const content = [
      `showing ${displayedItems.length} of ${items.length} open items (${waitingCount} with a draft waiting).`,
      ...displayedItems.map((item) => {
        const sender = compactLine(item.senderName || item.senderEmail, 80) || "Unknown sender";
        const subject = JSON.stringify(compactLine(item.subject, 120) || "(no subject)");
        const ask = compactLine(item.recommendedAction || item.summary, 140) || "none stated";
        return `- [${compactLine(item.status, 30)}] p${item.priority ?? "?"} ${JSON.stringify(sender)} ${subject}` +
          ` | ask: ${JSON.stringify(ask)}` +
          ` | draft: ${draftByItemId.get(item.id) ?? "none"}` +
          ` | age: ${inboundAge(item.receivedAt, input.now)}`;
      }),
    ].join("\n");
    const newestReceivedAt = items.reduce(
      (newest, item) => item.receivedAt && item.receivedAt > newest ? item.receivedAt : newest,
      "",
    );
    return { ...base, content, asOf: newestReceivedAt || undefined };
  } catch (error) {
    return { ...base, note: errorNote(error, "email_queue_failed") };
  }
}

function addCalendarDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("calendar target date invalid");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days, 12));
  return date.toISOString().slice(0, 10);
}

function zonedMidnight(localDate: string, timezone: string): { instant: Date; offset: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("calendar target date invalid");
  const desiredEpoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(desiredEpoch).toISOString().slice(0, 10) !== localDate) {
    throw new Error("calendar target date invalid");
  }
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instantEpoch = desiredEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instantEpoch)).map((part) => [part.type, part.value]),
    );
    const renderedEpoch = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const nextEpoch = desiredEpoch - (renderedEpoch - instantEpoch);
    if (nextEpoch === instantEpoch) break;
    instantEpoch = nextEpoch;
  }
  const instant = new Date(instantEpoch);
  if (localDateInTimezone(instant, timezone) !== localDate) {
    throw new Error("calendar timezone conversion failed");
  }
  const offsetMinutes = Math.round((desiredEpoch - instantEpoch) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return { instant, offset };
}

function calendarDayBounds(localDate: string, timezone: string): { timeMin: string; timeMax: string } {
  const nextDate = addCalendarDays(localDate, 1);
  const start = zonedMidnight(localDate, timezone);
  const end = zonedMidnight(nextDate, timezone);
  return {
    timeMin: `${localDate}T00:00:00${start.offset}`,
    timeMax: `${nextDate}T00:00:00${end.offset}`,
  };
}

// How many prior weekdays of closeouts and briefs the morning brief looks back
// over. Five covers a full working week without letting a quiet Friday fall out
// of view on Monday.
export const BRIEF_LOOKBACK_WEEKDAYS = 5;

// The operator does not do structured work on weekends, so a Monday brief that
// counted back five calendar days would spend two of its five slots on days that
// were never going to have a closeout in them. Counts strictly backwards from the
// day before the target and keeps only Monday through Friday, newest first.
export function previousWeekdays(
  targetLocalDate: string,
  count = BRIEF_LOOKBACK_WEEKDAYS,
): string[] {
  const dates: string[] = [];
  // Three calendar days per weekday needed is slack enough for any weekend run.
  for (let back = 1; dates.length < count && back <= count * 3; back += 1) {
    const date = addCalendarDays(targetLocalDate, -back);
    const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.push(date);
  }
  return dates;
}

// Working days sitting between the day a closeout covers and the day the brief
// is for. This, not elapsed hours, is what says whether a closeout is the
// current one: Friday's closeout read on Monday morning is ~60 hours old and is
// still the most recent one possible, while a Thursday closeout read the
// following Wednesday has three working days of silence behind it. An
// hours-based rule gets Mondays wrong every single week.
//
// Returns undefined when the date is unusable or in the future, and 0 when the
// closeout covers the immediately preceding working day.
export function closeoutGapWeekdays(
  closeoutLocalDate: string | undefined,
  targetLocalDate: string,
): number | undefined {
  if (!closeoutLocalDate || closeoutLocalDate >= targetLocalDate) return undefined;
  // Two working weeks is far enough back to be worth reporting exactly; past
  // that the precise number stops changing anyone's reading of it.
  const window = previousWeekdays(targetLocalDate, 10);
  const index = window.indexOf(closeoutLocalDate);
  return index >= 0 ? index : undefined;
}

// The provenance line Cove prepends to the closeout. Facts only: when it was
// written, which day it covers, and how many working days have gone by without
// another one. No verdict and no prohibition. The model has the target date and
// this line, so it can judge for itself which parts of a closeout still hold,
// which is the right call to leave with the writer rather than hard-code here.
export function closeoutTimestampHeader(input: {
  asOf: string | undefined;
  closeoutLocalDate: string | undefined;
  targetLocalDate: string;
  targetTimezone: string;
}): string {
  const parts = [
    `CLOSEOUT PROVENANCE (added by Cove, not written by the operator).`,
    input.asOf ? `Saved: ${input.asOf}.` : `Saved: time unknown.`,
    input.closeoutLocalDate
      ? `Covers the working day ${weekdayLabel(input.closeoutLocalDate, input.targetTimezone)}.`
      : `The day it covers was not recorded.`,
    `This brief is for ${weekdayLabel(input.targetLocalDate, input.targetTimezone)}.`,
  ];
  const gap = closeoutGapWeekdays(input.closeoutLocalDate, input.targetLocalDate);
  if (gap === 0) {
    parts.push("It covers the working day immediately before this one, so it is the operator's most recent word.");
  } else if (gap !== undefined && gap > 0) {
    const skipped = previousWeekdays(input.targetLocalDate, gap)
      .slice()
      .reverse()
      .map((date) => weekdayLabel(date, input.targetTimezone));
    parts.push(
      `${gap} working day${gap === 1 ? "" : "s"} (${skipped.join(", ")}) went by without a closeout, so anything time-bound in it may have moved since.`,
    );
  }
  return parts.join(" ");
}

function weekdayLabel(localDate: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      month: "short",
      day: "numeric",
    }).format(new Date(`${localDate}T12:00:00.000Z`));
  } catch {
    return localDate;
  }
}

// The previous weekdays' closeouts, under the newest one. The dump the operator
// wrote last night says what he decided; the four before it say what he has been
// circling for a week, which is how a brief notices that a task has been carried
// three nights running rather than treating every morning as day one.
function recentDumpsSource(input: {
  dumps: readonly DayDump[];
  newestId: string | undefined;
  targetLocalDate: string;
  now: Date;
}): BriefSourceInput {
  const base = {
    id: "recent_dumps",
    label: "RECENT_CLOSEOUT_NOTES",
    required: false,
    maxChars: 14_000,
    priority: 2,
  } as const;
  try {
    const window = new Set(previousWeekdays(input.targetLocalDate));
    const history = input.dumps
      .filter((dump) => dump.id !== input.newestId && window.has(dump.targetLocalDate))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (history.length === 0) {
      return { ...base, note: "recent_dumps_unavailable" };
    }
    return {
      ...base,
      content: history
        .map((dump) =>
          `--- closeout for ${dump.targetLocalDate} (written ${dump.createdAt}) ---\n` +
          dump.rawText.trim(),
        )
        .join("\n\n"),
      asOf: history[0].createdAt,
    };
  } catch (error) {
    // A malformed historical row must not suppress every other brief source.
    return { ...base, note: errorNote(error, "recent_dumps_failed") };
  }
}

// What Cove already told him on the previous weekdays. This is here so the brief
// can see its own repetition: a headline it has now written three mornings
// running is either the most important thing he owns or something it keeps
// pushing that he has not chosen, and both of those are worth saying out loud.
// Deliberately NOT evidence: prior briefs are Cove's own words, and treating
// them as fact is how a wrong call from Monday survives all week.
function briefCandidateReceipt(input: {
  taskId: string;
  plan: NonNullable<ReturnType<DayPlanStore["getPlanForDate"]>>;
  snapshot: ReturnType<DayPlanStore["getSnapshot"]>;
}): string {
  const item = input.plan.items.find((candidate) => candidate.taskId === input.taskId);
  if (!item) return `taskId=${input.taskId} dropped_before_arrival`;
  const title = compactLine(item.title, 80) || "Untitled task";
  const decision = item.decision === "accepted" || item.decision === "completed"
    ? "accepted"
    : item.decision === "pending" || item.decision === "preselected"
      ? "not_decided"
      : item.decision === "later"
        ? "set_aside"
        : item.decision === "dismissed"
          ? "dismissed"
          : "unknown_decision";
  let settled = "not_settled";
  if (input.snapshot?.body.completedHumanTaskIds.includes(input.taskId)) {
    settled = "done";
  } else {
    settled = input.snapshot?.body.unresolvedItems.find(
      (candidate) => candidate.taskId === input.taskId,
    )?.disposition ?? "not_settled";
  }
  return `'${title.replace(/'/g, "\\'")}' ${decision} then ${settled}`;
}

export function recentBriefsSource(input: {
  store: DayPlanStore;
  targetLocalDate: string;
  now: Date;
}): BriefSourceInput {
  const base = {
    id: "recent_briefs",
    label: "YOUR_RECENT_BRIEFS",
    required: false,
    maxChars: 8000,
    priority: 3,
  } as const;
  try {
    const lines: string[] = [];
    let newestAsOf: string | undefined;
    for (const date of previousWeekdays(input.targetLocalDate)) {
      const artifacts = input.store.listMorningBriefs(date);
      const plan = input.store.getPlanForDate?.(date);
      // A plan freezes the brief the operator actually saw when that artifact is
      // available and parseable. Otherwise preserve the date with a labelled fallback.
      const attachedArtifact = plan?.briefId
        ? artifacts.find((artifact) => artifact.id === plan.briefId)
        : undefined;
      const attachedBrief = attachedArtifact
        ? morningBriefFromArtifact(attachedArtifact)
        : undefined;
      let selected = attachedArtifact && attachedBrief
        ? { artifact: attachedArtifact, brief: attachedBrief, fallback: false }
        : undefined;
      selected ??= [...artifacts]
        .reverse()
        .flatMap((artifact) => {
          const brief = morningBriefFromArtifact(artifact);
          return brief ? [{ artifact, brief, fallback: true }] : [];
        })[0];
      if (!selected?.brief) continue;
      const { artifact, brief } = selected;
      const headline = compactLine(brief.headline, 240) ||
        compactLine(
          /^.*?[.!?](?:\s|$)/.exec(compactLine(brief.lensNarrative, 10_000))?.[0] ??
            brief.lensNarrative,
          240,
        );
      if (!headline) continue;
      const finished = artifact.finishedAt;
      if (!newestAsOf && finished) newestAsOf = finished;
      lines.push(
        `- ${date}: ${headline}` +
          (selected.fallback ? " (not the brief attached to the plan)" : ""),
      );

      if (
        brief.existingTaskCandidates.length === 0 ||
        !plan?.briefId ||
        plan.briefId !== artifact.id
      ) {
        continue;
      }
      const snapshot = input.store.getSnapshot?.(plan.id);
      const seenTaskIds = new Set<string>();
      const receipts = brief.existingTaskCandidates.flatMap((candidate) => {
        if (seenTaskIds.has(candidate.taskId)) return [];
        seenTaskIds.add(candidate.taskId);
        return [briefCandidateReceipt({ taskId: candidate.taskId, plan, snapshot })];
      });
      lines.push(`  candidates: ${receipts.join("; ")}`);
    }
    if (lines.length === 0) {
      return { ...base, note: "recent_briefs_unavailable" };
    }
    return {
      ...base,
      content: [
        "Headlines Cove gave the operator on the previous weekdays, newest first.",
        "These are Cove's own past words, not evidence.",
        "Receipts distinguish accepted work, dismissed work, work set aside, and work never decided.",
        "Use them only to notice repetition and what happened next, never as proof the recommendation was right.",
        "",
        ...lines,
      ].join("\n"),
      asOf: newestAsOf,
    };
  } catch (error) {
    return { ...base, note: errorNote(error, "recent_briefs_failed") };
  }
}

type CalendarEvent = {
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
  hangoutLink?: string;
  conferenceData?: unknown;
};

type CalendarSourceResult = {
  source: BriefSourceInput;
  events: CalendarEvent[];
};

function calendarTime(value: string, timezone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "time unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(timestamp))
    .replace(/\s+/g, "")
    .toLowerCase();
}

function calendarEventLocalDate(
  event: CalendarEvent,
  timezone: string,
  fallback: string,
): string {
  if (event.start?.date && !event.start.dateTime) return event.start.date;
  const timestamp = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN;
  return Number.isFinite(timestamp)
    ? localDateInTimezone(new Date(timestamp), timezone)
    : fallback;
}

function formatCalendarEvent(event: CalendarEvent, timezone: string): string {
  const summary = compactLine(event.summary, 240) || "Untitled event";
  if (event.start?.date && !event.start.dateTime) return `all day: ${summary}`;
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  const startTime = start ? calendarTime(start, timezone) : "time unknown";
  const endTime = end ? calendarTime(end, timezone) : undefined;
  const range = startTime === "time unknown"
    ? startTime
    : `${startTime}${endTime && endTime !== "time unknown" ? `-${endTime}` : ""}`;
  const otherAttendees = (event.attendees ?? [])
    .filter((attendee) => !attendee.self && attendee.email)
    .slice(0, 3)
    .map((attendee) => attendee.email as string);
  const people = otherAttendees.length > 0 ? ` (with ${otherAttendees.join(", ")})` : "";
  const meeting = event.hangoutLink || event.conferenceData ? " [Meet]" : "";
  return `${range}: ${summary}${people}${meeting}`;
}

function formatCalendarEvents(
  events: readonly CalendarEvent[],
  timezone: string,
  targetLocalDate: string,
): string {
  const windowDates = Array.from(
    { length: 7 },
    (_, index) => addCalendarDays(targetLocalDate, index),
  );
  const windowSet = new Set(windowDates);
  const visible = events
    .filter(
      (event) =>
        !event.attendees?.some(
          (attendee) => attendee.self === true && attendee.responseStatus === "declined",
        ),
    )
    .map((event) => ({
      event,
      localDate: calendarEventLocalDate(event, timezone, targetLocalDate),
    }))
    .filter((entry) => windowSet.has(entry.localDate))
    .sort((left, right) => {
      const dateOrder = left.localDate.localeCompare(right.localDate);
      if (dateOrder !== 0) return dateOrder;
      const leftStart = left.event.start?.dateTime ?? left.event.start?.date ?? "";
      const rightStart = right.event.start?.dateTime ?? right.event.start?.date ?? "";
      return leftStart.localeCompare(rightStart);
    });
  const health =
    `Window: ${targetLocalDate} to ${windowDates[6]} (7 days). ${visible.length} events.`;
  if (visible.length === 0) {
    return `${health}\nNo events in the 7-day window.`;
  }
  const grouped = new Map<string, CalendarEvent[]>();
  for (const entry of visible) {
    const group = grouped.get(entry.localDate) ?? [];
    group.push(entry.event);
    grouped.set(entry.localDate, group);
  }
  return [
    health,
    ...windowDates.flatMap((localDate) => {
      const dayEvents = grouped.get(localDate);
      if (!dayEvents) return [];
      return [
        "",
        weekdayLabel(localDate, timezone),
        ...dayEvents.map((event) => formatCalendarEvent(event, timezone)),
      ];
    }),
  ].join("\n");
}

async function calendarSource(
  _fetchImpl: typeof fetch,
  targetLocalDate: string,
  targetTimezone: string,
  now: Date,
  dataDir?: string,
  injectedGateway?: Pick<WorkspaceGateway, "calendar">,
): Promise<CalendarSourceResult> {
  const source = {
    id: "calendar",
    label: "CALENDAR",
    required: false,
    maxChars: 5000,
    priority: 7,
  } as const;
  const resolvedDataDir = coveDataDir(dataDir);
  if (!injectedGateway && !existsSync(workspaceConfigPath(resolvedDataDir))) {
    return { source: { ...source, note: "not_configured" }, events: [] };
  }
  try {
    const startBounds = calendarDayBounds(targetLocalDate, targetTimezone);
    const endBounds = calendarDayBounds(
      addCalendarDays(targetLocalDate, 7),
      targetTimezone,
    );
    const calendar = injectedGateway?.calendar ??
      createGoogleWorkspaceGateway({ dataDir: resolvedDataDir }).calendar;
    if (!calendar) return { source: { ...source, note: "not_configured" }, events: [] };
    const events = await calendar.listEvents({
      timeMin: startBounds.timeMin,
      timeMax: endBounds.timeMin,
      timeZone: targetTimezone,
      maxResults: 250,
    });
    const formatted: CalendarEvent[] = events.map((event) => ({
      summary: event.summary,
      start: /^\d{4}-\d{2}-\d{2}$/.test(event.start)
        ? { date: event.start }
        : { dateTime: event.start },
      end: /^\d{4}-\d{2}-\d{2}$/.test(event.end)
        ? { date: event.end }
        : { dateTime: event.end },
      attendees: event.attendees.map((attendee) => ({
        email: attendee.email,
        self: attendee.self,
        responseStatus: attendee.responseStatus,
      })),
      hangoutLink: event.meetingUrl || undefined,
    }));
    return {
      source: {
        ...source,
        content: formatCalendarEvents(formatted, targetTimezone, targetLocalDate),
        asOf: now.toISOString(),
      },
      events: formatted,
    };
  } catch (error) {
    return {
      source: { ...source, note: errorNote(error, "calendar_failed") },
      events: [],
    };
  }
}

async function pipelineFollowUpsSource(input: {
  targetLocalDate: string;
  targetTimezone: string;
  now: Date;
  dataDir?: string;
  calendarPromise: Promise<CalendarSourceResult>;
}): Promise<BriefSourceInput> {
  const source = {
    id: "crm_last_touch",
    label: "PIPELINE_FOLLOW_UPS",
    required: false,
    maxChars: 4000,
    priority: 10,
  } as const;
  const resolvedDataDir = coveDataDir(input.dataDir);
  const configuredDbPath = coveEnv("DB_PATH");
  const dbPath = configuredDbPath ?? (input.dataDir
    ? path.join(resolvedDataDir, "cove.db")
    : localDatabasePath());
  let deals: ReturnType<LocalPipelineStore["list"]>;
  try {
    const pipeline = new LocalPipelineStore({ dbPath });
    try {
      deals = pipeline.list().filter((deal) => isOpenPipelineStage(deal.stage));
    } finally {
      pipeline.close();
    }
  } catch (error) {
    return { ...source, note: errorNote(error, "pipeline_failed") };
  }
  const due = deals.filter((deal) => {
    const status = followUpStatus(deal, input.targetLocalDate);
    return status === "overdue" || status === "today" || status === "soon";
  });
  const attendeeLines: string[] = [];
  const calendarEvents = (await input.calendarPromise).events.filter(
    (event) => calendarEventLocalDate(event, input.targetTimezone, input.targetLocalDate) ===
      input.targetLocalDate,
  );
  const crm = new LocalCRMBackend({ dbPath });
  try {
    const seen = new Set<string>();
    for (const event of calendarEvents) {
      for (const attendee of event.attendees ?? []) {
        if (!attendee.email || attendee.self || seen.has(attendee.email.toLowerCase())) continue;
        seen.add(attendee.email.toLowerCase());
        const matches = crm.findByNormalizedEmail(attendee.email);
        if (matches.length !== 1) continue;
        const deal = deals.find((candidate) => candidate.contact_id === matches[0].id);
        if (!deal) continue;
        attendeeLines.push(
          `- ${deal.name}: ${PIPELINE_STAGE_LABELS[deal.stage]}; next=${compactLine(deal.next_action, 300) || "not set"}; follow_up=${deal.next_follow_up_at ?? "not set"}`,
        );
      }
    }
    const category = (label: string, status: "overdue" | "today" | "soon") => {
      const rows = due.filter((deal) => followUpStatus(deal, input.targetLocalDate) === status);
      return [
        `${label}:`,
        ...(rows.length
          ? rows.map((deal) =>
              `- ${deal.name}: ${PIPELINE_STAGE_LABELS[deal.stage]}; next=${compactLine(deal.next_action, 300) || "not set"}; follow_up=${deal.next_follow_up_at ?? "not set"}`
            )
          : ["- None."]),
      ];
    };
    return {
      ...source,
      content: [
        ...category("Overdue", "overdue"),
        "",
        ...category("Due today", "today"),
        "",
        ...category("Due within 7 days", "soon"),
        "",
        "Open deals among today's calendar attendees:",
        ...(attendeeLines.length ? attendeeLines : ["- None."]),
      ].join("\n"),
      asOf: input.now.toISOString(),
    };
  } catch (error) {
    return { ...source, note: errorNote(error, "pipeline_failed") };
  } finally {
    crm.close();
  }
}

function formatDecisionResults(results: readonly unknown[]): string {
  const contents = results
    .map((result) => asRecord(result)?.content)
    .filter((content): content is string => typeof content === "string" && content.trim().length > 0);
  if (contents.length === 0) return "No recent decisions recorded.";
  const decisions = contents.filter((content) => content.includes("[DECISION]"));
  const selected = decisions.length >= 3 ? decisions : contents;
  return selected
    .map((content) => `- ${content.replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n");
}

// The memory hub is whichever jarvis-memory server this install owns. There is
// deliberately no default address: an install with no hub configured degrades
// to a missing optional source instead of reaching for someone else's machine.
export function memoryHubUrl(): string | undefined {
  const profileUrl = loadOperatorProfile()?.memory_hub_url;
  const configured = nonEmptyEnv("COVE_BRIEF_JARVIS_URL")
    ?? (typeof profileUrl === "string" && profileUrl.trim() ? profileUrl.trim() : undefined);
  return configured?.replace(/\/$/, "");
}

function memoryQueries(): readonly string[] {
  return [
    "recent decisions, commitments, and direction changes",
    `what ${operatorName()} worked on in Claude sessions the last three days`,
    "current state of the operator's active projects and business lines",
  ];
}

function memoryResultScore(result: unknown): number {
  const score = asRecord(result)?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}

function memoryResultUuid(result: unknown): string | undefined {
  const record = asRecord(result);
  const uuid = record?.uuid ?? record?.memory_uuid;
  return typeof uuid === "string" && uuid.trim() ? uuid : undefined;
}

async function fetchMemoryResults(
  fetchImpl: typeof fetch,
  hubUrl: string,
  token: string,
  query: string,
): Promise<unknown[]> {
  const response = await fetchImpl(`${hubUrl}/api/v2/scored_search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit: 12 }),
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Jarvis scored search ${response.status}`);
  const results = asRecord(await response.json())?.results;
  if (!Array.isArray(results)) throw new Error("Jarvis search response shape");
  return results;
}

async function memoryDecisionsSource(
  fetchImpl: typeof fetch,
  memoryPath: string | undefined,
  now: Date,
): Promise<BriefSourceInput> {
  const sourceOptions = {
    required: false,
    maxChars: 4000,
    priority: 11,
    freshnessThresholdHours: staleThresholdHours("memory_decisions", 24 * 7),
  } as const;
  if (memoryPath) {
    return fileSource("memory_decisions", "RECENT_DECISIONS", memoryPath, sourceOptions);
  }
  const tokenPath = coveEnv("BRIEF_JARVIS_TOKEN_PATH")?.trim()
    || path.join(homedir(), ".config", "jarvis-v2", "hub_token");
  const token = readKeyFile(tokenPath);
  const hubUrl = memoryHubUrl();
  if (!token || !hubUrl) {
    return {
      id: "memory_decisions",
      label: "RECENT_DECISIONS",
      ...sourceOptions,
      note: "not_configured",
    };
  }
  try {
    const queries = memoryQueries();
    const batches: unknown[][] = [
      await fetchMemoryResults(fetchImpl, hubUrl, token, queries[0]),
    ];
    for (const query of queries.slice(1)) {
      try {
        batches.push(await fetchMemoryResults(fetchImpl, hubUrl, token, query));
      } catch {
        // The first search preserves the source. Later context lanes are
        // additive and may fail independently without discarding it.
      }
    }
    const byUuid = new Map<string, unknown>();
    let anonymousIndex = 0;
    for (const result of batches.flat()) {
      const uuid = memoryResultUuid(result) ?? `anonymous:${anonymousIndex++}`;
      const existing = byUuid.get(uuid);
      if (!existing || memoryResultScore(result) > memoryResultScore(existing)) {
        byUuid.set(uuid, result);
      }
    }
    const results = [...byUuid.values()]
      .sort((left, right) => memoryResultScore(right) - memoryResultScore(left))
      .slice(0, 12);
    return {
      id: "memory_decisions",
      label: "RECENT_DECISIONS",
      ...sourceOptions,
      content: formatDecisionResults(results),
      asOf: now.toISOString(),
    };
  } catch (error) {
    return {
      id: "memory_decisions",
      label: "RECENT_DECISIONS",
      ...sourceOptions,
      note: errorNote(error, "memory_failed"),
    };
  }
}

// Resolves configured sources, normalizes and bounds each, and reports every
// outcome truthfully in the source list. Optional sources degrade to "missing"
// on any failure; they are never a validity prerequisite.
export async function collectMorningBriefSources(
  options: MorningBriefSourceOptions,
): Promise<CollectedBriefSources> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.webBaseUrl ?? defaultBriefWebBase()).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 8000;
  const now = options.now ?? new Date();
  const machineIdentity = briefMachineIdentity(
    options.dataDir,
    options.homeDir,
    options.machineIdentity,
  );
  const targetTimezone = options.targetTimezone ?? coveEnv("BRIEF_TIMEZONE") ?? defaultBriefTimezone();
  let targetLocalDate = options.targetLocalDate;
  if (!targetLocalDate) {
    try {
      targetLocalDate = localDateInTimezone(now, targetTimezone);
    } catch {
      // Keep non-calendar sources available even if a direct caller supplies a
      // bad timezone. The calendar helper will report its own scoped error.
      targetLocalDate = localDateInTimezone(now, defaultBriefTimezone());
    }
  }
  const memoryPath = options.memoryDecisionsPath ?? coveEnv("BRIEF_MEMORY_PATH");
  const filePolicy = resolveBriefFileSourcePolicy({
    dataDir: options.dataDir,
    homeDir: options.homeDir,
    goalsPath: options.goalsPath,
    operatorProfilePath: options.operatorProfilePath,
    leadupPath: options.leadupPath,
    sprintMemoPath: options.sprintMemoPath,
  });
  const operatorProfileSourceOptions = {
    required: filePolicy.operator_profile.required,
    maxChars: 6000,
    priority: 2,
  };
  const operatorProfileSource = filePolicy.operator_profile.format === "operator-profile-json"
    ? operatorProfileJsonSource(
        filePolicy.operator_profile.path,
        operatorProfileSourceOptions,
      )
    : fileSource(
        "operator_profile",
        "OPERATOR_PROFILE",
        filePolicy.operator_profile.path,
        operatorProfileSourceOptions,
      );

  // Start independent external reads together. Each helper catches its own
  // failures so an optional integration can never reject the full collection.
  const calendarPromise = calendarSource(
    fetchImpl,
    targetLocalDate,
    targetTimezone,
    now,
    options.dataDir,
    options.workspaceGateway,
  );
  const crmPromise = pipelineFollowUpsSource({
    targetLocalDate,
    targetTimezone,
    now,
    dataDir: options.dataDir,
    calendarPromise,
  });
  const memoryPromise = memoryDecisionsSource(fetchImpl, memoryPath, now);
  const commitmentsPromise = commitmentsSource({
    fetchImpl,
    baseUrl,
    timeoutMs,
    targetLocalDate,
    now,
  });
  const emailQueuePromise = emailQueueSource({
    fetchImpl,
    baseUrl,
    timeoutMs,
    now,
  });
  const inboundPromise = inboundSource({
    fetchImpl,
    baseUrl,
    timeoutMs,
    dataDir: options.dataDir,
    now,
    machineIdentity,
  });

  // Last night's brain dump, in the operator's own words, and the first thing the brief
  // reads. Priority 0 because it is the only source that can be hours old:
  // GOALS and the sprint memo are written by hand and go stale between edits,
  // so when he changes direction at night the dump is the only place the brief
  // can learn it. Local store first, then the relay, same as settlements, since
  // dumps are typed on the MBP and the 7:30 brief runs on the Mini. Extraction
  // already reached the commitment ledger; what this adds is the reasoning
  // around it, which no extraction preserves.
  //
  // Status is deliberately NOT filtered. The raw text is his, and it exists from
  // the moment he saves; extraction only adds structure on top of it. Requiring
  // status === "succeeded" made the brief blind to the dump he had just written
  // whenever settlement triggered generation inside the extraction window, and it
  // fell back to the previous dump without saying so. On 2026-07-29 a closeout
  // moving a client install to Monday was saved 2s before collection and finished
  // 60s after it, so the brief planned the whole day off a five-day-old dump.
  let localDumps: DayDump[] = [];
  try {
    localDumps = options.store
      .listDayDumps()
      .filter((dump) => dump.rawText.trim());
  } catch {
    // Fall through to the relay.
  }
  // listDayDumps orders by created_at ascending, so the newest is last.
  const newestLocalDump = localDumps[localDumps.length - 1];
  let dumpContent = newestLocalDump?.rawText.trim();
  let dumpAsOf = newestLocalDump?.createdAt;
  let dumpLocalDate = newestLocalDump?.targetLocalDate;
  const relayDump = readDumpRelay({ dataDir: options.dataDir, now });
  if (relayDump) {
    const relayMs = Date.parse(relayDump.asOf);
    const localMs = dumpContent && dumpAsOf ? Date.parse(dumpAsOf) : NaN;
    if (!dumpContent || !Number.isFinite(localMs) || relayMs > localMs) {
      dumpContent = relayDump.content;
      dumpAsOf = relayDump.asOf;
      dumpLocalDate = relayDump.targetLocalDate;
    }
  }
  const closeoutGap = closeoutGapWeekdays(dumpLocalDate, targetLocalDate);
  // Current means "no working day has gone by without one". A closeout dated on
  // or after the target day is same-day or later, which is fresher still. An
  // unrecorded date cannot be judged either way, and the header says so.
  const closeoutIsCurrent = closeoutGap === 0 ||
    dumpLocalDate === undefined ||
    dumpLocalDate >= targetLocalDate;
  const closeoutHeader = closeoutTimestampHeader({
    asOf: dumpAsOf,
    closeoutLocalDate: dumpLocalDate,
    targetLocalDate,
    targetTimezone,
  });
  const autonomyCheckin = autonomyCheckinSource({
    dataDir: options.dataDir,
    now,
  });

  const localMode = getRuntimeMode() === "local";
  const sources: BriefSourceInput[] = [
    dumpContent
      ? {
          id: "day_dump",
          label: "LAST_NIGHT_BRAIN_DUMP",
          required: false,
          maxChars: 12_000,
          priority: 0,
          // Provenance leads so it survives the character cap: trimming takes
          // from the end, and a timestamp trimmed off is a timestamp unread.
          content: `${closeoutHeader}\n\n${dumpContent}`,
          asOf: dumpAsOf,
          // Freshness is the working-day gap, never elapsed hours. Friday's
          // closeout read on Monday is ~60 hours old and is still the most
          // recent one that exists, so an hours threshold would mark the normal
          // Monday case stale every week.
          freshness: closeoutIsCurrent ? "current" : "stale",
        }
      : {
          id: "day_dump",
          label: "LAST_NIGHT_BRAIN_DUMP",
          required: false,
          maxChars: 12_000,
          priority: 0,
          note: "day_dump_unavailable",
        },
    recentDumpsSource({
      dumps: localDumps,
      newestId: newestLocalDump?.id,
      targetLocalDate,
      now,
    }),
    recentBriefsSource({
      store: options.store,
      targetLocalDate,
      now,
    }),
    await inboundPromise,
    projectProgressSource({
      store: options.store,
      dataDir: options.dataDir,
      targetLocalDate,
      targetTimezone,
      now,
      machineIdentity,
    }),
    ...(localMode
      ? [
          recentActivitySource({
            dataDir: options.dataDir,
            now,
          }),
          recurringRhythmSource({
            dataDir: options.dataDir,
            targetLocalDate,
            targetTimezone,
            now,
          }),
          staleTasksSource({
            dataDir: options.dataDir,
            now,
          }),
        ]
      : []),
    ...(autonomyCheckin ? [autonomyCheckin] : []),
    {
      ...fileSource("goals", "GOALS", filePolicy.goals.path, {
        required: filePolicy.goals.required,
        maxChars: 20_000,
        priority: 1,
        // Goals change rarely; a month untouched is worth flagging.
        freshnessThresholdHours: staleThresholdHours("goals", 24 * 30),
      }),
      contentTrimmer: preserveGoalsNeverSections,
    },
    operatorProfileSource,
    fileSource(
      "leadup",
      "LEADUP",
      filePolicy.leadup.path,
      {
        required: filePolicy.leadup.required,
        maxChars: 9000,
        priority: 3,
      },
    ),
    fileSource(
      "sprint_memo",
      "SPRINT_MEMO",
      filePolicy.sprint_memo.path,
      {
        required: filePolicy.sprint_memo.required,
        maxChars: 12_000,
        priority: 4,
        // The sprint memo should move weekly.
        freshnessThresholdHours: staleThresholdHours("sprint_memo", 24 * 7),
      },
    ),
  ];

  const knownTaskIds = new Set<string>();
  const taskUpdatedAtById = new Map<string, string>();
  const recurringTaskIds = new Set<string>();
  let emailBrief: BriefSourceInput = {
    id: "email_brief",
    label: "EMAIL_BRIEF",
    required: false,
    maxChars: 3000,
    priority: 9,
    // Email triage runs twice a day; older than a day is stale.
    freshnessThresholdHours: staleThresholdHours("email_brief", 24),
  };
  sources.push(await commitmentsPromise);
  sources.push(await emailQueuePromise);
  try {
    const [taskRows, columnRows] = await Promise.all([
      fetchRows(fetchImpl, baseUrl, "tasks", timeoutMs),
      fetchRows(fetchImpl, baseUrl, "task_columns", timeoutMs),
    ]);
    const columns = new Map(
      (columnRows as ColumnRow[]).map((column) => [column.id, column.name]),
    );
    const completedCutoff = now.getTime() - 48 * 60 * 60 * 1000;
    const completed = (taskRows as TaskRow[])
      .flatMap((row) => {
        if (row.status !== "done" || !row.updated_at) return [];
        const updatedMs = Date.parse(row.updated_at);
        if (
          !Number.isFinite(updatedMs) ||
          updatedMs < completedCutoff ||
          updatedMs > now.getTime()
        ) {
          return [];
        }
        return [{ row, updatedMs }];
      })
      .sort((left, right) => right.updatedMs - left.updatedMs);
    const completedLines = completed.slice(0, 15).map(({ row }) =>
      `- "${compactLine(row.title, 96) || "Untitled task"}"` +
      ` project=${compactLine(row.project, 48) || "Atlas"}` +
      ` updated=${row.updated_at}`
    );
    if (completed.length > completedLines.length) {
      completedLines.push(`+${completed.length - completedLines.length} more`);
    }
    sources.push({
      id: "completed_recently",
      label: "COMPLETED_RECENTLY",
      required: false,
      maxChars: 3000,
      priority: 6,
      content: completedLines.length > 0
        ? completedLines.join("\n")
        : "Nothing marked done in the last two days.",
      asOf: completed[0]?.row.updated_at,
    });
    const lines: string[] = [];
    let newestUpdate = "";
    const priorityRank = new Map([["high", 0], ["medium", 1], ["low", 2]]);
    const orderedOpenRows = (taskRows as TaskRow[])
      .filter((row) => row.id && row.status === "open" && columnBucket(columns.get(row.column_id ?? undefined)))
      .sort((left, right) => {
        const leftDate = left.due_at ? localDateFor(left.due_at, targetTimezone) : undefined;
        const rightDate = right.due_at ? localDateFor(right.due_at, targetTimezone) : undefined;
        const leftDueNow = leftDate && leftDate <= targetLocalDate ? 0 : 1;
        const rightDueNow = rightDate && rightDate <= targetLocalDate ? 0 : 1;
        return leftDueNow - rightDueNow ||
          (leftDueNow === 0 && rightDueNow === 0
            ? (leftDate ?? "").localeCompare(rightDate ?? "")
            : 0) ||
          (priorityRank.get(left.priority ?? "medium") ?? 1) -
            (priorityRank.get(right.priority ?? "medium") ?? 1) ||
          (right.updated_at ?? "").localeCompare(left.updated_at ?? "");
      });
    for (const row of orderedOpenRows) {
      if (!row.id || row.status !== "open") continue;
      const bucket = columnBucket(columns.get(row.column_id ?? undefined));
      if (!bucket) continue;
      const title = compactLine(row.title, 160);
      const tags = taskTags(row.tags).map((tag) => tag.trim().toLowerCase());
      const recurringInstance = tags.includes("recurring") || Boolean(row.recurring_template_id);
      if (recurringInstance) recurringTaskIds.add(row.id);
      const candidateEligible =
        !tags.includes("jarvis-held") &&
        (!localMode || !recurringInstance) &&
        !tags.includes("email-current");
      if (candidateEligible) {
        knownTaskIds.add(row.id);
        taskUpdatedAtById.set(row.id, row.updated_at ?? "");
      }
      if (row.updated_at && row.updated_at > newestUpdate) newestUpdate = row.updated_at;
      lines.push(
        `- [${bucket}] id=${row.id} "${title}"` +
          ` priority=${row.priority ?? "medium"}` +
          ` project=${compactLine(row.project, 120) || "Atlas"}` +
          (candidateEligible ? " candidate_ok" : "") +
          (row.due_at ? ` due=${row.due_at}` : "") +
          (row.updated_at ? ` updated=${row.updated_at}` : "") +
          (row.description ? ` :: ${compactLine(row.description, 240)}` : ""),
      );
      if (tags.includes("email-current")) {
        emailBrief = {
          ...emailBrief,
          content: `${title}\n${compactLine(row.description, 2400)}`,
          asOf: row.updated_at,
        };
      }
    }
    sources.push({
      id: "task_snapshot",
      label: "OPEN_TASKS",
      required: true,
      maxChars: 14_000,
      priority: 6,
      content: lines.length > 0 ? lines.join("\n") : "The task board has no open Today, In-Flight, or Not Started work.",
      asOf: newestUpdate || undefined,
      // A board untouched for three days is a signal worth surfacing.
      freshnessThresholdHours: staleThresholdHours("task_snapshot", 72),
    });
  } catch (error) {
    sources.push({
      id: "completed_recently",
      label: "COMPLETED_RECENTLY",
      required: false,
      maxChars: 3000,
      priority: 6,
      note: error instanceof Error ? error.message.slice(0, 200) : "completed_recently_failed",
    });
    sources.push({
      id: "task_snapshot",
      label: "OPEN_TASKS",
      required: true,
      maxChars: 14_000,
      priority: 6,
      note: error instanceof Error ? error.message.slice(0, 200) : "task_snapshot_failed",
    });
  }

  sources.push((await calendarPromise).source);

  // Settlement summary: the local store is authoritative when it holds
  // snapshots. An empty local state (the Mini, whose DB no longer syncs) is
  // never treated as "no settlements"; it falls back to the relay file the MBP
  // publishes, whose as_of drives the same staleness threshold. Newest valid
  // source wins. If neither is available, state that truth explicitly so a
  // first-ever brief does not require a closeout that could not exist yet.
  const settlementThreshold = staleThresholdHours("settlement_summary", 96);
  let settlementContent: string | undefined;
  let settlementAsOf: string | undefined;
  try {
    const snapshots = options.store.listRecentSnapshots(7);
    if (snapshots.length > 0) {
      const summary = buildSettlementSummary(snapshots);
      settlementContent = summary.content;
      settlementAsOf = summary.asOf;
    }
  } catch {
    // Fall through to the relay fallback below.
  }
  const relaySettlement = readSettlementRelay({ dataDir: options.dataDir });
  if (relaySettlement) {
    // Newest valid wins, compared as parsed epochs (never as strings): prefer
    // whichever source has the later as_of; an unparseable local as_of loses.
    const relayMs = Date.parse(relaySettlement.asOf);
    const localMs = settlementContent && settlementAsOf ? Date.parse(settlementAsOf) : NaN;
    if (!settlementContent || !Number.isFinite(localMs) || relayMs > localMs) {
      settlementContent = relaySettlement.content;
      settlementAsOf = relaySettlement.asOf;
    }
  }
  sources.push(
    settlementContent
      ? {
          id: "settlement_summary",
          label: "RECENT_SETTLEMENTS",
          required: true,
          maxChars: 6000,
          priority: 8,
          content: settlementContent,
          asOf: settlementAsOf,
          freshnessThresholdHours: settlementThreshold,
        }
      : {
          id: "settlement_summary",
          label: "RECENT_SETTLEMENTS",
          required: true,
          maxChars: 6000,
          priority: 8,
          content: buildSettlementSummary([]).content,
        },
  );

  sources.push(emailBrief);
  sources.push(await crmPromise);
  sources.push(await memoryPromise);

  return { sources, knownTaskIds, taskUpdatedAtById, recurringTaskIds };
}
