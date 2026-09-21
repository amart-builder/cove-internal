import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { coveConfigPath, coveEnv } from "../env";
import { coveDataDir } from "../operator";
import { recordReceipt } from "../reliability/receipts";
import type { RestrictedMailGateway } from "../workspace";
import { createGoogleWorkspaceGateway, workspaceConfigPath } from "../workspace";
import type { BuddyFeedbackReceipt } from "./receipts";

type EmailConnection = {
  accountEmail: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function validEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

export function resolveSupportEmail(dataDir?: string): string | undefined {
  const fromEnvironment = validEmail(coveEnv("SUPPORT_EMAIL"));
  if (fromEnvironment) return fromEnvironment;
  const config = readJson(coveConfigPath(coveDataDir(dataDir), "support.json"));
  return validEmail(config?.support_email);
}

function readEmailConnection(dataDir?: string): EmailConnection | undefined {
  const config = readJson(workspaceConfigPath(coveDataDir(dataDir)));
  if (config?.provider !== "google-api" || typeof config.account_email !== "string") {
    return undefined;
  }
  return {
    accountEmail: config.account_email.trim(),
  };
}

function appVersion(): string {
  try {
    const pkg = readJson(path.join(process.cwd(), "package.json"));
    return typeof pkg?.version === "string" && pkg.version.trim()
      ? pkg.version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function feedbackContextHeader(
  pageContext: unknown,
  now = new Date(),
): string {
  const context = object(pageContext);
  const view = typeof context?.view === "string" && context.view.trim()
    ? context.view.trim()
    : "unknown";
  return `Context: Cove ${appVersion()}, view ${view}, ${now.toISOString()}`;
}

export function composeFeedbackMessage(input: {
  message: string;
  pageContext?: unknown;
  supportEmail?: string;
  now?: Date;
}): Omit<BuddyFeedbackReceipt, "mode" | "draftId"> {
  const message = input.message.replace(/\s+/g, " ").trim().slice(0, 4_000);
  if (!message) throw new Error("Tell me what happened or what you would like changed.");
  return {
    to: input.supportEmail?.trim() ?? "",
    subject: `Cove feedback: ${message.slice(0, 72)}`,
    body: [
      feedbackContextHeader(input.pageContext, input.now),
      "",
      message,
    ].join("\n"),
  };
}

async function defaultCreateDraft(
  _connection: EmailConnection,
  message: Omit<BuddyFeedbackReceipt, "mode" | "draftId">,
  dataDir?: string,
  gateway?: RestrictedMailGateway,
): Promise<string> {
  const mail = gateway ??
    createGoogleWorkspaceGateway({ dataDir: coveDataDir(dataDir) }).mail;
  const draft = await mail.createSupportDraft({
    recipient: message.to,
    subject: message.subject,
    body: message.body,
    idempotencyKey: `buddy-feedback:${
      createHash("sha256")
        .update(`${message.subject}\0${message.body}`)
        .digest("hex")
    }`,
  });
  return draft.id;
}

export async function prepareBuddyFeedback(input: {
  message: string;
  pageContext?: unknown;
  dataDir?: string;
  dbPath?: string;
  now?: Date;
  createDraft?: (
    connection: EmailConnection,
    message: Omit<BuddyFeedbackReceipt, "mode" | "draftId">,
  ) => Promise<string>;
  gateway?: RestrictedMailGateway;
}): Promise<BuddyFeedbackReceipt> {
  const now = input.now ?? new Date();
  const supportEmail = resolveSupportEmail(input.dataDir);
  const composed = composeFeedbackMessage({
    message: input.message,
    pageContext: input.pageContext,
    supportEmail,
    now,
  });
  let result: BuddyFeedbackReceipt;
  let fallbackReason: BuddyFeedbackReceipt["fallbackReason"];
  if (!supportEmail) {
    fallbackReason = "support_not_configured";
    result = { ...composed, mode: "copy", fallbackReason };
  } else {
    const connection = readEmailConnection(input.dataDir);
    if (!connection) {
      fallbackReason = "email_not_connected";
      result = { ...composed, mode: "copy", fallbackReason };
    } else {
      try {
        const draftId = input.createDraft
          ? await input.createDraft(connection, composed)
          : await defaultCreateDraft(connection, composed, input.dataDir, input.gateway);
        result = { ...composed, mode: "gmail_draft", draftId };
      } catch {
        fallbackReason = "draft_failed";
        result = { ...composed, mode: "copy", fallbackReason };
      }
    }
  }
  recordReceipt({
    dbPath: input.dbPath,
    source: "buddy-feedback",
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: result.mode === "gmail_draft"
      ? "Feedback draft created in Gmail."
      : "Feedback message prepared for copying.",
    actions: {
      delivery: result.mode,
      recipient: result.to,
      ...(result.draftId ? { draftId: result.draftId } : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
    },
    outcome: "success",
  });
  return result;
}

export function buddyFeedbackAssistantText(feedback: BuddyFeedbackReceipt): string {
  if (feedback.mode === "gmail_draft") {
    return "I made a Gmail draft for you. Review it there, then send it yourself.";
  }
  if (feedback.fallbackReason === "support_not_configured") {
    // A fresh install has no address until SETUP.md's Step 5 sets one, and
    // "here is the message to copy" on its own leaves the person holding text
    // with no destination -- the `to` line is empty in exactly this case.
    return "No feedback address is set up, so here is the message to copy. Your Cove setup agent can set one so this drafts itself next time.";
  }
  if (feedback.fallbackReason === "draft_failed") {
    return "I couldn't create the Gmail draft, so here is the message to copy.";
  }
  return "Email is not connected, so I made a message you can copy.";
}
