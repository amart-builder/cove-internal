import { openLocalDatabase } from "../local/database";
import { normalizeContactEmail, normalizeContactName } from "../crm/identity";
import type { MailHeader, MailMessage, RestrictedMailGateway } from "../workspace/contracts";

/** Sent mail read against the operator's own open promises.
 *
 * Cove records what the operator said they would do (promise, follow_up) but
 * nothing read what they then did. When the operator sends the email that
 * fulfils a promise, the commitment stays open until they tidy it by hand,
 * and the morning brief keeps asking about work that is already done.
 *
 * This lane reads recently sent mail and, when a message goes to the
 * commitment's counterparty and carries the words of the commitment, writes a
 * "looks done" proposal into the commitment's evidence. It is the same
 * `proposed_resolution` shape the day dump writes for a low-confidence
 * resolution, so the brief already renders it under proposed clarifications.
 * Nothing here changes a commitment's status: closing it stays the person's
 * decision, and a proposal is written once per message. */

export type SentMailReconciliationOptions = {
  mail: Pick<RestrictedMailGateway, "listMessages" | "getMessage">;
  dbPath?: string;
  now?: Date | (() => Date);
  lookbackDays?: number;
  maxMessages?: number;
};

export type SentMailReconciliationResult = {
  scanned: number;
  proposed: number;
  proposedCommitmentIds: string[];
};

type OpenPromise = {
  id: string;
  kind: string;
  title: string;
  details: string | null;
  counterparty: string | null;
  contact_email: string | null;
  evidence: string | null;
};

const STOPWORDS = new Set([
  "about", "after", "again", "before", "being", "between", "could", "email", "follow", "from",
  "have", "into", "just", "make", "more", "need", "over", "send", "sent", "share", "should",
  "some", "take", "than", "that", "their", "them", "then", "there", "these", "they", "this",
  "today", "tomorrow", "week", "what", "when", "which", "will", "with", "would", "your", "back",
  "reach", "check", "call", "meeting", "note", "notes", "reply", "update",
]);

export function commitmentKeywords(text: string): string[] {
  return Array.from(new Set(
    normalizeContactName(text)
      .split(" ")
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token) && !/^\d+$/.test(token)),
  ));
}

function header(headers: MailHeader[], name: string): string {
  return headers.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function recipientText(message: MailMessage): string {
  return [header(message.headers, "To"), header(message.headers, "Cc"), header(message.headers, "Bcc")]
    .join(", ")
    .toLowerCase();
}

/** A sent message counts as evidence for a promise only when it went to the
 * person the promise names and its subject or body carries the promise's own
 * words. Either half alone is a guess: a note to Kia about something else,
 * or the word "proposal" to anyone. */
export function sentMailMatchesCommitment(
  message: Pick<MailMessage, "headers" | "text" | "snippet">,
  commitment: Pick<OpenPromise, "title" | "details" | "counterparty" | "contact_email">,
): { subject: string; matchedKeywords: string[] } | null {
  const recipients = recipientText(message as MailMessage);
  const email = normalizeContactEmail(commitment.contact_email ?? undefined);
  const name = commitment.counterparty ? normalizeContactName(commitment.counterparty) : "";
  const nameParts = name.split(" ").filter((part) => part.length >= 3);
  const toCounterparty = Boolean(
    (email && recipients.includes(email)) ||
    (name && normalizeContactName(recipients).includes(name)) ||
    (nameParts.length >= 2 && nameParts.every((part) => normalizeContactName(recipients).includes(part))),
  );
  if (!toCounterparty) return null;
  const subject = header(message.headers, "Subject");
  const body = normalizeContactName(`${subject}\n${message.text || message.snippet || ""}`);
  const keywords = commitmentKeywords(`${commitment.title} ${commitment.details ?? ""}`)
    .filter((keyword) => !nameParts.includes(keyword));
  const matched = keywords.filter((keyword) => body.includes(keyword));
  const needed = Math.min(2, keywords.length);
  if (keywords.length === 0 || matched.length < needed) return null;
  return { subject, matchedKeywords: matched };
}

function evidenceObject(value: string | null): Record<string, unknown> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Legacy free text is kept below.
  }
  return { prior_evidence: value.slice(0, 500) };
}

function openPromises(dbPath: string | undefined): { promises: OpenPromise[]; close: () => void } {
  const db = openLocalDatabase(dbPath);
  const promises = db.prepare(
    `SELECT c.id, c.kind, c.title, c.details, c.counterparty, c.evidence, p.email AS contact_email
       FROM commitments c LEFT JOIN contacts p ON p.id = c.contact_id
      WHERE c.status = 'open' AND c.kind IN ('promise', 'follow_up')
      ORDER BY c.due_at ASC NULLS LAST, c.created_at ASC
      LIMIT 200`,
  ).all() as OpenPromise[];
  return { promises, close: () => db.close() };
}

export function hasOpenPromises(dbPath?: string): boolean {
  const { promises, close } = openPromises(dbPath);
  close();
  return promises.length > 0;
}

export async function reconcileSentMailWithCommitments(
  options: SentMailReconciliationOptions,
): Promise<SentMailReconciliationResult> {
  const now = typeof options.now === "function" ? options.now() : options.now ?? new Date();
  const lookback = Math.max(1, Math.floor(options.lookbackDays ?? 3));
  const { promises, close } = openPromises(options.dbPath);
  const result: SentMailReconciliationResult = { scanned: 0, proposed: 0, proposedCommitmentIds: [] };
  if (promises.length === 0) {
    close();
    return result;
  }
  try {
    const page = await options.mail.listMessages({
      query: `in:sent newer_than:${lookback}d`,
      maxResults: Math.max(1, Math.min(100, options.maxMessages ?? 40)),
    });
    const db = openLocalDatabase(options.dbPath);
    try {
      const update = db.prepare("UPDATE commitments SET evidence = ?, updated_at = ? WHERE id = ? AND status = 'open'");
      for (const listed of page.messages) {
        let message: MailMessage;
        try {
          message = await options.mail.getMessage({ messageId: listed.id, format: "full" });
        } catch {
          continue;
        }
        result.scanned += 1;
        for (const promise of promises) {
          const match = sentMailMatchesCommitment(message, promise);
          if (!match) continue;
          const evidence = evidenceObject(promise.evidence);
          const existing = evidence.proposed_resolution as Record<string, unknown> | undefined;
          // One proposal per commitment: a person who ignored the first one
          // does not need it restated by the next message, and a proposal from
          // the day dump is theirs to act on first.
          if (existing && typeof existing === "object") continue;
          const sentAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : now.toISOString();
          const next = {
            ...evidence,
            proposed_resolution: {
              action: "done",
              quote: `Sent "${match.subject.slice(0, 140) || "(no subject)"}" to ${promise.counterparty ?? "the counterparty"}`,
              note: `A sent email on ${sentAt.slice(0, 10)} looks like it fulfils this (matched: ${match.matchedKeywords.slice(0, 4).join(", ")}). Close it only if that is right.`,
              confidence: "medium",
              source: "sent_mail",
              message_id: message.id,
              thread_id: message.threadId,
              sent_at: sentAt,
              proposed_at: now.toISOString(),
            },
          };
          const stamp = now.toISOString();
          if (update.run(JSON.stringify(next), stamp, promise.id).changes === 1) {
            promise.evidence = JSON.stringify(next);
            result.proposed += 1;
            result.proposedCommitmentIds.push(promise.id);
          }
        }
      }
    } finally {
      db.close();
    }
  } finally {
    close();
  }
  return result;
}
