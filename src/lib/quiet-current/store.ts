import type Database from "better-sqlite3";
import { assertSuggestionSourceCurrent, relinkSuggestionResponsibility } from "../responsibility/suggestion-links";
/**
 * Durable pencil layer for inferred work and returned agent results.
 *
 * Suggestions expire, defer, reopen, and record human decisions without
 * becoming committed task state on their own. SQLite serializes the complete
 * read/change/write operation across browser and background processes.
 */
import { randomUUID } from "node:crypto";
import { sourceRecord, sourceVersion } from "../responsibility/store";
import { taskColumnKeyForName } from "../tasks/columns";
import { syncRecurringOccurrenceForTask } from "../tasks/recurrence";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coveDataDir } from "../operator";
import { coveEnv } from "../env";
import { localDatabasePath } from "../local/database";
import { transactQuietCurrent } from "./persistence";

export type SuggestionKind =
  | "create_task"
  | "returned_work"
  | "observed_progress"
  | "stale_task"
  | "attention_nudge";

export type SuggestionState =
  | "proposed"
  | "refined"
  | "accepted"
  | "deferred"
  | "dismissed"
  | "expired";

export type SuggestionPriority = "low" | "medium" | "high";

export type WorkSuggestion = {
  id: string;
  kind: SuggestionKind;
  title: string;
  description: string;
  reason: string;
  source: string;
  priority: SuggestionPriority;
  dueDate?: string;
  targetTaskId?: string;
  reviewMaterial?: string;
  claimKey?: string;
  state: SuggestionState;
  dismissReason?: string;
  resolvedTaskId?: string;
  deferredUntil?: string;
  deferredReturnState?: "proposed" | "refined";
  resurfacedFromDeferredAt?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type DecisionEvent = {
  id: string;
  eventType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source?: string;
  createdAt: string;
};

export type QuietCurrentStore = {
  version: 1;
  suggestions: WorkSuggestion[];
  decisionEvents: DecisionEvent[];
};

const ACTIVE_STATES = new Set<SuggestionState>(["proposed", "refined"]);
const NON_TERMINAL_STATES = new Set<SuggestionState>(["proposed", "refined", "deferred"]);
const MAX_SUGGESTIONS = 500;
const MAX_EVENTS = 2000;
let testStorePath: string | undefined;
let testNow: Date | undefined;
// Keyed by the token file's path: COVE_DB_PATH/COVE_DATA_DIR can change
// between tests, and tsx can load two copies of this module. Tying the cache
// to the file keeps every copy converging on the same on-disk token.
let tokenCache: { file: string; token: string } | undefined;

function nowDate(): Date {
  return testNow ? new Date(testNow) : new Date();
}

function nextMorning(now: Date): Date {
  const morning = new Date(now);
  morning.setHours(5, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return morning;
}

function storePath(dataDir?: string): string {
  if (testStorePath) return testStorePath;
  const configuredName = coveEnv("QUIET_CURRENT_FILE");
  const fileName = configuredName ? path.basename(configuredName) : "quiet-current.json";
  return path.join(coveDataDir(dataDir), fileName);
}

/** Test-only path override so state tests never touch a real Cove installation. */
export function setQuietCurrentStorePathForTests(file?: string): void {
  testStorePath = file;
  tokenCache = undefined;
}

/** Test-only clock override for deterministic lifecycle tests. */
export function setQuietCurrentNowForTests(now?: Date): void {
  testNow = now ? new Date(now) : undefined;
}

export function getQuietCurrentCsrfToken(): string {
  const file = `${storePath()}.token`;
  if (tokenCache?.file === file) return tokenCache.token;
  try {
    const existing = readFileSync(/* turbopackIgnore: true */ file, "utf8").trim();
    if (existing.length >= 32) {
      tokenCache = { file, token: existing };
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  try {
    writeFileSync(/* turbopackIgnore: true */ file, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process (or module copy) minted first; adopt its token so every
    // holder of this file agrees.
    const minted = readFileSync(/* turbopackIgnore: true */ file, "utf8").trim();
    if (minted.length >= 32) {
      tokenCache = { file, token: minted };
      return minted;
    }
    // The existing file is invalid (short or empty): replace it outright.
    writeFileSync(/* turbopackIgnore: true */ file, `${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  tokenCache = { file, token };
  return token;
}

function emptyStore(): QuietCurrentStore {
  return { version: 1, suggestions: [], decisionEvents: [] };
}

function quietDatabaseInDirectory(directory: string): string {
  const canonical = path.join(directory, "cove.db");
  const legacy = path.join(directory, "forge.db");
  return existsSync(canonical) || !existsSync(legacy) ? canonical : legacy;
}

function withStore<T>(dataDir: string | undefined, operation: (store: QuietCurrentStore, db: Database.Database) => T): T {
  const file = storePath(dataDir);
  const database = testStorePath
    ? `${testStorePath}.sqlite`
    : (coveEnv("DB_PATH") ?? (dataDir || coveEnv("DATA_DIR")
      ? quietDatabaseInDirectory(coveDataDir(dataDir))
      : localDatabasePath()));
  return transactQuietCurrent(database, file, emptyStore, operation);
}

function appendEvent(
  store: QuietCurrentStore,
  input: Omit<DecisionEvent, "id" | "createdAt">,
): DecisionEvent {
  const event: DecisionEvent = {
    ...input,
    id: randomUUID(),
    createdAt: nowDate().toISOString(),
  };
  store.decisionEvents.push(event);
  if (store.decisionEvents.length > MAX_EVENTS) {
    store.decisionEvents = store.decisionEvents.slice(-MAX_EVENTS);
  }
  return event;
}

function resurfaceDeferredSuggestions(store: QuietCurrentStore): boolean {
  const now = nowDate();
  let changed = false;

  for (const suggestion of store.suggestions) {
    const deferredReturnAt = suggestion.deferredUntil
      ? new Date(suggestion.deferredUntil).getTime()
      : now.getTime();
    const expiresBeforeReturn = Boolean(
      suggestion.deferredUntil &&
        new Date(suggestion.expiresAt).getTime() <= deferredReturnAt,
    );
    const isStillCurrent = new Date(suggestion.expiresAt).getTime() > now.getTime();
    if (
      suggestion.state === "deferred" &&
      !suggestion.resurfacedFromDeferredAt &&
      deferredReturnAt <= now.getTime() &&
      !expiresBeforeReturn &&
      isStillCurrent
    ) {
      const before = { ...suggestion };
      suggestion.state = suggestion.deferredReturnState ?? "proposed";
      suggestion.deferredUntil = undefined;
      suggestion.deferredReturnState = undefined;
      suggestion.resurfacedFromDeferredAt = now.toISOString();
      suggestion.updatedAt = now.toISOString();
      suggestion.expiresAt = new Date(
        now.getTime() + 3 * 24 * 60 * 60 * 1000,
      ).toISOString();
      appendEvent(store, {
        eventType: "suggestion_resurface",
        entityId: suggestion.id,
        before,
        after: suggestion,
        source: "quiet_current",
      });
      changed = true;
    }
  }

  return changed;
}

function expireSuggestions(store: QuietCurrentStore): boolean {
  const now = nowDate();
  let changed = false;

  for (const suggestion of store.suggestions) {
    if (
      (ACTIVE_STATES.has(suggestion.state) || suggestion.state === "deferred") &&
      new Date(suggestion.expiresAt).getTime() <= now.getTime()
    ) {
      const previousState = suggestion.state;
      suggestion.state = "expired";
      suggestion.deferredUntil = undefined;
      suggestion.deferredReturnState = undefined;
      suggestion.updatedAt = now.toISOString();
      appendEvent(store, {
        eventType: "suggestion_decay",
        entityId: suggestion.id,
        before: { state: previousState },
        after: { state: "expired" },
        source: "quiet_current",
      });
      changed = true;
    }
  }

  return changed;
}

function refreshSuggestionLifecycle(store: QuietCurrentStore): boolean {
  const resurfaced = resurfaceDeferredSuggestions(store);
  const expired = expireSuggestions(store);
  return resurfaced || expired;
}

export function pruneSuggestions(
  suggestions: WorkSuggestion[],
  maximum = MAX_SUGGESTIONS,
): WorkSuggestion[] {
  if (suggestions.length <= maximum) return suggestions;
  const terminal = suggestions.filter(
    (suggestion) => !NON_TERMINAL_STATES.has(suggestion.state),
  );
  const removable = new Set(
    terminal.slice(0, Math.max(0, suggestions.length - maximum)).map((item) => item.id),
  );
  return suggestions.filter((suggestion) => !removable.has(suggestion.id));
}

export function getQuietCurrentSnapshot(dataDir?: string): QuietCurrentStore {
  return withStore(dataDir, (store) => {
    refreshSuggestionLifecycle(store);
    return store;
  });
}

export function createWorkSuggestion(input: {
  id?: string;
  kind?: SuggestionKind;
  title: string;
  description?: string;
  reason: string;
  source: string;
  priority?: SuggestionPriority;
  dueDate?: string;
  targetTaskId?: string;
  reviewMaterial?: string;
  claimKey?: string;
  expiresAt?: string;
  dataDir?: string;
}): WorkSuggestion {
  const kind = input.kind ?? "create_task";
  if (
    (
      kind === "returned_work" ||
      kind === "observed_progress" ||
      kind === "stale_task"
    ) &&
    !input.targetTaskId
  ) {
    throw new Error(`${kind === "returned_work"
      ? "Returned work"
      : kind === "observed_progress"
        ? "Observed progress"
        : "A stale-task check"} requires an existing target task.`);
  }
  return withStore(input.dataDir, (store) => {
    refreshSuggestionLifecycle(store);
    const claimKey = input.claimKey?.trim();
    if (claimKey) {
      const existing = store.suggestions.find((suggestion) =>
        suggestion.claimKey === claimKey && NON_TERMINAL_STATES.has(suggestion.state)
      );
      if (existing) {
        return existing;
      }
    }
    if (input.id) {
      const existing = store.suggestions.find((suggestion) => suggestion.id === input.id);
      if (existing) {
        return existing;
      }
    }
    const now = nowDate();
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new Error("Suggestion expiry must be a future date.");
    }

    const suggestion: WorkSuggestion = {
      id: input.id ?? randomUUID(),
      kind,
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      reason: input.reason.trim(),
      source: input.source.trim(),
      priority: input.priority ?? "medium",
      dueDate: input.dueDate,
      targetTaskId: input.targetTaskId,
      reviewMaterial: input.reviewMaterial,
      claimKey,
      state: "proposed",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    store.suggestions.push(suggestion);
    store.suggestions = pruneSuggestions(store.suggestions);
    appendEvent(store, {
      eventType: "suggestion_create",
      entityId: suggestion.id,
      after: suggestion,
      source: input.source,
  });
  return suggestion;
  });
}

export function resolveWorkSuggestion(
  id: string,
  input: {
    state: Exclude<SuggestionState, "proposed" | "expired">;
    title?: string;
    description?: string;
    dueDate?: string;
    priority?: SuggestionPriority;
    dismissReason?: string;
    resolvedTaskId?: string;
    source?: string;
  },
): WorkSuggestion {
  return withStore(undefined, (store, db) => {
    refreshSuggestionLifecycle(store);
    const suggestion = store.suggestions.find((item) => item.id === id);
    if (!suggestion) throw new Error("Suggestion not found.");
    if (suggestion.state !== "proposed" && suggestion.state !== "refined") {
      throw new Error(`Suggestion is already ${suggestion.state}.`);
    }

    if (input.state === "accepted") assertSuggestionSourceCurrent(db, suggestion);
    const before = { ...suggestion };
    const previousState = suggestion.state;
    if (input.title !== undefined) suggestion.title = input.title.trim();
    if (input.description !== undefined) {
      suggestion.description = input.description.trim();
    }
    if (input.dueDate !== undefined) suggestion.dueDate = input.dueDate;
    if (input.priority !== undefined) suggestion.priority = input.priority;
    suggestion.dismissReason = input.dismissReason;
    suggestion.resolvedTaskId = input.resolvedTaskId;
    suggestion.state = input.state;
    suggestion.updatedAt = nowDate().toISOString();
    if (input.state === "deferred") {
      if (!suggestion.resurfacedFromDeferredAt) {
        suggestion.deferredUntil = nextMorning(nowDate()).toISOString();
        suggestion.deferredReturnState = previousState;
      } else {
        suggestion.deferredUntil = undefined;
        suggestion.deferredReturnState = undefined;
      }
    } else {
      suggestion.deferredUntil = undefined;
      suggestion.deferredReturnState = undefined;
    }

    if (input.state === "accepted" && input.resolvedTaskId)
      relinkSuggestionResponsibility(
        db,
        suggestion.id,
        input.resolvedTaskId,
        nowDate(),
      );
    appendEvent(store, {
      eventType: {
        refined: "suggestion_refine",
        accepted: "suggestion_accept",
        deferred: "suggestion_defer",
        dismissed: "suggestion_dismiss",
      }[input.state],
      entityId: suggestion.id,
      before,
      after: suggestion,
      reason: input.dismissReason,
      source: input.source ?? "human",
  });
  return suggestion;
  });
}

export function reopenWorkSuggestion(
  id: string,
  state: "proposed" | "refined" = "proposed",
): WorkSuggestion {
  return withStore(undefined, (store, db) => {
    const suggestion = store.suggestions.find((item) => item.id === id);
    if (!suggestion) throw new Error("Suggestion not found.");
    if (suggestion.state === state) return suggestion;
    if (ACTIVE_STATES.has(suggestion.state) || suggestion.state === "expired") {
      throw new Error(`Suggestion cannot be reopened from ${suggestion.state}.`);
    }

    const before = { ...suggestion };
    const previousState = suggestion.state;
    if (suggestion.state === "accepted" && suggestion.resolvedTaskId)
      restoreSuggestionResponsibility(db, suggestion.id, suggestion.resolvedTaskId, nowDate());
    suggestion.state = state;
    suggestion.dismissReason = undefined;
    suggestion.resolvedTaskId = undefined;
    suggestion.deferredUntil = undefined;
    suggestion.deferredReturnState = undefined;
    suggestion.updatedAt = nowDate().toISOString();
    if (new Date(suggestion.expiresAt).getTime() <= nowDate().getTime()) {
      suggestion.expiresAt = new Date(
        nowDate().getTime() + 3 * 24 * 60 * 60 * 1000,
      ).toISOString();
    }
    appendEvent(store, {
      eventType: "suggestion_undo",
      entityId: suggestion.id,
      before,
      after: suggestion,
      reason: previousState === "deferred" ? "defer_undo" : undefined,
      source: "human",
  });
  return suggestion;
  });
}

export function recordDecisionEvent(
  input: Omit<DecisionEvent, "id" | "createdAt">,
): DecisionEvent {
  return withStore(undefined, (store) => {
    refreshSuggestionLifecycle(store);
    const event = appendEvent(store, input);
    return event;
  });
}


function restoreSuggestionResponsibility(db: Database.Database, suggestionId: string, taskId: string, now: Date): void {
  const prior = db.prepare("SELECT 1 FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?").get(suggestionId);
  if (prior) return;
  db.prepare("UPDATE cove_responsibilities SET ref_kind='suggestion',ref_id=?,owner='Cove (proposal check)',revision=revision+1,updated_at=? WHERE ref_kind='task' AND ref_id=?")
    .run(suggestionId, now.toISOString(), taskId);
}

type AcceptedTask = Record<string, unknown> & {id: string; status: string; title: string};
export type SuggestionAcceptance = { suggestion: WorkSuggestion; taskId: string; acceptanceId: string };

/** Task change, proposal decision and responsibility ownership commit together. */
export function acceptWorkSuggestion(id: string, input: { source: "explicit_accept" | "focus"; expectedUpdatedAt?: string }): SuggestionAcceptance {
  return withStore(undefined, (store, db) => {
    refreshSuggestionLifecycle(store);
    const suggestion = store.suggestions.find(s => s.id === id);
    if (!suggestion) throw new Error("Suggestion not found.");
    if (suggestion.kind === "attention_nudge") throw new Error("Attention notices should be marked seen, not accepted as tasks.");
    if (suggestion.state === "accepted") {
      const prior = [...store.decisionEvents].reverse().find(e => e.entityId === id && e.eventType === "suggestion_accept_atomic");
      if (prior && suggestion.resolvedTaskId) return {suggestion, taskId:suggestion.resolvedTaskId, acceptanceId:prior.id};
      throw new Error("Suggestion was already accepted. Refresh before continuing.");
    }
    if (!["proposed", "refined"].includes(suggestion.state) || (input.expectedUpdatedAt && input.expectedUpdatedAt !== suggestion.updatedAt))
      throw new Error("This suggestion changed. Refresh before accepting.");
    assertSuggestionSourceCurrent(db,suggestion);
    const now = nowDate(); const stamp = now.toISOString();
    const before = structuredClone(suggestion);
    const targetsTask = ["returned_work", "observed_progress", "stale_task"].includes(suggestion.kind);
    const taskId = targetsTask ? suggestion.targetTaskId : randomUUID();
    if (!taskId) throw new Error("This suggestion has no task reference.");
    const taskBefore = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as AcceptedTask | undefined;
    if (targetsTask && (!taskBefore || taskBefore.status === "archived")) throw new Error("This task is no longer available.");
    if (!targetsTask && taskBefore) throw new Error("The accepted task already exists. Refresh before continuing.");
    if (!targetsTask) {
      const today = (db.prepare("SELECT id,name FROM task_columns ORDER BY position").all() as {id:string;name:string}[]).find(c=>taskColumnKeyForName(c.name)==="today");
      if (!today) throw new Error("Cove needs a Today list before accepting work.");
      db.prepare("INSERT INTO tasks(id,column_id,title,description,priority,due_at,due_date,tags,project,status,source_type,remind_native,remind_text,created_at,updated_at,origin) VALUES(?,?,?,?,?,?,?,'[]','Cove','open','manual',1,0,?,?,?)")
        .run(taskId,today.id,suggestion.title,suggestion.description,suggestion.priority,suggestion.dueDate??null,suggestion.dueDate??null,stamp,stamp,`Accepted Quiet Current suggestion. Source: ${suggestion.source}. Evidence: ${suggestion.reason}`);
    } else if (suggestion.kind === "returned_work") {
      const tags = JSON.parse(String(taskBefore!.tags ?? "[]"));
      db.prepare("UPDATE tasks SET tags=?,updated_at=?,engaged_at=? WHERE id=?").run(JSON.stringify(tags.filter((tag:string)=>tag!=="jarvis-held")),stamp,stamp,taskId);
    } else if (suggestion.kind === "observed_progress" && input.source === "explicit_accept") {
      const doneColumn = (db.prepare("SELECT id,name FROM task_columns ORDER BY position").all() as Array<{id:string;name:string}>).find(c=>taskColumnKeyForName(c.name)==="done");
      if (!doneColumn) throw new Error("Cove needs a Done list to complete this task.");
      const position = db.prepare("SELECT COALESCE(MAX(position),-1)+1 FROM tasks WHERE column_id=? AND status='done'").pluck().get(doneColumn.id) as number;
      db.prepare("UPDATE tasks SET status='done',column_id=?,position=?,updated_at=?,engaged_at=? WHERE id=?").run(doneColumn.id,position,stamp,stamp,taskId);
      syncRecurringOccurrenceForTask(db,taskId,"done",stamp);
    } else {
      db.prepare("UPDATE tasks SET engaged_at=? WHERE id=?").run(stamp,taskId);
    }
    if (!targetsTask) relinkSuggestionResponsibility(db,id,taskId,now);
    const taskAfter = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as AcceptedTask;
    suggestion.state="accepted"; suggestion.resolvedTaskId=taskId; suggestion.updatedAt=stamp;
    const event=appendEvent(store,{eventType:"suggestion_accept_atomic",entityId:id,before:{suggestion:before,task:taskBefore??null},after:{suggestion:structuredClone(suggestion),task:taskAfter,created:!targetsTask},source:input.source});
    return {suggestion,taskId,acceptanceId:event.id};
  });
}

/** Undo restores only the task version changed by this exact acceptance. */
export function undoWorkSuggestionAcceptance(id: string, acceptanceId: string): WorkSuggestion {
  return withStore(undefined,(store,db)=>{
    const suggestion=store.suggestions.find(s=>s.id===id);
    const event=store.decisionEvents.find(e=>e.id===acceptanceId && e.entityId===id && e.eventType==="suggestion_accept_atomic");
    if (!suggestion || !event || suggestion.state!=="accepted") throw new Error("This acceptance is no longer available to undo.");
    const before=event.before as {suggestion:WorkSuggestion;task:AcceptedTask|null};
    const after=event.after as {task:AcceptedTask;created:boolean};
    if (suggestion.resolvedTaskId!==after.task.id) throw new Error("This suggestion changed. Refresh before undoing.");
    const current=sourceRecord(db,"task",after.task.id);
    if (!current || sourceVersion(current)!==sourceVersion(after.task as unknown as NonNullable<ReturnType<typeof sourceRecord>>))
      throw new Error("This task changed after acceptance. Review it before undoing.");
    const stamp=nowDate().toISOString();
    if (after.created) {
      restoreSuggestionResponsibility(db,id,after.task.id,nowDate());
      db.prepare("UPDATE tasks SET archived_from_status=status,status='archived',archived_at=?,updated_at=? WHERE id=?").run(stamp,stamp,after.task.id);
    } else if (before.task) {
      db.prepare("UPDATE tasks SET status=?,column_id=?,position=?,tags=?,updated_at=? WHERE id=?").run(before.task.status,before.task.column_id??null,before.task.position??0,before.task.tags??"[]",stamp,after.task.id);
      syncRecurringOccurrenceForTask(db,after.task.id,before.task.status,stamp);
    }
    const prior=structuredClone(suggestion);
    Object.assign(suggestion,before.suggestion,{updatedAt:stamp});
    delete suggestion.resolvedTaskId;
    appendEvent(store,{eventType:"suggestion_undo_atomic",entityId:id,before:prior,after:structuredClone(suggestion),source:"human"});
    return suggestion;
  });
}
