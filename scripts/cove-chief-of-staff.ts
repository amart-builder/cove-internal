#!/usr/bin/env -S node --import tsx

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWake } from "../src/lib/chief-of-staff/driver";
import { runChiefOfStaffReview } from "../src/lib/chief-of-staff/review";
import {
  CHIEF_OF_STAFF_SWEEP_SLOTS,
  enqueueChiefOfStaffWake,
  readChiefOfStaffJournalLines,
  readChiefOfStaffSession,
  resetChiefOfStaffSession,
  type ChiefOfStaffSweepSlot,
} from "../src/lib/chief-of-staff/storage";
import {
  CHIEF_OF_STAFF_JOB_TYPE,
  CHIEF_OF_STAFF_REASONS,
  type ChiefOfStaffReason,
} from "../src/lib/chief-of-staff/types";
import { localDatabasePath, openLocalDatabase } from "../src/lib/local/database";
import { coveDataDir } from "../src/lib/operator";
import { JobScheduler } from "../src/lib/reliability/jobs";
import { loadLocalEnv } from "./lib/load-local-env.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(repoDir);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function optionValues(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []
  );
}

function payloadFile(): Record<string, unknown> {
  const file = option("--payload-file");
  if (!file) return {};
  const parsed = JSON.parse(readFileSync(path.resolve(file), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Wake payload file must contain one JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export async function drainChiefOfStaff(input: {
  repoDir: string;
  dataDir: string;
  dbPath: string;
  max: number;
  runWakeImpl?: typeof runWake;
}): Promise<{ claimed: number; done: number; failed: number; dead: number }> {
  const scheduler = new JobScheduler({ dbPath: input.dbPath, leaseMs: 20 * 60_000 });
  scheduler.register(CHIEF_OF_STAFF_JOB_TYPE, (job) =>
    (input.runWakeImpl ?? runWake)(job, input)
  );
  try {
    const result = await scheduler.runAvailable({ concurrency: 1, maxJobs: input.max });
    return {
      claimed: result.claimed,
      done: result.done,
      failed: result.failed,
      dead: result.dead,
    };
  } finally {
    scheduler.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dataDir = coveDataDir();
  const dbPath = localDatabasePath();
  if (command === "enqueue") {
    const reason = option("--reason");
    if (!reason || !(CHIEF_OF_STAFF_REASONS as readonly string[]).includes(reason)) {
      throw new Error("enqueue requires --reason brief|triage|meeting|sweep|nightly|manual.");
    }
    const requestedSlots = optionValues("--slot");
    if (reason !== "sweep" && requestedSlots.length > 0) {
      throw new Error("--slot can only be used with --reason sweep.");
    }
    if (requestedSlots.some((slot) =>
      !(CHIEF_OF_STAFF_SWEEP_SLOTS as readonly string[]).includes(slot)
    )) {
      throw new Error("--slot must be 11:30 or 16:00.");
    }
    const slots = requestedSlots as ChiefOfStaffSweepSlot[];
    const db = openLocalDatabase(dbPath);
    try {
      const result = db.transaction(() => enqueueChiefOfStaffWake(db, {
        reason: reason as ChiefOfStaffReason,
        payload: payloadFile(),
        note: option("--note"),
        ...(slots.length > 0 ? { slot: slots.length === 1 ? slots[0] : slots } : {}),
      })).immediate();
      console.log(JSON.stringify({ id: result.job.id, inserted: result.inserted }));
    } finally {
      db.close();
    }
    return;
  }
  if (command === "drain") {
    const requested = Number(option("--max") ?? 25);
    if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
      throw new Error("drain --max must be an integer from 1 to 100.");
    }
    console.log(JSON.stringify(await drainChiefOfStaff({ repoDir, dataDir, dbPath, max: requested })));
    return;
  }
  if (command === "reset") {
    const archived = resetChiefOfStaffSession({ dataDir, why: option("--why") });
    console.log(JSON.stringify({ reset: true, archived }));
    return;
  }
  if (command === "review") {
    const result = await runChiefOfStaffReview({ repoDir, dataDir, dbPath });
    console.log(JSON.stringify({ file: result.file, suggestionId: result.suggestionId }));
    return;
  }
  if (command === "status") {
    const session = readChiefOfStaffSession(dataDir);
    const db = openLocalDatabase(dbPath);
    try {
      const counts = db.prepare(
        `SELECT status, COUNT(*) AS count FROM cove_jobs
         WHERE type = ? AND status IN ('queued','leased','dead') GROUP BY status`,
      ).all(CHIEF_OF_STAFF_JOB_TYPE) as Array<{ status: string; count: number }>;
      console.log(JSON.stringify({
        sessionId: session?.sessionId ?? null,
        wakeCount: session?.wakes ?? 0,
        lastWakeAt: session?.lastWakeAt ?? null,
        lastWakeReason: session?.lastWakeReason ?? null,
        jobs: {
          queued: counts.find((row) => row.status === "queued")?.count ?? 0,
          leased: counts.find((row) => row.status === "leased")?.count ?? 0,
          dead: counts.find((row) => row.status === "dead")?.count ?? 0,
        },
        journal: readChiefOfStaffJournalLines(dataDir, 10),
      }, null, 2));
    } finally {
      db.close();
    }
    return;
  }
  throw new Error("Usage: cove-chief-of-staff.ts enqueue|drain|reset|review|status");
}

export { enqueueChiefOfStaffWake, runWake };

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
