export type SuggestionKind = "create_task" | "returned_work" | "observed_progress";

export type SuggestionState =
  | "proposed"
  | "refined"
  | "accepted"
  | "deferred"
  | "dismissed"
  | "expired";

export type WorkSuggestion = {
  id: string;
  kind: SuggestionKind;
  title: string;
  description: string;
  reason: string;
  source: string;
  priority: "low" | "medium" | "high";
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

export type QuietCurrentSnapshot = {
  version: 1;
  csrfToken: string;
  suggestions: WorkSuggestion[];
  decisionEvents: Array<{
    id: string;
    eventType: string;
    entityId?: string;
    createdAt: string;
  }>;
};

let csrfToken: string | undefined;

async function fetchQuietCurrentSnapshot(): Promise<QuietCurrentSnapshot> {
  const response = await fetch("/api/quiet-current", { cache: "no-store" });
  if (!response.ok) throw new Error("Cove couldn't refresh Jarvis suggestions.");
  const snapshot = (await response.json()) as QuietCurrentSnapshot;
  csrfToken = snapshot.csrfToken;
  return snapshot;
}

async function quietCurrentRequest<T>(body?: Record<string, unknown>): Promise<T> {
  if (!body) return (await fetchQuietCurrentSnapshot()) as T;
  if (body.action !== "suggest" && !csrfToken) await fetchQuietCurrentSnapshot();
  const response = await fetch("/api/quiet-current", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-Forge-CSRF": csrfToken } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || "Cove couldn't update that suggestion. Try again.");
  }
  return (await response.json()) as T;
}

export function getQuietCurrent(): Promise<QuietCurrentSnapshot> {
  return fetchQuietCurrentSnapshot();
}

export function resolveSuggestion(
  id: string,
  input: {
    state: "refined" | "accepted" | "deferred" | "dismissed";
    title?: string;
    description?: string;
    dueDate?: string;
    priority?: "low" | "medium" | "high";
    dismissReason?: string;
    resolvedTaskId?: string;
    source?: string;
  },
): Promise<WorkSuggestion> {
  return quietCurrentRequest<WorkSuggestion>({ action: "resolve", id, ...input });
}

export function reopenSuggestion(
  id: string,
  state: "proposed" | "refined" = "proposed",
): Promise<WorkSuggestion> {
  return quietCurrentRequest<WorkSuggestion>({ action: "reopen", id, state });
}

export function recordDecision(input: {
  eventType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  source?: string;
}): Promise<unknown> {
  return quietCurrentRequest({ action: "event", ...input });
}
