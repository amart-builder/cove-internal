import type {
  RecurrenceCadence,
  RecurringTemplate,
} from "../tasks/recurrence";

let csrfToken: string | undefined;

async function token(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/day-plan", { cache: "no-store" });
  if (!response.ok) throw new Error("Cove request token is unavailable.");
  const payload = await response.json() as { csrfToken?: unknown };
  if (typeof payload.csrfToken !== "string") {
    throw new Error("Cove request token is unavailable.");
  }
  csrfToken = payload.csrfToken;
  return csrfToken;
}

async function mutate(
  body: Record<string, unknown>,
): Promise<RecurringTemplate> {
  const response = await fetch("/api/recurrence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cove-CSRF": await token(),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json() as {
    error?: unknown;
  } & Partial<RecurringTemplate>;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Cove could not update that rhythm.",
    );
  }
  return payload as RecurringTemplate;
}

export async function listRecurringTemplates(): Promise<RecurringTemplate[]> {
  const response = await fetch("/api/recurrence", { cache: "no-store" });
  const payload = await response.json() as {
    templates?: unknown;
    error?: unknown;
  };
  if (!response.ok || !Array.isArray(payload.templates)) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Cove could not load rhythms.",
    );
  }
  return payload.templates as RecurringTemplate[];
}

export function confirmTaskRecurrence(
  taskId: string,
  cadence?: RecurrenceCadence | string,
): Promise<RecurringTemplate> {
  return mutate({ action: "confirm", taskId, cadence });
}

export function createRecurringTemplate(input: {
  title: string;
  description?: string;
  cadence: RecurrenceCadence | string;
}): Promise<RecurringTemplate> {
  return mutate({ action: "create", ...input });
}

export function updateRecurringTemplate(input: {
  id: string;
  cadence?: RecurrenceCadence | string;
  pausedUntil?: string | null;
  active?: boolean;
}): Promise<RecurringTemplate> {
  return mutate({ action: "update", ...input });
}
