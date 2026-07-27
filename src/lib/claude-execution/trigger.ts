export type WorkerLane = "execution";

export type WorkerQueueAcknowledgement = {
  queued: true;
  workerAvailable: boolean;
  lane: WorkerLane;
};

export function isClaudeWorkerAvailable(options: {
  configured?: boolean;
  heartbeatPath?: string;
  now?: number;
  maximumAgeMs?: number;
} = {}): boolean {
  const configured = options.configured ?? (
    process.env.FORGE_CLAUDE_WORKER_AVAILABLE === "1" ||
    process.env.FORGE_CLAUDE_WORKER_ENABLED === "1"
  );
  if (!configured) return false;
  try {
    const heartbeatPath = options.heartbeatPath ?? path.join(
      /*turbopackIgnore: true*/ process.cwd(),
      "data",
      "claude-worker.heartbeat",
    );
    const age = (options.now ?? Date.now()) - statSync(
      /*turbopackIgnore: true*/ heartbeatPath,
    ).mtimeMs;
    return age >= 0 && age <= (options.maximumAgeMs ?? 10_000);
  } catch {
    return false;
  }
}

export function triggerOneShotWorker(lane: WorkerLane): WorkerQueueAcknowledgement {
  // The supervised worker polls the durable SQLite queue. This response only
  // acknowledges persistence; it never claims that a subprocess was started.
  return { queued: true, workerAvailable: isClaudeWorkerAvailable(), lane };
}
import { statSync } from "node:fs";
import path from "node:path";
