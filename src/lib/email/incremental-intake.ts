import type { MailMessage, RestrictedMailGateway } from "../workspace";
import { observeInboundMessage } from "./state-machine";
import { parseFromHeader } from "./from-header";

const INCREMENTAL_PAGE_SIZE = 100;

function header(message: MailMessage, name: string): string {
  return message.headers.find((item) => item.name.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
}

function fromAccount(message: MailMessage, accountEmail: string): boolean {
  return parseFromHeader(header(message, "From")).address.toLowerCase() ===
    accountEmail.toLowerCase();
}

export async function observeIncrementalInbox(input: {
  gateway: RestrictedMailGateway;
  accountEmail: string;
  dbPath: string;
  now?: () => Date;
}): Promise<{ observed: number; scanned: number; truncated: boolean }> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  await input.gateway.ensureCoveLabel({ name: "Cove/Triaged" });
  const page = await input.gateway.listMessages({
    query: "in:inbox -label:Cove/Triaged -label:Forge/Triaged",
    maxResults: INCREMENTAL_PAGE_SIZE,
  });
  let observed = 0;
  for (const listed of page.messages) {
    const message = await input.gateway.getMessage({
      messageId: listed.id,
      format: "full",
    });
    if (fromAccount(message, input.accountEmail)) continue;
    const from = parseFromHeader(header(message, "From"));
    const result = observeInboundMessage({
      messageId: message.id,
      threadId: message.threadId,
      gmailHistoryId: message.historyId,
      internalDate: message.internalDate ?? "0",
      accountEmail: input.accountEmail,
      senderName: from.displayName.slice(0, 500),
      senderEmail: from.address,
      subject: header(message, "Subject").slice(0, 2_000),
      bodyExcerpt: message.text.slice(0, 20_000),
      receivedAt: message.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : startedAt,
      dbPath: input.dbPath,
      now: now(),
      resurrectFailed: false,
    });
    if (result.inserted) observed += 1;
  }
  return {
    observed,
    scanned: page.messages.length,
    truncated: Boolean(page.nextPageToken),
  };
}
