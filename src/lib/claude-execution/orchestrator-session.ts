import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function markForgeOrchestratorSession(
  sessionId: string,
  homeDir = os.homedir(),
): void {
  try {
    const forgeDir = path.join(homeDir, ".forge");
    mkdirSync(forgeDir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(forgeDir, "orchestrator-sessions"), `${sessionId}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    console.error("Could not mark Forge orchestrator session.", error);
  }
}
