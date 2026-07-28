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
