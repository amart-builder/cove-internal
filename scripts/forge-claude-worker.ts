import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createDayPlanStore } from "../src/lib/day-plan/store";
import {
  drainClaudeQueues,
  drainDayDumpQueue,
  enqueueDueMorningBrief,
  runOneDayDump,
  runOneExecution,
  runOneMorningBrief,
  watchClaudeQueues,
  watchDayDumpQueue,
  watchMorningBriefQueue,
} from "../src/lib/claude-execution/worker";

async function main(): Promise<number> {
  const laneIndex = process.argv.indexOf("--lane");
  const lane = laneIndex >= 0 ? process.argv[laneIndex + 1] : undefined;
  if (!["execution", "all", "watch", "brief", "dump"].includes(lane ?? "")) return 2;
  if (process.env.FORGE_CLAUDE_WORKER_ENABLED !== "1") return 3;
  const repoDir = process.cwd();
  const claudePath = process.env.FORGE_CLAUDE_BIN ?? path.join(homedir(), ".local", "bin", "claude");
  if (!existsSync(claudePath)) {
    return 4;
  }
  const dbPath = process.env.FORGE_DB_PATH ?? path.join(repoDir, "data", "forge.db");
  const store = createDayPlanStore({ dbPath });
  // The cross-machine file relay lives next to the (now machine-private) DB. A
  // generator that is not the authoritative source (the Mini) sets
  // FORGE_BRIEF_REQUIRE_SOURCE_CHECKPOINT=1 so it gates on the MBP's checkpoint.
  const relay = {
    dataDir: path.dirname(dbPath),
    requireSourceCheckpoint: process.env.FORGE_BRIEF_REQUIRE_SOURCE_CHECKPOINT === "1",
  };
  const heartbeatPath = path.join(repoDir, "data", "claude-worker.heartbeat");
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const options = {
      store,
      claudePath,
      emptyMcpConfigPath: path.join(repoDir, "scripts", "forge-empty-mcp.json"),
      logDir: path.join(repoDir, "data", "claude-runs"),
      fallbackCwd: repoDir,
      abortSignal: shutdown.signal,
      relay,
    };
    if (lane === "watch") {
      mkdirSync(path.dirname(heartbeatPath), { recursive: true, mode: 0o700 });
      const writeHeartbeat = () => writeFileSync(
        heartbeatPath,
        `${new Date().toISOString()}\n`,
        { mode: 0o600 },
      );
      writeHeartbeat();
      heartbeat = setInterval(writeHeartbeat, 2000);
    }
    if (lane === "execution") await runOneExecution(options);
    else if (lane === "all") {
      await drainClaudeQueues(options);
      await drainDayDumpQueue(options);
    }
    else if (lane === "dump") {
      while (await runOneDayDump(options)) {
        if (shutdown.signal.aborted) break;
      }
    }
    else if (lane === "brief") {
      // Scheduled one-shot (the ~7:30 local run): enqueue today's brief when
      // none exists, then drain the brief lane completely. Enqueueing is
      // best-effort: a transient SQLITE_BUSY must not exit-1 the whole run
      // (the drain below and the arrival trigger both cover the miss).
      try {
        enqueueDueMorningBrief(store, new Date(), { relay });
      } catch (error) {
        console.error("morning-brief enqueue failed (continuing to drain):", error);
      }
      while (await runOneMorningBrief(options)) {
        if (shutdown.signal.aborted) break;
      }
    } else {
      // Watch mode runs the execution loop and the dedicated
      // brief loop side by side, so briefs never queue behind execution runs.
      await Promise.all([
        watchClaudeQueues(options),
        watchMorningBriefQueue(options),
        watchDayDumpQueue(options),
      ]);
    }
    return 0;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (lane === "watch") rmSync(heartbeatPath, { force: true });
    store.close();
  }
}

void main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
