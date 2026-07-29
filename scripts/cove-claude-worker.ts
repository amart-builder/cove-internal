import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  watchInboundEvents,
  watchMorningBriefQueue,
} from "../src/lib/claude-execution/worker";
import {
  runOneGroundwork,
  watchGroundworkQueue,
} from "../src/lib/autonomy/groundwork";
import { triageRecordedEvent } from "../src/lib/intake/run";
import { coveEnv } from "../src/lib/env";
import {
  currentBootId,
  pruneSpawnedChildren,
  reapSpawnedChildren,
} from "../src/lib/claude-execution/child-process-registry";

async function main(): Promise<number> {
  const laneIndex = process.argv.indexOf("--lane");
  const lane = laneIndex >= 0 ? process.argv[laneIndex + 1] : undefined;
  const dryRun = process.argv.includes("--dry-run");
  if (!["execution", "all", "watch", "brief", "dump", "groundwork"].includes(lane ?? "")) return 2;
  if (coveEnv("CLAUDE_WORKER_ENABLED") !== "1") return 3;
  const repoDir = process.cwd();
  const claudePath = coveEnv("CLAUDE_BIN") ?? path.join(homedir(), ".local", "bin", "claude");
  if (!existsSync(claudePath)) {
    return 4;
  }
  const dbPath = coveEnv("DB_PATH") ?? path.join(repoDir, "data", "cove.db");
  if (lane === "groundwork") {
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      const result = await runOneGroundwork({
        claudePath,
        emptyMcpConfigPath: path.join(repoDir, "scripts", "cove-empty-mcp.json"),
        emptySettingsPath: path.join(repoDir, "scripts", "cove-empty-settings.json"),
        dataDir: path.dirname(dbPath),
        repoDir,
        dryRun,
        abortSignal: shutdown.signal,
      });
      if (dryRun) process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  }
  const store = createDayPlanStore({ dbPath });
  // The cross-machine file relay lives next to the (now machine-private) DB. A
  // generator that is not the authoritative source (the Mini) sets
  // COVE_BRIEF_REQUIRE_SOURCE_CHECKPOINT=1 so it gates on the MBP's checkpoint.
  const relay = {
    dataDir: path.dirname(dbPath),
    requireSourceCheckpoint: coveEnv("BRIEF_REQUIRE_SOURCE_CHECKPOINT") === "1",
  };
  const heartbeatPath = path.join(repoDir, "data", "claude-worker.heartbeat");
  const childServerGeneration = randomUUID();
  const childBootId = currentBootId();
  let heartbeat: NodeJS.Timeout | undefined;
  let orphanReaper: NodeJS.Timeout | undefined;
  try {
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const options = {
      store,
      claudePath,
      emptyMcpConfigPath: path.join(repoDir, "scripts", "cove-empty-mcp.json"),
      logDir: path.join(repoDir, "data", "claude-runs"),
      fallbackCwd: repoDir,
      abortSignal: shutdown.signal,
      relay,
      receiptDbPath: dbPath,
      childServerGeneration,
      childBootId,
    };
    pruneSpawnedChildren({ dbPath });
    reapSpawnedChildren({ dbPath, serverGeneration: childServerGeneration, bootId: childBootId });
    orphanReaper = setInterval(() => {
      try {
        reapSpawnedChildren({
          dbPath,
          serverGeneration: childServerGeneration,
          bootId: childBootId,
        });
      } catch (error) {
        console.error("Claude child reaper failed; continuing.", error);
      }
    }, 30_000);
    orphanReaper.unref();
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
      await runOneGroundwork({
        ...options,
        dataDir: relay.dataDir,
        repoDir,
      });
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
        watchInboundEvents({
          ...options,
          dataDir: relay.dataDir,
          triageEvent: (event, input) => triageRecordedEvent(event, input, {
            dataDir: relay.dataDir,
            repoDir,
            claudePath,
            emptyMcpConfigPath: options.emptyMcpConfigPath,
          }),
        }),
        watchGroundworkQueue({
          ...options,
          dataDir: relay.dataDir,
          repoDir,
        }),
      ]);
    }
    return 0;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (orphanReaper) clearInterval(orphanReaper);
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
