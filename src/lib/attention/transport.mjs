import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  localIMessageArgs,
  nativeNotificationCommand,
  remoteIMessageArgs,
  REMOTE_IMESSAGE_TIMEOUT_MS,
} from "../intake/notification-transport.mjs";
import { coveConfigPath, coveEnv } from "../env-runtime.mjs";

function reminderConfig(repoDir) {
  try {
    return JSON.parse(readFileSync(
      coveEnv("REMINDER_CONFIG_PATH") ??
        coveConfigPath(path.join(repoDir, "data"), "reminders.json"),
      "utf8",
    ));
  } catch {
    return null;
  }
}

function telegramToken() {
  try {
    const env = readFileSync(
      path.join(os.homedir(), ".claude/channels/telegram/.env"),
      "utf8",
    );
    return /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(env)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function createAttentionTransport(input = {}) {
  const repoDir = input.repoDir ?? process.cwd();
  const execute = input.execFileSyncImpl ?? execFileSync;
  const config = input.config ?? reminderConfig(repoDir);
  const token = input.telegramToken ?? telegramToken();
  return {
    banner(message, subtitle = "Needs your attention") {
      const command = nativeNotificationCommand(message, {
        title: "Cove",
        subtitle,
        sound: "Glass",
      }, {
        notificationAppPath: input.notificationAppPath ??
          coveEnv("NOTIFICATION_APP"),
        exists: input.exists,
      });
      execute(command.executable, command.args);
    },
    text(message) {
      if (config?.channel === "telegram" && token && config.telegram_chat_id) {
        const output = execute("curl", [
          "-sS",
          "-m",
          "15",
          `https://api.telegram.org/bot${token}/sendMessage`,
          "--data-urlencode",
          `chat_id=${config.telegram_chat_id}`,
          "--data-urlencode",
          `text=${message}`,
        ]).toString();
        if (!/"ok":\s*true/.test(output)) {
          throw new Error("Telegram rejected the attention message.");
        }
        return true;
      }
      if (config?.channel === "imessage" && config.imessage_to) {
        if (config.remote_host) {
          execute("ssh", remoteIMessageArgs(
            config.remote_host,
            config.imessage_to,
            message,
          ), { timeout: REMOTE_IMESSAGE_TIMEOUT_MS });
        } else {
          execute("osascript", localIMessageArgs(config.imessage_to, message));
        }
        return true;
      }
      return false;
    },
    textConfigured: Boolean(
      (config?.channel === "telegram" && token && config.telegram_chat_id) ||
      (config?.channel === "imessage" && config.imessage_to),
    ),
  };
}
