#!/usr/bin/env node
/**
 * Cove notify helper. Sends one line to the user's configured reminder channel.
 *
 *   node scripts/cove-notify.mjs "Inbox triaged: 2 need you, 1 action"
 *
 * The message is read from argv (never interpolated into a shell), so text from
 * email summaries can pass through safely. Reads the same channel config the
 * reminders cron uses (data/cove-reminders.json + the Telegram token). Prints
 * nothing on success and exits nonzero unless the configured text channel
 * delivered. A local notification fallback is visible but does not settle a
 * durable reminder receipt.
 *
 * Runs only while the Mac is awake, same limit as reminders.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error("Usage: node scripts/cove-notify.mjs <message>");
  process.exit(2);
}

function loadReminderConfig() {
  try {
    return JSON.parse(
      readFileSync(
        coveEnv("REMINDER_CONFIG_PATH") ??
          coveConfigPath(path.join(repoDir, "data"), "reminders.json"),
        "utf8",
      ),
    );
  } catch {
    return null; // No text channel configured; nothing to send.
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

function sendTelegram(token, chatId, text) {
  // curl exits 0 even on a 4xx, so check the API's own ok flag. Otherwise a bad
  // token or chat_id drops the nudge silently, which for an unattended run means
  // the user never learns triage happened.
  const out = execFileSync("curl", [
    "-sS",
    "-m",
    "15",
    `https://api.telegram.org/bot${token}/sendMessage`,
    "--data-urlencode",
    `chat_id=${chatId}`,
    "--data-urlencode",
    `text=${text}`,
  ]).toString();
  if (!/"ok":\s*true/.test(out)) {
    throw new Error(`Telegram API rejected the message: ${out.slice(0, 200)}`);
  }
}

function sendIMessage(to, text) {
  execFileSync("osascript", localIMessageArgs(to, text));
}

function sendRemoteIMessage(remoteHost, to, text) {
  execFileSync(
    "ssh",
    remoteIMessageArgs(remoteHost, to, text),
    { timeout: 10_000 },
  );
}

function notifyNative(text) {
  execFileSync(
    "osascript",
    nativeNotificationArgs(text, { title: "Cove", sound: "Glass" }),
  );
}

const config = loadReminderConfig();
if (!config) {
  console.error('COVE_NOTIFY {"delivered":false,"reason":"not_configured"}');
  process.exit(1);
}

try {
  if (config.channel === "telegram") {
    const token = telegramToken();
    if (!token || !config.telegram_chat_id) throw new Error("Telegram is not configured");
    sendTelegram(token, config.telegram_chat_id, message);
  } else if (config.channel === "imessage" && config.imessage_to) {
    if (config.remote_host) {
      try {
        sendRemoteIMessage(config.remote_host, config.imessage_to, message);
      } catch (error) {
        console.error(
          `cove-notify remote iMessage failed; using a local notification: ${error.message}`,
        );
        try {
          notifyNative(message);
        } catch {
          // Notification delivery never changes the intake result.
        }
        console.error(
          `COVE_NOTIFY ${JSON.stringify({
            delivered: false,
            reason: "remote_imessage_failed",
          })}`,
        );
        process.exitCode = 1;
      }
    } else {
      sendIMessage(config.imessage_to, message);
    }
  } else {
    throw new Error("No configured notification channel");
  }
} catch (err) {
  console.error("cove-notify failed:", err.message);
  console.error(
    `COVE_NOTIFY ${JSON.stringify({
      delivered: false,
      reason: "configured_channel_failed",
    })}`,
  );
  process.exitCode = 1;
}
