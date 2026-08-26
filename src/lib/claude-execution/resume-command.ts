export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export type ClaudeResumeCommandOptions = {
  permissionMode?: "plan" | "auto";
  safeMode?: boolean;
  tools?: string;
  settingsPath?: string;
  mcpConfigPath?: string;
  noChrome?: boolean;
};

export function buildClaudeResumeCommand(
  workspacePath: string,
  sessionId: string,
  options: ClaudeResumeCommandOptions = {},
): string {
  const args = ["--resume", shellQuote(sessionId)];
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.safeMode) args.push("--safe-mode");
  if (options.tools !== undefined) args.push("--tools", shellQuote(options.tools));
  if (options.settingsPath) args.push("--settings", shellQuote(options.settingsPath));
  if (options.mcpConfigPath) {
    args.push("--strict-mcp-config", "--mcp-config", shellQuote(options.mcpConfigPath));
  }
  if (options.noChrome) args.push("--no-chrome");
  return `cd ${shellQuote(workspacePath)} && claude ${args.join(" ")}`;
}
