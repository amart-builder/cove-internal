import {
  hasReceiptForSourceStartedAt,
  recordReceipt,
  type ReceiptOutcome,
} from "../src/lib/reliability/receipts";

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
      counts: {
        needYou: Number(argument("need-you-count") ?? 0),
        action: Number(argument("action-count") ?? 0),
        fyi: Number(argument("fyi-count") ?? 0),
        autoChecked: Number(argument("auto-checked-count") ?? 0),
        available: argument("counts-available") === "true",
      },
    };
const source = argument("source") ?? "unknown";
const startedAt = argument("started-at") ?? new Date().toISOString();
if (
  process.argv.includes("--skip-if-existing") &&
  hasReceiptForSourceStartedAt({ source, startedAt })
) {
  process.stdout.write(
    `Receipt already exists for ${source} started at ${startedAt}; skipped fallback.\n`,
  );
  process.exit(0);
}
recordReceipt({
  source,
  startedAt,
  finishedAt: argument("finished-at"),
  summary: argument("summary") ?? "Automated action completed.",
  actions,
  retryCount: Number(argument("retry-count") ?? 0),
  outcome,
  failureKey: argument("failure-key"),
  failureMessage: argument("failure-message"),
});
