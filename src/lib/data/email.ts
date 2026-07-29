import { forgeRest } from "../supabase/rest";
import { getRuntimeMode } from "../runtime/mode";
import { getDayPlanCsrfToken } from "./day-plan";
import type { Draft, EmailActionLog, EmailItem, EmailTriageRun } from "./types";

export async function listEmailItems(status = "pending"): Promise<EmailItem[]> {
  return forgeRest<EmailItem[]>("email_items", {
    requireAuth: true,
    query: {
      select: "*",
      status: `eq.${status}`,
      order: "received_at.desc.nullslast,created_at.desc",
    },
  });
}

export async function listAllEmailItems(): Promise<EmailItem[]> {
  return forgeRest<EmailItem[]>("email_items", {
    requireAuth: true,
    query: {
      select: "*",
      order: "created_at.desc",
    },
  });
}

export async function listDrafts(status = "needs_review"): Promise<Draft[]> {
  return forgeRest<Draft[]>("drafts", {
    requireAuth: true,
    query: {
      select: "*",
      status: `eq.${status}`,
      order: "created_at.desc",
    },
  });
}

export async function listEmailActionLog(): Promise<EmailActionLog[]> {
  return forgeRest<EmailActionLog[]>("email_action_log", {
    requireAuth: true,
    query: {
      select: "*",
      order: "created_at.desc",
      limit: 50,
    },
  });
}

export async function getLatestEmailSummary(): Promise<string> {
  const rows = await forgeRest<EmailTriageRun[]>("email_triage_runs", {
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
  const rows = await forgeRest<EmailItem[]>("email_items", {
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
      "X-Forge-CSRF": csrfToken,
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
  const rows = await forgeRest<Draft[]>("drafts", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: patch,
  });
  return rows[0];
}
