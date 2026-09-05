import { execFile } from "node:child_process";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Only pass commands built from stored, validated identifiers and argv. */
export async function openAgentTerminal(command: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Opening an agent session requires a Mac.");
  const literal = `"${command.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", 'tell application "Terminal" to activate', "-e", `tell application "Terminal" to do script ${literal}`], { timeout: 10000 }, error => error ? reject(new Error("Cove could not open Terminal. Check macOS automation permissions.")) : resolve());
  });
}
