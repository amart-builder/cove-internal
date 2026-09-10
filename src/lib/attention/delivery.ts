import { notificationUrl } from "./notification-links.mjs";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  allocateAttention,
  finalizeAttentionDelivery,
  type AttentionLedgerRow,
} from "./ledger.mjs";
import {
  cleanAttentionText,
  sanitizeAttentionContent,
  sanitizeNonDirectBanner,
} from "./safety.mjs";
import { createAttentionTransport, type AttentionTransport } from "./transport.mjs";
import {
  surfaceAttentionSuggestion,
  surfaceAttentionSuppression,
} from "./quiet-current";
import { salesPipelineEnabled } from "../crm/sales-pipeline";

const DIRECT_AUTHOR_SOURCES = new Set(["chat", "imessage", "voice", "buddy", "day-plan"]);

export type ChiefOfStaffNotifyRefKind = "task" | "commitment" | "deal";
export type ChiefOfStaffNotifyLevel = "banner" | "text";

export type AttentionItem = {
  title: string;
  direct: boolean;
  provenance: string;
  targetTaskId?: string;
};

export function attentionItemFromSnapshot(
  refKind: "task" | "commitment",
  item: Record<string, unknown>,
): AttentionItem {
  if (refKind === "task") {
    const provenance = taskProvenance(item.inboundSource);
    return {
      title: String(item.title ?? ""),
      direct: provenance.direct,
      provenance: provenance.prefix,
      targetTaskId: String(item.id ?? ""),
    };
  }
  const provenance = commitmentProvenance({
    sourceKind: item.sourceKind,
    sourceRef: item.sourceRef,
    details: item.details,
  });
  return {
    title: String(item.title ?? ""),
    direct: provenance.direct,
    provenance: provenance.prefix,
  };
}

export class AttentionDeliveryRejected extends Error {
  readonly ledgerRowId: string | null;
  readonly deliveredLevel: AttentionLedgerRow["level"] | null;
  readonly textAttempted: boolean;

  constructor(
    reason: string,
    ledgerRowId: string | null = null,
    deliveredLevel: AttentionLedgerRow["level"] | null = null,
    textAttempted = false,
  ) {
    super(reason);
    this.name = "AttentionDeliveryRejected";
    this.ledgerRowId = ledgerRowId;
    this.deliveredLevel = deliveredLevel;
    this.textAttempted = textAttempted;
  }
}

export function readAttentionShadowSetting(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(dataDir, "attention-sweep.json"), "utf8"),
    ) as { shadow?: unknown };
    return parsed?.shadow !== false;
  } catch {
    return true;
  }
}

function taskProvenance(source: unknown): { direct: boolean; prefix: string } {
  const normalized = String(source ?? "").trim().toLowerCase();
  if (DIRECT_AUTHOR_SOURCES.has(normalized)) return { direct: true, prefix: "from you" };
  if (normalized === "email") return { direct: false, prefix: "from email" };
  if (normalized === "meeting") return { direct: false, prefix: "from meeting" };
  return { direct: false, prefix: normalized ? `from ${normalized}` : "from unknown source" };
}

function commitmentProvenance(input: {
  sourceKind: unknown;
  sourceRef: unknown;
  details: unknown;
}): { direct: boolean; prefix: string } {
  if (["brain_dump", "manual", "chat"].includes(String(input.sourceKind ?? ""))) {
    return { direct: true, prefix: "from you" };
  }
  if (String(input.sourceRef ?? "").startsWith("gmail:")) {
    return {
      direct: false,
      prefix: /(?:^|\n)Meeting:/i.test(String(input.details ?? ""))
        ? "from meeting"
        : "from email",
    };
  }
  return { direct: false, prefix: "from unknown source" };
}

function currentAttentionItem(
  db: Database.Database,
  refKind: ChiefOfStaffNotifyRefKind,
  refId: string,
): AttentionItem | null {
  if (refKind === "task") {
    const row = db.prepare(
      `SELECT tasks.id, tasks.title, inbound_events.source AS inbound_source
       FROM tasks
       LEFT JOIN inbound_events ON inbound_events.id = tasks.id
       WHERE tasks.id = ? AND tasks.status = 'open'`,
    ).get(refId) as { id: string; title: string; inbound_source: string | null } | undefined;
    if (!row) return null;
    const provenance = taskProvenance(row.inbound_source);
    return {
      title: row.title,
      direct: provenance.direct,
      provenance: provenance.prefix,
      targetTaskId: row.id,
    };
  }
  if (refKind === "commitment") {
    const row = db.prepare(
      `SELECT id, title, details, source_kind, source_ref
       FROM commitments WHERE id = ? AND status = 'open'`,
    ).get(refId) as {
      id: string;
      title: string;
      details: string | null;
      source_kind: string;
      source_ref: string | null;
    } | undefined;
    if (!row) return null;
    const provenance = commitmentProvenance({
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      details: row.details,
    });
    return { title: row.title, direct: provenance.direct, provenance: provenance.prefix };
  }
  const row = db.prepare(
    `SELECT contacts.name, pipeline_deals.next_action
     FROM pipeline_deals
     JOIN contacts ON contacts.id = pipeline_deals.contact_id
     WHERE pipeline_deals.contact_id = ?
       AND pipeline_deals.stage NOT IN ('client','lost','parked')`,
  ).get(refId) as { name: string; next_action: string } | undefined;
  if (!row) return null;
  return {
    title: `Follow up with ${row.name}: ${row.next_action || "Open Cove to review the next action."}`,
    direct: true,
    provenance: "pipeline",
  };
}

function latestSuppression(db: Database.Database, input: {
  kind: "chief_of_staff" | "sweep_nudge";
  refKind: ChiefOfStaffNotifyRefKind;
  refId: string;
}): { id: string; suppressedReason: string } | null {
  const row = db.prepare(
    `SELECT id, suppressed_reason
     FROM cove_attention_ledger
     WHERE kind = ? AND ref_kind = ? AND ref_id = ?
       AND level = 'suppressed'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(input.kind, input.refKind, input.refId) as {
    id: string;
    suppressed_reason: string | null;
  } | undefined;
  return row ? { id: row.id, suppressedReason: row.suppressed_reason || "attention_cap" } : null;
}

function safeItemTitle(item: AttentionItem): string {
  const title = cleanAttentionText(item.title) || "Item";
  if (item.provenance === "pipeline") {
    return cleanAttentionText(sanitizeAttentionContent(title) || "Open Cove to review this deal.")
      .slice(0, 180);
  }
  return item.direct
    ? title.slice(0, 180)
    : cleanAttentionText(sanitizeNonDirectBanner(title, item.provenance));
}

function deliveryBanner(item: AttentionItem, reason: string, includeReason: boolean): string {
  if (!includeReason) return safeItemTitle(item);
  return cleanAttentionText(sanitizeNonDirectBanner(
    `${(sanitizeAttentionContent(item.title) || "Item").slice(0, 70)}. ${sanitizeAttentionContent(reason).slice(0, 100)}`,
    item.direct ? "from you" : item.provenance,
  ));
}

export function deliverAttentionNudge(input: {
  db: Database.Database;
  dataDir: string;
  repoDir?: string;
  kind?: "chief_of_staff" | "sweep_nudge";
  refKind: ChiefOfStaffNotifyRefKind;
  refId: string;
  level: ChiefOfStaffNotifyLevel;
  reason: string;
  now?: Date;
  shadow?: boolean;
  transport?: AttentionTransport;
  surface?: typeof surfaceAttentionSuggestion;
  surfaceSuppression?: typeof surfaceAttentionSuppression;
  initialItem?: AttentionItem;
  textMessage?: string;
  includeReasonInBanner?: boolean;
  allowText?: boolean;
  acceptBoardOnly?: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  row: AttentionLedgerRow;
  finalLevel: AttentionLedgerRow["level"];
  text: string;
  textAttempted: boolean;
} {
  const now = input.now ?? new Date();
  const kind = input.kind ?? "chief_of_staff";
  if (input.refKind === "deal" && !salesPipelineEnabled(input.env)) {
    throw new AttentionDeliveryRejected("sales_pipeline_disabled");
  }
  const current = input.initialItem ?? currentAttentionItem(input.db, input.refKind, input.refId);
  if (!current) throw new AttentionDeliveryRejected("no longer open");

  const shadow = input.shadow ?? readAttentionShadowSetting(input.dataDir);
  const transport = input.transport ?? createAttentionTransport({ repoDir: input.repoDir });
  const surface = input.surface ?? surfaceAttentionSuggestion;
  const surfaceSuppression = input.surfaceSuppression ?? surfaceAttentionSuppression;
  const maximumLevel = input.allowText !== false && current.direct && transport.textConfigured
    ? "text"
    : "banner";
  const allocation = allocateAttention(input.db, {
    kind,
    refKind: input.refKind,
    refId: input.refId,
    requestedLevel: input.level,
    maximumLevel,
    reason: input.reason,
    shadow,
    now,
  });
  for (const row of allocation.suppressionRows) {
    try {
      surfaceSuppression({ row, now, dataDir: input.dataDir });
    } catch {
      // The durable ledger preserves the suppression if the board is busy.
    }
  }
  if (!allocation.row) {
    const suppression = allocation.suppressionRows.at(-1) ?? latestSuppression(input.db, {
      kind,
      refKind: input.refKind,
      refId: input.refId,
    });
    throw new AttentionDeliveryRejected(
      suppression?.suppressedReason || "attention_cap",
      suppression?.id ?? null,
      "suppressed",
    );
  }

  const fresh = currentAttentionItem(input.db, input.refKind, input.refId);
  if (!fresh) {
    finalizeAttentionDelivery(input.db, {
      id: allocation.row.id,
      level: "suppressed",
      suppressedReason: "completed_since_snapshot",
      now,
    });
    throw new AttentionDeliveryRejected("no longer open", allocation.row.id, "suppressed");
  }
  const title = safeItemTitle(fresh);
  if (shadow) {
    try {
      surface({
        row: allocation.row,
        title: `Would have interrupted: ${title}`,
        reason: input.reason,
        source: kind === "chief_of_staff" ? "Cove chief of staff shadow" : "Cove attention sweep shadow",
        targetTaskId: fresh.targetTaskId,
        now,
        dataDir: input.dataDir,
      });
      return { row: allocation.row, finalLevel: "shadow", text: title, textAttempted: false };
    } catch {
      finalizeAttentionDelivery(input.db, {
        id: allocation.row.id,
        level: "suppressed",
        suppressedReason: "quiet_current_failed",
        now,
      });
      throw new AttentionDeliveryRejected(
        "quiet_current_failed",
        allocation.row.id,
        "suppressed",
      );
    }
  }

  const banner = deliveryBanner(fresh, input.reason, input.includeReasonInBanner === true);
  let bannerDelivered = false;
  let textDelivered = false;
  let boardDelivered = false;
  let textAttempted = false;
  const transportErrors: string[] = [];
  if (allocation.finalLevel === "text") {
    textAttempted = true;
    try {
      textDelivered = transport.text(
        input.textMessage ?? "Cove: 1 thing needs a look. Open the board.",
      ) !== false;
    } catch (error) {
      textDelivered = false;
      transportErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (allocation.finalLevel === "banner" || !textDelivered) {
    try {
      transport.banner(banner, "Needs your attention", notificationUrl({ taskId: fresh.targetTaskId, attentionId: allocation.row.id }));
      bannerDelivered = true;
    } catch (error) {
      bannerDelivered = false;
      transportErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    surface({
      row: allocation.row,
      title,
      reason: input.reason,
      source: kind === "chief_of_staff" ? "Cove chief of staff" : "Cove attention sweep",
      targetTaskId: fresh.targetTaskId,
      now,
      dataDir: input.dataDir,
    });
    boardDelivered = true;
  } catch {
    boardDelivered = false;
  }
  const deliveredLevel = textDelivered
    ? "text"
    : bannerDelivered
      ? "banner"
      : boardDelivered
        ? "board"
        : "suppressed";
  finalizeAttentionDelivery(input.db, {
    id: allocation.row.id,
    level: deliveredLevel,
    suppressedReason: deliveredLevel === "suppressed" ? "delivery_failed" : undefined,
    now,
  });
  if (deliveredLevel === "suppressed") {
    throw new AttentionDeliveryRejected(
      "delivery_failed",
      allocation.row.id,
      "suppressed",
      textAttempted,
    );
  }
  if (deliveredLevel === "board" && input.acceptBoardOnly !== true) {
    const transportError = cleanAttentionText(transportErrors.join("; ")).slice(0, 300) ||
      "notification transport unavailable";
    throw new AttentionDeliveryRejected(
      `delivered_board_only:${transportError}`,
      allocation.row.id,
      "board",
      textAttempted,
    );
  }
  return {
    row: allocation.row,
    finalLevel: deliveredLevel,
    text: banner,
    textAttempted,
  };
}
