import { sourceRecord, sourceVersion, activeResponsibilitySource } from "../responsibility/store";
import {
  collectPlanningContext,
  rememberCalendarOccurrences,
} from "../chief-of-staff/daily-planning";
import {
  acceptPlanningProposal,
  persistDecisionLinks,
  resolvePlanningItems,
  projectPlanningBrief,
} from "./planning";
/**
 * Durable state machine for Cove's daily ritual.
 *
 * This module owns plan creation, Morning Arrival, starting the day, closing
 * the day, snapshots, execution state, and repair. Callers should use its
 * versioned mutations rather than composing table writes. The transaction and
 * event ledger are part of the product contract: browser optimism, model
 * output, and stale workers never outrank the newest durable plan version.
 *
 * Keep pure selection and display rules in sibling modules when possible. The
 * state transitions stay together here because they share invariants across
 * plan rows, items, events, task mutations, and receipts.
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { resolveProjectDirectory } from "../atlas-projects";
import { normalizeBuddyReceipts } from "../buddy/receipts";
import { morningBriefModelConfig } from "../claude-execution/brief-commands";
import { hasPlanExecutionResultSubstance } from "../claude-execution/commands";
import { localDatabasePath, openSqliteDatabase } from "../local/database";
import { getRuntimeMode } from "../runtime/mode";
import { operatorTimezone } from "../operator";
import { recordFailureInDatabase } from "../reliability/failures";
import { recordReceiptInDatabase } from "../reliability/receipts";
import { taskColumnKeyForName } from "../tasks/columns";
import { syncRecurringOccurrenceForTask } from "../tasks/recurrence";
import { originDate, originQuote } from "../tasks/origin";
import { DEFAULT_TASK_SETTINGS, readTaskSettings } from "../tasks/settings";
import {
  applyLocalMigration,
  type LocalMigration,
} from "../local/migrations";
import type {
  DayPlan,
  DayPlanAssistantProposal,
  DayPlanAssistantOperation,
  DayPlanAssistantTurn,
  DayPlanAssistantTurnState,
  DayPlanEvent,
  DayPlanExecutionConfig,
  DayPlanExecutionConfigResult,
  DayPlanExecutionMode,
  DayPlanExecutionReadiness,
  DayPlanExecutionResultSummary,
  DayPlanExecutionRun,
  DayPlanExecutionWorkspaceMetadata,
  DayPlanKickoffSkip,
  DayPlanItem,
  DayPlanMutationInput,
  DayPlanMutationResult,
  EnsureDayPlanResult,
  DayPlanOwner,
  DayPlanReconciliation,
  DayPlanReconciliationResult,
  DayPlanTaskMutation,
  DayPlanTaskMutationResult,
  DayPlanReadModel,
  DayDump,
  DaySnapshot,
  DaySnapshotBody,
  DayPlanUnreadyItem,
  ConfigureDayPlanExecutionInput,
  EnsureDayPlanInput,
  KickoffDayPlanItemInput,
  KickoffDayPlanItemResult,
  RecommendationCandidate,
} from "./types";
import {
  assessDayPlanExecutionReadiness,
  dayPlanExecutionAuthorizationHash,
  dayPlanItemBriefHash,
  loadCoveExecutionEnvironment,
  selectExecutionModel,
  type CoveExecutionEnvironment,
} from "./execution-readiness";
import { applyAssistantProposal, validateAssistantProposal } from "./assistant-patch";
import { arrivalAdditionOutcomeKey } from "./arrival-addition";
import {
  isWeekendLocalDate,
  BRIEF_DEFERRED_PREFIX,
  morningBriefFromArtifact,
  morningBriefCreatedTaskId,
  morningBriefWriterFromJson,
  overlayBriefOnCandidates,
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
  type MorningBriefArtifact,
  type MorningBriefBoardAction,
  type MorningBriefSourceManifest,
  type MorningBriefStatus,
} from "./brief";
import {
  DayPlanInvalidTransition,
  DayPlanNotFound,
  DayPlanVersionConflict,
} from "./store-errors";
import {
  canStartDayPlanSettlement,
  focusBandItems,
} from "./presentation";

type Clock = () => Date;

// Mutations that count as a meaningful arrival interaction. Each durably stamps
// arrival_interacted_at, closing the late-attach window. Arrival lifecycle
// transitions (open/snooze/skip/bypass/reopen), start_day, and settlement are
// deliberately excluded.
const CONTENT_MUTATION_ACTIONS = new Set<string>([
  "item_accept",
  "item_edit",
  "item_later",
  "item_dismiss",
  "item_add",
  "item_complete",
  "item_reopen",
  "item_owner",
  "item_reorder",
]);
const OWNER_VALUES = new Set<DayPlanOwner>(["me", "claude", "together"]);

type DayPlanRow = {
  id: string;
  local_date: string;
  timezone: string;
  plan_state: DayPlan["state"];
  arrival_state: DayPlan["arrivalState"];
  settlement_state: DayPlan["settlementState"];
  version: number;
  last_mutation_id: string | null;
  items_json: string;
  brief_id: string | null;
  arrival_interacted_at: string | null;
  recommended_first_item_id: string | null;
  recommended_first_task_id: string | null;
  snoozed_until: string | null;
  next_day_note: string | null;
  confirmed_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

type SnapshotRow = {
  id: string;
  day_plan_id: string;
  local_date: string;
  timezone: string;
  version: 1;
  body_json: string;
  created_at: string;
};

type EventRow = {
  id: string;
  day_plan_id: string;
  event_type: DayPlanEvent["eventType"];
  expected_version: number | null;
  result_version: number;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
};

type ReconciliationRow = {
  id: string;
  day_plan_id: string;
  snapshot_id: string;
  task_id: string;
  action: DayPlanReconciliation["action"];
  available_at: string | null;
  state: DayPlanReconciliation["state"];
  created_at: string;
  applied_at: string | null;
};

type AssistantTurnRow = {
  id: string;
  day_plan_id: string;
  base_version: number;
  user_text: string;
  state: DayPlanAssistantTurnState;
  proposal_json: string | null;
  result_version: number | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  applied_at: string | null;
};

type TaskMutationRow = {
  id: string;
  day_plan_id: string;
  assistant_turn_id: string;
  task_id: string;
  action: DayPlanTaskMutation["action"];
  sequence: number;
  payload_json: string;
  state: DayPlanTaskMutation["state"];
  created_at: string;
  applied_at: string | null;
};

type ExecutionConfigRow = {
  day_plan_id: string;
  item_id: string;
  mode: DayPlanExecutionMode;
  model_alias: DayPlanExecutionConfig["modelAlias"];
  workspace_id: string | null;
  budget_usd: number | null;
  brief_hash: string;
  authorization_hash: string;
  last_mutation_id: string;
  configured_at: string;
  updated_at: string;
};

type MorningBriefRow = {
  id: string;
  target_local_date: string;
  status: MorningBriefStatus;
  input_hash: string | null;
  prompt_version: number;
  schema_version: number;
  source_manifest_json: string | null;
  model_alias: string;
  effort: string;
  budget_usd: number;
  brief_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type MorningBriefActionRow = {
  artifact_id: string;
  action_index: number;
  op_json: string;
  action_hash: string;
  expected_task_updated_at: string;
  state:
    | "staged"
    | "applied"
    | "skipped_conflict"
    | "skipped_offlimits"
    | "skipped_late";
  why: string;
  before_json: string | null;
  after_json: string | null;
  terminal_at: string | null;
};

type ManagedTaskRow = {
  id: string;
  column_id: string | null;
  title: string;
  description: string | null;
  priority: string | null;
  due_at: string | null;
  due_date: string | null;
  tags: string | null;
  project: string | null;
  position: number | null;
  status: string | null;
  archived_at: string | null;
  archived_from_status: string | null;
  recurring_template_id: string | null;
  occurrence_local_date: string | null;
  created_at: string | null;
  updated_at: string | null;
};

// Assistant-created tasks are normal board tasks. They no longer carry the
// inbound-event source_type or needs-triage tag used by the old post-commit writer.
function insertBackingTask(
  db: Database.Database,
  input: {
    id: string;
    title: string;
    description: string;
    priority: "low" | "medium" | "high";
    project?: string;
    // Plain-language answer to "why is this on my board?" (tasks.origin).
    origin: string;
    changedAt: string;
  },
): void {
  const todayColumn = (db.prepare(
    "SELECT id, name FROM task_columns ORDER BY position ASC",
  ).all() as Array<{ id: string; name: string }>).find(
    (column) => taskColumnKeyForName(column.name) === "today",
  );
  if (!todayColumn) {
    throw new DayPlanInvalidTransition("Cove needs a Today list to add work.");
  }
  const position = db.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE column_id = ? AND status = 'open'",
  ).pluck().get(todayColumn.id) as number;
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, due_at, due_date,
       tags, project, position, status, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]', ?, ?, 'open', ?, ?, ?)`,
  ).run(
    input.id,
    todayColumn.id,
    input.title,
    input.description,
    input.priority,
    input.project?.trim() || "Atlas",
    position,
    input.origin,
    input.changedAt,
    input.changedAt,
  );
}

// "Sep 4, 2026" for a plan's YYYY-MM-DD local date.
function planDateLabel(localDate: string): string {
  return originDate(`${localDate}T00:00:00Z`, "UTC");
}

type DayDumpRow = {
  id: string;
  target_local_date: string;
  raw_text: string;
  status: DayDump["status"];
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type SessionDigestRow = {
  id: string;
  run_at: string;
  project: string;
  summary: string;
  per_task_json: string;
  evidence_json: string;
  created_at: string;
};

type ExecutionRunRow = {
  id: string;
  day_plan_id: string;
  item_id: string;
  task_id: string;
  owner: DayPlanExecutionRun["owner"];
  mode: DayPlanExecutionMode;
  model_alias: DayPlanExecutionRun["modelAlias"];
  status: DayPlanExecutionRun["status"];
  idempotency_key: string;
  attempt: number;
  claude_session_id: string;
  brief_hash: string;
  authorization_hash: string;
  prompt_json: string;
  workspace_id: string | null;
  workspace_path: string | null;
  budget_usd: number | null;
  readiness_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  pid: number | null;
  heartbeat_at: string | null;
  log_path: string | null;
  result_summary_json: string | null;
  exit_code: number | null;
  error_code: string | null;
};

// Frozen by the migration ledger: edits affect fresh installs only; changes require a new migration.
const DAY_PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS day_plans (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL,
  open_slot INTEGER UNIQUE CHECK (open_slot IS NULL OR open_slot = 1),
  plan_state TEXT NOT NULL CHECK (plan_state IN ('draft','proposed','active','settling','settled','abandoned')),
  arrival_state TEXT NOT NULL CHECK (arrival_state IN ('not_due','due','opened','snoozed','skipped','confirmed','bypassed','failed')),
  settlement_state TEXT NOT NULL CHECK (settlement_state IN ('not_due','offered','in_progress','skipped','committed','settled')),
  version INTEGER NOT NULL CHECK (version > 0),
  last_mutation_id TEXT,
  items_json TEXT NOT NULL,
  brief_id TEXT,
  recommended_first_item_id TEXT,
  recommended_first_task_id TEXT,
  snoozed_until TEXT,
  next_day_note TEXT,
  confirmed_at TEXT,
  settled_at TEXT,
  -- Also added by an ALTER below for databases created before it existed.
  -- Declaring it here means a fresh install never runs that ALTER, so the web
  -- app and the worker starting together on first boot cannot race each other
  -- into a duplicate-column failure.
  arrival_interacted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS day_plan_events (
  id TEXT PRIMARY KEY,
  day_plan_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  expected_version INTEGER,
  result_version INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
);
CREATE INDEX IF NOT EXISTS day_plan_events_by_plan
  ON day_plan_events(day_plan_id, created_at, id);
CREATE TABLE IF NOT EXISTS day_snapshots (
  id TEXT PRIMARY KEY,
  day_plan_id TEXT NOT NULL UNIQUE,
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
);
CREATE INDEX IF NOT EXISTS day_snapshots_by_date
  ON day_snapshots(local_date DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS day_plan_reconciliations (
  id TEXT PRIMARY KEY,
  day_plan_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('defer','drop','resurface')),
  available_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','scheduled','applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (snapshot_id, task_id, action),
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id),
  FOREIGN KEY (snapshot_id) REFERENCES day_snapshots(id)
);
CREATE INDEX IF NOT EXISTS day_plan_reconciliations_pending
  ON day_plan_reconciliations(state, created_at, id);
CREATE TABLE IF NOT EXISTS day_plan_assistant_turns (
  id TEXT PRIMARY KEY,
  day_plan_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  user_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','proposed','applied','conflict','failed','cancelled')),
  proposal_json TEXT,
  result_version INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  applied_at TEXT,
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
);
CREATE INDEX IF NOT EXISTS day_plan_assistant_turns_queue
  ON day_plan_assistant_turns(state, created_at, id);
CREATE TABLE IF NOT EXISTS day_plan_task_mutations (
  id TEXT PRIMARY KEY,
  day_plan_id TEXT NOT NULL,
  assistant_turn_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','update','complete')),
  sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (assistant_turn_id, task_id, action),
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id),
  FOREIGN KEY (assistant_turn_id) REFERENCES day_plan_assistant_turns(id)
);
CREATE INDEX IF NOT EXISTS day_plan_task_mutations_pending
  ON day_plan_task_mutations(state, created_at, id);
CREATE TABLE IF NOT EXISTS day_plan_execution_configs (
  day_plan_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('plan_review','autonomous')),
  model_alias TEXT NOT NULL CHECK (model_alias IN ('sonnet','opus','fable')),
  workspace_id TEXT,
  budget_usd REAL,
  brief_hash TEXT NOT NULL,
  authorization_hash TEXT NOT NULL DEFAULT '',
  last_mutation_id TEXT NOT NULL UNIQUE,
  configured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day_plan_id, item_id),
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
);
CREATE TABLE IF NOT EXISTS day_plan_execution_runs (
  id TEXT PRIMARY KEY,
  day_plan_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('claude','together')),
  mode TEXT NOT NULL CHECK (mode IN ('plan_review','autonomous')),
  model_alias TEXT NOT NULL CHECK (model_alias IN ('sonnet','opus','fable')),
  status TEXT NOT NULL CHECK (status IN ('queued','starting','running','plan_ready','ready_to_join','awaiting_review','failed','interrupted','cancelling','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  claude_session_id TEXT NOT NULL UNIQUE,
  brief_hash TEXT NOT NULL,
  authorization_hash TEXT NOT NULL DEFAULT '',
  prompt_json TEXT NOT NULL,
  workspace_id TEXT,
  workspace_path TEXT,
  budget_usd REAL,
  readiness_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  pid INTEGER,
  heartbeat_at TEXT,
  log_path TEXT,
  result_summary_json TEXT,
  exit_code INTEGER,
  error_code TEXT,
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
);
CREATE INDEX IF NOT EXISTS day_plan_execution_runs_by_plan
  ON day_plan_execution_runs(day_plan_id, created_at, id);
CREATE INDEX IF NOT EXISTS day_plan_execution_runs_queue
  ON day_plan_execution_runs(status, created_at, id);
CREATE TABLE IF NOT EXISTS day_plan_execution_mutations (
  id TEXT PRIMARY KEY,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('configure','kickoff')),
  day_plan_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  result_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
);
CREATE TABLE IF NOT EXISTS day_plan_briefs (
  id TEXT PRIMARY KEY,
  target_local_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  input_hash TEXT,
  prompt_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  source_manifest_json TEXT,
  model_alias TEXT NOT NULL,
  effort TEXT NOT NULL,
  budget_usd REAL NOT NULL,
  brief_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (target_local_date, input_hash, prompt_version, schema_version)
);
CREATE INDEX IF NOT EXISTS day_plan_briefs_queue
  ON day_plan_briefs(status, created_at, id);
CREATE INDEX IF NOT EXISTS day_plan_briefs_by_date
  ON day_plan_briefs(target_local_date, finished_at DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS day_dumps (
  id TEXT PRIMARY KEY,
  target_local_date TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS day_dumps_queue
  ON day_dumps(status, created_at, id);
CREATE INDEX IF NOT EXISTS day_dumps_by_date
  ON day_dumps(target_local_date, created_at, id);
CREATE TABLE IF NOT EXISTS session_digests (
  id TEXT PRIMARY KEY,
  run_at TEXT NOT NULL,
  project TEXT NOT NULL,
  summary TEXT NOT NULL,
  per_task_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_digests_by_run
  ON session_digests(run_at DESC, project, id);
CREATE TABLE IF NOT EXISTS day_plan_brief_action_states (
  brief_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK (action_index >= 0),
  state TEXT NOT NULL CHECK (state IN ('approved','edited','skipped')),
  edited_text TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brief_id, action_index),
  FOREIGN KEY (brief_id) REFERENCES day_plan_briefs(id)
);
`;

const DAY_PLAN_MIGRATIONS: readonly LocalMigration[] = [
  {
    version: 100,
    name: "day-plan-baseline",
    up: (db) => db.exec(DAY_PLAN_SCHEMA),
  },
  {
    version: 101,
    name: "day-plan-execution-columns",
    up: (db) => {
      const executionRunColumns = new Set(
        (db.pragma("table_info(day_plan_execution_runs)") as Array<{ name: string;
          }>)
          .map((column) => column.name),
      );
      for (const [column, definition] of [
        ["pid", "INTEGER"],
        ["heartbeat_at", "TEXT"],
        ["log_path", "TEXT"],
        ["result_summary_json", "TEXT"],
        ["authorization_hash", "TEXT NOT NULL DEFAULT ''"],
      ] as const) {
        if (!executionRunColumns.has(column)) {
          db.exec(
            `ALTER TABLE day_plan_execution_runs ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      const executionConfigColumns = new Set(
        (db.pragma("table_info(day_plan_execution_configs)") as Array<{ name: string;
          }>)
          .map((column) => column.name),
      );
      if (!executionConfigColumns.has("authorization_hash")) {
        db.exec(
          "ALTER TABLE day_plan_execution_configs ADD COLUMN authorization_hash TEXT NOT NULL DEFAULT ''",
        );
      }
    },
  },
  {
    version: 102,
    name: "day-plan-fable-model",
    foreignKeysOff: true,
    up: (db) => {
      const executionConfigSchema = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'day_plan_execution_configs'",
      ).get() as { sql: string } | undefined;
      if (executionConfigSchema?.sql.includes("'fable'")) return;
      db.exec(`
        ALTER TABLE day_plan_execution_configs RENAME TO day_plan_execution_configs_model_legacy;
        CREATE TABLE day_plan_execution_configs (
          day_plan_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('plan_review','autonomous')),
          model_alias TEXT NOT NULL CHECK (model_alias IN ('sonnet','opus','fable')),
          workspace_id TEXT,
          budget_usd REAL,
          brief_hash TEXT NOT NULL,
          authorization_hash TEXT NOT NULL DEFAULT '',
          last_mutation_id TEXT NOT NULL UNIQUE,
          configured_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (day_plan_id, item_id),
          FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
        );
        INSERT INTO day_plan_execution_configs
          (day_plan_id, item_id, mode, model_alias, workspace_id, budget_usd,
           brief_hash, authorization_hash, last_mutation_id, configured_at, updated_at)
        SELECT day_plan_id, item_id, mode, model_alias, workspace_id, budget_usd,
               brief_hash, authorization_hash, last_mutation_id, configured_at, updated_at
        FROM day_plan_execution_configs_model_legacy;
        DROP TABLE day_plan_execution_configs_model_legacy;

        ALTER TABLE day_plan_execution_runs RENAME TO day_plan_execution_runs_model_legacy;
        CREATE TABLE day_plan_execution_runs (
          id TEXT PRIMARY KEY,
          day_plan_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          owner TEXT NOT NULL CHECK (owner IN ('claude','together')),
          mode TEXT NOT NULL CHECK (mode IN ('plan_review','autonomous')),
          model_alias TEXT NOT NULL CHECK (model_alias IN ('sonnet','opus','fable')),
          status TEXT NOT NULL CHECK (status IN ('queued','starting','running','plan_ready','ready_to_join','awaiting_review','failed','interrupted','cancelling','cancelled')),
          idempotency_key TEXT NOT NULL UNIQUE,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          claude_session_id TEXT NOT NULL UNIQUE,
          brief_hash TEXT NOT NULL,
          authorization_hash TEXT NOT NULL DEFAULT '',
          prompt_json TEXT NOT NULL,
          workspace_id TEXT,
          workspace_path TEXT,
          budget_usd REAL,
          readiness_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          pid INTEGER,
          heartbeat_at TEXT,
          log_path TEXT,
          result_summary_json TEXT,
          exit_code INTEGER,
          error_code TEXT,
          FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
        );
        INSERT INTO day_plan_execution_runs
          (id, day_plan_id, item_id, task_id, owner, mode, model_alias, status,
           idempotency_key, attempt, claude_session_id, brief_hash, authorization_hash,
           prompt_json, workspace_id, workspace_path, budget_usd, readiness_json,
           created_at, updated_at, started_at, finished_at, pid, heartbeat_at, log_path,
           result_summary_json, exit_code, error_code)
        SELECT id, day_plan_id, item_id, task_id, owner, mode, model_alias, status,
               idempotency_key, attempt, claude_session_id, brief_hash, authorization_hash,
               prompt_json, workspace_id, workspace_path, budget_usd, readiness_json,
               created_at, updated_at, started_at, finished_at, pid, heartbeat_at, log_path,
               result_summary_json, exit_code, error_code
        FROM day_plan_execution_runs_model_legacy;
        DROP TABLE day_plan_execution_runs_model_legacy;
        CREATE INDEX day_plan_execution_runs_by_plan
          ON day_plan_execution_runs(day_plan_id, created_at, id);
        CREATE INDEX day_plan_execution_runs_queue
          ON day_plan_execution_runs(status, created_at, id);
      `);
    },
  },
  {
    version: 103,
    name: "day-plan-late-columns",
    up: (db) => {
      const taskMutationColumns = new Set(
        (db.pragma("table_info(day_plan_task_mutations)") as Array<{ name: string;
          }>)
          .map((column) => column.name),
      );
      if (!taskMutationColumns.has("sequence")) {
        db.exec(
          "ALTER TABLE day_plan_task_mutations ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0",
        );
      }
      const dayPlanColumns = new Set(
        (db.pragma("table_info(day_plans)") as Array<{ name: string }>)
          .map((column) => column.name),
      );
      if (!dayPlanColumns.has("brief_id")) {
        db.exec("ALTER TABLE day_plans ADD COLUMN brief_id TEXT");
      }
      if (!dayPlanColumns.has("arrival_interacted_at")) {
        db.exec("ALTER TABLE day_plans ADD COLUMN arrival_interacted_at TEXT");
      }
    },
  },
  {
    version: 104,
    name: "day-plan-canonical-schema",
    foreignKeysOff: true,
    legacyAlterTable: true,
    up: (db) => {
      const dayPlanColumns = db.pragma(
        "table_info(day_plans)",
      ) as Array<{ name: string;
      }>;
      const canonicalDayPlanColumns = [
        "id", "local_date", "timezone", "open_slot", "plan_state",
        "arrival_state", "settlement_state", "version", "last_mutation_id",
        "items_json", "brief_id", "recommended_first_item_id",
        "recommended_first_task_id", "snoozed_until", "next_day_note",
        "confirmed_at", "settled_at", "arrival_interacted_at", "created_at",
        "updated_at",
      ];
      if (
        dayPlanColumns.map((column) => column.name).join(",") !==
        canonicalDayPlanColumns.join(",")
      ) {
        db.exec(`
          ALTER TABLE day_plans RENAME TO day_plans_migration_legacy;
          CREATE TABLE day_plans (
            id TEXT PRIMARY KEY,
            local_date TEXT NOT NULL UNIQUE,
            timezone TEXT NOT NULL,
            open_slot INTEGER UNIQUE CHECK (open_slot IS NULL OR open_slot = 1),
            plan_state TEXT NOT NULL CHECK (plan_state IN ('draft','proposed','active','settling','settled','abandoned')),
            arrival_state TEXT NOT NULL CHECK (arrival_state IN ('not_due','due','opened','snoozed','skipped','confirmed','bypassed','failed')),
            settlement_state TEXT NOT NULL CHECK (settlement_state IN ('not_due','offered','in_progress','skipped','committed','settled')),
            version INTEGER NOT NULL CHECK (version > 0),
            last_mutation_id TEXT,
            items_json TEXT NOT NULL,
            brief_id TEXT,
            recommended_first_item_id TEXT,
            recommended_first_task_id TEXT,
            snoozed_until TEXT,
            next_day_note TEXT,
            confirmed_at TEXT,
            settled_at TEXT,
            arrival_interacted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO day_plans
            (id, local_date, timezone, open_slot, plan_state, arrival_state,
             settlement_state, version, last_mutation_id, items_json, brief_id,
             recommended_first_item_id, recommended_first_task_id,
             snoozed_until, next_day_note, confirmed_at, settled_at,
             arrival_interacted_at, created_at, updated_at)
          SELECT
            id, local_date, timezone, open_slot, plan_state, arrival_state,
            settlement_state, version, last_mutation_id, items_json, brief_id,
            recommended_first_item_id, recommended_first_task_id,
            snoozed_until, next_day_note, confirmed_at, settled_at,
            arrival_interacted_at, created_at, updated_at
          FROM day_plans_migration_legacy;
          DROP TABLE day_plans_migration_legacy;
        `);
      }

      const mutationColumns = db.pragma(
        "table_info(day_plan_task_mutations)",
      ) as Array<{ name: string; dflt_value: string | null }>;
      const canonicalMutationColumns = [
        "id", "day_plan_id", "assistant_turn_id", "task_id", "action",
        "sequence", "payload_json", "state", "created_at", "applied_at",
      ];
      const sequence = mutationColumns.find((column) => column.name === "sequence");
      if (
        mutationColumns.map((column) => column.name).join(",") !==
          canonicalMutationColumns.join(",") ||
        sequence?.dflt_value !== null
      ) {
        db.exec(`
          ALTER TABLE day_plan_task_mutations
            RENAME TO day_plan_task_mutations_migration_legacy;
          CREATE TABLE day_plan_task_mutations (
            id TEXT PRIMARY KEY,
            day_plan_id TEXT NOT NULL,
            assistant_turn_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('create','update','complete')),
            sequence INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending','applied')),
            created_at TEXT NOT NULL,
            applied_at TEXT,
            UNIQUE (assistant_turn_id, task_id, action),
            FOREIGN KEY (day_plan_id) REFERENCES day_plans(id),
            FOREIGN KEY (assistant_turn_id) REFERENCES day_plan_assistant_turns(id)
          );
          INSERT INTO day_plan_task_mutations
            (id, day_plan_id, assistant_turn_id, task_id, action, sequence,
             payload_json, state, created_at, applied_at)
          SELECT
            id, day_plan_id, assistant_turn_id, task_id, action, sequence,
            payload_json, state, created_at, applied_at
          FROM day_plan_task_mutations_migration_legacy;
          DROP TABLE day_plan_task_mutations_migration_legacy;
          CREATE INDEX day_plan_task_mutations_pending
            ON day_plan_task_mutations(state, created_at, id);
        `);
      }
    },
  },
  {
    version: 105,
    name: "day-plan-weekend-auto-settle-receipts",
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS cove_receipts (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        actions_json TEXT NOT NULL DEFAULT '{}',
        retry_count INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('success','partial','failed','skipped')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cove_receipts_recent_idx
        ON cove_receipts(finished_at DESC);
      CREATE INDEX IF NOT EXISTS cove_receipts_source_idx
        ON cove_receipts(source, finished_at DESC);
    `),
  },
  {
    version: 106,
    name: "day-plan-brief-board-actions",
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS day_plan_brief_actions (
        artifact_id TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0),
        op_json TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        expected_task_updated_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'staged'
          CHECK (state IN ('staged','applied','skipped_conflict','skipped_offlimits')),
        why TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        terminal_at TEXT,
        UNIQUE (artifact_id, action_index),
        FOREIGN KEY (artifact_id) REFERENCES day_plan_briefs(id)
      );
      CREATE INDEX IF NOT EXISTS day_plan_brief_actions_staged
        ON day_plan_brief_actions(state, artifact_id, action_index);
    `),
  },
  {
    version: 107,
    name: "day-plan-brief-board-actions-skipped-late",
    foreignKeysOff: true,
    up: (db) => {
      const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'day_plan_brief_actions'",
      ).get() as { sql: string } | undefined;
      if (!table || table.sql.includes("'skipped_late'")) return;
      db.exec(`
        ALTER TABLE day_plan_brief_actions
          RENAME TO day_plan_brief_actions_migration_legacy;
        CREATE TABLE day_plan_brief_actions (
          artifact_id TEXT NOT NULL,
          action_index INTEGER NOT NULL CHECK (action_index >= 0),
          op_json TEXT NOT NULL,
          action_hash TEXT NOT NULL,
          expected_task_updated_at TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'staged'
            CHECK (state IN ('staged','applied','skipped_conflict','skipped_offlimits','skipped_late')),
          why TEXT NOT NULL,
          before_json TEXT,
          after_json TEXT,
          terminal_at TEXT,
          UNIQUE (artifact_id, action_index),
          FOREIGN KEY (artifact_id) REFERENCES day_plan_briefs(id)
        );
        INSERT INTO day_plan_brief_actions
          (artifact_id, action_index, op_json, action_hash,
           expected_task_updated_at, state, why, before_json, after_json, terminal_at)
        SELECT artifact_id, action_index, op_json, action_hash,
               expected_task_updated_at, state, why, before_json, after_json, terminal_at
        FROM day_plan_brief_actions_migration_legacy;
        DROP TABLE day_plan_brief_actions_migration_legacy;
        CREATE INDEX day_plan_brief_actions_staged
          ON day_plan_brief_actions(state, artifact_id, action_index);
      `);
    },
  },
  {
    version: 108,
    name: "bounded-planning-retry",
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS day_plan_planning_retries (
      parent_id TEXT PRIMARY KEY, child_id TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL
    )`),
  },
  {
    version: 109,
    name: "block-unguarded-assistant-task-mutations",
    foreignKeysOff: true,
    up: (db) => {
      // The old browser queue did not save the source version it was approved
      // against. Preserve its work for review instead of replaying stale writes.
      db.exec(`
        ALTER TABLE day_plan_task_mutations RENAME TO day_plan_task_mutations_legacy_queue;
        CREATE TABLE day_plan_task_mutations (
          id TEXT PRIMARY KEY, day_plan_id TEXT NOT NULL,
          assistant_turn_id TEXT NOT NULL, task_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('create','update','complete')),
          sequence INTEGER NOT NULL, payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','applied','blocked')),
          created_at TEXT NOT NULL, applied_at TEXT,
          UNIQUE (assistant_turn_id, task_id, action),
          FOREIGN KEY (day_plan_id) REFERENCES day_plans(id),
          FOREIGN KEY (assistant_turn_id) REFERENCES day_plan_assistant_turns(id)
        );
        INSERT INTO day_plan_task_mutations
          SELECT id, day_plan_id, assistant_turn_id, task_id, action, sequence,
                 payload_json, CASE state WHEN 'pending' THEN 'blocked' ELSE state END,
                 created_at, applied_at
          FROM day_plan_task_mutations_legacy_queue;
        DROP TABLE day_plan_task_mutations_legacy_queue;
        CREATE INDEX day_plan_task_mutations_pending ON day_plan_task_mutations(state, created_at, id);
        CREATE TABLE IF NOT EXISTS cove_failure_inbox (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
          message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
          occurred_at TEXT NOT NULL, dismissed_at TEXT, created_at TEXT NOT NULL,
          UNIQUE (source, source_id)
        );
        CREATE INDEX IF NOT EXISTS cove_failure_inbox_open_idx
          ON cove_failure_inbox(dismissed_at, occurred_at DESC);
      `);
      const blocked = db.prepare("SELECT id, task_id, day_plan_id, action FROM day_plan_task_mutations WHERE state = 'blocked'")
        .all() as Array<{id: string; task_id: string; day_plan_id: string; action: string}>;
      for (const row of blocked) recordFailureInDatabase(db, {
        source: "day-plan-task-mutation", sourceId: row.id,
        message: "An earlier Buddy task change needs review. Open the task and ask Buddy to apply the change again if it is still needed.",
        details: { taskId: row.task_id, dayPlanId: row.day_plan_id, action: row.action, reason: "missing_original_source_version" },
      });
    },
  },
];

export { DayPlanInvalidTransition, DayPlanNotFound, DayPlanVersionConflict };

function parseJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored ${name} is not valid JSON.`);
  }
}

export type SessionDigestTaskProgress = {
  task_id: string;
  progress: "none" | "some" | "likely_done";
  evidence_quote: string;
  note: string;
  scope_changed: boolean;
  suggested_reshape?: string;
};

export type SessionDigest = {
  id: string;
  runAt: string;
  project: string;
  summary: string;
  perTask: SessionDigestTaskProgress[];
  evidence: Record<string, unknown>;
  createdAt: string;
};

function sessionDigestFromRow(row: SessionDigestRow): SessionDigest {
  return {
    id: row.id,
    runAt: row.run_at,
    project: row.project,
    summary: row.summary,
    perTask: parseJson<SessionDigestTaskProgress[]>(
      row.per_task_json,
      "session digest task progress",
    ),
    evidence: parseJson<Record<string, unknown>>(
      row.evidence_json,
      "session digest evidence",
    ),
    createdAt: row.created_at,
  };
}

function planFromRow(row: DayPlanRow): DayPlan {
  return {
    id: row.id,
    localDate: row.local_date,
    timezone: row.timezone,
    state: row.plan_state,
    arrivalState: row.arrival_state,
    settlementState: row.settlement_state,
    version: row.version,
    lastMutationId: row.last_mutation_id ?? undefined,
    items: parseJson<DayPlanItem[]>(row.items_json, "day plan items"),
    briefId: row.brief_id ?? undefined,
    arrivalInteractedAt: row.arrival_interacted_at ?? undefined,
    recommendedFirstItemId: row.recommended_first_item_id ?? undefined,
    recommendedFirstTaskId: row.recommended_first_task_id ?? undefined,
    snoozedUntil: row.snoozed_until ?? undefined,
    nextDayNote: row.next_day_note ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    settledAt: row.settled_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotFromRow(row: SnapshotRow): DaySnapshot {
  return {
    id: row.id,
    dayPlanId: row.day_plan_id,
    localDate: row.local_date,
    timezone: row.timezone,
    version: 1,
    body: parseJson<DaySnapshotBody>(row.body_json, "day snapshot"),
    createdAt: row.created_at,
  };
}

function eventFromRow(row: EventRow): DayPlanEvent {
  return {
    id: row.id,
    dayPlanId: row.day_plan_id,
    eventType: row.event_type,
    expectedVersion: row.expected_version ?? undefined,
    resultVersion: row.result_version,
    before: row.before_json ? parseJson<unknown>(row.before_json, "event before") : undefined,
    after: row.after_json ? parseJson<unknown>(row.after_json, "event after") : undefined,
    createdAt: row.created_at,
  };
}

function reconciliationFromRow(row: ReconciliationRow): DayPlanReconciliation {
  return {
    id: row.id,
    dayPlanId: row.day_plan_id,
    snapshotId: row.snapshot_id,
    taskId: row.task_id,
    action: row.action,
    availableAt: row.available_at ?? undefined,
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

function assistantTurnFromRow(row: AssistantTurnRow): DayPlanAssistantTurn {
  return {
    id: row.id,
    dayPlanId: row.day_plan_id,
    baseVersion: row.base_version,
    userText: row.user_text,
    state: row.state,
    proposal: row.proposal_json
      ? parseJson<DayPlanAssistantProposal>(row.proposal_json, "assistant proposal")
      : undefined,
    resultVersion: row.result_version ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    appliedAt: row.applied_at ?? undefined,
  };
}

function taskMutationFromRow(row: TaskMutationRow): DayPlanTaskMutation {
  return {
    id: row.id,
    dayPlanId: row.day_plan_id,
    assistantTurnId: row.assistant_turn_id,
    taskId: row.task_id,
    action: row.action,
    ...parseJson<Omit<DayPlanTaskMutation,
        | "id" | "dayPlanId" | "assistantTurnId" | "taskId" | "action" | "state" | "createdAt" | "appliedAt">>(row.payload_json, "task mutation payload"),
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

function executionConfigFromRow(row: ExecutionConfigRow): DayPlanExecutionConfig {
  return {
    dayPlanId: row.day_plan_id,
    itemId: row.item_id,
    mode: row.mode,
    modelAlias: row.model_alias,
    workspaceId: row.workspace_id ?? undefined,
    budgetUsd: row.budget_usd ?? undefined,
    briefHash: row.brief_hash,
    authorizationHash: row.authorization_hash,
    lastMutationId: row.last_mutation_id,
    configuredAt: row.configured_at,
    updatedAt: row.updated_at,
  };
}

function morningBriefFromRow(row: MorningBriefRow): MorningBriefArtifact {
  return {
    id: row.id,
    targetLocalDate: row.target_local_date,
    status: row.status,
    inputHash: row.input_hash ?? undefined,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    sourceManifest: row.source_manifest_json
      ? parseJson<MorningBriefSourceManifest>(row.source_manifest_json, "brief manifest")
      : undefined,
    modelAlias: row.model_alias,
    effort: row.effort,
    budgetUsd: row.budget_usd,
    writer: morningBriefWriterFromJson(row.brief_json ?? undefined),
    briefJson: row.brief_json ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function dayDumpFromRow(row: DayDumpRow): DayDump {
  return {
    id: row.id,
    targetLocalDate: row.target_local_date,
    rawText: row.raw_text,
    status: row.status,
    resultJson: row.result_json ?? undefined,
    errorCode: row.error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function executionRunFromRow(row: ExecutionRunRow): DayPlanExecutionRun {
  return {
    id: row.id,
    dayPlanId: row.day_plan_id,
    itemId: row.item_id,
    taskId: row.task_id,
    owner: row.owner,
    mode: row.mode,
    modelAlias: row.model_alias,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    claudeSessionId: row.claude_session_id,
    briefHash: row.brief_hash,
    authorizationHash: row.authorization_hash,
    promptSnapshot: parseJson<DayPlanExecutionRun["promptSnapshot"]>(
      row.prompt_json,
      "execution prompt",
    ),
    workspaceId: row.workspace_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    budgetUsd: row.budget_usd ?? undefined,
    readiness: parseJson<DayPlanExecutionReadiness>(row.readiness_json, "execution readiness"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    pid: row.pid ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    resultSummary: row.result_summary_json
      ? parseJson<DayPlanExecutionResultSummary>(row.result_summary_json, "execution result summary")
      : undefined,
    exitCode: row.exit_code ?? undefined,
    errorCode: row.error_code ?? undefined,
  };
}

function clonePlan(plan: DayPlan): DayPlan {
  return structuredClone(plan);
}

function requireItem(plan: DayPlan, itemId?: string): DayPlanItem {
  const item = itemId ? plan.items.find((candidate) => candidate.id === itemId) : undefined;
  if (!item) throw new DayPlanInvalidTransition("Day plan item not found.");
  return item;
}

function requireArrivalEditing(plan: DayPlan): void {
  if (!["proposed", "active"].includes(plan.state) || plan.arrivalState !== "opened") {
    throw new DayPlanInvalidTransition("Arrival items can change only while arrival is open.");
  }
}

function requirePlanOrdering(plan: DayPlan): void {
  if (
    (plan.state === "proposed" && plan.arrivalState === "opened") ||
    plan.state === "active"
  ) return;
  throw new DayPlanInvalidTransition(
    "Today items can change only while arrival is open or the day is active.",
  );
}

function requireItemCompletionEditing(plan: DayPlan): void {
  if (
    (plan.state === "proposed" && plan.arrivalState === "opened") ||
    plan.state === "active" ||
    (plan.state === "settling" && plan.settlementState === "in_progress")
  ) return;
  throw new DayPlanInvalidTransition(
    "Today items can be completed or reopened only while arrival is open, the day is active, or settlement is in progress.",
  );
}

function activatePlanWithoutKickoff(
  plan: DayPlan,
  mutationId: string,
  changedAt: string,
  includePending: boolean,
): DayPlanItem[] {
  const accepted = [...plan.items]
    .filter(
      (item) =>
        item.commitment !== "pencil" &&
        (item.decision === "accepted" ||
        item.decision === "preselected" ||
        (includePending && item.decision === "pending")),
    )
    .sort((left, right) => left.position - right.position);
  for (const item of accepted) {
    item.decision = "accepted";
    item.humanDecisionEventIds = [
      ...new Set([...item.humanDecisionEventIds, mutationId]),
    ];
  }
  const firstHuman = accepted.find(
    (item) => item.owner === "me" || item.owner === "together",
  );
  const first = firstHuman ?? accepted[0];
  plan.state = "active";
  plan.recommendedFirstItemId = first?.id;
  plan.recommendedFirstTaskId = first?.taskId;
  plan.confirmedAt = changedAt;
  return accepted;
}

function isWeekendAutoSettleMutation(mutationId: string): boolean {
  return mutationId.startsWith("weekend-auto-settle:");
}

function requireAssistantEditing(
  plan: DayPlan,
  hasMiddayReplanProof: boolean,
): void {
  if (plan.state === "proposed" && plan.arrivalState === "opened") return;
  if (
    plan.state === "active" &&
    getRuntimeMode() === "local" &&
    hasMiddayReplanProof
  ) return;
  throw new DayPlanInvalidTransition(
    "Arrival items can change only while arrival is open.",
  );
}

function requireState<T extends string>(current: T, allowed: readonly T[], message: string): void {
  if (!allowed.includes(current)) throw new DayPlanInvalidTransition(message);
}

function cleanOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function localDateInTimezone(value: string, timezone: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : undefined;
}

export type DayPlanStore = ReturnType<typeof createDayPlanStore>;

// What this machine knows about whether a workday is still open here.
export type DayClosureFacts = {
  openLocalDate: string | null;
  latestLocalDate: string | null;
};

export function createDayPlanStore(options: {
  dbPath: string;
  now?: Clock;
  executionEnvironment?:
    | CoveExecutionEnvironment | (() => CoveExecutionEnvironment);
  resolveProjectDirectory?: (hint: string) => string | null;
  focusCount?: number | (() => number);
}) {
  const db = openSqliteDatabase(options.dbPath);
  const now = options.now ?? (() => new Date());
  const executionEnvironment = () =>
    typeof options.executionEnvironment === "function"
      ? options.executionEnvironment()
      : (options.executionEnvironment ?? loadCoveExecutionEnvironment());
  const projectDirectoryResolver = options.resolveProjectDirectory ?? resolveProjectDirectory;
  const configuredFocusCount = () => {
    const value = typeof options.focusCount === "function"
      ? options.focusCount()
      : (options.focusCount ?? 3);
    return Math.max(1, Math.min(3, value));
  };
  db.pragma("foreign_keys = ON");
  for (const migration of DAY_PLAN_MIGRATIONS) {
    applyLocalMigration(db, migration, now);
  }
  const selectPlan = db.prepare("SELECT * FROM day_plans WHERE id = ?");
  const selectOpenPlan = db.prepare("SELECT * FROM day_plans WHERE open_slot = 1 LIMIT 1");
  const selectNewestPlanDate = db.prepare(
    "SELECT local_date FROM day_plans ORDER BY local_date DESC LIMIT 1",
  );
  const selectDatePlan = db.prepare("SELECT * FROM day_plans WHERE local_date = ? LIMIT 1");
  const selectEvent = db.prepare("SELECT * FROM day_plan_events WHERE id = ?");
  const selectSnapshot = db.prepare("SELECT * FROM day_snapshots WHERE day_plan_id = ?");
  const selectLatestSnapshot = db.prepare(
    "SELECT * FROM day_snapshots ORDER BY local_date DESC, created_at DESC LIMIT 1",
  );
  const selectReconciliation = db.prepare(
    "SELECT * FROM day_plan_reconciliations WHERE id = ?",
  );
  const selectPendingReconciliations = db.prepare(
    `SELECT * FROM day_plan_reconciliations
     WHERE state = 'pending' OR (state = 'scheduled' AND available_at <= ?)
     ORDER BY CASE state WHEN 'pending' THEN 0 ELSE 1 END, created_at, id`,
  );
  const selectAssistantTurn = db.prepare(
    "SELECT * FROM day_plan_assistant_turns WHERE id = ?",
  );
  const selectTaskMutation = db.prepare("SELECT * FROM day_plan_task_mutations WHERE id = ?");
  const selectPendingTaskMutations = db.prepare(
    "SELECT * FROM day_plan_task_mutations WHERE state = 'pending' ORDER BY created_at, sequence, id",
  );
  const selectExecutionConfig = db.prepare(
    "SELECT * FROM day_plan_execution_configs WHERE day_plan_id = ? AND item_id = ?",
  );
  const selectExecutionRun = db.prepare(
    "SELECT * FROM day_plan_execution_runs WHERE id = ?",
  );
  const selectNextExecutionRun = db.prepare(
    `SELECT * FROM day_plan_execution_runs
     WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`,
  );
  const selectExecutionRunsByPlan = db.prepare(
    "SELECT * FROM day_plan_execution_runs WHERE day_plan_id = ? ORDER BY created_at, id",
  );
  const selectExecutionMutation = db.prepare(
    "SELECT * FROM day_plan_execution_mutations WHERE id = ?",
  );
  const upsertSessionDigest = db.prepare(`
    INSERT INTO session_digests
      (id, run_at, project, summary, per_task_json, evidence_json, created_at)
    VALUES
      (@id, @run_at, @project, @summary, @per_task_json, @evidence_json, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      run_at = excluded.run_at,
      project = excluded.project,
      summary = excluded.summary,
      per_task_json = excluded.per_task_json,
      evidence_json = excluded.evidence_json
  `);

  function immediate<T>(work: () => T): T {
    if (db.inTransaction) return db.transaction(work)();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  function getPlan(id: string): DayPlan | undefined {
    const row = selectPlan.get(id) as DayPlanRow | undefined;
    return row ? planFromRow(row) : undefined;
  }

  function getPlanForDate(localDate: string): DayPlan | undefined {
    const row = selectDatePlan.get(localDate) as DayPlanRow | undefined;
    return row ? planFromRow(row) : undefined;
  }

  function recordSessionDigest(
    input: Omit<SessionDigest, "createdAt">,
  ): SessionDigest {
    const createdAt = now().toISOString();
    upsertSessionDigest.run({
      id: input.id,
      run_at: input.runAt,
      project: input.project,
      summary: input.summary,
      per_task_json: JSON.stringify(input.perTask),
      evidence_json: JSON.stringify(input.evidence),
      created_at: createdAt,
    });
    db.prepare(
      `DELETE FROM session_digests
       WHERE project = ?
         AND id NOT IN (
           SELECT id FROM session_digests
           WHERE project = ?
           ORDER BY run_at DESC, created_at DESC, id DESC
           LIMIT 20
         )`,
    ).run(input.project, input.project);
    const row = db.prepare("SELECT * FROM session_digests WHERE id = ?")
      .get(input.id) as SessionDigestRow;
    return sessionDigestFromRow(row);
  }

  function listSessionDigests(input: {
    project?: string;
    since?: string;
    until?: string;
    limit?: number;
  } = {}): SessionDigest[] {
    const conditions: string[] = [];
    const parameters: Record<string, string | number> = {};
    if (input.project) {
      conditions.push("project = @project");
      parameters.project = input.project;
    }
    if (input.since) {
      conditions.push("run_at >= @since");
      parameters.since = input.since;
    }
    if (input.until) {
      conditions.push("run_at < @until");
      parameters.until = input.until;
    }
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    parameters.limit = limit;
    const rows = db.prepare(
      `SELECT * FROM session_digests${
        conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""
      } ORDER BY run_at DESC, project, id LIMIT @limit`,
    ).all(parameters) as SessionDigestRow[];
    return rows.map(sessionDigestFromRow);
  }


  // The two facts a peer machine needs to know whether a day is still open here.
  // openLocalDate is the single unsettled plan (open_slot is UNIQUE, so there is
  // never more than one); latestLocalDate lets a reader tell a current store from
  // a stale one before trusting either answer.
  function dayClosureFacts(): DayClosureFacts {
    const open = selectOpenPlan.get() as DayPlanRow | undefined;
    const newest = selectNewestPlanDate.get() as
      | { local_date: string } | undefined;
    return {
      openLocalDate: open?.local_date ?? null,
      latestLocalDate: newest?.local_date ?? null,
    };
  }

  function getSnapshot(planId: string): DaySnapshot | undefined {
    const row = selectSnapshot.get(planId) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : undefined;
  }

  function listPendingReconciliations(): DayPlanReconciliation[] {
    return (selectPendingReconciliations.all(now().toISOString()) as ReconciliationRow[]).map(
      reconciliationFromRow,
    );
  }

  function listPendingTaskMutations(): DayPlanTaskMutation[] {
    return (selectPendingTaskMutations.all() as TaskMutationRow[]).map(taskMutationFromRow);
  }

  function appendEvent(input: {
    id: string;
    planId: string;
    eventType: DayPlanEvent["eventType"];
    expectedVersion?: number;
    resultVersion: number;
    before?: unknown;
    after?: unknown;
    createdAt: string;
  }): void {
    db.prepare(
      `INSERT INTO day_plan_events
        (id, day_plan_id, event_type, expected_version, result_version, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.planId,
      input.eventType,
      input.expectedVersion ?? null,
      input.resultVersion,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.createdAt,
    );
  }

  function persistPlan(plan: DayPlan): void {
    db.prepare(
      `UPDATE day_plans SET
        timezone = ?, open_slot = ?, plan_state = ?, arrival_state = ?, settlement_state = ?,
        version = ?, last_mutation_id = ?, items_json = ?, brief_id = ?, arrival_interacted_at = ?,
        recommended_first_item_id = ?,
        recommended_first_task_id = ?, snoozed_until = ?, next_day_note = ?, confirmed_at = ?,
        settled_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      plan.timezone,
      plan.state === "settled" || plan.state === "abandoned" ? null : 1,
      plan.state,
      plan.arrivalState,
      plan.settlementState,
      plan.version,
      plan.lastMutationId ?? null,
      JSON.stringify(plan.items),
      plan.briefId ?? null,
      plan.arrivalInteractedAt ?? null,
      plan.recommendedFirstItemId ?? null,
      plan.recommendedFirstTaskId ?? null,
      plan.snoozedUntil ?? null,
      plan.nextDayNote ?? null,
      plan.confirmedAt ?? null,
      plan.settledAt ?? null,
      plan.updatedAt,
      plan.id,
    );
  }

  function getAssistantTurn(id: string): DayPlanAssistantTurn | undefined {
    const row = selectAssistantTurn.get(id) as AssistantTurnRow | undefined;
    return row ? assistantTurnFromRow(row) : undefined;
  }

  function getExecutionConfig(
    planId: string,
    itemId: string,
  ): DayPlanExecutionConfig | undefined {
    const row = selectExecutionConfig.get(planId, itemId) as
      | ExecutionConfigRow | undefined;
    return row ? executionConfigFromRow(row) : undefined;
  }

  function listExecutionConfigs(planId: string): DayPlanExecutionConfig[] {
    return (db.prepare(
      "SELECT * FROM day_plan_execution_configs WHERE day_plan_id = ? ORDER BY item_id",
    ).all(planId) as ExecutionConfigRow[]).map(executionConfigFromRow);
  }

  function listExecutionRuns(planId: string): DayPlanExecutionRun[] {
    return (selectExecutionRunsByPlan.all(planId) as ExecutionRunRow[]).map(executionRunFromRow);
  }

  function itemReadiness(
    plan: DayPlan,
    item: DayPlanItem,
    config = getExecutionConfig(plan.id, item.id),
  ): DayPlanExecutionReadiness {
    return assessDayPlanExecutionReadiness({
      item,
      config,
      environment: executionEnvironment(),
    });
  }

  function resolvePlanReviewWorkspacePath(item: DayPlanItem): string | undefined {
    const projectPath = item.project?.trim()
      ? projectDirectoryResolver(item.project)
      : null;
    if (projectPath) return projectPath;
    return item.title.trim() ? (projectDirectoryResolver(item.title) ?? undefined)
      : undefined;
  }

  function latestProgressContext(
    taskId: string,
    targetLocalDate: string,
  ): Pick<DayPlanExecutionRun["promptSnapshot"], "progressNote" | "nextStep"> {
    const cutoffDate = new Date(`${targetLocalDate}T12:00:00.000Z`);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 14);
    const cutoff = cutoffDate.toISOString().slice(0, 10);
    const rows = db.prepare(
      `SELECT * FROM day_snapshots
       WHERE local_date >= ? AND local_date < ?
       ORDER BY local_date DESC, created_at DESC`,
    ).all(cutoff, targetLocalDate) as SnapshotRow[];
    for (const row of rows) {
      const item = snapshotFromRow(row).body.unresolvedItems.find(
        (candidate) =>
          candidate.taskId === taskId && candidate.disposition === "progress",
      );
      if (item) {
        return {
          progressNote: cleanOptional(item.progressNote),
          nextStep: cleanOptional(item.nextStep),
        };
      }
    }
    return {};
  }

  function executionPromptSnapshot(
    plan: DayPlan,
    item: DayPlanItem,
  ): DayPlanExecutionRun["promptSnapshot"] {
    return {
      title: item.title,
      outcome: item.outcome,
      definitionOfDone: item.definitionOfDone,
      whyToday: item.whyToday,
      project: item.project,
      dueAt: item.dueAt,
      ...latestProgressContext(item.taskId, plan.localDate),
    };
  }

  function findExistingItemRun(
    planId: string,
    itemId: string,
    briefHash: string,
    mode: DayPlanExecutionMode,
    authorizationHash: string,
  ): DayPlanExecutionRun | undefined {
    const row = db.prepare(
      `SELECT * FROM day_plan_execution_runs
       WHERE day_plan_id = ? AND item_id = ? AND brief_hash = ? AND mode = ?
         AND authorization_hash = ?
         AND status NOT IN ('failed','interrupted','cancelled')
       ORDER BY attempt DESC LIMIT 1`,
    ).get(planId, itemId, briefHash, mode, authorizationHash) as
      | ExecutionRunRow | undefined;
    return row ? executionRunFromRow(row) : undefined;
  }

  function findLiveItemRun(planId: string, itemId: string): DayPlanExecutionRun | undefined {
    const row = db.prepare(
      `SELECT * FROM day_plan_execution_runs
       WHERE day_plan_id = ? AND item_id = ?
         AND status IN ('queued','starting','running','cancelling')
       ORDER BY attempt DESC LIMIT 1`,
    ).get(planId, itemId) as ExecutionRunRow | undefined;
    return row ? executionRunFromRow(row) : undefined;
  }

  function insertExecutionRun(input: {
    plan: DayPlan;
    item: DayPlanItem;
    config: DayPlanExecutionConfig;
    readiness: DayPlanExecutionReadiness;
    idempotencyKey: string;
    createdAt: string;
  }): DayPlanExecutionRun {
    const existing = findExistingItemRun(
      input.plan.id,
      input.item.id,
      input.config.briefHash,
      input.config.mode,
      input.config.authorizationHash,
    );
    if (existing) return existing;

    const priorAttempt = db.prepare(
      `SELECT COALESCE(MAX(attempt), 0) AS maximum_attempt
       FROM day_plan_execution_runs
       WHERE day_plan_id = ? AND item_id = ? AND authorization_hash = ?`,
    ).get(
      input.plan.id,
      input.item.id,
      input.config.authorizationHash,
    ) as { maximum_attempt: number;
    };
    const run: DayPlanExecutionRun = {
      id: randomUUID(),
      dayPlanId: input.plan.id,
      itemId: input.item.id,
      taskId: input.item.taskId,
      owner: input.item.owner === "together" ? "together" : "claude",
      mode: input.config.mode,
      modelAlias: input.config.modelAlias,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      attempt: priorAttempt.maximum_attempt + 1,
      claudeSessionId: randomUUID(),
      briefHash: input.config.briefHash,
      authorizationHash: input.config.authorizationHash,
      promptSnapshot: executionPromptSnapshot(input.plan, input.item),
      workspaceId: input.config.workspaceId,
      workspacePath: input.config.mode === "plan_review"
        ? resolvePlanReviewWorkspacePath(input.item)
        : input.readiness.workspacePath,
      budgetUsd: input.config.budgetUsd,
      readiness: input.readiness,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    db.prepare(
      `INSERT INTO day_plan_execution_runs
        (id, day_plan_id, item_id, task_id, owner, mode, model_alias, status,
         idempotency_key, attempt, claude_session_id, brief_hash, authorization_hash, prompt_json,
         workspace_id, workspace_path, budget_usd, readiness_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.dayPlanId,
      run.itemId,
      run.taskId,
      run.owner,
      run.mode,
      run.modelAlias,
      run.status,
      run.idempotencyKey,
      run.attempt,
      run.claudeSessionId,
      run.briefHash,
      run.authorizationHash,
      JSON.stringify(run.promptSnapshot),
      run.workspaceId ?? null,
      run.workspacePath ?? null,
      run.budgetUsd ?? null,
      JSON.stringify(run.readiness),
      run.createdAt,
      run.updatedAt,
    );
    return run;
  }

  function invalidateQueuedRunsForItem(
    plan: DayPlan,
    item: DayPlanItem,
    changedAt: string,
  ): void {
    const retained = ["pending", "preselected", "accepted"].includes(item.decision);
    const currentBriefHash = dayPlanItemBriefHash(item);
    db.prepare(
      `UPDATE day_plan_execution_runs
       SET status = 'cancelled', error_code = ?, finished_at = ?, updated_at = ?
       WHERE day_plan_id = ? AND item_id = ? AND status = 'queued'
         AND (? = 0 OR brief_hash <> ?)`,
    ).run(
      retained ? "brief_changed" : "item_not_retained",
      changedAt,
      changedAt,
      plan.id,
      item.id,
      retained ? 1 : 0,
      currentBriefHash,
    );
  }

  function requestExecutionRunCancellation(
    runId: string,
    changedAt: string,
  ): DayPlanExecutionRun {
    const row = selectExecutionRun.get(runId) as ExecutionRunRow | undefined;
    if (!row) throw new DayPlanInvalidTransition("Execution run not found.");
    if (row.status === "queued") {
      db.prepare(
        `UPDATE day_plan_execution_runs
         SET status = 'cancelled', error_code = 'user_cancelled',
             finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
      ).run(changedAt, changedAt, runId);
    } else if (row.status === "starting" || row.status === "running") {
      db.prepare(
        `UPDATE day_plan_execution_runs
         SET status = 'cancelling', error_code = 'user_cancelled', updated_at = ?
         WHERE id = ? AND status IN ('starting','running')`,
      ).run(changedAt, runId);
    }
    return executionRunFromRow(selectExecutionRun.get(runId) as ExecutionRunRow);
  }

  function quiesceExecutionRunsForPlanItems(plan: DayPlan, changedAt: string): void {
    const selectLiveItemRuns = db.prepare(
      `SELECT id FROM day_plan_execution_runs
       WHERE day_plan_id = ? AND item_id = ?
         AND status IN ('queued','starting','running')`,
    );
    for (const item of plan.items) {
      const rows = selectLiveItemRuns.all(plan.id, item.id) as Array<{ id: string;
      }>;
      for (const row of rows) requestExecutionRunCancellation(row.id, changedAt);
    }
  }

  function configureExecution(
    input: ConfigureDayPlanExecutionInput,
  ): DayPlanExecutionConfigResult {
    return immediate(() => {
      const replay = selectExecutionMutation.get(input.mutationId) as
        | { mutation_kind: string; result_json: string | null }
        | undefined;
      if (replay) {
        if (replay.mutation_kind !== "configure" || !replay.result_json) {
          throw new DayPlanInvalidTransition("Mutation ID was already used for another action.");
        }
        const config = parseJson<DayPlanExecutionConfig>(
          replay.result_json,
          "execution configuration replay",
        );
        const plan = getPlan(config.dayPlanId);
        const item = plan?.items.find((candidate) => candidate.id === config.itemId);
        if (!plan || !item) throw new DayPlanNotFound();
        return { config, readiness: itemReadiness(plan, item, config), replayed: true };
      }

      const plan = getPlan(input.planId);
      if (!plan) throw new DayPlanNotFound();
      if (plan.version !== input.expectedVersion) throw new DayPlanVersionConflict(plan);
      // Configuring execution during an open arrival is a real interaction; freeze
      // the arrival against a late brief attach (no-op once the day is active).
      stampArrivalInteraction(input.planId, now().toISOString());
      const item = requireItem(plan, input.itemId);
      // Execution can be configured while arrival is open for legacy API compatibility,
      // and once the day is active for an accepted agent-owned item. The arrival UI
      // never exposes this control, and kickoff itself is active-day-only.
      const arrivalEditing = plan.state === "proposed" && plan.arrivalState === "opened";
      const activeAgentItem =
        plan.state === "active" &&
        item.decision === "accepted" &&
        (item.owner === "claude" || item.owner === "together");
      if (!arrivalEditing && !activeAgentItem) {
        throw new DayPlanInvalidTransition(
          "Execution can be configured only while arrival is open or the day is active.",
        );
      }
      requireState(
        item.decision,
        ["pending", "preselected", "accepted"],
        "Execution can be configured only for a retained arrival item.",
      );
      if (item.owner !== "claude" && item.owner !== "together") {
        throw new DayPlanInvalidTransition("Choose Claude or Together before execution mode.");
      }
      if (item.owner === "together" && input.mode !== "plan_review") {
        throw new DayPlanInvalidTransition("Together work always uses plan review.");
      }
      if (input.budgetUsd !== undefined && (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0)) {
        throw new DayPlanInvalidTransition("Execution budget must be a positive number.");
      }

      const changedAt = now().toISOString();
      const existing = getExecutionConfig(plan.id, item.id);
      const provisional: DayPlanExecutionConfig = {
        dayPlanId: plan.id,
        itemId: item.id,
        mode: input.mode,
        modelAlias: input.modelAlias,
        workspaceId: cleanOptional(input.workspaceId),
        budgetUsd: input.budgetUsd,
        briefHash: dayPlanItemBriefHash(item),
        authorizationHash: "",
        lastMutationId: input.mutationId,
        configuredAt: existing?.configuredAt ?? changedAt,
        updatedAt: changedAt,
      };
      const readiness = itemReadiness(plan, item, provisional);
      const config: DayPlanExecutionConfig = {
        ...provisional,
        authorizationHash: dayPlanExecutionAuthorizationHash({
          briefHash: provisional.briefHash,
          mode: provisional.mode,
          modelAlias: provisional.modelAlias,
          workspaceId: provisional.workspaceId,
          workspacePath: provisional.mode === "autonomous" ? readiness.workspacePath : undefined,
          budgetUsd: provisional.budgetUsd,
        }),
      };
      db.prepare(
        `INSERT INTO day_plan_execution_configs
          (day_plan_id, item_id, mode, model_alias, workspace_id, budget_usd,
           brief_hash, authorization_hash, last_mutation_id, configured_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day_plan_id, item_id) DO UPDATE SET
           mode = excluded.mode, model_alias = excluded.model_alias,
           workspace_id = excluded.workspace_id, budget_usd = excluded.budget_usd,
           brief_hash = excluded.brief_hash, authorization_hash = excluded.authorization_hash,
           last_mutation_id = excluded.last_mutation_id,
           updated_at = excluded.updated_at`,
      ).run(
        config.dayPlanId,
        config.itemId,
        config.mode,
        config.modelAlias,
        config.workspaceId ?? null,
        config.budgetUsd ?? null,
        config.briefHash,
        config.authorizationHash,
        config.lastMutationId,
        config.configuredAt,
        config.updatedAt,
      );
      db.prepare(
        `UPDATE day_plan_execution_runs
         SET status = 'cancelled', error_code = 'authorization_changed',
             finished_at = ?, updated_at = ?
         WHERE day_plan_id = ? AND item_id = ? AND status = 'queued'
           AND authorization_hash <> ?`,
      ).run(changedAt, changedAt, plan.id, item.id, config.authorizationHash);
      db.prepare(
        `INSERT INTO day_plan_execution_mutations
          (id, mutation_kind, day_plan_id, item_id, result_json, created_at)
         VALUES (?, 'configure', ?, ?, ?, ?)`,
      ).run(
        input.mutationId,
        plan.id,
        item.id,
        JSON.stringify(config),
        changedAt,
      );
      return { config, readiness, replayed: false };
    });
  }

  function kickoffItem(input: KickoffDayPlanItemInput): KickoffDayPlanItemResult {
    return immediate(() => {
      const replay = selectExecutionMutation.get(input.mutationId) as
        | { mutation_kind: string; day_plan_id: string; item_id: string; result_id: string | null;
          }
        | undefined;
      if (replay) {
        if (replay.mutation_kind !== "kickoff") {
          throw new DayPlanInvalidTransition("Mutation ID was already used for another action.");
        }
        const replayedPlan = getPlan(replay.day_plan_id);
        if (!replayedPlan) throw new DayPlanNotFound();
        const item = requireItem(replayedPlan, replay.item_id);
        const config = getExecutionConfig(replayedPlan.id, item.id);
        const readiness = itemReadiness(replayedPlan, item, config);
        const run = replay.result_id
          ? executionRunFromRow(selectExecutionRun.get(replay.result_id) as ExecutionRunRow)
          : undefined;
        return { plan: replayedPlan, run, readiness, replayed: true };
      }

      const plan = getPlan(input.planId);
      if (!plan) throw new DayPlanNotFound();
      if (plan.version !== input.expectedVersion) throw new DayPlanVersionConflict(plan);
      if (plan.state !== "active") {
        throw new DayPlanInvalidTransition("Kickoff requires an active day.");
      }
      const before = clonePlan(plan);
      const item = requireItem(plan, input.itemId);
      requireState(
        item.decision,
        ["pending", "preselected", "accepted"],
        "Only retained work can be kicked off.",
      );
      const config = getExecutionConfig(plan.id, item.id);
      const readiness = itemReadiness(plan, item, config);
      const changedAt = now().toISOString();
      let run: DayPlanExecutionRun | undefined;
      if (readiness.ready && config) {
        item.decision = "accepted";
        item.humanDecisionEventIds = [
          ...new Set([...item.humanDecisionEventIds, input.mutationId]),
        ];
        run = insertExecutionRun({
          plan,
          item,
          config,
          readiness,
          idempotencyKey: input.mutationId,
          createdAt: changedAt,
        });
        plan.version += 1;
        plan.lastMutationId = input.mutationId;
        plan.updatedAt = changedAt;
        persistPlan(plan);
        appendEvent({
          id: input.mutationId,
          planId: plan.id,
          eventType: "item_kickoff",
          expectedVersion: input.expectedVersion,
          resultVersion: plan.version,
          before,
          after: { plan, runId: run.id },
          createdAt: changedAt,
        });
      }
      db.prepare(
        `INSERT INTO day_plan_execution_mutations
          (id, mutation_kind, day_plan_id, item_id, result_id, created_at)
         VALUES (?, 'kickoff', ?, ?, ?, ?)`,
      ).run(input.mutationId, plan.id, item.id, run?.id ?? null, changedAt);
      return { plan, run, readiness, replayed: false };
    });
  }

  function completeItemSource(item: DayPlanItem, changedAt: string): void {
    acceptPlanningProposal(db, item, new Date(changedAt));
    if (item.planningRef?.kind === "commitment") {
      db.prepare(
        "UPDATE commitments SET status='done',updated_at=? WHERE id=? AND status='open'",
      ).run(changedAt, item.planningRef.id);
      const source = sourceRecord(db, "commitment", item.planningRef.id);
      if (!source || source.status !== "done")
        throw new DayPlanInvalidTransition("This commitment is no longer available to complete.");
      item.completionSourceVersion = sourceVersion(source);
    }
    const taskBacked = item.sourceRefs.some(
      (source) => source.sourceType === "task" && source.recordId === item.taskId,
    );
    if (taskBacked) {
      const task = managedTask(item.taskId);
      if (!task || task.status === "archived") throw new DayPlanInvalidTransition("The board task no longer exists.");
      if (task.status !== "done") {
        if (
          task.column_id &&
          typeof task.position === "number" &&
          Number.isFinite(task.position)
        ) {
          item.preCompletionBoardPlacement = {
            columnId: task.column_id,
            position: task.position,
            status: task.status,
          };
        } else {
          delete item.preCompletionBoardPlacement;
        }
        const doneColumn = (db.prepare(
          "SELECT id, name FROM task_columns ORDER BY position ASC",
        ).all() as Array<{ id: string; name: string }>).find(
          (column) => taskColumnKeyForName(column.name) === "done",
        );
        if (!doneColumn) {
          throw new DayPlanInvalidTransition("Cove needs a Done list to complete this task.");
        }
        const nextPosition = db.prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE column_id = ? AND status = 'done'",
        ).pluck().get(doneColumn.id) as number;
        db.prepare(
          `UPDATE tasks
           SET column_id = ?, status = 'done', position = ?, updated_at = ?
           WHERE id = ?`,
        ).run(doneColumn.id, nextPosition, changedAt, task.id);
        if (task.recurring_template_id) syncRecurringOccurrenceForTask(db,task.id,"done",changedAt);
      }
      item.completionSourceVersion = sourceVersion(sourceRecord(db, "task", task.id)!);
    }
  }

  function updateItemResponsibility(item: DayPlanItem, changedAt: string): void {
    const ref=item.planningRef;
    if (!ref) return;
    const source=sourceRecord(db,ref.kind,ref.id);
    if (!source) throw new DayPlanInvalidTransition("The source for this item no longer exists.");
    const changed=db.prepare("UPDATE cove_responsibilities SET next_action=?,source_version=?,revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=? AND revision=?")
      .run(item.title,sourceVersion(source),changedAt,ref.kind,ref.id,ref.revision);
    if (changed.changes!==1) throw new DayPlanInvalidTransition("This item's responsibility changed. Refresh before editing.");
    ref.revision+=1;
  }

  function applyValidatedAssistantPatch(input: {
    plan: DayPlan;
    proposal: DayPlanAssistantProposal;
    assistantTurnId: string;
    baseVersion: number;
    finishedAt: string;
    requestedCreatedItemIds?: string[];
    // What the operator said to Buddy, when Cove has it; the origin box quotes it.
    userText?: string;
  }): { plan: DayPlan; createdItemIds: string[] } {
    const {
      plan,
      proposal,
      assistantTurnId,
      baseVersion,
      finishedAt,
      requestedCreatedItemIds,
    } = input;
    const arrivalDate = planDateLabel(plan.localDate);
    const userWords = input.userText ? originQuote(input.userText) : "";
    const createdOrigin = userWords
      ? `You asked Buddy during Morning Arrival on ${arrivalDate}: "${userWords}"`
      : `Buddy added this while replanning your day in Morning Arrival on ${arrivalDate}.`;
    const before = clonePlan(plan);
    for (const operation of proposal.operations) {
      if (operation.operation !== "edit_item" && operation.operation !== "complete_item") continue;
      const item = plan.items.find(candidate=>candidate.id===operation.itemId)!;
      const ref = item.planningRef;
      if (ref) {
        const source=sourceRecord(db,ref.kind,ref.id);
        const responsibility=db.prepare("SELECT revision,source_version FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?").get(ref.kind,ref.id) as {revision:number;source_version:string}|undefined;
        if (!source || !responsibility || item.planningStale || responsibility.revision!==ref.revision || responsibility.source_version!==sourceVersion(source))
          throw new DayPlanInvalidTransition("This source changed. Review a fresh replan before applying it.");
      } else {
        const task=managedTask(item.taskId);
        const source=item.sourceRefs.find(ref=>ref.sourceType==="task" && ref.recordId===item.taskId);
        if (task && source && task.updated_at && task.updated_at!==source.sourceUpdatedAt)
          throw new DayPlanInvalidTransition("This task changed. Review a fresh replan before applying it.");
      }
    }
    const createdItemIds: string[] = [];
    let createdIndex = 0;
    applyAssistantProposal(plan, proposal, {
      now: finishedAt,
      idFactory: () => {
        const id = requestedCreatedItemIds?.[createdIndex] ?? randomUUID();
        createdIndex += 1;
        createdItemIds.push(id);
        return id;
      },
    });
    const descriptionFor = (item: DayPlanItem) => [
      item.outcome,
      item.definitionOfDone ? `Done means: ${item.definitionOfDone}` : undefined,
    ].filter(Boolean).join("\n\n");
    let createdOperationIndex = 0;
    for (const operation of proposal.operations) {
      if (operation.operation === "edit_item") {
        const item = plan.items.find((candidate) => candidate.id === operation.itemId)!;
        const payload: Record<string, unknown> = {};
        if (operation.title !== undefined) payload.title = item.title;
        if (operation.outcome !== undefined || operation.definitionOfDone !== undefined) {
          payload.description = descriptionFor(item);
        }
        if (Object.keys(payload).length > 0) {
          if (!item.planningRef || item.planningRef.kind === "task") {
            const task=managedTask(item.taskId);
            if (!task || task.status === "archived") throw new DayPlanInvalidTransition("The board task no longer exists.");
            const fields=Object.keys(payload);
            db.prepare(`UPDATE tasks SET ${fields.map(field=>`${field}=?`).join(",")},updated_at=? WHERE id=?`).run(...fields.map(field=>payload[field]),finishedAt,item.taskId);
          }
          updateItemResponsibility(item,finishedAt);
          if (!item.planningRef || item.planningRef.kind === "task") item.sourceRefs = item.sourceRefs.map(ref=>ref.sourceType==="task" && ref.recordId===item.taskId ? {...ref,sourceUpdatedAt:finishedAt,refreshedAt:finishedAt} : ref);
        }
      } else if (operation.operation === "complete_item") {
        const item = plan.items.find((candidate) => candidate.id === operation.itemId)!;
        item.preCompletionPlanPosition = before.items.find(prior=>prior.id===item.id)?.position;
        completeItemSource(item,finishedAt);
      } else if (operation.operation === "create_item") {
        const itemId = createdItemIds[createdOperationIndex++];
        const item = plan.items.find((candidate) => candidate.id === itemId)!;
        insertBackingTask(db, {
          id: item.taskId,
          title: item.title,
          description: descriptionFor(item),
          priority: item.priority,
          project: item.project,
          origin: createdOrigin,
          changedAt: finishedAt,
        });
        item.sourceRefs = [{
          sourceType: "task",
          recordId: item.taskId,
          sourceUpdatedAt: finishedAt,
          refreshedAt: finishedAt,
          freshness: "current",
          supports: ["commitment", "priority"],
        }, ...item.sourceRefs];
      }
    }
    for (const item of plan.items) invalidateQueuedRunsForItem(plan, item, finishedAt);
    const eventId = `assistant:${assistantTurnId}`;
    plan.version += 1;
    plan.lastMutationId = eventId;
    plan.updatedAt = finishedAt;
    persistPlan(plan);
    appendEvent({
      id: eventId,
      planId: plan.id,
      eventType: "assistant_patch",
      expectedVersion: baseVersion,
      resultVersion: plan.version,
      before,
      after: { plan, assistantTurnId },
      createdAt: finishedAt,
    });
    return { plan, createdItemIds };
  }

  function applyAssistantOperations(input: {
    expectedVersion: number;
    operations: DayPlanAssistantOperation[];
    createdItemIds?: string[];
    replanReceiptProof?: {
      turnId: string;
      expectedReceiptsJson: string;
      appliedReceiptsJson: string;
    };
  }): { turn: DayPlanAssistantTurn; plan: DayPlan; createdItemIds: string[] } {
    return immediate(() => {
      const plan = getReadModel().currentPlan;
      if (!plan) throw new DayPlanNotFound();
      if (plan.version !== input.expectedVersion) throw new DayPlanVersionConflict(plan);
      const proof = input.replanReceiptProof;
      let buddyUserText: string | undefined;
      if (proof) {
        const row = db.prepare(
          `SELECT state, finished_at, receipts_json, user_text
           FROM buddy_turns WHERE id = ?`,
        ).get(proof.turnId) as
          | {
          state: string;
          finished_at: string | null;
          receipts_json: string | null;
          user_text: string | null;
        } | undefined;
        const proposed = normalizeBuddyReceipts(
          JSON.parse(proof.expectedReceiptsJson) as unknown,
        );
        const applied = normalizeBuddyReceipts(
          JSON.parse(proof.appliedReceiptsJson) as unknown,
        );
        if (
          !row ||
          row.state !== "succeeded" ||
          !row.finished_at ||
          row.receipts_json !== proof.expectedReceiptsJson ||
          proposed?.replan?.status !== "proposed" ||
          proposed.replan.expectedVersion !== input.expectedVersion ||
          !isDeepStrictEqual(proposed.replan.operations, input.operations) ||
          applied?.replan?.status !== "applied" ||
          applied.replan.expectedVersion !== input.expectedVersion ||
          !isDeepStrictEqual(applied.replan.operations, input.operations)
        ) {
          throw new DayPlanInvalidTransition(
            "Replan preview does not authorize these changes.",
          );
        }
        buddyUserText = row.user_text ?? undefined;
      }
      requireAssistantEditing(plan, Boolean(proof));
      if (!Array.isArray(input.operations) || input.operations.length === 0) {
        throw new DayPlanInvalidTransition("Assistant apply requires at least one operation.");
      }
      const createCount = input.operations.filter(
        (operation) => operation.operation === "create_item",
      ).length;
      if (
        input.createdItemIds &&
        (
          input.createdItemIds.length !== createCount ||
          new Set(input.createdItemIds).size !== createCount
        )
      ) {
        throw new DayPlanInvalidTransition("Assistant create item identities are invalid.");
      }
      const timestamp = now().toISOString();
      const turnId = `buddy-${randomUUID()}`;
      db.prepare(
        `INSERT INTO day_plan_assistant_turns
          (id, day_plan_id, base_version, user_text, state, created_at, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      ).run(turnId, plan.id, plan.version, "Buddy day-plan apply", timestamp, timestamp);
      stampArrivalInteraction(plan.id, timestamp);
      plan.arrivalInteractedAt ??= timestamp;
      const proposal = validateAssistantProposal(plan, {
        assistantText: "Buddy updated the day plan.",
        needsClarification: false,
        operations: input.operations,
      });
      const applied = applyValidatedAssistantPatch({
        plan,
        proposal,
        assistantTurnId: turnId,
        baseVersion: input.expectedVersion,
        finishedAt: timestamp,
        requestedCreatedItemIds: input.createdItemIds,
        userText: buddyUserText,
      });
      if (proof) {
        const consumed = db.prepare(
          `UPDATE buddy_turns
           SET receipts_json = ?
           WHERE id = ? AND state = 'succeeded' AND finished_at IS NOT NULL
             AND receipts_json = ?`,
        ).run(
          proof.appliedReceiptsJson,
          proof.turnId,
          proof.expectedReceiptsJson,
        );
        if (consumed.changes !== 1) {
          throw new DayPlanInvalidTransition(
            "Replan preview was already used.",
          );
        }
      }
      db.prepare(
        `UPDATE day_plan_assistant_turns
         SET state = 'applied', proposal_json = ?, result_version = ?, finished_at = ?, applied_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(proposal), plan.version, timestamp, timestamp, turnId);
      return { turn: getAssistantTurn(turnId)!, plan, createdItemIds: applied.createdItemIds };
    });
  }

  function claimNextExecutionRun(workerPid?: number): DayPlanExecutionRun | undefined {
    return immediate(() => {
      while (true) {
        const row = selectNextExecutionRun.get() as ExecutionRunRow | undefined;
        if (!row) return undefined;
        const checkedAt = now().toISOString();
        const plan = getPlan(row.day_plan_id);
        const item = plan?.items.find((candidate) => candidate.id === row.item_id);
        const config = plan ? getExecutionConfig(plan.id, row.item_id) : undefined;
        const readiness = plan && item
          ? itemReadiness(plan, item, config)
          : undefined;
        const currentHash = item ? dayPlanItemBriefHash(item) : undefined;
        const currentAuthorizationHash = config && readiness
          ? dayPlanExecutionAuthorizationHash({
              briefHash: config.briefHash,
              mode: config.mode,
              modelAlias: config.modelAlias,
              workspaceId: config.workspaceId,
              workspacePath: config.mode === "autonomous" ? readiness.workspacePath : undefined,
              budgetUsd: config.budgetUsd,
            })
          : undefined;
        const retained = item?.decision === "accepted";
        const exactAuthorization = Boolean(
          config &&
          currentAuthorizationHash === config.authorizationHash &&
          row.authorization_hash === config.authorizationHash &&
          row.mode === config.mode &&
          row.model_alias === config.modelAlias &&
          (row.workspace_id ?? undefined) === config.workspaceId &&
          (config.mode !== "autonomous" ||
            (row.workspace_path ?? undefined) === readiness?.workspacePath) &&
          (row.budget_usd ?? undefined) === config.budgetUsd,
        );
        if (
          !plan ||
          !item ||
          !config ||
          !retained ||
          currentHash !== row.brief_hash ||
          !exactAuthorization ||
          !readiness?.ready
        ) {
          const errorCode = !plan || !item
            ? "item_missing"
            : !retained
              ? "item_not_retained"
              : currentHash !== row.brief_hash || config?.briefHash !== row.brief_hash
                ? "brief_changed"
                : !exactAuthorization
                  ? "authorization_changed"
                  : (readiness?.codes[0] ?? "not_ready");
          db.prepare(
            `UPDATE day_plan_execution_runs
             SET status = 'cancelled', error_code = ?, finished_at = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          ).run(errorCode, checkedAt, checkedAt, row.id);
          continue;
        }
        const changed = db.prepare(
          `UPDATE day_plan_execution_runs
           SET status = 'starting', pid = ?, heartbeat_at = ?, started_at = ?, updated_at = ?,
               readiness_json = ?
           WHERE id = ? AND status = 'queued'`,
        ).run(
          workerPid ?? null,
          checkedAt,
          checkedAt,
          checkedAt,
          JSON.stringify(readiness),
          row.id,
        );
        if (changed.changes !== 1) continue;
        return executionRunFromRow(selectExecutionRun.get(row.id) as ExecutionRunRow);
      }
    });
  }

  function markExecutionRunRunning(runId: string, childPid: number): DayPlanExecutionRun {
    return immediate(() => {
      const updatedAt = now().toISOString();
      const changed = db.prepare(
        `UPDATE day_plan_execution_runs
         SET status = 'running', pid = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      ).run(childPid, updatedAt, updatedAt, runId);
      if (changed.changes !== 1) {
        throw new DayPlanInvalidTransition("Execution run is not starting.");
      }
      return executionRunFromRow(selectExecutionRun.get(runId) as ExecutionRunRow);
    });
  }

  function heartbeatExecutionRun(runId: string, childPid: number): boolean {
    const heartbeatAt = now().toISOString();
    return (
      db.prepare(
      `UPDATE day_plan_execution_runs
       SET heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND pid = ? AND status IN ('starting','running')`,
    ).run(heartbeatAt, heartbeatAt, runId, childPid).changes === 1
    );
  }

  function setExecutionRunLogPath(runId: string, logPath: string): boolean {
    return (
      db.prepare(
      `UPDATE day_plan_execution_runs SET log_path = ?
       WHERE id = ? AND status IN ('starting','running')`,
    ).run(logPath.slice(0, 4096), runId).changes === 1
    );
  }

  function finishExecutionRun(input: {
    runId: string;
    exitCode?: number;
    interrupted?: boolean;
    errorCode?: string;
    resultSummary?: DayPlanExecutionResultSummary;
  }): DayPlanExecutionRun {
    return immediate(() => {
      const row = selectExecutionRun.get(input.runId) as
        | ExecutionRunRow | undefined;
      if (!row) throw new DayPlanInvalidTransition("Execution run not found.");
      if (!["starting", "running", "cancelling"].includes(row.status)) {
        return executionRunFromRow(row);
      }
      const resultSummary = input.resultSummary && input.resultSummary.text.trim()
        ? {
            ...input.resultSummary,
            text: input.resultSummary.text.trim().slice(0, 8000),
          }
        : undefined;
      const planDegenerate = row.mode === "plan_review" && input.exitCode === 0 && (
        input.errorCode === "plan_degenerate" ||
        !hasPlanExecutionResultSubstance(resultSummary?.text)
      );
      const errorCode = planDegenerate ? "plan_degenerate" : input.errorCode;
      const status: DayPlanExecutionRun["status"] = row.status === "cancelling"
        ? "cancelled"
        : input.interrupted
        ? "interrupted"
        : input.exitCode === 0 && !errorCode
          ? row.mode === "autonomous"
            ? "awaiting_review"
            : row.owner === "together"
              ? "ready_to_join"
              : "plan_ready"
          : "failed";
      const finishedAt = now().toISOString();
      db.prepare(
        `UPDATE day_plan_execution_runs
         SET status = ?, finished_at = ?, updated_at = ?, heartbeat_at = ?,
             exit_code = ?, error_code = ?, result_summary_json = ?
         WHERE id = ? AND status IN ('starting','running','cancelling')`,
      ).run(
        status,
        finishedAt,
        finishedAt,
        finishedAt,
        input.exitCode ?? null,
        row.status === "cancelling"
          ? "user_cancelled"
          : (errorCode?.slice(0, 120) ?? null),
        resultSummary ? JSON.stringify(resultSummary) : null,
        input.runId,
      );
      return executionRunFromRow(selectExecutionRun.get(input.runId) as ExecutionRunRow);
    });
  }

  function cancelExecutionRun(runId: string): DayPlanExecutionRun {
    return immediate(() => requestExecutionRunCancellation(runId, now().toISOString()));
  }

  function recoverStaleExecutionRuns(staleBefore: string): DayPlanExecutionRun[] {
    return immediate(() => {
      const rows = db.prepare(
        `SELECT * FROM day_plan_execution_runs
         WHERE status IN ('starting','running','cancelling')
           AND COALESCE(heartbeat_at, started_at, created_at) < ?`,
      ).all(staleBefore) as ExecutionRunRow[];
      if (rows.length === 0) return [];
      const finishedAt = now().toISOString();
      const update = db.prepare(
        `UPDATE day_plan_execution_runs
         SET status = ?, error_code = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('starting','running','cancelling')`,
      );
      for (const row of rows) {
        update.run(
          row.status === "cancelling" ? "cancelled" : "interrupted",
          row.status === "cancelling" ? "user_cancelled" : "worker_interrupted",
          finishedAt,
          finishedAt,
          row.id,
        );
      }
      return rows.map((row) => executionRunFromRow(row));
    });
  }

  function interruptStaleExecutionRuns(staleBefore: string): number {
    return recoverStaleExecutionRuns(staleBefore).length;
  }

  function listExecutionWorkspaces(): DayPlanExecutionWorkspaceMetadata[] {
    return [...executionEnvironment().workspaces.values()]
      .map((workspace) => ({
        id: workspace.id,
        maximumBudgetUsd: workspace.maximumBudgetUsd,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  // -------------------------------------------------------------------------
  // Evening dump queue. Settlement is authoritative; parsing is asynchronous
  // and fail-open, so rows are append-only receipts rather than plan state.
  // -------------------------------------------------------------------------

  function getDayDump(id: string): DayDump | undefined {
    const row = db.prepare("SELECT * FROM day_dumps WHERE id = ?").get(id) as
      | DayDumpRow
      | undefined;
    return row ? dayDumpFromRow(row) : undefined;
  }

  function listDayDumps(targetLocalDate?: string): DayDump[] {
    const rows = targetLocalDate
      ? db.prepare(
          "SELECT * FROM day_dumps WHERE target_local_date = ? ORDER BY created_at, id",
        ).all(targetLocalDate)
      : db.prepare("SELECT * FROM day_dumps ORDER BY created_at, id").all();
    return (rows as DayDumpRow[]).map(dayDumpFromRow);
  }

  function claimNextDayDump(): DayDump | undefined {
    return immediate(() => {
      const row = db.prepare(
        `SELECT * FROM day_dumps
         WHERE status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM day_dumps active WHERE active.status = 'running')
         ORDER BY created_at, id LIMIT 1`,
      ).get() as DayDumpRow | undefined;
      if (!row) return undefined;
      const startedAt = now().toISOString();
      db.prepare(
        `UPDATE day_dumps
         SET status = 'running', started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(startedAt, startedAt, row.id);
      return getDayDump(row.id);
    });
  }

  function completeDayDump(id: string, resultJson: string): DayDump | undefined {
    return immediate(() => {
      const finishedAt = now().toISOString();
      const changed = db.prepare(
        `UPDATE day_dumps
         SET status = 'succeeded', result_json = ?, error_code = NULL,
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(resultJson, finishedAt, finishedAt, id).changes;
      return changed > 0 ? getDayDump(id) : undefined;
    });
  }

  function failDayDump(id: string, errorCode: string, resultJson?: string): void {
    immediate(() => {
      const finishedAt = now().toISOString();
      db.prepare(
        `UPDATE day_dumps
         SET status = 'failed', result_json = COALESCE(?, result_json), error_code = ?,
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued','running')`,
      ).run(
        resultJson ?? null,
        errorCode.replace(/\s+/g, " ").slice(0, 200),
        finishedAt,
        finishedAt,
        id,
      );
    });
  }

  function interruptStaleDayDumps(staleBefore: string): number {
    const finishedAt = now().toISOString();
    return db.prepare(
      `UPDATE day_dumps
       SET status = 'failed', error_code = 'worker_interrupted', finished_at = ?, updated_at = ?
       WHERE status = 'running' AND started_at < ?`,
    ).run(finishedAt, finishedAt, staleBefore).changes;
  }

  // -------------------------------------------------------------------------
  // Morning Brief artifacts. Rows are immutable once succeeded; regeneration
  // creates new rows and the newest eligible artifact wins at selection time.
  // -------------------------------------------------------------------------

  function getMorningBrief(id: string): MorningBriefArtifact | undefined {
    const row = db
      .prepare("SELECT * FROM day_plan_briefs WHERE id = ?")
      .get(id) as MorningBriefRow | undefined;
    return row ? withBriefActionState(morningBriefFromRow(row)) : undefined;
  }

  function withBriefActionState(artifact: MorningBriefArtifact): MorningBriefArtifact {
    const pending = db.prepare(
      "SELECT 1 FROM day_plan_brief_actions WHERE artifact_id = ? AND state = 'staged' LIMIT 1",
    ).get(artifact.id);
    return pending ? { ...artifact, boardActionsPending: true } : artifact;
  }

  function listMorningBriefs(targetLocalDate: string): MorningBriefArtifact[] {
    return (db
      .prepare(
        "SELECT * FROM day_plan_briefs WHERE target_local_date = ? ORDER BY created_at, id",
      )
      .all(targetLocalDate) as MorningBriefRow[]).map((row) =>
        withBriefActionState(morningBriefFromRow(row))
      );
  }

  // Newest by REQUEST time, which is the only correct ordering for deciding
  // which of several succeeded briefs wins: a brief requested at 11am saw more
  // of the world than one requested at 7:30am, no matter which finished first.
  // Finish-time ordering used to live here, and it let a slow older generation
  // land after a fresher one and be picked as "latest".
  function latestEligibleMorningBrief(
    targetLocalDate: string,
    versions: { promptVersion: number; schemaVersion: number } = {
      promptVersion: MORNING_BRIEF_PROMPT_VERSION,
      schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
    },
  ): MorningBriefArtifact | undefined {
    const row = db
      .prepare(
        `SELECT * FROM day_plan_briefs
         WHERE target_local_date = ? AND status = 'succeeded'
           AND prompt_version = ? AND schema_version = ? AND brief_json IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM day_plan_brief_actions actions
             WHERE actions.artifact_id = day_plan_briefs.id AND actions.state = 'staged'
           )
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(targetLocalDate, versions.promptVersion, versions.schemaVersion) as
      | MorningBriefRow
      | undefined;
    return row ? morningBriefFromRow(row) : undefined;
  }

  function enqueueMorningBrief(
    targetLocalDate: string,
    provenance: { modelAlias: string; effort: string; budgetUsd: number },
  ): { brief: MorningBriefArtifact; created: boolean } {
    return immediate(() => {
      const active = db
        .prepare(
          `SELECT * FROM day_plan_briefs
           WHERE target_local_date = ? AND status IN ('queued','running')
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(targetLocalDate) as MorningBriefRow | undefined;
      if (active) return { brief: morningBriefFromRow(active), created: false };
      const createdAt = now().toISOString();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO day_plan_briefs
          (id, target_local_date, status, prompt_version, schema_version,
           model_alias, effort, budget_usd, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        targetLocalDate,
        MORNING_BRIEF_PROMPT_VERSION,
        MORNING_BRIEF_SCHEMA_VERSION,
        provenance.modelAlias,
        provenance.effort,
        provenance.budgetUsd,
        createdAt,
        createdAt,
      );
      return { brief: getMorningBrief(id)!, created: true };
    });
  }

  function requeueStalePlanning(id: string) {
    return immediate(() => {
      const artifact = getMorningBrief(id);
      if (
        !artifact ||
        artifact.status !== "failed" ||
        db
          .prepare(
            "SELECT 1 FROM day_plan_planning_retries WHERE parent_id=? OR child_id=?",
          )
          .get(id, id)
      )
        return undefined;
      const plan = getPlanForDate(artifact.targetLocalDate);
      if (plan && (!["draft", "proposed"].includes(plan.state) || plan.arrivalInteractedAt))
        return undefined;
      const queued = enqueueMorningBrief(artifact.targetLocalDate, {
        modelAlias: artifact.modelAlias,
        effort: artifact.effort,
        budgetUsd: artifact.budgetUsd,
      });
      db.prepare("INSERT INTO day_plan_planning_retries VALUES(?,?,?)").run(
        id,
        queued.brief.id,
        now().toISOString(),
      );
      return queued.brief;
    });
  }

  // Observed run times of recent successful briefs, newest first, for the
  // arrival progress estimate. Only rows with both timestamps count.
  function recentBriefDurationsSeconds(limit = 10): number[] {
    const capped = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = db
      .prepare(
        `SELECT started_at, finished_at FROM day_plan_briefs
         WHERE status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(capped) as Array<{ started_at: string; finished_at: string }>;
    return rows
      .map((row) => {
        const started = Date.parse(row.started_at);
        const finished = Date.parse(row.finished_at);
        if (!Number.isFinite(started) || !Number.isFinite(finished)) return NaN;
        return (finished - started) / 1000;
      })
      .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
  }

  function claimNextMorningBrief(): MorningBriefArtifact | undefined {
    return immediate(() => {
      const row = db
        .prepare(
          `SELECT * FROM day_plan_briefs
           WHERE status = 'queued'
             AND (error_code IS NULL OR error_code NOT LIKE 'budget_deferred:%'
                  OR substr(error_code, 17) <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM day_plan_briefs active WHERE active.status = 'running'
             )
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(now().toISOString()) as MorningBriefRow | undefined;
      if (!row) return undefined;
      const startedAt = now().toISOString();
      db.prepare(
        `UPDATE day_plan_briefs
         SET status = 'running', started_at = ?, updated_at = ?, error_code = NULL
         WHERE id = ? AND status = 'queued'`,
      ).run(startedAt, startedAt, row.id);
      return getMorningBrief(row.id);
    });
  }

  function recordMorningBriefInputs(
    id: string,
    inputs: {
      inputHash: string;
      sourceManifest: MorningBriefSourceManifest;
      promptVersion: number;
      schemaVersion: number;
    },
  ): { duplicateOfId?: string } {
    return immediate(() => {
      const row = db
        .prepare("SELECT * FROM day_plan_briefs WHERE id = ?")
        .get(id) as MorningBriefRow | undefined;
      if (!row || row.status !== "running") return {};
      const updatedAt = now().toISOString();
      const duplicate = db
        .prepare(
          `SELECT id FROM day_plan_briefs
           WHERE target_local_date = ? AND input_hash = ?
             AND prompt_version = ? AND schema_version = ? AND status = 'succeeded'
           LIMIT 1`,
        )
        .get(
          row.target_local_date,
          inputs.inputHash,
          inputs.promptVersion,
          inputs.schemaVersion,
        ) as { id: string } | undefined;
      if (duplicate) {
        // Identical inputs already produced an artifact; skip the session and
        // let selection keep using the existing brief.
        db.prepare(
          `UPDATE day_plan_briefs
           SET status = 'failed', error_code = 'duplicate_input', finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(updatedAt, updatedAt, id);
        return { duplicateOfId: duplicate.id };
      }
      // Dead failed attempts with the same composite key would collide with the
      // unique index; they carry no artifact, so prune them.
      db.prepare(
        `DELETE FROM day_plan_briefs
         WHERE target_local_date = ? AND input_hash = ?
           AND prompt_version = ? AND schema_version = ? AND status = 'failed'`,
      ).run(
        row.target_local_date,
        inputs.inputHash,
        inputs.promptVersion,
        inputs.schemaVersion,
      );
      db.prepare(
        `UPDATE day_plan_briefs
         SET input_hash = ?, prompt_version = ?, schema_version = ?,
             source_manifest_json = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(
        inputs.inputHash,
        inputs.promptVersion,
        inputs.schemaVersion,
        JSON.stringify(inputs.sourceManifest),
        updatedAt,
        id,
      );
      return {};
    });
  }

  function planningContext(
    localDate: string,
    events: import("../workspace/contracts").CalendarEvent[] = [],
    observation?: import("../workspace/contracts").CalendarObservation,
  ) {
    return immediate(() => {
      const calendarIds = rememberCalendarOccurrences(db, events, now());
      return collectPlanningContext(
        db,
        getPlanForDate(localDate) ?? null,
        now(),
        observation ? { observation, calendarIds } : undefined,
      );
    });
  }

  function completeDailyPlanning(
    id: string,
    brief: import("./brief").MorningBrief,
    writer: string,
  ) {
    return immediate(() => {
      const artifact = getMorningBrief(id);
      if (!artifact || artifact.status !== "running" || !brief.dailyDecision)
        return undefined;
      const plan = getPlanForDate(artifact.targetLocalDate) ?? null;
      let candidates: RecommendationCandidate[] | undefined;
      const untouched =
        !plan ||
        (plan.state === "proposed" &&
          !plan.arrivalInteractedAt &&
          plan.items.every((i) => i.decision === "preselected"));
      // Opening Arrival and refreshing source projections change plan.version
      // without changing intent. Human edits stamp arrivalInteractedAt; source
      // and responsibility versions are separately validated before any write.
      const applies = untouched && brief.dailyDecision.basePlanId === (plan?.id ?? null);
      // A plan can be ensured while its first brief is being written. Keep
      // that morning's new proposals and questions without replacing its items.
      // Human interaction or starting the day closes this automatic write window.
      const canSaveLinks = !plan ||
        (["draft", "proposed"].includes(plan.state) && !plan.arrivalInteractedAt);
      const linkedCandidates = canSaveLinks
        ? persistDecisionLinks(db, brief.dailyDecision, now(), { applyExisting: applies })
        : [];
      if (applies) candidates = linkedCandidates;
      const result = completeMorningBrief(
        id,
        JSON.stringify({
          ...brief,
          writer,
          planningCandidates: candidates,
          proposalCandidates: linkedCandidates.filter(
            (item) => item.commitment === "pencil",
          ),
        }),
      );
      if (plan && candidates) {
        const before = structuredClone(plan);
        plan.items = candidates.map((candidate, position) => ({
          ...candidate,
          id: candidate.candidateId,
          position,
          decision: "preselected" as const,
        }));
        plan.briefId = id;
        plan.version += 1;
        plan.updatedAt = now().toISOString();
        persistPlan(plan);
        appendEvent({
          id: `planning:${id}`,
          planId: plan.id,
          eventType: "brief_attach",
          expectedVersion: before.version,
          resultVersion: plan.version,
          before,
          after: plan,
          createdAt: plan.updatedAt,
        });
      } else if (plan && result && latestEligibleMorningBrief(plan.localDate)?.id === id) {
        // Written prose is a saved document. Attaching it never authorizes
        // replacing choices made while the recommendation was being written.
        forceAttachMorningBrief(plan.localDate, id);
      }
      return result;
    });
  }

  function planningSelection(artifact: MorningBriefArtifact | undefined):
    | Array<{
        candidate: RecommendationCandidate;
        brief?: import("./types").DayPlanItemBriefAnnotation;
      }>
    | undefined {
    if (!artifact?.briefJson) return undefined;
    const raw = JSON.parse(artifact.briefJson);
    if (!raw.dailyDecision || !Array.isArray(raw.planningCandidates))
      return undefined;
    return raw.planningCandidates
      .filter((candidate: RecommendationCandidate) => {
        const ref = candidate.planningRef;
        if (!ref) return false;
        const source = sourceRecord(db, ref.kind, ref.id);
        return source && activeResponsibilitySource(source);
      })
      .map((candidate: RecommendationCandidate) => ({ candidate }));
  }

  function projectedPlan(plan: DayPlan) {
    return resolvePlanningItems(db, plan);
  }

  function planningReadBundle() {
    return immediate(() => {
      const model = getReadModel();
      if (!model.currentPlan) return { model };
      const plan = resolvePlanningItems(db, model.currentPlan);
      if (!isDeepStrictEqual(plan.items, model.currentPlan.items)) {
        const before = model.currentPlan;
        plan.version += 1;
        plan.updatedAt = now().toISOString();
        persistPlan(plan);
        appendEvent({
          id: `source-refresh:${plan.id}:${plan.version}`,
          planId: plan.id,
          eventType: "source_reconcile",
          expectedVersion: before.version,
          resultVersion: plan.version,
          before,
          after: plan,
          createdAt: plan.updatedAt,
        });
        // One bounded regeneration per newly observed source revision. Queue
        // deduplication coalesces concurrent changes; failures remain visible.
        if (plan.state === "proposed" && !plan.arrivalInteractedAt &&
            plan.items.some((i) => i.planningStale))
          enqueueMorningBrief(plan.localDate, morningBriefModelConfig());
      }
      const latest = latestEligibleMorningBrief(plan.localDate);
      // Repair older successful daily briefs that were saved but never attached
      // after a concurrent human edit. Only the document changes, never items.
      if (latest && latest.id !== plan.briefId && morningBriefFromArtifact(latest)?.dailyDecision &&
          forceAttachMorningBrief(plan.localDate, latest.id)) plan.briefId = latest.id;
      const artifact = plan.briefId ? getMorningBrief(plan.briefId) : undefined;
      const brief = projectPlanningBrief(db, plan, artifact);
      if (plan.state !== "draft" && plan.state !== "proposed") delete brief.statusNote;
      const recommendationsAccepted = latest && db.prepare(
        "SELECT 1 FROM day_plan_events WHERE day_plan_id=? AND event_type='plan_revision_accept' AND json_extract(after_json,'$.briefId')=? LIMIT 1",
      ).get(plan.id, latest.id);
      const latestHasUnappliedRecommendations = latest?.briefJson && !recommendationsAccepted
        ? !Array.isArray(JSON.parse(latest.briefJson).planningCandidates)
        : false;
      if (plan.state === "proposed" && latest &&
          (latest.id !== plan.briefId || latestHasUnappliedRecommendations)) {
        const proposal = morningBriefFromArtifact(latest)?.dailyDecision;
        if (proposal) {
          brief.proposalId = latest.id;
          brief.proposedActions = proposal.actions.map((a) => ({
            title: a.nextAction,
            reason: a.rationale,
          }));
          const proposedItems = JSON.parse(latest.briefJson!)
            .proposalCandidates as RecommendationCandidate[] | undefined;
          if (proposedItems?.length) {
            const watches = projectPlanningBrief(
              db,
              {
                ...plan,
                items: proposedItems.map((candidate, position) => ({
                  ...candidate,
                  id: candidate.candidateId,
                  position,
                  decision: "pending" as const,
                })),
              },
              undefined,
            ).watchItems;
            brief.watchItems = [...brief.watchItems, ...watches].filter(
              (watch, index, all) =>
                all.findIndex((other) => other.recordId === watch.recordId) ===
                index,
            );
          }
          brief.statusNote =
            "Your current choices are preserved. A new recommendation is ready to review.";
        }
      }
      return { model: { ...model, currentPlan: plan }, brief };
    });
  }

  function completeMorningBrief(
    id: string,
    briefJson: string,
  ): MorningBriefArtifact | undefined {
    return immediate(() => {
      const finishedAt = now().toISOString();
      // Only a running row can succeed. A late finisher whose row was already
      // interrupted stays failed, so it can never clobber a newer artifact.
      const changed = db
        .prepare(
          `UPDATE day_plan_briefs
           SET status = 'succeeded', brief_json = ?, error_code = NULL,
               finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(briefJson, finishedAt, finishedAt, id).changes;
      return changed > 0 ? getMorningBrief(id) : undefined;
    });
  }

  function stageMorningBriefBoardActions(artifactId: string): number {
    return immediate(() => {
      const artifact = getMorningBrief(artifactId);
      const brief = morningBriefFromArtifact(artifact);
      if (!artifact || !brief) return 0;
      const stagedAt = now().toISOString();
      const newest = db.prepare(
        `SELECT id FROM day_plan_briefs
         WHERE target_local_date = ? AND status = 'succeeded'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(artifact.targetLocalDate) as { id: string } | undefined;
      const stagedState: MorningBriefActionRow["state"] =
        newest?.id === artifactId ? "staged" : "skipped_late";
      db.prepare(
        `UPDATE day_plan_brief_actions
         SET state = 'skipped_late', terminal_at = ?
         WHERE state = 'staged'
           AND artifact_id IN (
             SELECT id FROM day_plan_briefs
             WHERE target_local_date = ? AND status = 'succeeded'
               AND (
                 created_at < ? OR (created_at = ? AND id < ?)
               )
           )`,
      ).run(
        stagedAt,
        artifact.targetLocalDate,
        artifact.createdAt,
        artifact.createdAt,
        artifact.id,
      );
      const insert = db.prepare(
        `INSERT OR IGNORE INTO day_plan_brief_actions
          (artifact_id, action_index, op_json, action_hash,
           expected_task_updated_at, state, why, terminal_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let inserted = 0;
      brief.boardActions.forEach((action, actionIndex) => {
        const opJson = JSON.stringify(action);
        const actionHash = createHash("sha256").update(opJson, "utf8").digest("hex");
        inserted += insert.run(
          artifactId,
          actionIndex,
          opJson,
          actionHash,
          "expectedTaskUpdatedAt" in action ? action.expectedTaskUpdatedAt : "",
          stagedState,
          action.why,
          stagedState === "skipped_late" ? stagedAt : null,
        ).changes;
      });
      return inserted;
    });
  }

  function managedTask(id: string): ManagedTaskRow | undefined {
    return db.prepare(
      `SELECT id, column_id, title, description, priority, due_at, due_date,
              tags, project, position, status, archived_at, archived_from_status,
              recurring_template_id, occurrence_local_date, created_at, updated_at
       FROM tasks WHERE id = ?`,
    ).get(id) as ManagedTaskRow | undefined;
  }

  function managedTaskOfflimits(task: ManagedTaskRow | undefined): boolean {
    if (!task || task.status !== "open" || task.recurring_template_id) return true;
    if (task.column_id) {
      const column = db.prepare(
        "SELECT name FROM task_columns WHERE id = ?",
      ).get(task.column_id) as { name: string } | undefined;
      if (column && taskColumnKeyForName(column.name) === "done") return true;
    }
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(task.tags ?? "[]");
      tags = Array.isArray(parsed)
        ? parsed.filter((tag): tag is string => typeof tag === "string")
        : [];
    } catch {
      tags = (task.tags ?? "").split(",");
    }
    const normalized = tags.map((tag) => tag.trim().toLowerCase());
    return (
      normalized.includes("jarvis-held") ||
      normalized.includes("email-current") ||
      normalized.includes("recurring")
    );
  }

  const SNAPSHOT_TITLE_LIMIT = 240;
  const SNAPSHOT_DESCRIPTION_LIMIT = 2_000;
  const SNAPSHOT_TAGS_LIMIT = 500;
  const SNAPSHOT_PROJECT_LIMIT = 240;
  const SNAPSHOT_TRUNCATION_MARKER = "… [truncated]";

  function boundedSnapshotText(value: string, limit: number): string {
    return value.length <= limit
      ? value
      : value.slice(0, limit - SNAPSHOT_TRUNCATION_MARKER.length) +
        SNAPSHOT_TRUNCATION_MARKER;
  }

  function managedTaskSnapshot(task: ManagedTaskRow | undefined): ManagedTaskRow | undefined {
    if (!task) return undefined;
    return {
      ...task,
      title: boundedSnapshotText(task.title, SNAPSHOT_TITLE_LIMIT),
      description: task.description === null
        ? null
        : boundedSnapshotText(task.description, SNAPSHOT_DESCRIPTION_LIMIT),
      tags: task.tags === null
        ? null
        : boundedSnapshotText(task.tags, SNAPSHOT_TAGS_LIMIT),
      project: task.project === null
        ? null
        : boundedSnapshotText(task.project, SNAPSHOT_PROJECT_LIMIT),
    };
  }

  function managedText(
    value: string,
    maxLength: number,
    options: { preserveFormatting?: boolean } = {},
  ): string {
    let cleaned = "";
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0;
      if (
        (code < 32 || code === 127) &&
        !(options.preserveFormatting && (character === "\n" || character === "\t"))
      ) continue;
      if (cleaned.length + character.length > maxLength) break;
      cleaned += character;
    }
    return cleaned;
  }

  function managedDueLocalDate(value: string | null): boolean {
    return (
      value === null || (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      value >= "2024-01-01" &&
      value <= "2036-12-31")
    );
  }

  function normalizedManagedTaskTitle(value: string): string {
    return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  /** A task finished this recently still blocks a brief from creating the same title again. */
  const RECENT_TASK_DAYS = 14;

  function activateBriefBoardActions(targetLocalDate: string, activationNow: Date = now()) {
    const hasStagedActions = db.prepare(
      `SELECT 1 FROM day_plan_brief_actions actions
       JOIN day_plan_briefs briefs ON briefs.id = actions.artifact_id
       WHERE actions.state = 'staged' AND briefs.target_local_date = ?
         AND briefs.status = 'succeeded'
         AND briefs.prompt_version = ? AND briefs.schema_version = ?
       LIMIT 1`,
    ).get(
      targetLocalDate,
      MORNING_BRIEF_PROMPT_VERSION,
      MORNING_BRIEF_SCHEMA_VERSION,
    );
    if (!hasStagedActions) {
      return { activated: false, applied: 0, skippedConflict: 0, skippedOfflimits: 0 };
    }
    return immediate(() => {
      const targetPlanRow = selectDatePlan.get(targetLocalDate) as
        | DayPlanRow | undefined;
      const openPlanRow = selectOpenPlan.get() as DayPlanRow | undefined;
      const timezone = targetPlanRow?.timezone ?? openPlanRow?.timezone ?? operatorTimezone();
      if (localDateInTimezone(activationNow.toISOString(), timezone) !== targetLocalDate) {
        return { activated: false, applied: 0, skippedConflict: 0, skippedOfflimits: 0 };
      }
      const artifact = db.prepare(
        `SELECT briefs.* FROM day_plan_briefs briefs
         WHERE briefs.target_local_date = ? AND briefs.status = 'succeeded'
           AND briefs.prompt_version = ? AND briefs.schema_version = ?
         ORDER BY briefs.created_at DESC, briefs.id DESC LIMIT 1`,
      ).get(
        targetLocalDate,
        MORNING_BRIEF_PROMPT_VERSION,
        MORNING_BRIEF_SCHEMA_VERSION,
      ) as MorningBriefRow | undefined;
      if (!artifact) {
        return { activated: false, applied: 0, skippedConflict: 0, skippedOfflimits: 0 };
      }
      const rows = db.prepare(
        `SELECT * FROM day_plan_brief_actions
         WHERE artifact_id = ? AND state = 'staged'
         ORDER BY action_index`,
      ).all(artifact.id) as MorningBriefActionRow[];
      if (rows.length === 0) {
        return { activated: false, applied: 0, skippedConflict: 0, skippedOfflimits: 0 };
      }
      const terminalAt = activationNow.toISOString();
      if (
        targetPlanRow &&
        (targetPlanRow.plan_state !== "proposed" || targetPlanRow.arrival_interacted_at)
      ) {
        db.prepare(
          `UPDATE day_plan_brief_actions
           SET state = 'skipped_late', terminal_at = ?
           WHERE artifact_id = ? AND state = 'staged'`,
        ).run(terminalAt, artifact.id);
        return { activated: false, applied: 0, skippedConflict: 0, skippedOfflimits: 0 };
      }
      const columnIds = new Map<string, string>();
      for (const row of db.prepare("SELECT id, name FROM task_columns").all() as Array<{ id: string; name: string }>) {
        const key = taskColumnKeyForName(row.name);
        if (key) columnIds.set(key, row.id);
      }
      const originalTasks = new Map<string, ManagedTaskRow | undefined>();
      for (const row of rows) {
        const action = JSON.parse(row.op_json) as MorningBriefBoardAction;
        if (action.op !== "create_task" && !originalTasks.has(action.taskId)) {
          originalTasks.set(action.taskId, managedTask(action.taskId));
        }
      }
      let applied = 0;
      let skippedConflict = 0;
      let skippedOfflimits = 0;
      const outcomes: Array<Record<string, unknown>> = [];
      const finish = db.prepare(
        `UPDATE day_plan_brief_actions
         SET state = ?, before_json = ?, after_json = ?, terminal_at = ?
         WHERE artifact_id = ? AND action_index = ? AND state = 'staged'`,
      );
      for (const row of rows) {
        const action = JSON.parse(row.op_json) as MorningBriefBoardAction;
        const taskId = action.op === "create_task"
          ? morningBriefCreatedTaskId(artifact.id, row.action_index)
          : action.taskId;
        let resolvedTaskId = taskId;
        const original = action.op === "create_task" ? undefined : originalTasks.get(taskId);
        const before = managedTask(taskId);
        const beforeSnapshot = managedTaskSnapshot(before);
        const beforeJson = beforeSnapshot ? JSON.stringify(beforeSnapshot) : null;
        let state: MorningBriefActionRow["state"];
        if (action.op === "create_task") {
          const title = managedText(action.title, 240).trim();
          const description = managedText(action.description, 4_000, { preserveFormatting: true });
          const normalizedTitle = normalizedManagedTaskTitle(title);
          const recentCutoff = new Date(activationNow.getTime() - RECENT_TASK_DAYS * 86_400_000).toISOString();
          const duplicate = title
            ? (db.prepare(
                `SELECT id, title FROM tasks
                 WHERE status = 'open' OR (status IN ('done', 'archived') AND updated_at >= ?)`,
              ).all(recentCutoff) as Array<{ id: string; title: string }>)
                .find((task) => normalizedManagedTaskTitle(task.title) === normalizedTitle)
            : undefined;
          const columnId = columnIds.get("today");
          if (before || duplicate) {
            if (duplicate) resolvedTaskId = duplicate.id;
            state = "skipped_conflict";
            skippedConflict += 1;
          } else if (!title || !columnId || !managedDueLocalDate(action.dueLocalDate)) {
            state = "skipped_offlimits";
            skippedOfflimits += 1;
          } else {
            const position = (db.prepare(
              "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE column_id = ? AND status = 'open'",
            ).get(columnId) as { position: number }).position;
            const briefReason = typeof action.why === "string" ? originQuote(action.why) : "";
            const briefOrigin = `Suggested by your Morning Brief on ${planDateLabel(targetLocalDate)}. Cove created it when the brief was applied${briefReason ? `: ${briefReason}` : "."}`;
            db.prepare(
              `INSERT INTO tasks
                (id, column_id, title, description, priority, due_at, due_date,
                 tags, project, position, status, origin, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'Atlas', ?, 'open', ?, ?, ?)`,
            ).run(
              taskId,
              columnId,
              title,
              description,
              action.priority,
              action.dueLocalDate,
              action.dueLocalDate,
              position,
              briefOrigin,
              terminalAt,
              terminalAt,
            );
            state = "applied";
            applied += 1;
          }
        } else if (
          !original ||
          !row.expected_task_updated_at ||
          !original.updated_at ||
          original.updated_at !== row.expected_task_updated_at
        ) {
          state = "skipped_conflict";
          skippedConflict += 1;
        } else if (
          managedTaskOfflimits(original) ||
          (action.op === "archive_duplicate" && managedTaskOfflimits(managedTask(action.duplicateOfTaskId)))
        ) {
          state = "skipped_offlimits";
          skippedOfflimits += 1;
        } else {
          const live = before;
          if (managedTaskOfflimits(live)) {
            state = "skipped_offlimits";
            skippedOfflimits += 1;
          } else {
            if (action.op === "move_column") {
              const key = action.column === "in_flight"
                ? "in-progress"
                : action.column === "not_started" ? "not-started" : "today";
              const columnId = columnIds.get(key);
              if (!columnId) {
                state = "skipped_offlimits";
                skippedOfflimits += 1;
              } else {
                const position = (db.prepare(
                  "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE column_id = ? AND status = 'open'",
                ).get(columnId) as { position: number }).position;
                db.prepare("UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?")
                  .run(columnId, position, terminalAt, action.taskId);
                state = "applied";
                applied += 1;
              }
            } else if (action.op === "set_priority") {
              db.prepare("UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?")
                .run(action.priority, terminalAt, action.taskId);
              state = "applied";
              applied += 1;
            } else if (action.op === "set_due") {
              if (!managedDueLocalDate(action.dueLocalDate) || (live?.due_at && live.due_at !== action.dueLocalDate)) {
                state = "skipped_offlimits";
                skippedOfflimits += 1;
              } else {
                db.prepare("UPDATE tasks SET due_at = ?, due_date = ?, updated_at = ? WHERE id = ?")
                  .run(action.dueLocalDate, action.dueLocalDate, terminalAt, action.taskId);
                state = "applied";
                applied += 1;
              }
            } else if (action.op === "retitle") {
              const title = managedText(action.title, 240);
              if (!title) {
                state = "skipped_offlimits";
                skippedOfflimits += 1;
              } else {
                db.prepare("UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?")
                  .run(title, terminalAt, action.taskId);
                state = "applied";
                applied += 1;
              }
            } else if (action.op === "edit_description") {
              db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?")
                .run(
                  managedText(action.description, 4_000, { preserveFormatting: true }),
                  terminalAt,
                  action.taskId,
                );
              state = "applied";
              applied += 1;
            } else {
              db.prepare(
                `UPDATE tasks SET status = 'archived', archived_at = ?,
                   archived_from_status = COALESCE(archived_from_status, status), updated_at = ?
                 WHERE id = ?`,
              ).run(terminalAt, terminalAt, action.taskId);
              state = "applied";
              applied += 1;
            }
          }
        }
        const after = managedTask(resolvedTaskId);
        const afterSnapshot = managedTaskSnapshot(after);
        const afterJson = afterSnapshot ? JSON.stringify(afterSnapshot) : null;
        finish.run(state, beforeJson, afterJson, terminalAt, artifact.id, row.action_index);
        outcomes.push({
          actionIndex: row.action_index,
          actionHash: row.action_hash,
          op: action.op,
          taskId: resolvedTaskId.slice(0, 200),
          ...(action.op === "archive_duplicate"
            ? { duplicateOfTaskId: action.duplicateOfTaskId.slice(0, 200) }
            : {}),
          why: row.why.slice(0, 500),
          state,
          before: beforeSnapshot ?? null,
          after: afterSnapshot ?? null,
        });
      }
      const receiptBase = {
        artifactId: artifact.id,
        applied,
        skippedConflict,
        skippedOfflimits,
      };
      let receiptActions: Record<string, unknown> = { ...receiptBase, outcomes };
      try {
        if (JSON.stringify(receiptActions).length > 80_000) {
          receiptActions = {
            ...receiptBase,
            snapshotsOmitted: true,
            outcomes: outcomes.map((outcome) => {
              const compact = { ...outcome };
              delete compact.before;
              delete compact.after;
              return compact;
            }),
          };
        }
        recordReceiptInDatabase(db, {
          source: "morning-brief-management",
          startedAt: terminalAt,
          finishedAt: terminalAt,
          summary: `Morning brief board pass applied ${applied} changes.`,
          actions: receiptActions,
          outcome: skippedConflict + skippedOfflimits > 0 ? "partial" : "success",
          surfaceFailure: false,
        });
      } catch (error) {
        console.error("Morning brief management receipt skipped.", error);
      }
      return {
        activated: true,
        artifactId: artifact.id,
        applied,
        skippedConflict,
        skippedOfflimits,
      };
    });
  }

  function morningBriefCreatedTaskPicks(
    artifactId: string,
  ): Array<{ taskId: string; whyToday: string }> {
    const rows = db.prepare(
      `SELECT op_json, after_json FROM day_plan_brief_actions
       WHERE artifact_id = ? AND state IN ('applied', 'skipped_conflict')
       ORDER BY action_index`,
    ).all(artifactId) as Array<{ op_json: string; after_json: string | null }>;
    const picks: Array<{ taskId: string; whyToday: string }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      try {
        const action = JSON.parse(row.op_json) as MorningBriefBoardAction;
        if (action.op !== "create_task" || !row.after_json) continue;
        const task = JSON.parse(row.after_json) as Partial<ManagedTaskRow>;
        if (
          typeof task.id !== "string" ||
          !task.id ||
          task.status !== "open" ||
          seen.has(task.id)
        ) continue;
        seen.add(task.id);
        picks.push({ taskId: task.id, whyToday: action.why });
      } catch {
        // A malformed receipt snapshot never becomes plan authority.
      }
    }
    return picks;
  }

  function morningBriefManagementSummary(artifactId: string): string | undefined {
    const counts = db.prepare(
      `SELECT
         SUM(CASE WHEN state = 'applied' THEN 1 ELSE 0 END) AS applied,
         SUM(CASE WHEN state = 'skipped_conflict' THEN 1 ELSE 0 END) AS conflicts,
         SUM(CASE WHEN state = 'skipped_offlimits' THEN 1 ELSE 0 END) AS offlimits,
         SUM(CASE WHEN state = 'staged' THEN 1 ELSE 0 END) AS staged,
         COUNT(*) AS total
       FROM day_plan_brief_actions WHERE artifact_id = ?`,
    ).get(artifactId) as {
      applied: number | null;
      conflicts: number | null;
      offlimits: number | null;
      staged: number | null;
      total: number;
    };
    const applied = counts.applied ?? 0;
    // Conflict-only runs stay silent in Arrival; their details remain in the receipt.
    if (!counts.total || counts.staged || applied === 0) return undefined;
    const parts = [`${applied} board ${applied === 1 ? "change" : "changes"} applied`];
    if (counts.conflicts) {
      parts.push(
        `${counts.conflicts} ${counts.conflicts === 1 ? "change" : "changes"} left alone because you edited ${counts.conflicts === 1 ? "the card" : "those cards"}`,
      );
    }
    if (counts.offlimits) {
      parts.push(`${counts.offlimits} protected ${(counts.offlimits ?? 0) === 1 ? "card" : "cards"} left alone`);
    }
    return `Cove reorganized the board this morning: ${parts.join(", ")}.`;
  }

  function deferMorningBrief(id: string, retryAt: string): void {
    const parsed = Date.parse(retryAt);
    if (!Number.isFinite(parsed) || parsed <= now().getTime()) throw new Error("invalid_brief_retry_time");
    immediate(() => {
      db.prepare(`UPDATE day_plan_briefs
        SET status = 'queued', error_code = ?, started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running'`)
        .run(`${BRIEF_DEFERRED_PREFIX}${new Date(parsed).toISOString()}`, now().toISOString(), id);
    });
  }

  function failMorningBrief(id: string, errorCode: string): void {
    immediate(() => {
      const finishedAt = now().toISOString();
      db.prepare(
        `UPDATE day_plan_briefs
         SET status = 'failed', error_code = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued','running')`,
      ).run(errorCode.slice(0, 200), finishedAt, finishedAt, id);
    });
  }

  // Imports a relay artifact (already deeply validated by the caller) in one
  // transaction, reconciling every local same-key state:
  //   - a local succeeded row for the same composite key wins by earliest
  //     finished_at (identical content, so this only adjusts provenance);
  //   - a local queued/running row for the same date is adopted into a succeeded
  //     row carrying the imported payload (a late local finisher's complete then
  //     no-ops, which the store already tolerates);
  //   - otherwise the artifact is inserted as a new succeeded row.
  // Idempotent and safe against a concurrent local generation of the same
  // envelope. Returns whether a row was written.
  function importMorningBrief(
    artifact: MorningBriefArtifact,
  ): { imported: boolean; adopted: boolean; briefId?: string;
  } {
    if (artifact.status !== "succeeded" || !artifact.briefJson || !artifact.inputHash) {
      return { imported: false, adopted: false };
    }
    return immediate(() => {
      const updatedAt = now().toISOString();
      const importedFinishedAt = artifact.finishedAt ?? artifact.createdAt;
      const sameKey = db
        .prepare(
          `SELECT * FROM day_plan_briefs
           WHERE target_local_date = ? AND input_hash = ?
             AND prompt_version = ? AND schema_version = ? AND status = 'succeeded'
           LIMIT 1`,
        )
        .get(
          artifact.targetLocalDate,
          artifact.inputHash,
          artifact.promptVersion,
          artifact.schemaVersion,
        ) as MorningBriefRow | undefined;
      if (sameKey) {
        // Deterministic winner on a same-key conflict is the earliest
        // finished_at, and the winner's COMPLETE canonical payload is adopted
        // (an identical input hash does not guarantee identical model output).
        // The row id is kept so references stay valid, but a brief a plan has
        // already consumed is pinned: its content must never change under an
        // arrival that was built from it.
        const existingFinished = sameKey.finished_at ?? sameKey.created_at;
        if (importedFinishedAt < existingFinished) {
          const pinned = db
            .prepare("SELECT 1 FROM day_plans WHERE brief_id = ? LIMIT 1")
            .get(sameKey.id);
          if (!pinned) {
            db.prepare(
              `UPDATE day_plan_briefs
               SET source_manifest_json = ?, model_alias = ?, effort = ?, budget_usd = ?,
                   brief_json = ?, created_at = ?, started_at = ?, finished_at = ?, updated_at = ?
               WHERE id = ? AND status = 'succeeded'`,
            ).run(
              artifact.sourceManifest ? JSON.stringify(artifact.sourceManifest) : null,
              artifact.modelAlias,
              artifact.effort,
              artifact.budgetUsd,
              artifact.briefJson,
              artifact.createdAt,
              artifact.startedAt ?? null,
              importedFinishedAt,
              updatedAt,
              sameKey.id,
            );
          }
        }
        return { imported: false, adopted: false };
      }
      // A dead failed row with this composite key would collide with the unique
      // index on insert/adopt; it carries no artifact, so prune it first.
      db.prepare(
        `DELETE FROM day_plan_briefs
         WHERE target_local_date = ? AND input_hash = ?
           AND prompt_version = ? AND schema_version = ? AND status = 'failed'`,
      ).run(
        artifact.targetLocalDate,
        artifact.inputHash,
        artifact.promptVersion,
        artifact.schemaVersion,
      );
      const adoptable = db
        .prepare(
          `SELECT * FROM day_plan_briefs
           WHERE target_local_date = ? AND status IN ('queued','running')
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(artifact.targetLocalDate) as MorningBriefRow | undefined;
      if (adoptable) {
        const changed = db
          .prepare(
            `UPDATE day_plan_briefs
             SET status = 'succeeded', input_hash = ?, prompt_version = ?, schema_version = ?,
                 source_manifest_json = ?, model_alias = ?, effort = ?, budget_usd = ?,
                 brief_json = ?, error_code = NULL, created_at = ?,
                 started_at = COALESCE(started_at, ?), finished_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('queued','running')`,
          )
          .run(
            artifact.inputHash,
            artifact.promptVersion,
            artifact.schemaVersion,
            artifact.sourceManifest ? JSON.stringify(artifact.sourceManifest) : null,
            artifact.modelAlias,
            artifact.effort,
            artifact.budgetUsd,
            artifact.briefJson,
            // The adopted row now carries the artifact's OWN request time, not
            // the local placeholder's. Brief selection orders by created_at, so
            // keeping the local time would let an imported 7:30 brief pose as
            // the 8:05 request that adopted it and outrank a genuinely newer one.
            artifact.createdAt,
            artifact.startedAt ?? null,
            importedFinishedAt,
            updatedAt,
            adoptable.id,
          ).changes;
        if (changed > 0) return { imported: true, adopted: true, briefId: adoptable.id };
        // Raced with a local transition; fall through to a plain insert.
      }
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO day_plan_briefs
            (id, target_local_date, status, input_hash, prompt_version, schema_version,
             source_manifest_json, model_alias, effort, budget_usd, brief_json, error_code,
             created_at, updated_at, started_at, finished_at)
           VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.targetLocalDate,
          artifact.inputHash,
          artifact.promptVersion,
          artifact.schemaVersion,
          artifact.sourceManifest ? JSON.stringify(artifact.sourceManifest) : null,
          artifact.modelAlias,
          artifact.effort,
          artifact.budgetUsd,
          artifact.briefJson,
          artifact.createdAt,
          updatedAt,
          artifact.startedAt ?? null,
          importedFinishedAt,
        ).changes;
      return {
        imported: inserted > 0,
        adopted: false,
        ...(inserted > 0 ? { briefId: artifact.id } : {}),
      };
    });
  }

  function interruptStaleMorningBriefs(staleBefore: string): number {
    return db
      .prepare(
        `UPDATE day_plan_briefs
         SET status = 'failed', error_code = 'worker_interrupted', finished_at = ?, updated_at = ?
         WHERE status = 'running' AND started_at < ?`,
      )
      .run(now().toISOString(), now().toISOString(), staleBefore).changes;
  }

  // Only the "brief me anyway" path calls this. A queued row nothing ever
  // claimed would otherwise make enqueueMorningBrief hand back that same dead
  // row, so the button would render and do nothing. The worker's own sweep
  // deliberately leaves queued rows alone, because a worker starting late still
  // owes him that brief; this runs only when he has asked again himself.
  function abandonStaleQueuedMorningBriefs(staleBefore: string): number {
    return db
      .prepare(
        `UPDATE day_plan_briefs
         SET status = 'failed', error_code = 'never_claimed', finished_at = ?, updated_at = ?
         WHERE status = 'queued' AND created_at < ?`,
      )
      .run(now().toISOString(), now().toISOString(), staleBefore).changes;
  }

  function listRecentSnapshots(limit = 3): DaySnapshot[] {
    return (db
      .prepare(
        "SELECT * FROM day_snapshots ORDER BY local_date DESC, created_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(20, limit))) as SnapshotRow[]).map(snapshotFromRow);
  }

  function hasManualCreationMarker(planId: string): boolean {
    const rows = db.prepare(
      "SELECT after_json FROM day_plan_events WHERE day_plan_id = ? AND event_type = 'ensure'",
    ).all(planId) as Array<{ after_json: string | null }>;
    return rows.some((row) => {
      if (!row.after_json) return false;
      const after = parseJson<unknown>(row.after_json, "event after");
      return Boolean(
        after &&
          typeof after === "object" &&
          !Array.isArray(after) &&
          (after as { creation?: unknown }).creation === "manual",
      );
    });
  }

  // Compatibility repair for pre-gate automatic weekend plans only. It
  // intentionally performs store-level settlement without the route-level
  // recurring expiry, brief enqueue, relay, or checkpoint side effects. The
  // Monday ensure trigger covers the brief. Stable mutation ids make every step
  // replay-safe, and an interrupted settlement resumes on initialization.
  function cleanupWeekendPlan(): void {
    const row = selectOpenPlan.get() as DayPlanRow | undefined;
    if (!row) return;
    let plan = planFromRow(row);
    const today = localDateInTimezone(now().toISOString(), plan.timezone);
    if (!today || plan.localDate >= today || !isWeekendLocalDate(plan.localDate)) return;
    if (
      plan.arrivalInteractedAt ||
      hasManualCreationMarker(plan.id) ||
      plan.items.some((item) => item.decision === "accepted" || item.decision === "completed")
    ) {
      return;
    }

    if (plan.state === "proposed" && plan.arrivalState === "failed") {
      plan = mutateDayPlan({
        planId: plan.id,
        mutationId: `weekend-auto-settle:reopen:${plan.id}`,
        expectedVersion: plan.version,
        action: "arrival_reopen",
      }).plan;
    }
    if (
      plan.state === "proposed" &&
      !["skipped", "bypassed"].includes(plan.arrivalState)
    ) {
      plan = mutateDayPlan({
        planId: plan.id,
        mutationId: `weekend-auto-settle:bypass:${plan.id}`,
        expectedVersion: plan.version,
        action: "arrival_bypass",
      }).plan;
    }
    if (!(plan.state === "settling" && plan.settlementState === "in_progress")) {
      plan = mutateDayPlan({
        planId: plan.id,
        mutationId: `weekend-auto-settle:start:${plan.id}`,
        expectedVersion: plan.version,
        action: "settlement_start",
        completedHumanTaskIds: [],
      }).plan;
    }
    mutateDayPlan({
      planId: plan.id,
      mutationId: `weekend-auto-settle:commit:${plan.id}`,
      expectedVersion: plan.version,
      action: "settlement_commit",
      completedHumanTaskIds: [],
    });
  }

  function initialize(): void {
    cleanupWeekendPlan();
    const open = selectOpenPlan.get() as DayPlanRow | undefined;
    const timezone = open?.timezone ?? operatorTimezone();
    const today = localDateInTimezone(now().toISOString(), timezone);
    if (today) activateBriefBoardActions(today, now());
  }

  function ensureDayPlan(input: EnsureDayPlanInput): EnsureDayPlanResult {
    return immediate(() => {
      const existingEvent = selectEvent.get(input.mutationId) as
        | EventRow | undefined;
      if (existingEvent) {
        // A prior ensure with this id may have either returned/created a plan or
        // late-attached a brief; both replay as an untouched return.
        if (
          existingEvent.event_type !== "ensure" &&
          existingEvent.event_type !== "brief_attach"
        ) {
          throw new DayPlanInvalidTransition("Mutation ID was already used for another action.");
        }
        const replayed = getPlan(existingEvent.day_plan_id);
        if (!replayed) throw new DayPlanNotFound();
        return { plan: replayed, snapshot: getSnapshot(replayed.id), replayed: true };
      }

      const existingRow =
        (selectOpenPlan.get() as DayPlanRow | undefined) ??
        (selectDatePlan.get(input.localDate) as DayPlanRow | undefined);
      if (existingRow) {
        const existing = planFromRow(existingRow);
        // Guarded arrival heal. Fresh candidates can fill a pristine plan that
        // was created before board work existed, and a late brief can attach in
        // the same versioned mutation. All guards live in this transaction.
        const attached = maybeLateAttachBrief(existing, input);
        if (attached) {
          return { plan: attached, snapshot: getSnapshot(attached.id), replayed: false };
        }
        // Attach-only (the 15s late-brief poll): nothing attached, so this is a
        // deliberate silent no-op with no ledger event, and the mutation id stays
        // unconsumed, so a repeating poll never grows the ledger. Only a real
        // attach above records anything (as its brief_attach event).
        if (input.attachOnly) {
          return { plan: existing, snapshot: getSnapshot(existing.id), replayed: false };
        }
        appendEvent({
          id: input.mutationId,
          planId: existing.id,
          eventType: "ensure",
          resultVersion: existing.version,
          after: { returnedExisting: true },
          createdAt: now().toISOString(),
        });
        return { plan: existing, snapshot: getSnapshot(existing.id), replayed: false };
      }

      // Attach-only must never create a plan (the poll only runs against an
      // existing arrival; a vanished plan means the ritual moved on).
      if (input.attachOnly) throw new DayPlanNotFound();

      const creation = input.creation ?? "automatic";
      if (creation === "automatic" && isWeekendLocalDate(input.localDate)) {
        return {
          weekendGate: {
            localDate: input.localDate,
            weekday: new Intl.DateTimeFormat("en-US", {
              weekday: "long",
              timeZone: "UTC",
            }).format(new Date(`${input.localDate}T12:00:00.000Z`)) as
              | "Saturday"
              | "Sunday",
          },
          replayed: false,
        };
      }

      assertArrivalCandidates(input.candidates);

      const createdAt = now().toISOString();
      const id = randomUUID();
      // Consume today's Morning Brief when a valid one exists: its ranking,
      // rationale, and owner suggestions overlay the fresh candidate pool, and
      // deterministic order backfills anything the brief missed or that
      // vanished. Any brief problem falls open to the deterministic proposal.
      let briefArtifact: MorningBriefArtifact | undefined;
      let briefContent: ReturnType<typeof morningBriefFromArtifact>;
      let selection: ReturnType<typeof overlayBriefOnCandidates>;
      // One fallback boundary around lookup, parse, AND overlay: any defect in
      // a stored brief (including one the deep parse cannot anticipate) must
      // degrade to the deterministic proposal, never fail the ensure.
      try {
        briefArtifact = latestEligibleMorningBrief(input.localDate);
        briefContent = morningBriefFromArtifact(briefArtifact);
        if (briefContent?.dailyDecision && !planningSelection(briefArtifact)) {
          briefArtifact = undefined;
          briefContent = undefined;
        }
        selection =
          planningSelection(briefArtifact) ??
          overlayBriefOnCandidates(input.candidates, briefContent);
      } catch {
        briefArtifact = undefined;
        briefContent = undefined;
        selection = overlayBriefOnCandidates(input.candidates, undefined);
      }
      const items: DayPlanItem[] = selection.map(({ candidate, brief }, position) => ({
        ...structuredClone(candidate),
        id: candidate.candidateId,
        position,
        decision: "preselected",
        ...(brief
          ? {
              brief,
              // The owner suggestion is preselected but fully overridable in arrival.
              owner: brief.suggestedOwner ?? candidate.owner,
            }
          : {}),
      }));
      const plan: DayPlan = {
        id,
        localDate: input.localDate,
        timezone: input.timezone,
        state: "proposed",
        arrivalState: "due",
        settlementState: "not_due",
        version: 1,
        lastMutationId: input.mutationId,
        items,
        briefId: briefContent && briefArtifact ? briefArtifact.id : undefined,
        createdAt,
        updatedAt: createdAt,
      };

      db.prepare(
        `INSERT INTO day_plans
          (id, local_date, timezone, open_slot, plan_state, arrival_state, settlement_state,
           version, last_mutation_id, items_json, brief_id, arrival_interacted_at,
           created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        plan.id,
        plan.localDate,
        plan.timezone,
        plan.state,
        plan.arrivalState,
        plan.settlementState,
        plan.version,
        plan.lastMutationId,
        JSON.stringify(plan.items),
        plan.briefId ?? null,
        plan.createdAt,
        plan.updatedAt,
      );
      appendEvent({
        id: input.mutationId,
        planId: plan.id,
        eventType: "ensure",
        resultVersion: plan.version,
        after: { ...plan, creation },
        createdAt,
      });
      return { plan, replayed: false };
    });
  }

  // Shared candidate-evidence validation for the arrival. Both plan creation and
  // the guarded late-attach must only ever build items from candidates carrying
  // current, unconflicted, single-source task evidence.
  function assertArrivalCandidates(candidates: RecommendationCandidate[]): void {
    if (candidates.length > 10) {
      throw new DayPlanInvalidTransition("Arrival supports at most ten candidates.");
    }
    if (
      new Set(candidates.map((candidate) => candidate.taskId)).size !== candidates.length ||
      new Set(candidates.map((candidate) => candidate.outcomeKey)).size !== candidates.length
    ) {
      throw new DayPlanInvalidTransition("Arrival candidates must be unique.");
    }
    if (
      candidates.some(
        (candidate) =>
          candidate.commitment !== "ink" ||
          candidate.conflicts.length > 0 ||
          candidate.sourceRefs.length !== 1 ||
          candidate.sourceRefs[0].sourceType !== "task" ||
          candidate.sourceRefs[0].recordId !== candidate.taskId ||
          candidate.sourceRefs[0].freshness !== "current",
      )
    ) {
      throw new DayPlanInvalidTransition(
        "Arrival candidates require current accepted task evidence.",
      );
    }
  }

  // Heals an empty pristine arrival from fresh candidates and attaches today's
  // eligible brief when one exists. Existing non-empty behavior remains the
  // guarded late-attach path. Runs inside the caller's immediate() transaction;
  // any malformed candidate or brief fails open to the existing plan.
  function maybeLateAttachBrief(
    existing: DayPlan,
    input: EnsureDayPlanInput,
  ): DayPlan | undefined {
    try {
      if (existing.state !== "draft" && existing.state !== "proposed") return undefined;
      if (
        existing.arrivalState !== "not_due" &&
        existing.arrivalState !== "due" &&
        existing.arrivalState !== "opened"
      ) return undefined;
      // The durable no-hot-swap guard: any interaction closes the window.
      if (existing.arrivalInteractedAt) return undefined;
      if (existing.items.length > 0 && !existing.items.every((item) => item.decision === "preselected")) {
        return undefined;
      }
      // Brief attachment is independent from item evidence. Empty candidates
      // can attach the narrative, but only fresh candidates may heal or rebuild
      // the plan's items.
      if (input.candidates.length > 0) assertArrivalCandidates(input.candidates);

      let briefArtifact: MorningBriefArtifact | undefined;
      let briefContent: ReturnType<typeof morningBriefFromArtifact>;
      try {
        if (existing.briefId) {
          // A plan that already consumed a brief still upgrades to a strictly
          // newer one for the same day: settling last night regenerates the
          // brief, and without this the better artifact is written, paid for,
          // and orphaned. Ordering is by request time, never finish time, so a
          // slow older generation can never clobber a fresher one. The
          // no-hot-swap guard above still applies: once he has touched the
          // arrival, nothing swaps underneath him.
          const current = getMorningBrief(existing.briefId);
          const currentContent = morningBriefFromArtifact(current);
          const newest = latestEligibleMorningBrief(existing.localDate);
          const supersedes = Boolean(
            newest &&
              newest.id !== existing.briefId &&
              (!current || newest.createdAt > current.createdAt),
          );
          // Only swap to a replacement that actually parses; a newer artifact
          // we cannot read is worse than the readable one already attached.
          const newestContent = supersedes ? morningBriefFromArtifact(newest) : undefined;
          if (newest && newestContent) {
            briefArtifact = newest;
            briefContent = newestContent;
          } else {
            briefArtifact = current;
            briefContent = currentContent;
          }
        } else {
          briefArtifact = latestEligibleMorningBrief(existing.localDate);
          briefContent = morningBriefFromArtifact(briefArtifact);
        }
      } catch {
        briefArtifact = undefined;
        briefContent = undefined;
      }
      if (briefContent?.dailyDecision && !planningSelection(briefArtifact))
        return undefined;
      const attachesBrief = Boolean(
        briefArtifact &&
        briefContent &&
        briefArtifact.id !== existing.briefId,
      );
      const healsItems = existing.items.length === 0 && input.candidates.length > 0;
      if (!healsItems && !attachesBrief) return undefined;

      const planned = planningSelection(briefArtifact);
      const items: DayPlanItem[] =
        planned || input.candidates.length > 0
        ? (
              planned ??
              overlayBriefOnCandidates(input.candidates, briefContent)
            )
            .map(({ candidate, brief }, position) => ({
              ...structuredClone(candidate),
              id: candidate.candidateId,
              position,
              decision: "preselected" as const,
              ...(brief
                ? { brief, owner: brief.suggestedOwner ?? candidate.owner }
                : {}),
            }))
        : existing.items;

      const changedAt = now().toISOString();
      const attached: DayPlan = {
        ...existing,
        items,
        briefId: attachesBrief ? briefArtifact!.id : existing.briefId,
        version: existing.version + 1,
        lastMutationId: input.mutationId,
        updatedAt: changedAt,
      };
      persistPlan(attached);
      appendEvent({
        id: input.mutationId,
        planId: attached.id,
        eventType: attachesBrief ? "brief_attach" : "ensure",
        resultVersion: attached.version,
        before: existing,
        after: attached,
        createdAt: changedAt,
      });
      return attached;
    } catch {
      return undefined;
    }
  }

  // Durably records the first arrival interaction without bumping the plan
  // version (so it never conflicts with the client's in-flight expectedVersion).
  // Only stamps a still-pristine, proposed arrival; anything else is a safe
  // no-op. Called directly by content mutations that live outside mutateDayPlan
  // (assistant turns, execution configure/kickoff).
  function stampArrivalInteraction(planId: string, at: string): void {
    db.prepare(
      `UPDATE day_plans
       SET arrival_interacted_at = COALESCE(arrival_interacted_at, ?)
       WHERE id = ? AND plan_state = 'proposed' AND arrival_state IN ('due','opened')`,
    ).run(at, planId);
  }

  // Attach saved prose independently from recommendation adoption. This is
  // used by an explicit Generate request and a late successful daily decision.
  // Items and version stay unchanged so concurrent human edits retain authority.
  function forceAttachMorningBrief(localDate: string, briefId: string): boolean {
    return immediate(() => {
      const plan = getPlanForDate(localDate);
      if (!plan || plan.briefId === briefId) return false;
      // Start My Day pins the written brief, including any existing saved
      // narrative. Late results remain available as artifacts only.
      if (plan.state !== "draft" && plan.state !== "proposed") return false;
      const artifact = getMorningBrief(briefId);
      const newBrief = morningBriefFromArtifact(artifact);
      if (!newBrief || artifact?.targetLocalDate !== localDate) return false;
      const changed = db
        .prepare("UPDATE day_plans SET brief_id = ?, updated_at = ? WHERE id = ?")
        .run(briefId, now().toISOString(), plan.id).changes;
      return changed > 0;
    });
  }

  // The explicit, idempotent interaction marker the client fires on first
  // meaningful touch (card expansion, typing in the refine box). Idempotent on
  // the mutation id via the event ledger; never bumps the version.
  function markArrivalInteraction(
    planId: string,
    mutationId: string,
  ): { plan: DayPlan; replayed: boolean } {
    return immediate(() => {
      const existingEvent = selectEvent.get(mutationId) as EventRow | undefined;
      if (existingEvent) {
        if (existingEvent.event_type !== "arrival_interact") {
          throw new DayPlanInvalidTransition("Mutation ID was already used for another action.");
        }
        const replayed = getPlan(existingEvent.day_plan_id);
        if (!replayed) throw new DayPlanNotFound();
        return { plan: replayed, replayed: true };
      }
      const plan = getPlan(planId);
      if (!plan) throw new DayPlanNotFound();
      const at = now().toISOString();
      stampArrivalInteraction(planId, at);
      const updated = getPlan(planId) ?? plan;
      appendEvent({
        id: mutationId,
        planId,
        eventType: "arrival_interact",
        resultVersion: updated.version,
        after: { arrivalInteractedAt: updated.arrivalInteractedAt },
        createdAt: at,
      });
      return { plan: updated, replayed: false };
    });
  }

  function mutateDayPlan(input: DayPlanMutationInput): DayPlanMutationResult {
    return immediate(() => {
      const existingEvent = selectEvent.get(input.mutationId) as
        | EventRow | undefined;
      if (existingEvent) {
        if (
          existingEvent.day_plan_id !== input.planId ||
          existingEvent.event_type !== input.action
        ) {
          throw new DayPlanInvalidTransition("Mutation ID was already used for another action.");
        }
        const replayed = getPlan(input.planId);
        if (!replayed) throw new DayPlanNotFound();
        const replayedRuns = input.action === "start_day"
          ? listExecutionRuns(replayed.id).filter(
              (run) => run.idempotencyKey.startsWith(`${input.mutationId}:kickoff:`),
            )
          : [];
        const replayedAfter = existingEvent.after_json
          ? parseJson<unknown>(existingEvent.after_json, "event after")
          : undefined;
        const replayedSkips = input.action === "start_day" && replayedAfter &&
            typeof replayedAfter === "object" && !Array.isArray(replayedAfter) &&
            Array.isArray((replayedAfter as { kickoffSkips?: unknown }).kickoffSkips)
          ? (replayedAfter as { kickoffSkips: DayPlanKickoffSkip[] }).kickoffSkips
          : [];
        const replayedUnready = replayedSkips
          .filter((skip) => skip.reason === "not_ready" && skip.readiness)
          .map((skip) => ({
            itemId: skip.itemId,
            taskId: skip.taskId,
            title: skip.title,
            readiness: skip.readiness!,
          }));
        return {
          plan: replayed,
          snapshot: getSnapshot(input.planId),
          pendingReconciliations: listPendingReconciliations(),
          executionRuns: replayedRuns.length > 0 ? replayedRuns : undefined,
          unreadyItems: replayedUnready.length > 0 ? replayedUnready : undefined,
          kickoffSkips: replayedSkips.length > 0 ? replayedSkips : undefined,
          replayed: true,
        };
      }

      const plan = getPlan(input.planId);
      if (!plan) throw new DayPlanNotFound();
      if (plan.version !== input.expectedVersion) {
        throw new DayPlanVersionConflict(plan);
      }
      if (plan.state === "settled" || plan.state === "abandoned") {
        throw new DayPlanInvalidTransition(`Day plan is already ${plan.state}.`);
      }

      const before = clonePlan(plan);
      const changedAt = now().toISOString();
      let snapshot: DaySnapshot | undefined;
      const executionRuns: DayPlanExecutionRun[] = [];
      const unreadyItems: DayPlanUnreadyItem[] = [];
      const kickoffSkips: DayPlanKickoffSkip[] = [];
      let settlementOrigin: "active" | "proposed" | undefined;

      switch (input.action) {
        case "arrival_open":
          requireState(
            plan.arrivalState,
            ["not_due", "due", "snoozed", "failed"],
            "Arrival cannot open from its current state.",
          );
          plan.arrivalState = "opened";
          plan.snoozedUntil = undefined;
          break;
        case "arrival_snooze": {
          requireState(
            plan.arrivalState,
            ["due", "opened"],
            "Arrival can be snoozed only once while due or open.",
          );
          const snoozedUntil = input.snoozedUntil
            ? new Date(input.snoozedUntil)
            : undefined;
          if (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= now()) {
            throw new DayPlanInvalidTransition("Snooze time must be in the future.");
          }
          plan.arrivalState = "snoozed";
          plan.snoozedUntil = snoozedUntil.toISOString();
          break;
        }
        case "arrival_skip":
          requireState(
            plan.arrivalState,
            ["not_due", "due", "opened", "snoozed"],
            "Arrival cannot be skipped from its current state.",
          );
          plan.arrivalState = "skipped";
          plan.snoozedUntil = undefined;
          if (plan.state === "proposed") activatePlanWithoutKickoff(plan, input.mutationId, changedAt, true);
          break;
        case "arrival_bypass":
          requireState(
            plan.arrivalState,
            ["not_due", "due", "opened", "snoozed"],
            "Arrival cannot be bypassed from its current state.",
          );
          plan.arrivalState = "bypassed";
          plan.snoozedUntil = undefined;
          if (plan.state === "proposed" && !isWeekendAutoSettleMutation(input.mutationId)) {
            activatePlanWithoutKickoff(plan, input.mutationId, changedAt, true);
          }
          break;
        case "arrival_reopen":
          if (plan.state === "proposed") {
            requireState(
              plan.arrivalState,
              ["skipped", "bypassed", "failed"],
              "Arrival cannot be reopened from its current state.",
            );
          } else {
            requireState(
              plan.state,
              ["active", "settling"],
              "Arrival cannot be reopened from its current state.",
            );
            if (plan.state === "settling" && plan.settlementState !== "in_progress") {
              throw new DayPlanInvalidTransition(
                "Arrival cannot reopen from an invalid settlement state.",
              );
            }
            if (plan.state === "settling") {
              quiesceExecutionRunsForPlanItems(plan, changedAt);
              plan.state = "proposed";
              plan.settlementState = "not_due";
              plan.recommendedFirstItemId = undefined;
              plan.recommendedFirstTaskId = undefined;
              plan.confirmedAt = undefined;
              for (const item of plan.items) item.settlementDecision = undefined;
            }
          }
          plan.arrivalState = "opened";
          plan.snoozedUntil = undefined;
          break;
        case "item_accept": {
          requireArrivalEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["pending", "preselected"],
            "Only a proposed item can be accepted.",
          );
          acceptPlanningProposal(db, item, new Date(changedAt));
          item.decision = "accepted";
          break;
        }
        case "item_edit": {
          requireArrivalEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["pending", "preselected", "accepted"],
            "A resolved item cannot be edited.",
          );
          const title = cleanOptional(input.title);
          const outcome = cleanOptional(input.outcome);
          if (input.title !== undefined && !title) {
            throw new DayPlanInvalidTransition("Item title cannot be empty.");
          }
          if (input.outcome !== undefined && !outcome) {
            throw new DayPlanInvalidTransition("Item outcome cannot be empty.");
          }
          if (title) {
            item.title = title;
            if (item.planningRef) {
              const changed = db
                .prepare(
                  "UPDATE cove_responsibilities SET next_action=?,revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=? AND revision=?",
                )
                .run(
                  title,
                  changedAt,
                  item.planningRef.kind,
                  item.planningRef.id,
                  item.planningRef.revision,
                ).changes;
              if (!changed) throw new DayPlanVersionConflict(getPlan(plan.id)!);
              item.planningRef.revision += 1;
            }
          }
          if (outcome) item.outcome = outcome;
          if (input.definitionOfDone !== undefined) {
            item.definitionOfDone = cleanOptional(input.definitionOfDone);
          }
          break;
        }
        case "item_later": {
          requireArrivalEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["pending", "preselected", "accepted"],
            "A resolved item cannot be set aside.",
          );
          item.decision = "later";
          plan.items = [
            ...plan.items.filter((candidate) => candidate.id !== item.id),
            item,
          ];
          plan.items.forEach((candidate, index) => {
            candidate.position = index;
          });
          break;
        }
        case "item_dismiss": {
          requireArrivalEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["pending", "preselected", "accepted"],
            "A resolved item cannot be dismissed.",
          );
          item.decision = "dismissed";
          plan.items = [
            ...plan.items.filter((candidate) => candidate.id !== item.id),
            item,
          ];
          plan.items.forEach((candidate, index) => {
            candidate.position = index;
          });
          break;
        }
        case "item_add": {
          requirePlanOrdering(plan);
          const addedDecision = plan.state === "active" ? "accepted" : "preselected";
          const activeCount = plan.items.filter(
            (item) =>
              item.decision === "pending" ||
              item.decision === "preselected" ||
              item.decision === "accepted",
          ).length;
          const taskId = cleanOptional(input.taskId);
          if (taskId) {
            const existing = plan.items.find((item) => item.taskId === taskId);
            if (
              existing &&
              (existing.decision === "pending" ||
                existing.decision === "preselected" ||
                existing.decision === "accepted")
            ) {
              throw new DayPlanInvalidTransition("That task is already in Today.");
            }
            if (existing?.decision === "completed") {
              throw new DayPlanInvalidTransition("That task is already complete.");
            }
            const task = managedTask(taskId);
            if (managedTaskOfflimits(task)) {
              throw new DayPlanInvalidTransition(
                "That task is not available for today's plan.",
              );
            }
            const taskPriority = task!.priority === "high" || task!.priority === "low"
              ? task!.priority
              : "medium";
            const title = task!.title.trim();
            if (!title) {
              throw new DayPlanInvalidTransition("That task needs a title.");
            }
            const description = task!.description?.trim();
            const dueAt = task!.due_at ?? task!.due_date ?? undefined;
            const itemId = existing?.id ?? randomUUID();
            const hydrated: DayPlanItem = {
              ...(existing ?? ({} as DayPlanItem)),
              id: itemId,
              candidateId: existing?.candidateId ?? itemId,
              taskId,
              outcomeKey: `task:${taskId}`,
              title,
              outcome: description || title,
              definitionOfDone: existing?.definitionOfDone ?? description ?? title,
              project: task!.project?.trim() || undefined,
              owner: existing?.owner ?? "me",
              commitment: "ink",
              whyToday: existing?.whyToday ?? "Added from Not today.",
              priority: taskPriority,
              dueAt,
              sourceRefs: [{
                sourceType: "task",
                recordId: taskId,
                sourceUpdatedAt: task!.updated_at ?? changedAt,
                refreshedAt: changedAt,
                freshness: "current",
                supports: ["commitment", "priority"],
              }],
              newestSourceRefreshAt: changedAt,
              conflicts: [],
              humanDecisionEventIds: [
                ...new Set([...(existing?.humanDecisionEventIds ?? []), input.mutationId]),
              ],
              rankReasons: ["accepted_today", `priority_${taskPriority}`],
              position: activeCount,
              decision: addedDecision,
            };
            const ordered = [...plan.items]
              .sort((left, right) => left.position - right.position)
              .filter((item) => item.id !== itemId);
            const lastActiveIndex = ordered.findLastIndex(
              (item) =>
                item.decision === "pending" ||
                item.decision === "preselected" ||
                item.decision === "accepted",
            );
            const insertIndex = lastActiveIndex >= 0
              ? lastActiveIndex + 1
              : ordered.length;
            ordered.splice(insertIndex, 0, hydrated);
            ordered.forEach((item, position) => {
              item.position = position;
            });
            plan.items = ordered;
            break;
          }
          const title = cleanOptional(input.title);
          const outcome = cleanOptional(input.outcome);
          const why = cleanOptional(input.why);
          if (!title) throw new DayPlanInvalidTransition("Item title is required.");
          if (!outcome) throw new DayPlanInvalidTransition("Item outcome is required.");
          if (!why) throw new DayPlanInvalidTransition("Item rationale is required.");
          if (!input.owner || !OWNER_VALUES.has(input.owner)) {
            throw new DayPlanInvalidTransition("Item owner is invalid.");
          }
          const id = randomUUID();
          insertBackingTask(db, {
            id,
            title,
            description: outcome,
            priority: "high",
            origin: `You added this during Morning Arrival on ${planDateLabel(plan.localDate)}. Your reason: "${originQuote(why)}"`,
            changedAt,
          });
          plan.items.push({
            id,
            candidateId: id,
            taskId: id,
            outcomeKey: arrivalAdditionOutcomeKey({ title, outcome, why }),
            title,
            outcome,
            definitionOfDone: outcome,
            owner: input.owner,
            commitment: "ink",
            whyToday: why,
            priority: "high",
            sourceRefs: [
              {
                sourceType: "task",
                recordId: id,
                sourceUpdatedAt: changedAt,
                refreshedAt: changedAt,
                freshness: "current",
                supports: ["commitment", "priority"],
              },
              {
                sourceType: "decision",
                recordId: id,
                sourceUpdatedAt: changedAt,
                refreshedAt: changedAt,
                freshness: "current",
                supports: ["commitment", "priority"],
              },
            ],
            newestSourceRefreshAt: changedAt,
            conflicts: [],
            humanDecisionEventIds: [input.mutationId],
            rankReasons: ["accepted_today", "priority_high"],
            position: plan.items.length,
            decision: addedDecision,
          });
          break;
        }
        case "item_complete": {
          requireItemCompletionEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["pending", "preselected", "accepted"],
            "Only a Today item can be completed.",
          );
          item.preCompletionPlanPosition = item.position;
          completeItemSource(item, changedAt);
          item.decision = "completed";
          delete item.settlementDecision;
          plan.items = [
            ...plan.items.filter((candidate) => candidate.id !== item.id),
            item,
          ];
          plan.items.forEach((candidate, index) => {
            candidate.position = index;
          });
          break;
        }
        case "item_reopen": {
          requireItemCompletionEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["completed"],
            "Only a completed Today item can be reopened.",
          );
          // Older completions lack a source digest. Only a matching audit event
          // and unchanged terminal timestamp/location can authorize their write.
          const legacyCompletionAt = () => {
            const events = db.prepare(
              "SELECT before_json,after_json,created_at FROM day_plan_events WHERE day_plan_id=? AND event_type IN ('item_complete','assistant_patch') ORDER BY result_version DESC",
            ).all(plan.id) as Array<{ before_json: string; after_json: string; created_at: string }>;
            for (const event of events) {
              try {
                const before = JSON.parse(event.before_json);
                const after = JSON.parse(event.after_json);
                const prior = (before.plan ?? before).items?.find((candidate: DayPlanItem) => candidate.id === item.id);
                const completed = (after.plan ?? after).items?.find((candidate: DayPlanItem) => candidate.id === item.id);
                if (prior && prior.decision !== "completed" && completed?.decision === "completed" &&
                    completed.taskId === item.taskId && completed.planningRef?.id === item.planningRef?.id &&
                    Number.isFinite(Date.parse(event.created_at)))
                  return event.created_at;
              } catch { /* Unreadable legacy evidence cannot authorize a source write. */ }
            }
            return undefined;
          };
          if (item.planningRef?.kind === "commitment") {
            const source = sourceRecord(db, "commitment", item.planningRef.id);
            if (item.completionSourceVersion) {
              if (!source || sourceVersion(source) !== item.completionSourceVersion)
                throw new DayPlanInvalidTransition("This commitment changed after completion. Review it before reopening.");
            } else if (!source || (source.status !== "open" &&
                !(source.status === "done" && source.updated_at === legacyCompletionAt()))) {
              throw new DayPlanInvalidTransition("Cove cannot verify this older completion. Review and reopen the original commitment, then retry here.");
            }
            if (source!.status !== "open")
              db.prepare("UPDATE commitments SET status='open',updated_at=? WHERE id=?").run(changedAt,item.planningRef.id);
            delete item.completionSourceVersion;
          }
          const taskBacked = item.sourceRefs.some(
            (source) => source.sourceType === "task" && source.recordId === item.taskId,
          );
          if (taskBacked) {
            const task = managedTask(item.taskId);
            if (!task) throw new DayPlanInvalidTransition("The board task no longer exists.");
            const source = sourceRecord(db, "task", task.id);
            if (item.completionSourceVersion && (!source || sourceVersion(source) !== item.completionSourceVersion))
              throw new DayPlanInvalidTransition("This task changed after completion. Review it before reopening.");
            const placement = item.preCompletionBoardPlacement;
            const recordedColumn = placement
              ? (db.prepare("SELECT id, name FROM task_columns WHERE id = ?")
                  .get(placement.columnId) as { id: string; name: string } | undefined)
              : undefined;
            const todayColumn = recordedColumn ?? (db.prepare(
              "SELECT id, name FROM task_columns ORDER BY position ASC",
            ).all() as Array<{ id: string; name: string }>).find(
              (column) => taskColumnKeyForName(column.name) === "today",
            );
            if (!todayColumn) {
              throw new DayPlanInvalidTransition("Cove needs a Today list to reopen this task.");
            }
            const alreadyReopened = !item.completionSourceVersion && source?.status === "open" &&
              !source.archived_at && task.column_id === todayColumn.id;
            if (!item.completionSourceVersion && !alreadyReopened) {
              const sourceColumn = db.prepare("SELECT name FROM task_columns WHERE id=?").pluck().get(task.column_id ?? "") as string | undefined;
              if (!source || source.status !== "done" || source.archived_at ||
                  !sourceColumn || taskColumnKeyForName(sourceColumn) !== "done" ||
                  source.updated_at !== legacyCompletionAt())
                throw new DayPlanInvalidTransition(`Cove cannot verify this older completion. Review and reopen it in All Work, return it to the ${todayColumn.name} list, then retry here.`);
            }
            // If the operator already restored a legacy task, update only the
            // plan item. Preserve their newer task fields and board ordering.
            if (!alreadyReopened) {
              const nextPosition = recordedColumn && placement
                ? placement.position
                : (db.prepare(
                    "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE column_id = ? AND status = 'open'",
                  ).pluck().get(todayColumn.id) as number);
              if (recordedColumn && placement) {
                const occupied = db.prepare(
                  `SELECT 1 FROM tasks
                   WHERE column_id = ? AND id <> ? AND position = ? AND status IS ?
                   LIMIT 1`,
                ).get(recordedColumn.id, task.id, placement.position, placement.status);
                if (occupied) {
                  db.prepare(
                    `UPDATE tasks
                     SET position = position + 1
                     WHERE column_id = ? AND id <> ? AND position >= ? AND status IS ?`,
                  ).run(recordedColumn.id, task.id, placement.position, placement.status);
                }
              }
              db.prepare(
                `UPDATE tasks
                 SET column_id = ?, status = ?, position = ?, archived_at = NULL,
                     archived_from_status = NULL, updated_at = ?
                 WHERE id = ?`,
              ).run(
                todayColumn.id,
                recordedColumn && placement ? placement.status : "open",
                nextPosition,
                changedAt,
                task.id,
              );
              if (task.recurring_template_id) syncRecurringOccurrenceForTask(db,task.id,recordedColumn && placement ? placement.status : "open",changedAt);
            }
          }
          item.decision = "accepted";
          const preCompletionPlanPosition = item.preCompletionPlanPosition;
          if (
            typeof preCompletionPlanPosition === "number" &&
            Number.isInteger(preCompletionPlanPosition)
          ) {
            const ordered = [...plan.items].sort(
              (left, right) => left.position - right.position,
            );
            ordered.splice(ordered.indexOf(item), 1);
            ordered.splice(
              Math.max(0, Math.min(ordered.length, preCompletionPlanPosition)),
              0,
              item,
            );
            ordered.forEach((candidate, index) => {
              candidate.position = index;
            });
            plan.items = ordered;
          }
          delete item.completionSourceVersion;
          delete item.preCompletionPlanPosition;
          delete item.preCompletionBoardPlacement;
          delete item.settlementDecision;
          break;
        }
        case "item_owner": {
          requireArrivalEditing(plan);
          const item = requireItem(plan, input.itemId);
          requireState(
            item.decision,
            ["pending", "preselected", "accepted"],
            "A resolved item's owner cannot change.",
          );
          if (!input.owner) throw new DayPlanInvalidTransition("Item owner is required.");
          item.owner = input.owner;
          break;
        }
        case "item_reorder": {
          requirePlanOrdering(plan);
          const item = requireItem(plan, input.itemId);
          if (!Number.isInteger(input.position)) {
            throw new DayPlanInvalidTransition("Item position must be an integer.");
          }
          const target = Math.max(0, Math.min(plan.items.length - 1, input.position!));
          const ordered = [...plan.items].sort((left, right) => left.position - right.position);
          ordered.splice(ordered.indexOf(item), 1);
          ordered.splice(target, 0, item);
          ordered.forEach((candidate, index) => {
            candidate.position = index;
          });
          plan.items = ordered;
          break;
        }
        case "plan_revision_accept": {
          if (plan.state !== "proposed" || plan.arrivalState !== "opened") {
            throw new DayPlanInvalidTransition(
              "Recommendations can change only before Start My Day. Update tasks in All Tasks after starting.",
            );
          }
          const artifact = input.briefId
            ? getMorningBrief(input.briefId)
            : undefined;
          const proposed = morningBriefFromArtifact(artifact)?.dailyDecision;
          if (
            !artifact ||
            artifact.targetLocalDate !== plan.localDate ||
            !proposed
          )
            throw new DayPlanInvalidTransition(
              "That proposed revision is unavailable.",
            );
          const candidates = persistDecisionLinks(
            db,
            proposed,
            new Date(changedAt),
          );
          const completed = plan.items.filter(
            (item) => item.decision === "completed",
          );
          plan.items = [
            ...candidates.map((candidate, position) => ({
              ...candidate,
              id: candidate.candidateId,
              position,
              decision: "preselected" as const,
            })),
            ...completed,
          ];
          plan.items.forEach((item, position) => {
            item.position = position;
          });
          plan.briefId = artifact.id;
          break;
        }
        case "start_day": {
          // Reopening an active day's brief is a review, not new authorization
          // to accept pending work or restart agent runs.
          if (plan.state === "active" && plan.arrivalState === "opened") {
            plan.arrivalState = "confirmed";
            break;
          }
          if (plan.state !== "proposed" || plan.arrivalState !== "opened") {
            throw new DayPlanInvalidTransition("Start My Day requires an open proposed arrival.");
          }
          const accepted = [...plan.items]
            .filter(
              (item) => item.decision === "accepted" || item.decision === "preselected",
            )
            .sort((left, right) => left.position - right.position);
          if (accepted.length === 0) {
            throw new DayPlanInvalidTransition(
              "Start My Day requires one accepted focus.",
            );
          }
          plan.items
            .filter((i) => ["preselected", "accepted"].includes(i.decision))
            .forEach((i) => acceptPlanningProposal(db, i, new Date(changedAt)));
          activatePlanWithoutKickoff(plan, input.mutationId, changedAt, false);
          const focus = focusBandItems(plan.items, configuredFocusCount());
          plan.arrivalState = "confirmed";
          // Local owner chips launch resumable task sessions through the
          // separate task-session lifecycle. Keep the allowlisted headless lane
          // intact for unattended work and preserve its existing cloud behavior.
          for (const item of getRuntimeMode() === "local" ? [] : focus) {
            if (item.owner !== "claude" && item.owner !== "together") continue;
            const liveRun = findLiveItemRun(plan.id, item.id);
            if (liveRun) {
              kickoffSkips.push({
                itemId: item.id,
                taskId: item.taskId,
                title: item.title,
                reason: "already_live",
                status: liveRun.status,
              });
              continue;
            }
            const existingConfig = getExecutionConfig(plan.id, item.id);
            const mode: DayPlanExecutionMode = "plan_review";
            const modelAlias = selectExecutionModel(item);
            const provisional: DayPlanExecutionConfig = {
              dayPlanId: plan.id,
              itemId: item.id,
              mode,
              modelAlias,
              workspaceId: undefined,
              budgetUsd: undefined,
              briefHash: dayPlanItemBriefHash(item),
              authorizationHash: "",
              lastMutationId: `${input.mutationId}:route:${item.id}`,
              configuredAt: existingConfig?.configuredAt ?? changedAt,
              updatedAt: changedAt,
            };
            const provisionalReadiness = itemReadiness(plan, item, provisional);
            const config: DayPlanExecutionConfig = {
              ...provisional,
              authorizationHash: dayPlanExecutionAuthorizationHash({
                briefHash: provisional.briefHash,
                mode: provisional.mode,
                modelAlias: provisional.modelAlias,
                workspaceId: provisional.workspaceId,
                workspacePath: provisional.mode === "autonomous"
                  ? provisionalReadiness.workspacePath
                  : undefined,
                budgetUsd: provisional.budgetUsd,
              }),
            };
            db.prepare(
              `INSERT INTO day_plan_execution_configs
                (day_plan_id, item_id, mode, model_alias, workspace_id, budget_usd,
                 brief_hash, authorization_hash, last_mutation_id, configured_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(day_plan_id, item_id) DO UPDATE SET
                 mode = excluded.mode, model_alias = excluded.model_alias,
                 workspace_id = excluded.workspace_id, budget_usd = excluded.budget_usd,
                 brief_hash = excluded.brief_hash, authorization_hash = excluded.authorization_hash,
                 last_mutation_id = excluded.last_mutation_id, updated_at = excluded.updated_at`,
            ).run(
              config.dayPlanId, config.itemId, config.mode, config.modelAlias,
              config.workspaceId ?? null, config.budgetUsd ?? null, config.briefHash,
              config.authorizationHash, config.lastMutationId, config.configuredAt, config.updatedAt,
            );
            const readiness = itemReadiness(plan, item, config);
            if (!readiness.ready) {
              const unready = {
                itemId: item.id,
                taskId: item.taskId,
                title: item.title,
                readiness,
              };
              unreadyItems.push(unready);
              kickoffSkips.push({ ...unready, reason: "not_ready" });
              continue;
            }
            const existingRun = findExistingItemRun(
              plan.id,
              item.id,
              config.briefHash,
              config.mode,
              config.authorizationHash,
            );
            if (existingRun) {
              kickoffSkips.push({
                itemId: item.id,
                taskId: item.taskId,
                title: item.title,
                reason: "result_available",
                status: existingRun.status,
              });
              continue;
            }
            executionRuns.push(insertExecutionRun({
              plan,
              item,
              config,
              readiness,
              idempotencyKey: `${input.mutationId}:kickoff:${item.id}`,
              createdAt: changedAt,
            }));
          }
          break;
        }
        case "settlement_offer":
          if (
            plan.state !== "active" &&
            !(plan.state === "proposed" && ["bypassed", "skipped"].includes(plan.arrivalState))
          ) {
            throw new DayPlanInvalidTransition("Settlement cannot be offered yet.");
          }
          requireState(
            plan.settlementState,
            ["not_due", "skipped"],
            "Settlement is already open or complete.",
          );
          plan.settlementState = "offered";
          break;
        case "settlement_skip":
          requireState(
            plan.settlementState,
            ["offered"],
            "Only an offered settlement can be skipped.",
          );
          plan.settlementState = "skipped";
          break;
        case "settlement_start":
          {
            const alreadyInProgress =
              plan.state === "settling" && plan.settlementState === "in_progress";
            if (!canStartDayPlanSettlement(plan)) {
              throw new DayPlanInvalidTransition("Settlement cannot start yet.");
            }
            if (!alreadyInProgress) {
              requireState(
                plan.settlementState,
                ["not_due", "offered", "skipped"],
                "Settlement is already in progress or complete.",
              );
              if (
                plan.state === "proposed" &&
                plan.arrivalState === "snoozed"
              ) {
              plan.items
                .filter((i) => ["preselected", "accepted"].includes(i.decision))
                .forEach((i) =>
                  acceptPlanningProposal(db, i, new Date(changedAt)),
                );
              activatePlanWithoutKickoff(plan, input.mutationId, changedAt, true);
              }
              settlementOrigin = plan.state === "active" ? "active" : "proposed";
              plan.state = "settling";
              plan.settlementState = "in_progress";
            }
            let completionChanged = false;
            if (input.completedHumanTaskIds) {
              const tracked = plan.items.filter(
                (item) => item.decision === "accepted" || item.decision === "completed",
              );
              const trackedIds = new Set(tracked.map((item) => item.taskId));
              const completedIds = new Set(input.completedHumanTaskIds);
              if ([...completedIds].some((taskId) => !trackedIds.has(taskId))) {
                throw new DayPlanInvalidTransition("Completed work must belong to this day plan.");
              }
              for (const item of tracked) {
                const nextDecision = completedIds.has(item.taskId) ? "completed" : "accepted";
                if (item.decision !== nextDecision) {
                  item.decision = nextDecision;
                  item.settlementDecision = undefined;
                  completionChanged = true;
                }
              }
            }
            if (alreadyInProgress && !completionChanged) {
              return {
                plan,
                snapshot: getSnapshot(plan.id),
                pendingReconciliations: listPendingReconciliations(),
                replayed: false,
              };
            }
            break;
          }
        case "settlement_cancel":
          if (plan.state !== "settling" || plan.settlementState !== "in_progress") {
            throw new DayPlanInvalidTransition("Only an active settlement can be cancelled.");
          }
          plan.state = settlementOriginState(plan.id);
          plan.settlementState = "offered";
          for (const item of plan.items) delete item.settlementDecision;
          break;
        case "settlement_decide": {
          if (plan.state !== "settling" || plan.settlementState !== "in_progress") {
            throw new DayPlanInvalidTransition("Settlement decisions require an active settlement.");
          }
          const item = requireItem(plan, input.itemId);
          if (item.decision !== "accepted") {
            throw new DayPlanInvalidTransition("Only accepted work needs a settlement decision.");
          }
          if (!input.disposition) {
            throw new DayPlanInvalidTransition("Settlement disposition is required.");
          }
          const progressNote = cleanOptional(input.progressNote);
          const nextStep = cleanOptional(input.nextStep);
          if (progressNote && progressNote.length > 500) {
            throw new DayPlanInvalidTransition("Progress note must be 500 characters or fewer.");
          }
          if (nextStep && nextStep.length > 200) {
            throw new DayPlanInvalidTransition("Next step must be 200 characters or fewer.");
          }
          if (input.disposition !== "progress" && (progressNote || nextStep)) {
            throw new DayPlanInvalidTransition(
              "Progress details are only valid for a Progress decision.",
            );
          }
          let deferUntil: string | undefined;
          if (input.disposition === "defer") {
            const deferDate = input.deferUntil ? new Date(input.deferUntil) : undefined;
            if (!deferDate || Number.isNaN(deferDate.getTime()) || deferDate <= now()) {
              throw new DayPlanInvalidTransition("Deferred work needs a future return time.");
            }
            deferUntil = deferDate.toISOString();
          }
          item.settlementDecision = {
            disposition: input.disposition,
            deferUntil,
            ...(input.disposition === "progress" ? { progressNote, nextStep } : {}),
            decidedAt: changedAt,
          };
          break;
        }
        case "settlement_commit": {
          if (plan.state !== "settling" || plan.settlementState !== "in_progress") {
            throw new DayPlanInvalidTransition("Settlement is not ready to commit.");
          }
          const settlementItems = plan.items.filter(
            (item) => item.decision === "accepted" || item.decision === "completed",
          );
          const settlementTaskIds = new Set(settlementItems.map((item) => item.taskId));
          const completed = [...new Set(
            input.completedHumanTaskIds ??
              settlementItems
                .filter((item) => item.decision === "completed")
                .map((item) => item.taskId),
          )];
          if (completed.some((taskId) => !settlementTaskIds.has(taskId))) {
            throw new DayPlanInvalidTransition("Completed work must belong to this day plan.");
          }
          const unresolved = settlementItems.filter((item) => !completed.includes(item.taskId));
          if (unresolved.some((item) => !item.settlementDecision)) {
            throw new DayPlanInvalidTransition(
              "Every unfinished accepted item needs Progress, Carry, Defer, or Drop.",
            );
          }
          const eventRows = db
            .prepare(
              "SELECT * FROM day_plan_events WHERE day_plan_id = ? ORDER BY created_at, id",
            )
            .all(plan.id) as EventRow[];
          const firstProgress = unresolved
            .filter((item) => item.settlementDecision?.disposition === "progress")
            .sort((left, right) => left.position - right.position)[0];
          const firstCarry = unresolved
            .filter((item) => item.settlementDecision?.disposition === "carry")
            .sort((left, right) => left.position - right.position)[0];
          const firstContinuing = firstProgress ?? firstCarry;
          const body: DaySnapshotBody = {
            completedHumanTaskIds: completed,
            returnedAgentWork: [],
            unresolvedItems: unresolved.map((item) => ({
              dayPlanItemId: item.id,
              taskId: item.taskId,
              title: item.title,
              owner: item.owner,
              disposition: item.settlementDecision!.disposition,
              deferUntil: item.settlementDecision!.deferUntil,
              progressNote: item.settlementDecision!.progressNote,
              nextStep: item.settlementDecision!.nextStep,
            })),
            humanDecisionEventIds: [
              ...eventRows
                // Provenance covers human decisions only: ensure (plan
                // creation), brief_attach (system late-attach), and
                // arrival_interact (a touch marker, not a decision) are all
                // machine-recorded and excluded.
                .filter(
                  (event) =>
                    event.event_type !== "ensure" &&
                    event.event_type !== "brief_attach" &&
                    event.event_type !== "arrival_interact",
                )
                .map((event) => event.id),
              input.mutationId,
            ],
            overnightQueue: [],
            nextDayRecommendationSeed: firstContinuing
              ? {
                  dayPlanItemId: firstContinuing.id,
                  taskId: firstContinuing.taskId,
                  title: firstContinuing.title,
                }
              : undefined,
          };
          snapshot = {
            id: randomUUID(),
            dayPlanId: plan.id,
            localDate: plan.localDate,
            timezone: plan.timezone,
            version: 1,
            body,
            createdAt: changedAt,
          };
          db.prepare(
            `INSERT INTO day_snapshots
              (id, day_plan_id, local_date, timezone, version, body_json, created_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          ).run(
            snapshot.id,
            snapshot.dayPlanId,
            snapshot.localDate,
            snapshot.timezone,
            JSON.stringify(snapshot.body),
            snapshot.createdAt,
          );
          const insertReconciliation = db.prepare(
            `INSERT INTO day_plan_reconciliations
              (id, day_plan_id, snapshot_id, task_id, action, available_at, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          for (const item of unresolved) {
            const disposition = item.settlementDecision!.disposition;
            if (disposition !== "defer" && disposition !== "drop") continue;
            insertReconciliation.run(
              randomUUID(),
              plan.id,
              snapshot.id,
              item.taskId,
              disposition,
              null,
              "pending",
              changedAt,
            );
            if (disposition === "defer") {
              insertReconciliation.run(
                randomUUID(),
                plan.id,
                snapshot.id,
                item.taskId,
                "resurface",
                item.settlementDecision!.deferUntil!,
                "scheduled",
                changedAt,
              );
            }
          }
          plan.nextDayNote = cleanOptional(input.nextDayNote);
          if (plan.nextDayNote) {
            try {
              db.prepare(
                `INSERT INTO day_dumps
                  (id, target_local_date, raw_text, status, created_at, updated_at)
                 VALUES (?, ?, ?, 'queued', ?, ?)`,
              ).run(
                randomUUID(),
                plan.localDate,
                input.nextDayNote,
                changedAt,
                changedAt,
              );
            } catch (error) {
              console.error("Day dump enqueue failed; settlement will continue.", error);
            }
          }
          plan.state = "settled";
          plan.settlementState = "settled";
          plan.settledAt = changedAt;
          if (input.mutationId === `weekend-auto-settle:commit:${plan.id}`) {
            // Audit only by design: silent weekend auto-settlement stays out of Recent activity.
            recordReceiptInDatabase(db, {
              source: "weekend-auto-settle",
              startedAt: changedAt,
              finishedAt: changedAt,
              summary: `Automatically closed untouched weekend plan ${plan.localDate}.`,
              actions: { planId: plan.id, localDate: plan.localDate },
              outcome: "success",
            });
          }
          break;
        }
        default:
          throw new DayPlanInvalidTransition(
            `Unsupported day-plan action: ${input.action}`,
          );
      }

      if (input.action.startsWith("item_") && input.itemId) {
        const changedItem = requireItem(plan, input.itemId);
        changedItem.humanDecisionEventIds = [
          ...new Set([...changedItem.humanDecisionEventIds, input.mutationId]),
        ];
        if (["item_edit", "item_owner", "item_later", "item_dismiss", "item_complete", "item_reopen"].includes(input.action)) {
          invalidateQueuedRunsForItem(plan, changedItem, changedAt);
        }
      }

      // Every content mutation is a real interaction: it durably freezes the
      // arrival against a late brief attach. Arrival-state-only transitions
      // (open, snooze, skip) deliberately do not stamp, so a brief can still
      // attach to an opened-but-untouched arrival.
      if (CONTENT_MUTATION_ACTIONS.has(input.action) && !plan.arrivalInteractedAt) {
        plan.arrivalInteractedAt = changedAt;
      }

      plan.version += 1;
      plan.lastMutationId = input.mutationId;
      plan.updatedAt = changedAt;
      persistPlan(plan);
      appendEvent({
        id: input.mutationId,
        planId: plan.id,
        eventType: input.action,
        expectedVersion: input.expectedVersion,
        resultVersion: plan.version,
        before,
        after: input.action === "start_day"
          ? { plan, kickoffSkips }
          : input.action === "settlement_start"
            ? { plan, settlementOriginState: settlementOrigin }
            : plan,
        createdAt: changedAt,
      });
      return {
        plan,
        snapshot,
        pendingReconciliations: listPendingReconciliations(),
        executionRuns: executionRuns.length > 0 ? executionRuns : undefined,
        unreadyItems: unreadyItems.length > 0 ? unreadyItems : undefined,
        kickoffSkips: kickoffSkips.length > 0 ? kickoffSkips : undefined,
        replayed: false,
      };
    });
  }

  function acknowledgeReconciliation(
    reconciliationId: string,
  ): DayPlanReconciliationResult {
    return immediate(() => {
      const row = selectReconciliation.get(reconciliationId) as
        | ReconciliationRow
        | undefined;
      if (!row) {
        throw new DayPlanInvalidTransition("Day-plan reconciliation not found.");
      }
      if (row.state === "applied") {
        return { reconciliation: reconciliationFromRow(row), replayed: true };
      }
      const appliedAt = now().toISOString();
      if (
        row.state === "scheduled" &&
        row.available_at &&
        new Date(row.available_at) > new Date(appliedAt)
      ) {
        throw new DayPlanInvalidTransition("Day-plan reconciliation is not due yet.");
      }
      db.prepare(
        `UPDATE day_plan_reconciliations
         SET state = 'applied', applied_at = ?
         WHERE id = ? AND state IN ('pending', 'scheduled')`,
      ).run(appliedAt, reconciliationId);
      const applied = selectReconciliation.get(reconciliationId) as ReconciliationRow;
      return { reconciliation: reconciliationFromRow(applied), replayed: false };
    });
  }

  function acknowledgeTaskMutation(mutationId: string): DayPlanTaskMutationResult {
    return immediate(() => {
      const row = selectTaskMutation.get(mutationId) as
        | TaskMutationRow | undefined;
      if (!row) throw new DayPlanInvalidTransition("Day-plan task mutation not found.");
      if (row.state === "applied") {
        return { mutation: taskMutationFromRow(row), replayed: true };
      }
      if (row.state === "blocked") throw new DayPlanInvalidTransition("This earlier task change needs review before it can be applied.");
      const appliedAt = now().toISOString();
      db.prepare(
        "UPDATE day_plan_task_mutations SET state = 'applied', applied_at = ? WHERE id = ? AND state = 'pending'",
      ).run(appliedAt, mutationId);
      return {
        mutation: taskMutationFromRow(selectTaskMutation.get(mutationId) as TaskMutationRow),
        replayed: false,
      };
    });
  }

  function getReadModel(): DayPlanReadModel {
    const open = selectOpenPlan.get() as DayPlanRow | undefined;
    const latestSnapshot = selectLatestSnapshot.get() as
      | SnapshotRow | undefined;
    return {
      currentPlan: open ? planFromRow(open) : undefined,
      latestSnapshot: latestSnapshot ? snapshotFromRow(latestSnapshot) : undefined,
      pendingReconciliations: listPendingReconciliations(),
      pendingTaskMutations: listPendingTaskMutations(),
    };
  }

  function withSettlementEvidence(plan: DayPlan): DayPlan {
    if (plan.state !== "settling" || plan.settlementState !== "in_progress") return plan;
    const workedItemIds = new Set<string>();
    const workedTaskIds = new Set<string>();
    for (const run of listExecutionRuns(plan.id)) {
      if (localDateInTimezone(run.createdAt, plan.timezone) !== plan.localDate) continue;
      workedItemIds.add(run.itemId);
      workedTaskIds.add(run.taskId);
    }
    return {
      ...plan,
      items: plan.items.map((item) =>
        item.decision === "accepted"
          ? {
              ...item,
              workedToday: workedItemIds.has(item.id) || workedTaskIds.has(item.taskId),
            }
          : item,
      ),
    };
  }

  function listEvents(planId: string): DayPlanEvent[] {
    const rows = db
      .prepare("SELECT * FROM day_plan_events WHERE day_plan_id = ? ORDER BY created_at, id")
      .all(planId) as EventRow[];
    return rows.map(eventFromRow);
  }

  function settlementOriginState(planId: string): "active" | "proposed" {
    const rows = db.prepare(
      `SELECT event_type, before_json, after_json
       FROM day_plan_events
       WHERE day_plan_id = ? AND event_type IN ('settlement_start', 'settlement_cancel')
       ORDER BY rowid DESC`,
    ).all(planId) as Array<Pick<EventRow, "event_type" | "before_json" | "after_json">>;
    for (const row of rows) {
      if (row.event_type === "settlement_cancel") break;
      const after = row.after_json
        ? parseJson<unknown>(row.after_json, "settlement start event after")
        : undefined;
      if (after && typeof after === "object" && !Array.isArray(after)) {
        const origin = (after as { settlementOriginState?: unknown }).settlementOriginState;
        if (origin === "active" || origin === "proposed") return origin;
      }
      const before = row.before_json
        ? parseJson<unknown>(row.before_json, "settlement start event before")
        : undefined;
      if (before && typeof before === "object" && !Array.isArray(before)) {
        const origin = (before as { state?: unknown }).state;
        if (origin === "active" || origin === "proposed") return origin;
      }
    }
    throw new DayPlanInvalidTransition("Settlement origin is unavailable.");
  }

  // Construction keeps the historical compatibility repair, but board
  // activation is reserved for the guarded GET initialization call (or the
  // worker's explicit same-day activation) so a task-table problem cannot make
  // store construction fail before the route's fail-open boundary.
  try {
    cleanupWeekendPlan();
  } catch (error) {
    console.error("Day plan initialization skipped.", error);
  }

  return {
    planningReadBundle,
    planningContext,
    completeDailyPlanning,
    projectedPlan,
    initialize,
    ensureDayPlan,
    markArrivalInteraction,
    forceAttachMorningBrief,
    mutateDayPlan,
    applyAssistantOperations,
    getAssistantTurn,
    configureExecution,
    kickoffItem,
    getExecutionConfig,
    listExecutionConfigs,
    listExecutionRuns,
    claimNextExecutionRun,
    markExecutionRunRunning,
    heartbeatExecutionRun,
    setExecutionRunLogPath,
    finishExecutionRun,
    cancelExecutionRun,
    recoverStaleExecutionRuns,
    interruptStaleExecutionRuns,
    listExecutionWorkspaces,
    getExecutionRun: (id: string) => {
      const row = selectExecutionRun.get(id) as ExecutionRunRow | undefined;
      return row ? executionRunFromRow(row) : undefined;
    },
    getExecutionReadiness: (planId: string, itemId: string) => {
      const plan = getPlan(planId);
      if (!plan) throw new DayPlanNotFound();
      return itemReadiness(plan, requireItem(plan, itemId));
    },
    acknowledgeReconciliation,
    acknowledgeTaskMutation,
    getReadModel,
    withSettlementEvidence,
    getPlan,
    getPlanForDate,
    dayClosureFacts,
    getSnapshot,
    listEvents,
    listPendingReconciliations,
    listPendingTaskMutations,
    listRecentSnapshots,
    getDayDump,
    listDayDumps,
    recordSessionDigest,
    listSessionDigests,
    claimNextDayDump,
    completeDayDump,
    failDayDump,
    interruptStaleDayDumps,
    getMorningBrief,
    listMorningBriefs,
    latestEligibleMorningBrief,
    recentBriefDurationsSeconds,
    enqueueMorningBrief,
    requeueStalePlanning,
    claimNextMorningBrief,
    recordMorningBriefInputs,
    completeMorningBrief,
    stageMorningBriefBoardActions,
    activateBriefBoardActions,
    morningBriefCreatedTaskPicks,
    morningBriefManagementSummary,
    failMorningBrief,
    deferMorningBrief,
    importMorningBrief,
    interruptStaleMorningBriefs,
    abandonStaleQueuedMorningBriefs,
    close: () => {
      if (db.open) db.close();
    },
  };
}

type DayPlanGlobal = { __coveDayPlanStore?: DayPlanStore };

let warnedTaskSettingsReadFailure = false;

function configuredFocusCountFromTaskSettings(): number {
  try {
    return readTaskSettings().focus_count;
  } catch (error) {
    if (!warnedTaskSettingsReadFailure) {
      warnedTaskSettingsReadFailure = true;
      console.warn("Task settings could not be read. Using defaults.", error);
    }
    return DEFAULT_TASK_SETTINGS.focus_count;
  }
}

export function getDayPlanStore(): DayPlanStore {
  const global = globalThis as unknown as DayPlanGlobal;
  if (!global.__coveDayPlanStore) {
    global.__coveDayPlanStore = createDayPlanStore({
      dbPath: localDatabasePath(),
      focusCount: configuredFocusCountFromTaskSettings,
    });
  }
  return global.__coveDayPlanStore;
}
