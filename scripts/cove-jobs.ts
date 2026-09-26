import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCoveRuntimePaths } from "./lib/cove-runtime-paths.mjs";
import { signatureHtmlToText } from "../src/lib/email/draft-format";
import { loadSignature } from "../src/lib/email/signature";
import { readEmailVoiceGuide } from "../src/lib/email/voice-guide";
import { createSqliteBackup, sqliteBackupPath, verifySqliteBackup } from "../src/lib/reliability/backup";
import { JobScheduler } from "../src/lib/reliability/jobs";
import { diagnosticCause } from "../src/lib/reliability/job-failure-copy";
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
import { observeIncrementalInbox } from "../src/lib/email/incremental-intake";

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function paths(): { dataDir: string; dbPath: string; backupDir: string } {
  return loadCoveRuntimePaths(REPO_DIR);
}

function schedulerWithHandlers(dbPath: string, backupDir: string, dataDir: string, backupOnly = false): JobScheduler {
  const scheduler = new JobScheduler({ dbPath });
  if (!backupOnly && existsSync(workspaceConfigPath(dataDir))) {
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
    // This runner drains every queue every five minutes, so in practice it is
    // the one that classifies mail; cove-email-triage runs a few times a day.
    // It registered the handler without dataDir or repoDir and with its own
    // reader of ~/.claude/voice.md, so the measured voice fingerprint never
    // reached the model and the voice judge -- which is guarded on dataDir --
    // never ran at all. Both are shipped features that did nothing on the lane
    // that does the work. The arguments now match cove-email-runner.ts.
    scheduler.register("email-classify", createEmailClassificationHandler({
      gateway: gateway.mail,
      accountEmail: workspace.accountEmail,
      dbPath,
      repoDir: REPO_DIR,
      dataDir,
      signatureText,
      voice: () => readEmailVoiceGuide({ dataDir }),
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
      snapshotId: (job.payload as { snapshotId?: string } | null)?.snapshotId,
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
  if (backupOnly) return scheduler;
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
    process.stderr.write(`No database at ${dbPath}; no backup was created. Confirm the configured database path.\n`);
    return 1;
  }
  if (command !== "enqueue-backup" && command !== "run") {
    process.stderr.write(
      "Usage: tsx scripts/cove-jobs.ts enqueue-backup [--run] [--daily] | run\n",
    );
    return 2;
  }

  const scheduler = schedulerWithHandlers(dbPath, backupDir, dataDir, command === "enqueue-backup");
  try {
    let incrementalEmail: Awaited<ReturnType<typeof observeIncrementalInbox>> | undefined;
    if (command === "run") {
      if (getRuntimeMode() === "local") {
        enqueueDailyTaskMaintenance(scheduler);
        enqueueDueHealthCollection(scheduler, { dbPath });
      }
      if (existsSync(workspaceConfigPath(dataDir))) {
        try {
          const workspace = readWorkspaceConfig(dataDir);
          const gateway = createGoogleWorkspaceGateway({ dataDir });
          incrementalEmail = await observeIncrementalInbox({
            gateway: gateway.mail,
            accountEmail: workspace.accountEmail,
            dbPath,
          });
        } catch (error) {
          console.warn(
            "Incremental email intake could not poll this tick:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    if (command === "enqueue-backup") {
      const now = new Date();
      const enqueued = scheduler.enqueue({
        type: "backup",
        payload: { requestedAt: now.toISOString(), snapshotId: randomUUID() },
        priority: 100,
        maxAttempts: 5,
        idempotencyKey: process.argv.includes("--daily")
          ? `backup:${localDateKey(now)}`
          : `backup:manual:${randomUUID()}`,
      });
      process.stdout.write(
        `${enqueued.inserted ? "Enqueued" : "Already queued"} backup ${enqueued.job.id}.\n`,
      );
      if (!process.argv.includes("--run")) return 0;
      // A backup request must never drain unrelated Gmail or task jobs.
      // Re-running a completed daily job verifies its durable snapshot as well.
      if (enqueued.job.status === "done") {
        const payload = enqueued.job.payload as { requestedAt: string; snapshotId?: string };
        const file = sqliteBackupPath({
          backupDir, now: new Date(payload.requestedAt), snapshotId: payload.snapshotId,
        });
        verifySqliteBackup(file);
        process.stdout.write(`Verified daily backup ${file}.\n`);
        return 0;
      }
      const status = await scheduler.runJob(enqueued.job.id);
      if (status !== "done") {
        process.stderr.write(`Backup did not complete (${status}). See Cove Issues and retry.\n`);
        return 1;
      }
      process.stdout.write(`Backup completed ${enqueued.job.id}.\n`);
      return 0;
    }
    const result = await scheduler.runAvailable({ concurrency: 1, maxJobs: 25 });
    reconcileDeadEmailJobs({ dbPath });
    process.stdout.write(`${JSON.stringify({ ...result, incrementalEmail })}\n`);
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
    // A person runs this from SETUP.md and from the recovery steps in
    // OPERATIONS.md, so what they read when it fails has to be a sentence. On
    // a full disk this printed an eleven-line stack with `SQLITE_FULL` and
    // internal file paths, and the one fact they could act on was inside it.
    // The stack still prints for anything Cove cannot name, because that is
    // exactly when whoever is helping needs it.
    const diagnostic = error instanceof Error ? error.message : String(error);
    const { cause, remedy } = diagnosticCause(diagnostic);
    if (cause) {
      process.stderr.write(`Cove could not finish this run.${cause}${remedy}\n`);
      if (process.env.COVE_DEBUG) console.error(error);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
