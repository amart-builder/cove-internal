import type { AttentionLedgerRow } from "./ledger.mjs";
import { createWorkSuggestion } from "../quiet-current/store";

function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function surfaceAttentionSuggestion(input: {
  row: AttentionLedgerRow;
  title: string;
  description?: string;
  reason: string;
  source: string;
  targetTaskId?: string;
  now?: Date;
  dataDir?: string;
}): void {
  const now = input.now ?? new Date();
  // Claim deduplication and insertion share a SQLite write transaction.
  createWorkSuggestion({
    id: `attention-${input.row.id}`,
    kind: "attention_nudge",
    title: input.title,
    description: input.description,
    reason: input.reason,
    source: input.source,
    priority: input.row.level === "text" ? "high" : "medium",
    targetTaskId: input.targetTaskId,
    claimKey: `${input.row.kind}:${input.row.refKind}:${input.row.refId}`,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    dataDir: input.dataDir,
  });
}

export function surfaceAttentionSuppression(input: {
  row: AttentionLedgerRow;
  now?: Date;
  dataDir?: string;
}): void {
  const now = input.now ?? new Date();
  if (
    !input.row.suppressedReason ||
    input.row.suppressedReason.startsWith("cooldown_until:") ||
    input.row.suppressedReason === "sweep_failure"
  ) {
    return;
  }
  // One id per local day keeps concurrent cap hits to one Quiet Current line.
  createWorkSuggestion({
    id: `attention-suppressed-${localDateKey(now)}`,
    kind: "attention_nudge",
    title: "Nudges were suppressed",
    description: "Cove reached an interruption limit. The underlying work is still on the board.",
    reason: "The daily attention budget protected your focus.",
    source: "Cove attention ledger",
    priority: "medium",
    expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1_000).toISOString(),
    dataDir: input.dataDir,
  });
}
