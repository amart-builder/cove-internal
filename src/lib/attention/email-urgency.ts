import { notificationUrl } from "./notification-links.mjs";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  allocateAttention,
  finalizeAttentionDelivery,
  hasAttentionLedger,
  type AttentionLedgerRow,
} from "./ledger.mjs";
import {
  safeSenderDomain,
  sanitizeNonDirectBanner,
} from "./safety.mjs";
import {
  createAttentionTransport,
  type AttentionTransport,
} from "./transport.mjs";
import {
  surfaceAttentionSuggestion,
  surfaceAttentionSuppression,
} from "./quiet-current";

function shadowSetting(dataDir: string): boolean {
  const file = path.join(dataDir, "attention-sweep.json");
  if (!existsSync(file)) return true;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as {
      email_shadow?: unknown;
    };
    return value.email_shadow !== false;
  } catch {
    return true;
  }
}

export type EmailUrgencyResult = {
  status: "not_urgent" | "deduped" | "stale" | "shadow" | "live" | "suppressed";
  // Why nothing was sent. "budget" is the interruption policy working and the
  // suppression already reaches the board; "shadow_only" is the lane recording
  // rather than alerting, where a lost log line is not a missed alert. The
  // other two mean nobody was told at all, which is the drop this lane exists
  // to prevent, so the caller turns those into a visible failure.
  reason?: "budget" | "shadow_only" | "no_ledger" | "delivery_failed";
  row?: AttentionLedgerRow;
};

export function handleUrgentEmail(input: {
  dbPath: string;
  dataDir?: string;
  repoDir?: string;
  messageId: string;
  emailItemId: string;
  fromHeader: string;
  urgent?: boolean;
  urgencyReason?: string | null;
  now?: Date;
  shadow?: boolean;
}, dependencies: {
  transport?: AttentionTransport;
  surface?: typeof surfaceAttentionSuggestion;
  surfaceSuppression?: typeof surfaceAttentionSuppression;
} = {}): EmailUrgencyResult {
  if (input.urgent !== true || !input.urgencyReason?.trim()) {
    return { status: "not_urgent" };
  }
  const now = input.now ?? new Date();
  const dataDir = input.dataDir ?? path.dirname(input.dbPath);
  const shadow = input.shadow ?? shadowSetting(dataDir);
  const transport = dependencies.transport ?? createAttentionTransport({
    repoDir: input.repoDir,
    dataDir,
  });
  const surface = dependencies.surface ?? surfaceAttentionSuggestion;
  const surfaceSuppression = dependencies.surfaceSuppression ??
    surfaceAttentionSuppression;
  const db = new Database(input.dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  try {
    if (!hasAttentionLedger(db)) return { status: "suppressed", reason: "no_ledger" };
    // A shadow row alerted nobody, so it must not block a later real alert for
    // the same message. Only a shadow run treats an earlier shadow row as a
    // duplicate, which keeps the shadow log itself free of repeats.
    const seenLevels = shadow
      ? ["text", "banner", "board", "shadow"]
      : ["text", "banner", "board"];
    const duplicate = db.prepare(
      `SELECT 1 FROM cove_attention_ledger
       WHERE kind = 'urgent_email' AND ref_kind = 'email' AND ref_id = ?
         AND level IN (${seenLevels.map(() => "?").join(",")})
       LIMIT 1`,
    ).get(input.messageId, ...seenLevels);
    if (duplicate) return { status: "deduped" };

    const current = db.prepare(
      `SELECT 1
         FROM cove_email_messages messages
         JOIN email_items items ON items.id = messages.email_item_id
        WHERE messages.message_id = ?
          AND messages.state = 'processed'
          AND items.id = ?
          AND items.latest_inbound_message_id = messages.message_id
          AND items.status = 'pending'
          AND items.workflow_state = 'open'`,
    ).get(input.messageId, input.emailItemId);
    if (!current) return { status: "stale" };

    // Deliberate exception to the rule that email-origin items never text. The
    // message carries only a normalized sender domain, never sender-controlled
    // prose, so nothing an attacker writes can reach the phone.
    const allocation = allocateAttention(db, {
      kind: "urgent_email",
      refKind: "email",
      refId: input.messageId,
      requestedLevel: transport.textConfigured ? "text" : "banner",
      maximumLevel: transport.textConfigured ? "text" : "banner",
      reason: input.urgencyReason,
      shadow,
      now,
    });
    for (const row of allocation.suppressionRows) {
      try {
        surfaceSuppression({ row, now, dataDir });
      } catch {
        // The ledger remains the source of truth if the file-backed board is busy.
      }
    }
    if (!allocation.row) return { status: "suppressed", reason: "budget" };

    // Classification nominates the message. Re-read the canonical thread row
    // immediately before transport so a newer or completed thread wins.
    const stillCurrent = db.prepare(
      `SELECT 1
         FROM cove_email_messages messages
         JOIN email_items items ON items.id = messages.email_item_id
        WHERE messages.message_id = ?
          AND messages.state = 'processed'
          AND items.id = ?
          AND items.latest_inbound_message_id = messages.message_id
          AND items.status = 'pending'
          AND items.workflow_state = 'open'`,
    ).get(input.messageId, input.emailItemId);
    if (!stillCurrent) {
      db.prepare(
        `UPDATE cove_attention_ledger
         SET level = 'suppressed', delivered_at = NULL,
             suppressed_reason = 'completed_since_snapshot'
         WHERE id = ?`,
      ).run(allocation.row.id);
      return { status: "stale", row: allocation.row };
    }

    const domain = safeSenderDomain(input.fromHeader);
    const title = `Urgent email from ${domain}`;
    if (shadow) {
      try {
        surface({
          row: allocation.row,
          title: `Would have alerted: ${title}`,
          reason: input.urgencyReason,
          source: "Cove email urgency shadow",
          dataDir,
          now,
        });
      } catch {
        finalizeAttentionDelivery(db, {
          id: allocation.row.id,
          level: "suppressed",
          suppressedReason: "quiet_current_failed",
          now,
        });
        // Shadow mode was never going to alert anyone, so a failed shadow
        // board write loses a log line, not a person's alert.
        return { status: "suppressed", reason: "shadow_only", row: allocation.row };
      }
      return { status: "shadow", row: allocation.row };
    }

    let bannerDelivered = false;
    let textDelivered = false;
    let boardDelivered = false;
    if (allocation.finalLevel === "text" || allocation.finalLevel === "banner") {
      try {
        transport.banner(sanitizeNonDirectBanner(
          `Urgent message. ${input.urgencyReason}`,
          "from email",
        ), "Email needs you", notificationUrl({ attentionId: allocation.row.id, email: true }));
        bannerDelivered = true;
      } catch {
        bannerDelivered = false;
      }
    }
    if (allocation.finalLevel === "text") {
      try {
        textDelivered = transport.text(
          `Cove: urgent email from ${domain}. Open the board.`,
        ) !== false;
      } catch {
        textDelivered = false;
      }
    }
    try {
      surface({
        row: allocation.row,
        title,
        reason: input.urgencyReason,
        source: "Cove email urgency",
        dataDir,
        now,
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
    finalizeAttentionDelivery(db, {
      id: allocation.row.id,
      level: deliveredLevel,
      suppressedReason: deliveredLevel === "suppressed" ? "delivery_failed" : undefined,
      now,
    });
    return {
      status: deliveredLevel === "suppressed" ? "suppressed" : "live",
      ...(deliveredLevel === "suppressed" ? { reason: "delivery_failed" as const } : {}),
      row: allocation.row,
    };
  } finally {
    db.close();
  }
}
