#!/usr/bin/env node
/**
 * Cove reminder helper. Run every minute by the com.cove.reminders LaunchAgent.
 *
 * Fires a reminder for every open task whose due time has passed and that hasn't
 * been notified yet:
 *   - a native macOS notification (default, controlled by tasks.remind_native)
 *   - a Telegram or iMessage text (if tasks.remind_text is on AND a channel is
 *     configured in data/cove-reminders.json)
 * Then it stamps tasks.notified_at so a reminder fires only once.
 *
 * Delivery is claimed before any subprocess send. A hard kill between claim
 * and send can silently drop one reminder. That rare drop is accepted because
 * retrying an uncertain claim can duplicate a text. The noon floor claims the
 * same way: its ledger row is written before delivery, so a kill in that window
 * leaves a row that spends budget without having interrupted anyone.
 *
 * Runs only while the Mac is awake. On a laptop that is closed or off, reminders
 * fire when it next wakes; for always-on delivery the user needs a Mac Mini/VPS.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  localIMessageArgs,
  nativeNotificationArgs,
  remoteIMessageArgs,
} from "../src/lib/intake/notification-transport.mjs";
import {
  allocateAttention,
  finalizeAttentionDelivery,
  hasAttentionLedger,
} from "../src/lib/attention/ledger.mjs";
import { coveConfigPath, coveEnv } from "../src/lib/env-runtime.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = coveEnv("DB_PATH") || path.join(repoDir, "data", "cove.db");
const DIRECT_AUTHOR_SOURCES = new Set([
  "chat",
  "imessage",
  "voice",
  "buddy",
  "day-plan",
]);
const CONTENT_FREE_REMINDER = "Cove reminder: open the board";

function floorText(count) {
  return `Cove: ${count} ${count === 1 ? "thing needs" : "things need"} a look. Open the board.`;
}

function loadReminderConfig() {
  let raw;
  try {
    raw = readFileSync(
      coveEnv("REMINDER_CONFIG_PATH") ??
        coveConfigPath(path.join(repoDir, "data"), "reminders.json"),
      "utf8",
    );
  } catch {
    return null; // No text channel configured; native notifications still work.
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("cove-reminders: data/cove-reminders.json is not valid JSON:", err.message);
    return null;
  }
}

function telegramToken() {
  try {
    const env = readFileSync(
      path.join(os.homedir(), ".claude/channels/telegram/.env"),
      "utf8",
    );
    const match = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function notifyNative(taskTitle) {
  execFileSync(
    "osascript",
    nativeNotificationArgs(taskTitle, {
      title: "Cove",
      subtitle: "Task due",
      sound: "Glass",
    }),
  );
}

function notifyAttentionBanner(message, subtitle = "Attention check") {
  execFileSync(
    "osascript",
    nativeNotificationArgs(message, {
      title: "Cove",
      subtitle,
      sound: "Glass",
    }),
  );
}

function notifyTextFailure(taskTitle) {
  execFileSync(
    "osascript",
    nativeNotificationArgs(`Text failed: ${taskTitle}`, {
      title: "Cove",
      subtitle: "Reminder delivery failed",
      sound: "Glass",
    }),
  );
}

function notifyTelegram(token, chatId, message) {
  const output = execFileSync("curl", [
    "-sS",
    "-m",
    "15",
    `https://api.telegram.org/bot${token}/sendMessage`,
    "--data-urlencode",
    `chat_id=${chatId}`,
    "--data-urlencode",
    `text=${message}`,
  ]).toString();
  if (!/"ok":\s*true/.test(output)) {
    throw new Error(`Telegram API rejected the message: ${output.slice(0, 200)}`);
  }
}

function notifyIMessage(to, message) {
  execFileSync("osascript", localIMessageArgs(to, message));
}

function notifyRemoteIMessage(remoteHost, to, message) {
  execFileSync(
    "ssh",
    remoteIMessageArgs(remoteHost, to, message),
    { timeout: 10_000 },
  );
}

function notifyConfigured(config, token, message) {
  if (config?.channel === "telegram" && token && config.telegram_chat_id) {
    notifyTelegram(token, config.telegram_chat_id, message);
    return true;
  } else if (config?.channel === "imessage" && config.imessage_to) {
    if (config.remote_host) {
      notifyRemoteIMessage(
        config.remote_host,
        config.imessage_to,
        message,
      );
    } else {
      notifyIMessage(config.imessage_to, message);
    }
    return true;
  }
  return false;
}

function configuredChannelExpected(config) {
  return config?.channel === "telegram" || config?.channel === "imessage";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function localDateKey(now) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function attentionNow() {
  const configured = coveEnv("ATTENTION_NOW");
  if (!configured) return new Date();
  const parsed = new Date(configured);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function plainAttentionText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u2013\u2014]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizedNonDirectText(value, provenance) {
  const sanitized = plainAttentionText(value)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, "")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  return `${provenance}: ${sanitized || "Open Cove to review this item."}`.slice(0, 180);
}

function taskProvenance(task) {
  if (DIRECT_AUTHOR_SOURCES.has(task.inbound_source)) {
    return { direct: true, prefix: "from you" };
  }
  if (task.inbound_source === "email") {
    return { direct: false, prefix: "from email" };
  }
  if (task.inbound_source === "meeting") {
    return { direct: false, prefix: "from meeting" };
  }
  // A task with no inbound event was typed into Cove by the owner, which is as
  // direct as authorship gets. Only an inbound event can carry outside content.
  if (!task.inbound_source && task.source_type !== "inbound_event") {
    return { direct: true, prefix: "from you" };
  }
  return {
    direct: false,
    prefix: task.inbound_source ? `from ${task.inbound_source}` : "from unknown source",
  };
}

function commitmentProvenance(commitment) {
  if (["brain_dump", "manual", "chat"].includes(commitment.source_kind)) {
    return { direct: true, prefix: "from you" };
  }
  if (String(commitment.source_ref ?? "").startsWith("gmail:")) {
    const meeting = /(?:^|\n)Meeting:/i.test(commitment.details ?? "");
    return {
      direct: false,
      prefix: meeting ? "from meeting" : "from email",
    };
  }
  return { direct: false, prefix: "from unknown source" };
}

async function surfaceSuppressionRows(rows, now) {
  if (rows.length === 0) return;
  try {
    const { surfaceAttentionSuppression } = await import(
      "../src/lib/attention/quiet-current.ts"
    );
    for (const row of rows) surfaceAttentionSuppression({ row, now });
  } catch (error) {
    console.error("Floor suppression could not reach Quiet Current:", errorMessage(error));
  }
}

function stillOpen(db, refKind, refId) {
  if (refKind === "task") {
    return Boolean(db.prepare(
      "SELECT 1 FROM tasks WHERE id = ? AND status = 'open'",
    ).get(refId));
  }
  return Boolean(db.prepare(
    "SELECT 1 FROM commitments WHERE id = ? AND status = 'open'",
  ).get(refId));
}

async function runDeterministicFloor(db, config, token, now = new Date()) {
  if (!hasAttentionLedger(db) || now.getHours() < 12) return;
  const today = localDateKey(now);
  const tasks = db.prepare(
    `SELECT tasks.id, tasks.title, tasks.source_type,
            inbound_events.source AS inbound_source
       FROM tasks
       LEFT JOIN inbound_events ON inbound_events.id = tasks.id
      WHERE tasks.status = 'open'
        AND tasks.due_at IS NOT NULL
        AND CASE
              WHEN length(tasks.due_at) = 10 THEN tasks.due_at
              ELSE date(tasks.due_at, 'localtime')
            END <= ?
      ORDER BY tasks.due_at, tasks.position, tasks.id`,
  ).all(today);
  const commitments = db.prepare(
    `SELECT id, title, details, source_kind, source_ref
       FROM commitments
      WHERE status = 'open'
        AND kind IN ('promise','follow_up')
        AND due_at IS NOT NULL
        AND CASE
              WHEN length(due_at) = 10 THEN due_at
              ELSE date(due_at, 'localtime')
            END <= ?
        AND counterparty IS NOT NULL
        AND trim(counterparty) <> ''
      ORDER BY due_at, id`,
  ).all(today);
  const candidates = [
    ...tasks.map((task) => ({
      refKind: "task",
      refId: task.id,
      title: task.title || "Task",
      provenance: taskProvenance(task),
    })),
    ...commitments.map((commitment) => ({
      refKind: "commitment",
      refId: commitment.id,
      title: commitment.title || "Commitment",
      provenance: commitmentProvenance(commitment),
    })),
  ];

  // The day's one text goes out first, then each item gets at most a banner.
  // Six things due must not cost six interruptions, and a heavy day must not
  // spend the banner budget and leave the off-machine signal unsent.
  const open = candidates.filter((candidate) =>
    stillOpen(db, candidate.refKind, candidate.refId));
  const directCount = open.filter((candidate) => candidate.provenance.direct).length;
  // Only items the owner authored are counted, so the text stays true to the
  // rule that email and meeting content never reaches the phone.
  if (directCount > 0 && configuredChannelExpected(config)) {
    const summary = allocateAttention(db, {
      kind: "floor_nudge",
      refKind: "task",
      refId: `__floor_daily__:${today}`,
      requestedLevel: "text",
      maximumLevel: "text",
      reason: `Due today, not done: ${directCount} of your own items.`,
      now,
    });
    await surfaceSuppressionRows(summary.suppressionRows, now);
    if (summary.row) {
      if (summary.finalLevel === "text") {
        const outcome = deliverTextReminder(db, config, token, {
          kind: "floor",
          id: `daily:${today}`,
          title: `${directCount} due today`,
          message: floorText(directCount),
        });
        // A fallback banner is a real interruption, so it starts the cooldown
        // that stops this lane retrying a broken channel every minute.
        finalizeAttentionDelivery(db, {
          id: summary.row.id,
          level: outcome === "text"
            ? "text"
            : outcome === "fallback_banner"
              ? "banner"
              : "suppressed",
          suppressedReason: outcome === "none" ? "delivery_failed" : undefined,
          now,
        });
      } else {
        // The per-item banners below still carry the day.
        finalizeAttentionDelivery(db, {
          id: summary.row.id,
          level: "suppressed",
          suppressedReason: "daily_floor_text_cap",
          now,
        });
      }
    }
  }

  for (const candidate of open) {
    const title = plainAttentionText(candidate.title) || "Item";
    const reason = `Due today, not done: ${title}`;
    const allocation = allocateAttention(db, {
      kind: "floor_nudge",
      refKind: candidate.refKind,
      refId: candidate.refId,
      requestedLevel: "banner",
      maximumLevel: "banner",
      reason,
      now,
    });
    await surfaceSuppressionRows(allocation.suppressionRows, now);
    if (!allocation.row) continue;

    // The snapshot only nominates candidates. Re-read immediately before any
    // external delivery so a completion during this tick wins.
    if (!stillOpen(db, candidate.refKind, candidate.refId)) {
      db.prepare(
        `UPDATE cove_attention_ledger
         SET level = 'suppressed', delivered_at = NULL,
             suppressed_reason = 'completed_since_snapshot'
         WHERE id = ?`,
      ).run(allocation.row.id);
      continue;
    }

    const banner = candidate.provenance.direct
      ? `Due today, not done: ${title}`
      : sanitizedNonDirectText(title, candidate.provenance.prefix);
    let bannerDelivered = false;
    try {
      notifyAttentionBanner(banner);
      bannerDelivered = true;
    } catch (error) {
      console.error(`Floor nudge ${candidate.refId} banner failed:`, errorMessage(error));
    }
    finalizeAttentionDelivery(db, {
      id: allocation.row.id,
      level: bannerDelivered ? "banner" : "suppressed",
      suppressedReason: bannerDelivered ? undefined : "delivery_failed",
      now,
    });
  }
}

function recordDeliveryFailure(db, input) {
  if (!db) {
    console.error(
      `Could not record ${input.kind} reminder delivery failure: database unavailable.`,
    );
    return;
  }
  const occurredAt = new Date().toISOString();
  const source = "reminder-delivery";
  const sourceId = `${input.kind}:${input.id}`.slice(0, 240);
  const title = String(input.title).slice(0, 1000);
  const failure = String(input.error).slice(0, 4000);
  const deliveryLabel = input.channel === "native" ? "Native reminder" : "Text reminder";
  const message = `${deliveryLabel} failed for "${title}": ${failure}`
    .trim()
    .slice(0, 1000);
  const details = JSON.stringify({
    kind: input.kind,
    taskId: input.id,
    title,
    channel: input.channel ?? null,
    error: failure,
  });
  db.prepare(
    `INSERT INTO cove_failure_inbox
       (id, source, source_id, message, details_json, occurred_at, dismissed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(source, source_id) DO UPDATE SET
       message = excluded.message,
       details_json = excluded.details_json,
       occurred_at = excluded.occurred_at,
       dismissed_at = NULL`,
  ).run(
    randomUUID(),
    source,
    sourceId,
    message,
    details,
    occurredAt,
    occurredAt,
  );
}

/**
 * Returns "text" when the phone got it, "fallback_banner" when only the screen
 * did, "none" when nothing landed. Callers must record a successful fallback as
 * a real delivery: a suppressed row starts no cooldown, so an every-minute lane
 * would retry a broken channel forever and banner on each pass.
 */
function deliverTextReminder(db, config, token, input) {
  try {
    if (!notifyConfigured(config, token, input.message)) {
      throw new Error("Configured text channel is unavailable.");
    }
    return "text";
  } catch (error) {
    const failure = errorMessage(error);
    console.error(
      `${input.kind === "scheduled" ? "Scheduled reminder" : "Reminder for task"} ${input.id} configured channel failed:`,
      failure,
    );
    try {
      recordDeliveryFailure(db, {
        ...input,
        channel: config?.channel,
        error: failure,
      });
    } catch (recordError) {
      console.error(
        `Reminder ${input.id} failure inbox write failed:`,
        errorMessage(recordError),
      );
    }
    try {
      notifyTextFailure(input.bannerTitle ?? input.title);
      return "fallback_banner";
    } catch (fallbackError) {
      console.error(
        `Reminder ${input.id} fallback native notification failed:`,
        errorMessage(fallbackError),
      );
    }
    return "none";
  }
}

function recordNativeOnlyFailure(db, input) {
  try {
    recordDeliveryFailure(db, {
      kind: input.kind,
      id: input.id,
      title: input.title,
      channel: "native",
      error: input.error,
    });
  } catch (recordError) {
    console.error(
      `Reminder ${input.id} native failure inbox write failed:`,
      errorMessage(recordError),
    );
  }
}

/** Parse a due_at into a Date, treating date-only values as 9am LOCAL (not UTC). */
function dueTime(raw) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00:00` : raw;
  return new Date(normalized);
}

function fireScheduledReminders(db, config, token) {
  const directory = path.join(path.dirname(dbPath), "reminders");
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter((value) =>
    /^scheduled-.*\.json$/.test(value)
  )) {
    const file = path.join(directory, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      console.error(`Scheduled reminder ${name} is unreadable:`, error.message);
      continue;
    }
    const when = dueTime(entry.surface_at);
    if (Number.isNaN(when.getTime()) || when.getTime() > Date.now()) continue;
    const title = entry.title || "Task";
    try {
      let nativeFailure = null;
      try {
        notifyNative(title);
      } catch (error) {
        nativeFailure = errorMessage(error);
        console.error(
          `Scheduled reminder ${entry.id ?? name} native notification failed:`,
          nativeFailure,
        );
      }
      const textExpected = configuredChannelExpected(config);
      if (textExpected) {
        const directAuthor = DIRECT_AUTHOR_SOURCES.has(entry.source);
        deliverTextReminder(db, config, token, {
          kind: "scheduled",
          id: entry.id ?? name,
          title,
          message: directAuthor
            ? `Cove reminder: ${title}`
            : CONTENT_FREE_REMINDER,
        });
      } else if (nativeFailure) {
        recordNativeOnlyFailure(db, {
          kind: "scheduled",
          id: entry.id ?? name,
          title,
          error: nativeFailure,
        });
      }
    } finally {
      try {
        unlinkSync(file);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.error(`Scheduled reminder ${name} cleanup failed:`, errorMessage(error));
        }
      }
    }
  }
}

async function main() {
  const config = loadReminderConfig();
  const token = telegramToken();

  let db = null;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch {
    // Scheduled native notifications can still fire before Cove has a database.
  }
  if (db) db.pragma("busy_timeout = 5000");
  fireScheduledReminders(db, config, token);
  if (!db) return;
  await runDeterministicFloor(db, config, token, attentionNow());

  const due = db
    .prepare(
      `SELECT tasks.id, tasks.title, tasks.due_at, tasks.remind_native,
              tasks.remind_text, tasks.source_type,
              inbound_events.source AS inbound_source
         FROM tasks
         LEFT JOIN inbound_events ON inbound_events.id = tasks.id
        WHERE tasks.status = 'open' AND tasks.notified_at IS NULL
          AND tasks.due_at IS NOT NULL`,
    )
    .all()
    .filter((t) => {
      const when = dueTime(t.due_at);
      return !Number.isNaN(when.getTime()) && when.getTime() <= Date.now();
    });

  if (due.length === 0) return;

  const claim = db.prepare(
    `UPDATE tasks SET notified_at = ?
      WHERE id = ? AND notified_at IS NULL`,
  );

  for (const task of due) {
    try {
      if (claim.run(new Date().toISOString(), task.id).changes !== 1) continue;
    } catch (error) {
      console.error(`Reminder for task ${task.id} claim failed:`, errorMessage(error));
      continue;
    }

    const title = plainAttentionText(task.title) || "Task";
    const provenance = taskProvenance(task);
    const textExpected = Boolean(
      task.remind_text && configuredChannelExpected(config),
    );
    let nativeFailure = null;
    if (task.remind_native) {
      try {
        // The same rule the floor uses: a title written by someone else is
        // sanitized and labelled before it borrows Cove's credibility.
        notifyNative(provenance.direct
          ? title
          : sanitizedNonDirectText(title, provenance.prefix));
      } catch (error) {
        nativeFailure = errorMessage(error);
        console.error(`Reminder for task ${task.id} native notification failed:`, nativeFailure);
      }
    }
    if (textExpected) {
      deliverTextReminder(db, config, token, {
        kind: "task",
        id: task.id,
        title,
        bannerTitle: provenance.direct
          ? title
          : sanitizedNonDirectText(title, provenance.prefix),
        message: provenance.direct
          ? `Cove reminder: ${title}`
          : CONTENT_FREE_REMINDER,
      });
    } else if (task.remind_native && nativeFailure) {
      recordNativeOnlyFailure(db, {
        kind: "task",
        id: task.id,
        title,
        error: nativeFailure,
      });
    }
  }
}

void main().catch((error) => {
  console.error("cove-reminders failed:", errorMessage(error));
  process.exitCode = 1;
});
