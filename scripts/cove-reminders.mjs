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
 * Runs only while the Mac is awake. On a laptop that is closed or off, reminders
 * fire when it next wakes; for always-on delivery the user needs a Mac Mini/VPS.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
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
import { coveConfigPath, coveEnv } from "../src/lib/env-runtime.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = coveEnv("DB_PATH") || path.join(repoDir, "data", "forge.db");

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

/** Parse a due_at into a Date, treating date-only values as 9am LOCAL (not UTC). */
function dueTime(raw) {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00:00` : raw;
  return new Date(normalized);
}

function fireScheduledReminders(config, token) {
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
    let nativeDelivered = false;
    let channelDelivered = false;
    try {
      notifyNative(title);
      nativeDelivered = true;
    } catch (error) {
      console.error(
        `Scheduled reminder ${entry.id ?? name} native notification failed:`,
        error.message,
      );
    }
    try {
      channelDelivered =
        notifyConfigured(config, token, `Cove reminder: ${title}`);
    } catch (error) {
      console.error(
        `Scheduled reminder ${entry.id ?? name} configured channel failed:`,
        error.message,
      );
    }
    const delivered = configuredChannelExpected(config)
      ? channelDelivered
      : nativeDelivered;
    if (delivered) {
      try {
        unlinkSync(file);
      } catch {
        // Another reminder tick may have claimed it.
      }
    }
  }
}

function main() {
  const config = loadReminderConfig();
  const token = telegramToken();
  fireScheduledReminders(config, token);

  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true });
  } catch {
    return; // No database yet; nothing to do.
  }
  db.pragma("busy_timeout = 5000");

  const due = db
    .prepare(
      `SELECT id, title, due_at, remind_native, remind_text
         FROM tasks
        WHERE status = 'open' AND notified_at IS NULL AND due_at IS NOT NULL`,
    )
    .all()
    .filter((t) => {
      const when = dueTime(t.due_at);
      return !Number.isNaN(when.getTime()) && when.getTime() <= Date.now();
    });

  if (due.length === 0) return;

  const claim = db.prepare(
    "UPDATE tasks SET notified_at = ? WHERE id = ? AND notified_at IS NULL",
  );

  for (const task of due) {
    // Claim the task atomically before firing. If an overlapping run (a slow
    // tick that ran past 60s) already took it, changes is 0 and we skip, so a
    // reminder is never sent twice. A failed send still leaves it claimed, so
    // a transient error doesn't loop forever.
    if (claim.run(new Date().toISOString(), task.id).changes !== 1) continue;

    const title = task.title || "Task";
    try {
      if (task.remind_native) notifyNative(title);

      if (task.remind_text && config) {
        const message = `Cove reminder: ${title}`;
        notifyConfigured(config, token, message);
      }
    } catch (err) {
      console.error(`Reminder for task ${task.id} failed:`, err.message);
    }
  }
}

main();
