import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { coveConfigPath, coveEnv } from "../env";
import { coveDataDir } from "../operator";
import { recordReceipt } from "../reliability/receipts";
import type { BuddyFeedbackReceipt } from "./receipts";

const execFileAsync = promisify(execFile);
const GMAIL_CREATE_DRAFT_TOOL = "GMAIL_CREATE_EMAIL_DRAFT";

type EmailConnection = {
  accountEmail: string;
  connectedAccountId: string;
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
  const config = readJson(coveConfigPath(coveDataDir(dataDir), "email.json"));
  if (
    config?.connector !== "composio" ||
    typeof config.account_email !== "string" ||
    !config.account_email.trim() ||
    typeof config.connected_account_id !== "string" ||
    !config.connected_account_id.trim()
  ) return undefined;
  return {
    accountEmail: config.account_email.trim(),
    connectedAccountId: config.connected_account_id.trim(),
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

function draftIdFromResult(value: unknown): string | undefined {
  const row = object(value);
  const data = object(row?.data);
  return [row?.id, row?.draft_id, data?.id, data?.draft_id].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && Boolean(candidate.trim()),
  );
}

async function defaultCreateDraft(
  connection: EmailConnection,
  message: Omit<BuddyFeedbackReceipt, "mode" | "draftId">,
): Promise<string> {
  const result = await execFileAsync(
    coveEnv("COMPOSIO_BIN") ?? "composio",
    [
      "execute",
      GMAIL_CREATE_DRAFT_TOOL,
      "-d",
      JSON.stringify({
        user_id: connection.accountEmail,
        recipient_email: message.to,
        subject: message.subject,
        body: message.body,
      }),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 12 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  let parsed = JSON.parse(result.stdout) as unknown;
  const first = object(parsed);
  if (first?.successful === false || first?.success === false) {
    throw new Error("Composio could not create the draft.");
  }
  if (first?.storedInFile === true && typeof first.outputFilePath === "string") {
    const file = path.isAbsolute(first.outputFilePath)
      ? first.outputFilePath
      : path.resolve(process.cwd(), first.outputFilePath);
    if (!existsSync(file)) throw new Error("Composio draft result was unavailable.");
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  }
  const id = draftIdFromResult(parsed);
  if (!id) throw new Error("Composio did not return a Gmail draft id.");
  return id;
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
        const draftId = await (input.createDraft ?? defaultCreateDraft)(
          connection,
          composed,
        );
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
    return "No feedback address is set up, so here is the message to copy.";
  }
  if (feedback.fallbackReason === "draft_failed") {
    return "I couldn't create the Gmail draft, so here is the message to copy.";
  }
  return "Email is not connected, so I made a message you can copy.";
}
