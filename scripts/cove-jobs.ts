import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coveEnv } from "../src/lib/env";
import { resolveEmailRuntimePaths } from "../src/lib/email/runtime-paths";
import { signatureHtmlToText } from "../src/lib/email/draft-format";
import { loadSignature } from "../src/lib/email/signature";
import { createSqliteBackup } from "../src/lib/reliability/backup";
import { JobScheduler } from "../src/lib/reliability/jobs";
import {
  enqueueDailyTaskMaintenance,
  registerTaskMaintenanceHandlers,
} from "../src/lib/tasks/maintenance";
import { getRuntimeMode } from "../src/lib/runtime/mode";
import {
  collectCoveHealth,
  enqueueDueHealthCollection,
} from "../src/lib/health/collector";
import {
  createGmailOperationHandler,
  reconcileDeadEmailJobs,
} from "../src/lib/email/gmail-outbox";
import {
  createEmailArtifactHandler,
  createEmailClassificationHandler,
} from "../src/lib/email/classification-job";
import { createGoogleWorkspaceGateway, workspaceConfigPath } from "../src/lib/workspace";
import { readWorkspaceConfig } from "../src/lib/workspace";

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function voiceGuide(): string {
  const file = path.join(os.homedir(), ".claude", "voice.md");
  return existsSync(file) ? readFileSync(file, "utf8").slice(0, 12_000) : "";
}

function paths(): { dataDir: string; dbPath: string; backupDir: string } {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { dataDir, dbPath } = resolveEmailRuntimePaths({ repoDir });
  return {
    dataDir,
    dbPath,
    backupDir: coveEnv("BACKUP_DIR") ?? path.join(path.dirname(dbPath), "backups"),
  };
}

function schedulerWithHandlers(dbPath: string, backupDir: string, dataDir: string): JobScheduler {
  const scheduler = new JobScheduler({ dbPath });
  if (existsSync(workspaceConfigPath(dataDir))) {
    const gateway = createGoogleWorkspaceGateway({ dataDir });
    const workspace = readWorkspaceConfig(dataDir);
    const cachedSignature = loadSignature(dataDir, workspace.accountEmail);
    if (
      cachedSignature &&
      Date.now() - Date.parse(cachedSignature.fetchedAt) > 30 * 24 * 60 * 60 * 1_000
    ) {
      console.warn("Cove email signature cache is over 30 days old. Run `npm run email:signature-sync` to refresh it.");
    }
    const signatureText = cachedSignature
      ? signatureHtmlToText(cachedSignature.html)
      : null;
    scheduler.register("gmail-operation", createGmailOperationHandler({
      gateway: gateway.mail,
      dbPath,
      dataDir,
      cachedSignature,
    }));
    scheduler.register("email-classify", createEmailClassificationHandler({
      gateway: gateway.mail,
      accountEmail: workspace.accountEmail,
      dbPath,
      signatureText,
      voice: voiceGuide,
    }));
    scheduler.register("email-artifacts", createEmailArtifactHandler({
      dbPath,
      dataDir,
    }));
  }
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
  scheduler.register("health-collector", async (job) => {
    const requestedAt = (
      job.payload &&
      typeof job.payload === "object" &&
      typeof (job.payload as { requestedAt?: unknown }).requestedAt === "string"
    )
      ? new Date((job.payload as { requestedAt: string }).requestedAt)
      : new Date();
    const snapshot = collectCoveHealth({
      dbPath,
      dataDir: path.dirname(dbPath),
      backupDir,
      now: Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt,
    });
    return {
      summary: "Collected Cove system health and adoption signals.",
      actions: {
        snapshotId: snapshot.id,
        collectedAt: snapshot.collectedAt,
        collectorVersion: snapshot.collectorVersion,
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
  const { dataDir, dbPath, backupDir } = paths();
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

  const scheduler = schedulerWithHandlers(dbPath, backupDir, dataDir);
  try {
    if (command === "run") {
      if (getRuntimeMode() === "local") {
        enqueueDailyTaskMaintenance(scheduler);
        enqueueDueHealthCollection(scheduler, { dbPath });
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
    reconcileDeadEmailJobs({ dbPath });
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
