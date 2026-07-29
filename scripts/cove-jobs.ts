import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coveEnv } from "../src/lib/env";
import { createSqliteBackup } from "../src/lib/reliability/backup";
import { JobScheduler } from "../src/lib/reliability/jobs";
import {
  enqueueDailyTaskMaintenance,
  registerTaskMaintenanceHandlers,
} from "../src/lib/tasks/maintenance";
import { getRuntimeMode } from "../src/lib/runtime/mode";

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function paths(): { dbPath: string; backupDir: string } {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dbPath = coveEnv("DB_PATH") ?? path.join(repoDir, "data", "forge.db");
  return {
    dbPath,
    backupDir: coveEnv("BACKUP_DIR") ?? path.join(path.dirname(dbPath), "backups"),
  };
}

function schedulerWithHandlers(dbPath: string, backupDir: string): JobScheduler {
  const scheduler = new JobScheduler({ dbPath });
  scheduler.register("backup", async (job) => {
    const requestedAt = (
      job.payload &&
      typeof job.payload === "object" &&
      typeof (job.payload as { requestedAt?: unknown }).requestedAt === "string"
    )
      ? new Date((job.payload as { requestedAt: string }).requestedAt)
      : new Date();
    const result = await createSqliteBackup({
      dbPath,
      backupDir,
      keep: 14,
      now: Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt,
      reuseExisting: true,
    });
    return {
      summary: `${result.reused ? "Verified existing" : "Created"} database backup ${path.basename(result.path)}.`,
      actions: {
        backupPath: result.path,
        rotated: result.removed.length,
        reused: result.reused,
      },
    };
  });
  return getRuntimeMode() === "local"
    ? registerTaskMaintenanceHandlers(scheduler, {
        dbPath,
        dataDir: path.dirname(dbPath),
      })
    : scheduler;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const { dbPath, backupDir } = paths();
  if (command === "enqueue-backup" && !existsSync(dbPath)) {
    process.stdout.write(`No database at ${dbPath} yet; nothing to back up.\n`);
    return 0;
  }
  if (command !== "enqueue-backup" && command !== "run") {
    process.stderr.write(
      "Usage: tsx scripts/cove-jobs.ts enqueue-backup [--run] | run\n",
    );
    return 2;
  }

  const scheduler = schedulerWithHandlers(dbPath, backupDir);
  try {
    if (command === "run") {
      if (getRuntimeMode() === "local") {
        enqueueDailyTaskMaintenance(scheduler);
      }
    }
    if (command === "enqueue-backup") {
      const now = new Date();
      const enqueued = scheduler.enqueue({
        type: "backup",
        payload: { requestedAt: now.toISOString() },
        priority: 100,
        maxAttempts: 5,
        idempotencyKey: `backup:${localDateKey(now)}`,
      });
      process.stdout.write(
        `${enqueued.inserted ? "Enqueued" : "Already queued"} daily backup ${enqueued.job.id}.\n`,
      );
      if (!process.argv.includes("--run")) return 0;
    }
    const result = await scheduler.runAvailable({ concurrency: 1, maxJobs: 25 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } finally {
    scheduler.close();
  }
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
