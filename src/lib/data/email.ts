import { coveRest } from "../supabase/rest";
import { getRuntimeMode } from "../runtime/mode";
import { getDayPlanCsrfToken } from "./day-plan";
import type { Draft, EmailActionLog, EmailItem, EmailTriageRun } from "./types";

export async function listEmailItems(status = "pending"): Promise<EmailItem[]> {
  return coveRest<EmailItem[]>("email_items", {
    requireAuth: true,
    query: {
      select: "*",
      status: `eq.${status}`,
      order: "received_at.desc.nullslast,created_at.desc",
    },
  });
}

export async function listHandledEmailItems({
  days = 7,
  limit = 200,
}: {
  days?: number;
  limit?: number;
} = {}): Promise<EmailItem[]> {
  const boundedDays = Math.max(1, Math.floor(days));
  const boundedLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const since = new Date(Date.now() - boundedDays * 24 * 60 * 60_000).toISOString();
  return coveRest<EmailItem[]>("email_items", {
    requireAuth: true,
    query: {
      select: "*",
      status: "in.(actioned,archived,reviewed)",
      bucket: "in.(fyi,noise)",
      actioned_at: `gte.${since}`,
      order: "actioned_at.desc",
      limit: boundedLimit,
    },
  });
}

export async function listAllEmailItems(): Promise<EmailItem[]> {
  return coveRest<EmailItem[]>("email_items", {
    requireAuth: true,
    query: {
      select: "*",
      order: "created_at.desc",
    },
  });
}

export async function listDrafts(status = "needs_review"): Promise<Draft[]> {
  return coveRest<Draft[]>("drafts", {
    requireAuth: true,
    query: {
      select: "*",
      status: `eq.${status}`,
      order: "created_at.desc",
    },
  });
}

export async function listEmailActionLog(): Promise<EmailActionLog[]> {
  return coveRest<EmailActionLog[]>("email_action_log", {
    requireAuth: true,
    query: {
      select: "*",
      order: "created_at.desc",
      limit: 50,
    },
  });
}

export async function getLatestEmailSummary(): Promise<string> {
  const rows = await coveRest<EmailTriageRun[]>("email_triage_runs", {
    requireAuth: true,
    query: {
      select: "id,summary,created_at",
      order: "created_at.desc",
      limit: 1,
    },
  });
  return rows[0]?.summary ?? "No triage data yet.";
}

export async function updateEmailItem(
  id: string,
  patch: Partial<EmailItem>,
): Promise<EmailItem> {
  const rows = await coveRest<EmailItem[]>("email_items", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: patch,
  });
  return rows[0];
}

export async function archiveEmailItemFromCard(id: string): Promise<void> {
  if (getRuntimeMode() !== "local") {
    throw new Error(
      "Email can only be marked handled after the connected Gmail account confirms the archive.",
    );
  }
  const csrfToken = await getDayPlanCsrfToken();
  const response = await fetch("/api/email/automation", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cove-CSRF": csrfToken,
    },
    body: JSON.stringify({ action: "card_archive", emailItemId: id }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as {
      error?: string;
    };
    throw new Error(payload.error || "Gmail archive failed.");
  }
}

export async function updateDraft(id: string, patch: Partial<Draft>): Promise<Draft> {
  const rows = await coveRest<Draft[]>("drafts", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: patch,
  });
  return rows[0];
}
