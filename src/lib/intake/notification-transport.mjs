import { existsSync } from "node:fs";

export const COVE_NOTIFICATION_ICON_RELATIVE_PATH =
  "public/cove-notification-icon.png";
// The SSH connection gets 10 seconds. Leave a separate bounded window for
// Messages to handle the AppleScript instead of killing it at that same limit.
export const REMOTE_IMESSAGE_TIMEOUT_MS = 30_000;

export function appleScriptLiteral(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function validateRemoteHost(remoteHost) {
  if (
    typeof remoteHost !== "string" ||
    !/^[A-Za-z0-9._@:-]+$/.test(remoteHost) ||
    remoteHost.startsWith("-")
  ) {
    throw new Error("remote_host is invalid");
  }
  return remoteHost;
}

export function imessageAppleScript(to, message) {
  return `tell application "Messages" to send ${appleScriptLiteral(message)} to buddy ${appleScriptLiteral(to)} of (1st service whose service type = iMessage)`;
}

export function localIMessageArgs(to, message) {
  return ["-e", imessageAppleScript(to, message)];
}

export function remoteIMessageArgs(remoteHost, to, message) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    validateRemoteHost(remoteHost),
    `osascript -e ${shellQuote(imessageAppleScript(to, message))}`,
  ];
}

/**
 * @param {string} message
 * @param {{title?: string, subtitle?: string, sound?: string}} [options]
 */
export function nativeNotificationArgs(
  message,
  { title = "Cove", subtitle, sound } = {},
) {
  return [
    "-e",
    [
      `display notification ${appleScriptLiteral(message)}`,
      `with title ${appleScriptLiteral(title)}`,
      subtitle ? `subtitle ${appleScriptLiteral(subtitle)}` : undefined,
      sound ? `sound name ${appleScriptLiteral(sound)}` : undefined,
    ].filter(Boolean).join(" "),
  ];
}

/**
 * Build one native macOS notification command without putting user-controlled
 * text through a shell. Cove's installed sender app supplies the real macOS
 * identity and icon; AppleScript remains the no-dependency fallback if that
 * helper is unavailable.
 *
 * @param {string} message
 * @param {{title?: string, subtitle?: string, sound?: string, group?: string, openUrl?: string}} [options]
 * @param {{notificationAppPath?: string, osascriptPath?: string, exists?: (candidate: string) => boolean}} [dependencies]
 * @returns {{executable: string, args: string[]}}
 */
export function nativeNotificationCommand(
  message,
  {
    title = "Cove",
    subtitle,
    sound,
    group,
    openUrl,
  } = {},
  {
    notificationAppPath,
    osascriptPath = "osascript",
    exists = existsSync,
  } = {},
) {
  const notificationApp = notificationAppPath?.trim();
  if (notificationApp && exists(notificationApp)) {
    return {
      executable: notificationApp,
      args: [
        "--title", title,
        "--message", String(message),
        ...(subtitle ? ["--subtitle", subtitle] : []),
        ...(sound ? ["--sound", sound] : []),
        ...(group ? ["--group", group] : []),
        ...(openUrl ? ["--open-url", openUrl] : []),
      ],
    };
  }
  return {
    executable: osascriptPath,
    args: nativeNotificationArgs(message, { title, subtitle, sound }),
  };
}

/** An SSH connection failure occurs before the remote Messages command runs.
 * A generic command timeout can happen after handoff and remains uncertain. */
export function textDeliveryUncertain(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^ssh: connect to host [^\n]+ port \d+:[^\n]*(?:timed out|refused|unreachable)/im.test(message)) return false;
  return /\b(?:ETIMEDOUT|timeout)\b|timed? out/i.test(message);
}
