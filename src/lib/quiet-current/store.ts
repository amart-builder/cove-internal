import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coveDataDir } from "../operator";
import { coveEnv } from "../env";

export type SuggestionKind = "create_task" | "returned_work" | "observed_progress";

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

type QuietCurrentStore = {
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

function storePath(): string {
  if (testStorePath) return testStorePath;
  const configuredName = coveEnv("QUIET_CURRENT_FILE");
  const fileName = configuredName ? path.basename(configuredName) : "quiet-current.json";
  return path.join(coveDataDir(), fileName);
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

function readStore(): QuietCurrentStore {
  const file = storePath();
  try {
    const parsed = JSON.parse(
      readFileSync(/* turbopackIgnore: true */ file, "utf8"),
    ) as QuietCurrentStore;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.suggestions) ||
      !Array.isArray(parsed.decisionEvents)
    ) {
      throw new Error("Quiet Current data has an unsupported shape.");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw error;
  }
}

function writeStore(store: QuietCurrentStore): void {
  const file = storePath();
  mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(/* turbopackIgnore: true */ temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(
    /* turbopackIgnore: true */ temporary,
    /* turbopackIgnore: true */ file,
  );
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

export function getQuietCurrentSnapshot(): QuietCurrentStore {
  const store = readStore();
  if (refreshSuggestionLifecycle(store)) writeStore(store);
  return store;
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
}): WorkSuggestion {
  const kind = input.kind ?? "create_task";
  if (
    (kind === "returned_work" || kind === "observed_progress") &&
    !input.targetTaskId
  ) {
    throw new Error(`${kind === "returned_work" ? "Returned work" : "Observed progress"} requires an existing target task.`);
  }
  const store = readStore();
  const lifecycleChanged = refreshSuggestionLifecycle(store);
  if (input.id) {
    const existing = store.suggestions.find((suggestion) => suggestion.id === input.id);
    if (existing) {
      if (lifecycleChanged) writeStore(store);
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
    claimKey: input.claimKey,
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
  writeStore(store);
  return suggestion;
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
  const store = readStore();
  refreshSuggestionLifecycle(store);
  const suggestion = store.suggestions.find((item) => item.id === id);
  if (!suggestion) throw new Error("Suggestion not found.");
  if (suggestion.state !== "proposed" && suggestion.state !== "refined") {
    throw new Error(`Suggestion is already ${suggestion.state}.`);
  }

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
  writeStore(store);
  return suggestion;
}

export function reopenWorkSuggestion(
  id: string,
  state: "proposed" | "refined" = "proposed",
): WorkSuggestion {
  const store = readStore();
  const suggestion = store.suggestions.find((item) => item.id === id);
  if (!suggestion) throw new Error("Suggestion not found.");
  if (suggestion.state === state) return suggestion;
  if (ACTIVE_STATES.has(suggestion.state) || suggestion.state === "expired") {
    throw new Error(`Suggestion cannot be reopened from ${suggestion.state}.`);
  }

  const before = { ...suggestion };
  const previousState = suggestion.state;
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
  writeStore(store);
  return suggestion;
}

export function recordDecisionEvent(
  input: Omit<DecisionEvent, "id" | "createdAt">,
): DecisionEvent {
  const store = readStore();
  refreshSuggestionLifecycle(store);
  const event = appendEvent(store, input);
  writeStore(store);
  return event;
}
