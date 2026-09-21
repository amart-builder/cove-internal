#!/usr/bin/env node
import { executeNotificationDelivery } from "../src/lib/notifications/delivery-receipts.mjs";
import { drainNotificationReminders } from "../src/lib/notifications/reminders.mjs";
import { notificationUrl } from "../src/lib/attention/notification-links.mjs";
// The two names below used to be local copies of these functions, byte for
// byte. That is how the invisible-character bypass stayed open here after it
// was closed in safety.mjs: a fix to one copy was invisible to the other, and
// this is the copy that runs every minute from com.cove.reminders and feeds
// Telegram and iMessage as well as the Mac banner. Importing rather than
// re-copying is what stops them drifting apart again.
import {
  cleanAttentionText as plainAttentionText,
  sanitizeNonDirectBanner as sanitizedNonDirectText,
} from "../src/lib/attention/safety.mjs";
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
import { unseenFloorCandidates, recordFloorNotice, releaseFloorNotice } from "../src/lib/attention/floor-state.mjs";
import { dueCalendarDay, dueInstant } from "../src/lib/attention/due-date.mjs";
import { localDateKey as dateInZone } from "../src/lib/local-time.mjs";
import { loadCoveRuntimePaths } from "./lib/cove-runtime-paths.mjs";
import { readAgentSettings } from "../src/lib/agent-settings.mjs";
import { runFollowThrough } from "../src/lib/attention/follow-through.mjs";
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
  nativeNotificationCommand,
  remoteIMessageArgs,
  REMOTE_IMESSAGE_TIMEOUT_MS,
  textDeliveryUncertain,
} from "../src/lib/intake/notification-transport.mjs";
import {
  allocateAttention,
  finalizeAttentionDelivery,
  hasAttentionLedger,
} from "../src/lib/attention/ledger.mjs";
import { coveEnv } from "../src/lib/env-runtime.mjs";
import { attentionReminderConfigPath } from "../src/lib/attention/transport.mjs";
import { operatorTimezone } from "../src/lib/operator-runtime.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { dbPath, dataDir } = loadCoveRuntimePaths(repoDir);
const DIRECT_AUTHOR_SOURCES = new Set([
  "chat",
  "imessage",
  "voice",
  "buddy",
  "day-plan",
]);
const CONTENT_FREE_REMINDER = "Cove reminder: open the board";
const NUDGE_SEND_LIMIT = 3;
const nativeNotificationDependencies = {
  notificationAppPath: coveEnv("NOTIFICATION_APP"),
};

function floorText(candidate, count) {
  const title = plainAttentionText(candidate.nextAction || candidate.title).slice(0, 180);
  return `Cove: ${title}. ${count > 1 ? `${count - 1} other due or overdue items also need a next step. ` : ""}Open Today to review.`;
}

function loadReminderConfig() {
  let raw;
  try {
    raw = readFileSync(
      attentionReminderConfigPath({ repoDir }),
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

function recordedDelivery(channel, reference, content, send) {
  return executeNotificationDelivery({ dataDir, channel, reference: String(reference || "unlinked"), content }, send);
}

function notifyNative(taskTitle, taskId) {
  const message = `Here's your reminder: ${taskTitle}`;
  const command = nativeNotificationCommand(message, {
    title: "Cove",
    subtitle: "Your reminder",
    openUrl: notificationUrl({taskId, reminder: true}),
    sound: "Glass",
  }, nativeNotificationDependencies);
  recordedDelivery("native", `task:${taskId ?? "unlinked"}`, message, () => execFileSync(command.executable, command.args));
}

function notifyAttentionBanner(message, subtitle = "Needs your attention", openUrl) {
  const command = nativeNotificationCommand(message, {
    title: "Cove",
    subtitle,
    openUrl,
    sound: "Glass",
  }, nativeNotificationDependencies);
  const url = openUrl ? new URL(openUrl) : null;
  const reference = url?.searchParams.get("notice") ?? url?.searchParams.get("task") ?? "attention";
  recordedDelivery("native", reference, message, () => execFileSync(command.executable, command.args));
}

function notifyTextFailure(input, uncertain = false) {
  const title = input.bannerTitle ?? input.title;
  const reminder = input.kind === "floor"
    ? `${title}. Open Today to choose the next step.`
    : `Here's your reminder: ${title}.`;
  const message = `${reminder} ${uncertain ? "Text delivery is unconfirmed." : "The text reminder could not be sent."}`;
  const command = nativeNotificationCommand(message, {
    title: "Cove",
    subtitle: "Your reminder",
    openUrl: notificationUrl({ taskId: input.taskId ?? (input.kind === "task" ? input.id : undefined), reminder: true }),
    sound: "Glass",
  }, nativeNotificationDependencies);
  recordedDelivery("native", `${input.kind}:${input.id}`, message, () => execFileSync(command.executable, command.args));
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
    { timeout: REMOTE_IMESSAGE_TIMEOUT_MS },
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
  return dateInZone(now, operatorTimezone());
}

function attentionNow() {
  const configured = coveEnv("ATTENTION_NOW");
  if (!configured) return new Date();
  const parsed = new Date(configured);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
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
  if (isMeetingDerivedTask(task)) {
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

// The scheduled-reminder equivalent of taskProvenance. It reads a JSON entry
// rather than a row, and it deliberately differs on one case: an entry with no
// recorded source is treated as outside words, where a task with no inbound
// event is treated as the owner's. A task row proves the absence -- it joined
// against inbound_events and found nothing. An entry only fails to carry a
// field, which older files do, and the safe reading of a missing field is the
// one that labels rather than the one that vouches. It also matches what the
// text branch of fireScheduledReminders has always done with the same value.
function scheduledProvenance(entry) {
  const source = entry.source;
  if (DIRECT_AUTHOR_SOURCES.has(source)) return { direct: true, prefix: "from you" };
  if (source === "email") return { direct: false, prefix: "from email" };
  if (isMeetingDerivedScheduled(entry)) return { direct: false, prefix: "from meeting" };
  return { direct: false, prefix: source ? `from ${source}` : "from unknown source" };
}

function isMeetingDerivedScheduled(entry) {
  return String(entry.source ?? "").toLowerCase() === "meeting" ||
    String(entry.source_type ?? "").toLowerCase().startsWith("meeting");
}

function isMeetingDerivedTask(task) {
  const sourceType = String(task.source_type ?? "").trim().toLowerCase();
  return task.inbound_source === "meeting" ||
    sourceType === "meeting" ||
    sourceType.startsWith("meeting_") ||
    sourceType.startsWith("meeting-");
}

function dueLaneEnabled(task) {
  return task.notification_policy == null ||
    task.notification_policy === "due" ||
    task.notification_policy === "both";
}

function nudgeLaneEnabled(task) {
  return task.notification_policy === "predeadline" ||
    task.notification_policy === "both";
}

function localHour(now, timezone = operatorTimezone()) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).find((part) => part.type === "hour")?.value;
  return Number(hour);
}

function insideNudgeDeliveryWindow(now) {
  const hour = localHour(now);
  return Number.isInteger(hour) && hour >= 8 && hour < 20;
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
      "SELECT 1 FROM tasks WHERE id = ? AND status = 'open' AND archived_at IS NULL",
    ).get(refId));
  }
  return Boolean(db.prepare(
    "SELECT 1 FROM commitments WHERE id = ? AND status = 'open'",
  ).get(refId));
}

async function runDeterministicFloor(db, config, token, now = new Date()) {
  // Basic Mode opts out of unsolicited follow-through. Explicit task alarms
  // and one-hour reminders have their own user-controlled delivery paths.
  if (coveEnv("FOLLOW_THROUGH") === "0") return;
  if (!hasAttentionLedger(db) || localHour(now) < 12) return;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cove_floor_reminder_state'").get()) return;
  const today = localDateKey(now);
  const tasks = db.prepare(
    `SELECT tasks.id, tasks.title, tasks.source_type, tasks.due_at,
            (SELECT next_action FROM cove_responsibilities WHERE ref_kind='task' AND ref_id=tasks.id) AS next_action,
            inbound_events.source AS inbound_source
       FROM tasks
       LEFT JOIN inbound_events ON inbound_events.id = tasks.id
      WHERE tasks.status = 'open' AND tasks.archived_at IS NULL
        AND (tasks.notification_policy IS NULL OR tasks.notification_policy IN ('due','both'))
        AND tasks.due_at IS NOT NULL
      ORDER BY tasks.due_at, tasks.position, tasks.id`,
  ).all().filter(row => {
    const day = dueCalendarDay(row.due_at) ??
      (Number.isFinite(Date.parse(row.due_at)) ? localDateKey(new Date(row.due_at)) : null);
    return day !== null && day <= today;
  });
  const commitments = db.prepare(
    `SELECT id, title, details, source_kind, source_ref, due_at,
            (SELECT next_action FROM cove_responsibilities WHERE ref_kind='commitment' AND ref_id=commitments.id) AS next_action
       FROM commitments
      WHERE status = 'open'
        AND kind IN ('promise','follow_up')
        AND due_at IS NOT NULL
        AND counterparty IS NOT NULL
        AND trim(counterparty) <> ''
      ORDER BY due_at, id`,
  ).all().filter(row => {
    const day = dueCalendarDay(row.due_at) ??
      (Number.isFinite(Date.parse(row.due_at)) ? localDateKey(new Date(row.due_at)) : null);
    return day !== null && day <= today;
  });
  const candidates = [
    ...tasks.map((task) => ({
      refKind: "task",
      refId: task.id,
      title: task.title || "Task",
      dueAt: task.due_at, nextAction: task.next_action,
      provenance: taskProvenance(task),
    })),
    ...commitments.map((commitment) => ({
      refKind: "commitment",
      refId: commitment.id,
      title: commitment.title || "Commitment",
      dueAt: commitment.due_at, nextAction: commitment.next_action,
      provenance: commitmentProvenance(commitment),
    })),
  ];

  // The day's one text goes out first, then each item gets at most a banner.
  // Six things due must not cost six interruptions, and a heavy day must not
  // spend the banner budget and leave the off-machine signal unsent.
  const open = unseenFloorCandidates(db, candidates.filter((candidate) =>
    stillOpen(db, candidate.refKind, candidate.refId)));
  const direct = open.filter((candidate) => candidate.provenance.direct);
  const directCount = direct.length;
  // Only items the owner authored are counted, so the text stays true to the
  // rule that email and meeting content never reaches the phone.
  if (directCount > 0 && configuredChannelExpected(config)) {
    const summary = allocateAttention(db, {
      kind: "floor_nudge",
      refKind: "task",
      refId: `__floor_daily__:${today}`,
      requestedLevel: "text",
      maximumLevel: "text",
      reason: floorText(direct[0], directCount),
      now,
    });
    await surfaceSuppressionRows(summary.suppressionRows, now);
    if (summary.row) {
      if (!stillOpen(db, direct[0].refKind, direct[0].refId)) {
        finalizeAttentionDelivery(db, { id: summary.row.id, level: "suppressed", suppressedReason: "completed_since_snapshot", now });
      } else if (summary.finalLevel === "text") {
        recordFloorNotice(db, direct[0], now);
        const outcome = deliverTextReminder(db, config, token, {
          kind: "floor",
          id: `daily:${today}`,
          title: plainAttentionText(direct[0].nextAction || direct[0].title),
          message: floorText(direct[0], directCount),
        });
        if (outcome === "none") releaseFloorNotice(db, direct[0]);
        // A fallback banner is a real interruption, so it starts the cooldown
        // that stops this lane retrying a broken channel every minute.
        if (outcome === "uncertain") {
          // Keep the original reservation: Messages may have accepted the text
          // even if the connection and fallback both timed out. No blind replay.
          db.prepare("UPDATE cove_attention_ledger SET suppressed_reason='delivery_uncertain' WHERE id=?")
            .run(summary.row.id);
        } else {
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
        }
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

  for (const candidate of unseenFloorCandidates(db, open)) {
    const title = plainAttentionText(candidate.nextAction || candidate.title) || "Item";
    const dueDay = dueCalendarDay(candidate.dueAt) ?? localDateKey(new Date(candidate.dueAt));
    const dueLabel = dueDay < today ? "Overdue and still open in Cove" : "Due today and still open in Cove";
    const reason = `${dueLabel}: ${title}. Choose the next step or a new date in Cove.`;
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
    if (!allocation.row || allocation.finalLevel !== "banner") continue;

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
      ? reason
      : `${dueLabel}. ${sanitizedNonDirectText(title, candidate.provenance.prefix)}`;
    let bannerDelivered = false;
    let bannerUncertain = false;
    // Claim before transport. A crash or uncertain handoff must not cause a
    // repeat of the unchanged item on the next day.
    recordFloorNotice(db, candidate, now);
    try {
      notifyAttentionBanner(banner, "Needs your attention", notificationUrl({ taskId: candidate.refKind === "task" ? candidate.refId : undefined, attentionId: allocation.row.id }));
      bannerDelivered = true;
    } catch (error) {
      bannerUncertain = error?.deliveryUncertain === true || textDeliveryUncertain(error);
      if (!bannerUncertain) releaseFloorNotice(db, candidate);
      console.error(`Floor nudge ${candidate.refId} banner failed:`, errorMessage(error));
    }
    if (bannerUncertain) {
      db.prepare("UPDATE cove_attention_ledger SET suppressed_reason='delivery_uncertain' WHERE id=?").run(allocation.row.id);
      continue;
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
  // What reaches the person is the labelled, sanitized title -- the same string
  // that went on the banner. The Issues screen renders this through
  // reminderFailureMessage (src/lib/reliability/failures.ts:35), so a raw title
  // here puts an email's own words on one of Cove's screens, in quotation marks
  // and nothing else, which is the gap findings 46-51 closed everywhere but on
  // the path that only runs once delivery has already failed. Nothing is lost
  // for investigation: details carries the task id, and the task row keeps its
  // own title.
  const title = String(input.bannerTitle ?? input.title).slice(0, 1000);
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
 * Returns "text" when the configured transport accepted it, "fallback_banner"
 * when macOS accepted the reminder, "uncertain" when a timed-out send has no confirmed fallback, and "none"
 * for a known failure of both paths. Callers must record a successful fallback as
 * a real delivery: a suppressed row starts no cooldown, so an every-minute lane
 * would retry a broken channel forever and banner on each pass.
 */
function deliverTextReminder(db, config, token, input) {
  try {
    if (!recordedDelivery(config?.channel, `${input.kind}:${input.id}`, input.message, () => {
      if (!notifyConfigured(config, token, input.message)) throw new Error("Configured text channel is unavailable.");
      return true;
    })) {
      throw new Error("Configured text channel is unavailable.");
    }
    return "text";
  } catch (error) {
    const failure = errorMessage(error);
    const uncertain = error?.deliveryUncertain === true || textDeliveryUncertain(failure);
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
    let fallbackUncertain = false;
    try {
      if (input.nativeDelivered) return "fallback_banner";
      notifyTextFailure(input, uncertain);
      return "fallback_banner";
    } catch (fallbackError) {
      fallbackUncertain = fallbackError?.deliveryUncertain === true || textDeliveryUncertain(fallbackError);
      console.error(
        `Reminder ${input.id} fallback native notification failed:`,
        errorMessage(fallbackError),
      );
    }
    return uncertain || fallbackUncertain ? "uncertain" : "none";
  }
}

function recordNativeOnlyFailure(db, input) {
  try {
    recordDeliveryFailure(db, {
      kind: input.kind,
      id: input.id,
      title: input.title,
      bannerTitle: input.bannerTitle,
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

/**
 * Parse a due_at into a Date, treating a calendar day as 9am LOCAL (not UTC).
 *
 * dueCalendarDay decides which values are a day. Both forms count: a bare
 * YYYY-MM-DD, and the YYYY-MM-DDT00:00:00.000Z that Cove's own date pickers
 * write. Reading the second as the instant it literally is rang the card on
 * the evening before the day the board showed.
 */
function dueTime(raw) {
  return dueInstant(raw);
}

/**
 * When a scheduled reminder is owed.
 *
 * surface_at is always a moment, never a calendar day: the triage model emits
 * a timestamp and intake falls back to the instant of capture. So the UTC
 * midnight that dueTime reads as a day is a real midnight here, and must not
 * be moved to 9am. Only the bare YYYY-MM-DD form, which carries no time at
 * all, gets an hour put on it -- the behaviour this lane has always had.
 */
function surfaceTime(raw) {
  return new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00:00` : raw,
  );
}

function fireScheduledReminders(db, config, token, now = attentionNow()) {
  // These files are written by the intake lane, which resolves its directory
  // as COVE_DATA_DIR first and the database's directory only as a fallback.
  // Reading from the database's directory meant that on an install where the
  // two differ — a configuration this repo's own tests cover — every scheduled
  // reminder was written somewhere nothing ever looked, and a commitment Cove
  // had accepted simply never came back.
  const directory = path.join(dataDir, "reminders");
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
    const when = surfaceTime(entry.surface_at);
    if (Number.isNaN(when.getTime()) || when.getTime() > now.getTime()) continue;
    // Cove holds its own automatic notifications to daytime everywhere else:
    // firePredeadlineNudges below, the Apple Reminders bridge, and the meeting
    // analyst's remind_at rule. This path had no window, and com.cove.reminders
    // runs every 60 seconds around the clock, so a scheduled reminder that came
    // due at 3am rang at 3am -- a Mac banner and a phone text.
    //
    // surface_at is not a time the operator chose. The triage prompt asks the
    // model when the card should surface and its only timestamp is NOW in UTC,
    // so a late hour is a reasonable answer and 3am is what a misread offset
    // costs. surface: "now" is exempt: it is written at the moment of capture,
    // so the person is already at the machine.
    //
    // The file is left in place rather than consumed, so the next pass inside
    // the window delivers it. Waiting must not mean discarded.
    if (entry.surface !== "now" && !insideNudgeDeliveryWindow(now)) continue;
    const provenance = scheduledProvenance(entry);
    const title = plainAttentionText(entry.title) || "Task";
    // The rule the due lane and the attention floor both state at their own
    // notifyNative calls: a title written by someone else is sanitized and
    // labelled before it borrows Cove's credibility. This lane was the one
    // that did neither. entry.title is the triage model's wording of a
    // capture, and under an email capture the words are a stranger's, so an
    // unlabelled banner reading "Here's your reminder: confirm your account
    // at pay.example" arrived over Cove's name with nothing to say otherwise.
    const bannerTitle = provenance.direct
      ? title
      : sanitizedNonDirectText(entry.title, provenance.prefix);
    try {
      let nativeFailure = null;
      try {
        notifyNative(bannerTitle, entry.task_id ?? entry.id);
      } catch (error) {
        nativeFailure = errorMessage(error);
        console.error(
          `Scheduled reminder ${entry.id ?? name} native notification failed:`,
          nativeFailure,
        );
      }
      const textExpected = configuredChannelExpected(config);
      const meetingDerived = String(entry.source ?? "").toLowerCase() === "meeting" ||
        String(entry.source_type ?? "").toLowerCase().startsWith("meeting");
      if (textExpected && !meetingDerived) {
        deliverTextReminder(db, config, token, {
          kind: "scheduled",
          id: entry.id ?? name,
          taskId: entry.task_id,
          nativeDelivered: nativeFailure === null,
          title,
          // notifyTextFailure falls back to input.title when no bannerTitle is
          // given, so without this the raw title reached a banner by the other
          // door: the one a failed text opens.
          bannerTitle,
          message: provenance.direct
            ? `Cove reminder: ${title}`
            : CONTENT_FREE_REMINDER,
        });
      } else if (nativeFailure) {
        recordNativeOnlyFailure(db, {
          kind: "scheduled",
          id: entry.id ?? name,
          title,
          bannerTitle,
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

async function firePredeadlineNudges(db, dueTaskIds, now) {
  const nowIso = now.toISOString();
  const claim = db.prepare(
    `UPDATE tasks SET nudged_at = ?
      WHERE id = ? AND nudged_at IS NULL AND status = 'open' AND engaged_at IS NULL
        AND remind_at IS NOT NULL
        AND notification_policy IN ('predeadline','both')`,
  );

  // A due reminder owns a same-tick collision. Claim the nudge as suppressed so
  // it cannot appear after the due lane has already spoken.
  for (const id of dueTaskIds) {
    try {
      claim.run(nowIso, id);
    } catch (error) {
      console.error(`Nudge for task ${id} collision claim failed:`, errorMessage(error));
    }
  }

  // A predeadline nudge is no longer truthful once its due moment has passed,
  // including when policy disables the due lane. Claim those rows without send.
  const pastDue = db.prepare(
    `SELECT id, due_at
       FROM tasks
      WHERE status = 'open'
        AND remind_at IS NOT NULL
        AND nudged_at IS NULL
        AND engaged_at IS NULL
        AND julianday(remind_at) <= julianday(?)
        AND due_at IS NOT NULL
        AND notification_policy IN ('predeadline','both')`,
  ).all(nowIso);
  for (const task of pastDue) {
    const due = dueTime(task.due_at);
    if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) continue;
    try {
      claim.run(nowIso, task.id);
    } catch (error) {
      console.error(`Nudge for task ${task.id} past-due claim failed:`, errorMessage(error));
    }
  }

  if (!insideNudgeDeliveryWindow(now)) return;
  const candidates = db.prepare(
    `SELECT tasks.id, tasks.title, tasks.source_type,
            tasks.notification_policy, tasks.due_at,
            inbound_events.source AS inbound_source
       FROM tasks
       LEFT JOIN inbound_events ON inbound_events.id = tasks.id
      WHERE tasks.status = 'open'
        AND tasks.remind_at IS NOT NULL
        AND tasks.nudged_at IS NULL
        AND tasks.engaged_at IS NULL
        AND julianday(tasks.remind_at) <= julianday(?)
        AND tasks.notification_policy IN ('predeadline','both')
        AND (
          tasks.due_at IS NULL OR
          CASE
            WHEN length(tasks.due_at) = 10
              THEN julianday(tasks.due_at || 'T09:00:00', 'utc')
            -- The other calendar-day form, written by Cove's own date pickers.
            -- See src/lib/attention/due-date.mjs; read as the instant it
            -- literally is, this gate closed a day early.
            WHEN tasks.due_at LIKE '____-__-__T00:00:00Z'
              OR tasks.due_at LIKE '____-__-__T00:00:00.000Z'
              THEN julianday(substr(tasks.due_at, 1, 10) || 'T09:00:00', 'utc')
            ELSE julianday(tasks.due_at)
          END > julianday(?)
        )
      ORDER BY tasks.remind_at, tasks.position, tasks.id
      LIMIT ?`,
  ).all(nowIso, nowIso, NUDGE_SEND_LIMIT * 4);
  const stillEligible = db.prepare(
    `SELECT due_at FROM tasks
      WHERE id = ? AND status = 'open' AND engaged_at IS NULL`,
  );

  let deliveredNudges = 0;
  for (const task of candidates) {
    if (deliveredNudges >= NUDGE_SEND_LIMIT) break;
    if (!nudgeLaneEnabled(task)) continue;
    const title = plainAttentionText(task.title) || "Task";
    const allocation = allocateAttention(db, {
      kind: "sweep_nudge",
      refKind: "task",
      refId: task.id,
      requestedLevel: "banner",
      maximumLevel: "banner",
      reason: `Before it is due: ${title}`,
      now,
    });
    await surfaceSuppressionRows(allocation.suppressionRows, now);
    if (!allocation.row) continue;
    try {
      if (claim.run(nowIso, task.id).changes !== 1) {
        finalizeAttentionDelivery(db, {
          id: allocation.row.id,
          level: "suppressed",
          suppressedReason: "nudge_claim_lost",
          now,
        });
        continue;
      }
    } catch (error) {
      console.error(`Nudge for task ${task.id} claim failed:`, errorMessage(error));
      finalizeAttentionDelivery(db, {
        id: allocation.row.id,
        level: "suppressed",
        suppressedReason: "nudge_claim_failed",
        now,
      });
      continue;
    }
    const current = stillEligible.get(task.id);
    const currentDue = current?.due_at ? dueTime(current.due_at) : null;
    if (
      !current ||
      (currentDue && !Number.isNaN(currentDue.getTime()) && currentDue.getTime() <= now.getTime())
    ) {
      finalizeAttentionDelivery(db, {
        id: allocation.row.id,
        level: "suppressed",
        suppressedReason: "nudge_no_longer_eligible",
        now,
      });
      continue;
    }
    const provenance = taskProvenance(task);
    const banner = provenance.direct
      ? `Coming up: ${title}. This is your advance reminder.`
      : `This is your advance reminder. ${sanitizedNonDirectText(title, provenance.prefix)}`;
    let delivered = false;
    try {
      notifyAttentionBanner(banner, "Upcoming task", notificationUrl({ taskId: task.id, attentionId: allocation.row.id }));
      delivered = true;
    } catch (error) {
      console.error(`Nudge for task ${task.id} native notification failed:`, errorMessage(error));
      recordNativeOnlyFailure(db, {
        kind: "nudge",
        id: task.id,
        title,
        bannerTitle: provenance.direct
          ? title
          : sanitizedNonDirectText(title, provenance.prefix),
        error: errorMessage(error),
      });
    }
    finalizeAttentionDelivery(db, {
      id: allocation.row.id,
      level: delivered ? "banner" : "suppressed",
      suppressedReason: delivered ? undefined : "delivery_failed",
      now,
    });
    if (delivered) deliveredNudges += 1;
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
  const now = attentionNow();
  fireScheduledReminders(db, config, token, now);
  if (!db) return;
  // Deliberately the database's directory, not dataDir: the "remind me later"
  // button writes these through /api/notifications, which resolves the same
  // way (dirname of the local database). Both sides agree; changing one alone
  // would strand them.
  try { drainNotificationReminders({db, dataDir:path.dirname(dbPath), now,
    notify:task=>notifyNative(sanitizedNonDirectText(plainAttentionText(task.title), "your requested reminder"),task.id),
    onFailure:failure=>recordNativeOnlyFailure(db,{kind:"notification-repeat",...failure,
      bannerTitle:sanitizedNonDirectText(plainAttentionText(failure.title), "your requested reminder")}),
  }); } catch (error) { console.error("Requested reminder check failed:", errorMessage(error)); }
  // Only explicit new agent settings activate the additional native checks.
  // Existing installs keep their reminder behavior until their setup is changed.
  try {
  if (readAgentSettings() && coveEnv("FOLLOW_THROUGH") !== "0" && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cove_follow_through_notices'").get()) {
    await runFollowThrough({ db, now, timezone: operatorTimezone(),
      calendar: async () => {
        const { createGoogleWorkspaceGateway } = await import("../src/lib/workspace/google/gateway.ts");
        return createGoogleWorkspaceGateway({ dataDir }).calendar ?? null;
      },
      notify: ({ id, message, taskId }) => {
        const command = nativeNotificationCommand(message, { title: "Cove", subtitle: "On your radar", group: `follow-through-${id}`,
          openUrl: notificationUrl({ taskId, followThroughId: id }, coveEnv("BUDDY_APP_URL") ?? "http://127.0.0.1:3200") }, nativeNotificationDependencies);
        recordedDelivery("native", `follow-through:${id}`, message, () => execFileSync(command.executable, command.args, { timeout: 10_000, maxBuffer: 64_000 }));
      },
    });
  }

  } catch (error) {
    console.error("Follow-through check failed; explicit reminders will continue:", errorMessage(error));
  }

  // Refresh known meetings before the optional floor spends shared capacity.
  await runDeterministicFloor(db, config, token, now);

  const due = db
    .prepare(
      `SELECT tasks.id, tasks.title, tasks.due_at, tasks.remind_native,
              tasks.remind_text, tasks.source_type,
              tasks.notification_policy,
              inbound_events.source AS inbound_source
         FROM tasks
         LEFT JOIN inbound_events ON inbound_events.id = tasks.id
        WHERE tasks.status = 'open' AND tasks.notified_at IS NULL
          AND tasks.due_at IS NOT NULL`,
    )
    .all()
    .filter((t) => {
      if (!dueLaneEnabled(t)) return false;
      const when = dueTime(t.due_at);
      return !Number.isNaN(when.getTime()) && when.getTime() <= now.getTime();
    });

  const dueTaskIds = new Set(due.map((task) => task.id));
  await firePredeadlineNudges(db, dueTaskIds, now);

  if (due.length === 0) return;

  const claim = db.prepare(
    `UPDATE tasks SET notified_at = ?
      WHERE id = ? AND notified_at IS NULL`,
  );

  for (const task of due) {
    try {
      if (claim.run(now.toISOString(), task.id).changes !== 1) continue;
    } catch (error) {
      console.error(`Reminder for task ${task.id} claim failed:`, errorMessage(error));
      continue;
    }

    const title = plainAttentionText(task.title) || "Task";
    const provenance = taskProvenance(task);
    const textExpected = Boolean(
      task.remind_text &&
      configuredChannelExpected(config) &&
      !isMeetingDerivedTask(task),
    );
    let nativeFailure = null;
    if (task.remind_native) {
      try {
        // The same rule the floor uses: a title written by someone else is
        // sanitized and labelled before it borrows Cove's credibility.
        notifyNative(provenance.direct
          ? title
          : sanitizedNonDirectText(title, provenance.prefix), task.id);
      } catch (error) {
        nativeFailure = errorMessage(error);
        console.error(`Reminder for task ${task.id} native notification failed:`, nativeFailure);
      }
    }
    if (textExpected) {
      deliverTextReminder(db, config, token, {
        kind: "task",
        id: task.id,
        nativeDelivered: Boolean(task.remind_native) && nativeFailure === null,
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
        bannerTitle: provenance.direct
          ? title
          : sanitizedNonDirectText(title, provenance.prefix),
        error: nativeFailure,
      });
    }
  }
}

void main().catch((error) => {
  console.error("cove-reminders failed:", errorMessage(error));
  process.exitCode = 1;
});
