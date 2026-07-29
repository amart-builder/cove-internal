import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function markCoveOrchestratorSession(
  sessionId: string,
  homeDir = os.homedir(),
): void {
  try {
    const coveDir = path.join(homeDir, ".cove");
    mkdirSync(coveDir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(coveDir, "orchestrator-sessions"), `${sessionId}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    console.error("Could not mark Cove orchestrator session.", error);
  }
}
