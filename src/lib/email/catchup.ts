import { listRecentReceipts, type Receipt } from "../reliability/receipts";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type EmailCatchupWindow = {
  days: number;
  query: string;
  lastSuccessfulAt: string | null;
};

export type EmailTriageContext = EmailCatchupWindow & {
  meetingQuietLines: string[];
};

export function deriveEmailCatchupWindow(
  now: Date,
  receipts: Pick<Receipt, "finishedAt" | "outcome">[],
): EmailCatchupWindow {
  const lastSuccess = receipts
    .filter((receipt) => receipt.outcome === "success")
    .map((receipt) => ({
      receipt,
      time: Date.parse(receipt.finishedAt),
    }))
    .filter(({ time }) => Number.isFinite(time) && time <= now.getTime())
    .sort((left, right) => right.time - left.time)[0];
  const elapsedDays = lastSuccess
    ? Math.ceil((now.getTime() - lastSuccess.time) / DAY_MS)
    : 2;
  const days = Math.min(30, Math.max(2, elapsedDays));
  return {
    days,
    query: `newer_than:${days}d`,
    lastSuccessfulAt: lastSuccess?.receipt.finishedAt ?? null,
  };
}

export function currentEmailCatchupWindow(input: {
  dbPath?: string;
  now?: Date;
} = {}): EmailCatchupWindow {
  return deriveEmailCatchupWindow(
    input.now ?? new Date(),
    listRecentReceipts({
      dbPath: input.dbPath,
      source: "email-triage",
      limit: 200,
    }),
  );
}

export function currentEmailTriageContext(input: {
  dbPath?: string;
  now?: Date;
} = {}): EmailTriageContext {
  const now = input.now ?? new Date();
  const window = currentEmailCatchupWindow({ ...input, now });
  const since = window.lastSuccessfulAt
    ? Date.parse(window.lastSuccessfulAt)
    : now.getTime() - 2 * DAY_MS;
  const meetingQuietLines = listRecentReceipts({
    dbPath: input.dbPath,
    source: "meeting-intake",
    limit: 200,
  })
    .filter((receipt) =>
      (receipt.outcome === "success" || receipt.outcome === "partial") &&
      Date.parse(receipt.finishedAt) > since
    )
    .map((receipt) => receipt.summary.trim())
    .filter(Boolean)
    .filter((summary, index, rows) => rows.indexOf(summary) === index)
    .slice(0, 20);
  return { ...window, meetingQuietLines };
}
