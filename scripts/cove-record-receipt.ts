import { recordReceipt, type ReceiptOutcome } from "../src/lib/reliability/receipts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outcome = argument("outcome") as ReceiptOutcome | undefined;
if (!outcome || !["success", "partial", "failed", "skipped"].includes(outcome)) {
  throw new Error("--outcome must be success, partial, failed, or skipped.");
}
const actionsText = argument("actions-json");
const actions = actionsText
  ? JSON.parse(actionsText)
  : {
      entryPoint: argument("entry-point"),
      engine: argument("engine"),
      exitCode: Number(argument("exit-code") ?? 0),
      actionSummary: argument("action-summary"),
    };
recordReceipt({
  source: argument("source") ?? "unknown",
  startedAt: argument("started-at") ?? new Date().toISOString(),
  summary: argument("summary") ?? "Automated action completed.",
  actions,
  retryCount: Number(argument("retry-count") ?? 0),
  outcome,
  failureKey: argument("failure-key"),
  failureMessage: argument("failure-message"),
});
