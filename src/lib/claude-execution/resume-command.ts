export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildClaudeResumeCommand(workspacePath: string, sessionId: string): string {
  return `cd ${shellQuote(workspacePath)} && claude --resume ${shellQuote(sessionId)}`;
}
