import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openLocalDatabase } from "../local/database";
import { recordFailureInDatabase } from "./failures";
import { notifyHardFailure } from "./notifications";
import { recordReceiptInDatabase } from "./receipts";

export type JobStatus = "queued" | "leased" | "done" | "failed" | "dead";

export type ScheduledJob = {
  id: string;
  type: string;
  payload: unknown;
  priority: number;
  runAfter: string;
  leaseUntil: string | null;
  attempts: number;
  maxAttempts: number;
  status: JobStatus;
  idempotencyKey: string;
  createdAt: string;
  finishedAt: string | null;
  lastError: string | null;
};

export type JobHandlerResult = {
  summary?: string;
  actions?: unknown;
};

export type JobHandler = (
  job: ScheduledJob,
) => Promise<void | JobHandlerResult> | void | JobHandlerResult;

type JobRow = {
  id: string;
  type: string;
  payload: string;
  priority: number;
  run_after: string;
  lease_until: string | null;
  lease_token: string | null;
  attempts: number;
  max_attempts: number;
  status: JobStatus;
  idempotency_key: string;
  created_at: string;
  finished_at: string | null;
  last_error: string | null;
};

type ClaimedJob = ScheduledJob & { leaseToken: string };

export type EnqueueJobInput = {
  type: string;
  payload?: unknown;
  priority?: number;
  runAfter?: Date | string;
  maxAttempts?: number;
  idempotencyKey: string;
};

function decodeJob(row: JobRow): ScheduledJob {
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = { raw: row.payload };
  }
  return {
    id: row.id,
    type: row.type,
    payload,
    priority: row.priority,
    runAfter: row.run_after,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000) || "Job failed.";
}

export function enqueueJobInDatabase(
  db: Database.Database,
  input: EnqueueJobInput,
  nowDate: Date,
): { job: ScheduledJob; inserted: boolean } {
  const type = input.type.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!type) throw new Error("Job type is required.");
  if (!idempotencyKey) throw new Error("Job idempotency key is required.");
  const payload = JSON.stringify(input.payload ?? {});
  if (payload.length > 100_000) {
    throw new Error("Job payload exceeds 100000 characters.");
  }
  const now = nowDate.toISOString();
  const runAfter = input.runAfter instanceof Date
    ? input.runAfter.toISOString()
    : input.runAfter ?? now;
  const maxAttempts = Math.min(
    20,
    Math.max(1, Math.trunc(input.maxAttempts ?? 5)),
  );
  const key = idempotencyKey.slice(0, 300);
  const result = db.prepare(
    `INSERT INTO forge_jobs
       (id, type, payload, priority, run_after, attempts, max_attempts,
        status, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 'queued', ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  ).run(
    randomUUID(),
    type,
    payload,
    Math.trunc(input.priority ?? 0),
    runAfter,
    maxAttempts,
    key,
    now,
  );
  const row = db.prepare(
    "SELECT * FROM forge_jobs WHERE idempotency_key = ?",
  ).get(key) as JobRow;
  return { job: decodeJob(row), inserted: result.changes === 1 };
}

export class JobScheduler {
  private readonly db: Database.Database;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: {
    dbPath?: string;
    now?: () => Date;
    leaseMs?: number;
    backoffBaseMs?: number;
    maxBackoffMs?: number;
  } = {}) {
    this.db = openLocalDatabase(options.dbPath);
    this.now = options.now ?? (() => new Date());
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 5 * 60_000);
    this.backoffBaseMs = Math.max(1_000, options.backoffBaseMs ?? 30_000);
    this.maxBackoffMs = Math.max(
      this.backoffBaseMs,
      options.maxBackoffMs ?? 6 * 60 * 60_000,
    );
  }

  close(): void {
    this.db.close();
  }

  register(type: string, handler: JobHandler): this {
    const normalized = type.trim();
    if (!normalized) throw new Error("Job type is required.");
    if (this.handlers.has(normalized)) {
      throw new Error(`A handler is already registered for ${normalized}.`);
    }
    this.handlers.set(normalized, handler);
    return this;
  }

  enqueue(input: EnqueueJobInput): { job: ScheduledJob; inserted: boolean } {
    return enqueueJobInDatabase(this.db, input, this.now());
  }

  getJob(id: string): ScheduledJob | undefined {
    const row = this.db.prepare(
      "SELECT * FROM forge_jobs WHERE id = ?",
    ).get(id) as JobRow | undefined;
    return row ? decodeJob(row) : undefined;
  }

  listJobs(status?: JobStatus): ScheduledJob[] {
    const rows = status
      ? this.db.prepare(
          `SELECT * FROM forge_jobs
           WHERE status = ?
           ORDER BY priority DESC, run_after ASC, created_at ASC`,
        ).all(status)
      : this.db.prepare(
          `SELECT * FROM forge_jobs
           ORDER BY priority DESC, run_after ASC, created_at ASC`,
        ).all();
    return (rows as JobRow[]).map(decodeJob);
  }

  private backoff(attempts: number): number {
    return Math.min(
      this.maxBackoffMs,
      this.backoffBaseMs * (2 ** Math.max(0, attempts - 1)),
    );
  }

  private sweepRetention(): void {
    const now = this.now().getTime();
    const jobCutoff = new Date(now - 30 * 24 * 60 * 60_000).toISOString();
    const receiptCutoff = new Date(now - 90 * 24 * 60 * 60_000).toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM forge_jobs
         WHERE status IN ('done','dead')
           AND COALESCE(finished_at, created_at) < ?`,
      ).run(jobCutoff);
      this.db.prepare(
        `DELETE FROM forge_failure_inbox
         WHERE dismissed_at IS NOT NULL AND dismissed_at < ?`,
      ).run(jobCutoff);
      this.db.prepare(
        "DELETE FROM forge_receipts WHERE finished_at < ?",
      ).run(receiptCutoff);
    })();
  }

  private recoverExpiredLeases(): { recovered: number; dead: number } {
    const now = this.now();
    const expired = this.db.prepare(
      `SELECT * FROM forge_jobs
       WHERE status = 'leased' AND lease_until <= ?
       ORDER BY lease_until ASC`,
    ).all(now.toISOString()) as JobRow[];
    if (expired.length === 0) return { recovered: 0, dead: 0 };

    let recovered = 0;
    let dead = 0;
    const hardFailures: ScheduledJob[] = [];
    this.db.transaction(() => {
      for (const row of expired) {
        const nextStatus: JobStatus = row.attempts >= row.max_attempts
          ? "dead"
          : "failed";
        const message = "Lease expired before the job completed.";
        const runAfter = new Date(
          now.getTime() + this.backoff(row.attempts),
        ).toISOString();
        const result = this.db.prepare(
          `UPDATE forge_jobs
           SET status = ?, run_after = ?, lease_until = NULL, lease_token = NULL,
               finished_at = ?, last_error = ?
           WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        ).run(
          nextStatus,
          runAfter,
          nextStatus === "dead" ? now.toISOString() : null,
          message,
          row.id,
          row.lease_token,
        );
        if (result.changes !== 1) continue;
        if (nextStatus === "dead") {
          dead += 1;
          hardFailures.push(decodeJob({ ...row, status: "dead" }));
        } else {
          recovered += 1;
        }
        recordReceiptInDatabase(this.db, {
          source: "scheduler",
          startedAt: row.created_at,
          finishedAt: now.toISOString(),
          summary: `${row.type} job lost its lease.`,
          actions: { jobId: row.id, type: row.type, nextStatus },
          retryCount: Math.max(0, row.attempts - 1),
          outcome: "failed",
          surfaceFailure: false,
        });
        recordReceiptInDatabase(this.db, {
          source: row.type,
          startedAt: row.created_at,
          finishedAt: now.toISOString(),
          summary: `${row.type} action lost its scheduler lease.`,
          actions: { jobId: row.id, type: row.type, nextStatus },
          retryCount: Math.max(0, row.attempts - 1),
          outcome: "failed",
          surfaceFailure: false,
        });
        recordFailureInDatabase(this.db, {
          source: "job",
          sourceId: row.id,
          message: `${row.type} job ${nextStatus === "dead" ? "stopped retrying" : "will retry"}: ${message}`,
          details: { jobId: row.id, type: row.type, attempts: row.attempts },
          occurredAt: now.toISOString(),
        });
      }
    })();
    for (const job of hardFailures) {
      notifyHardFailure({
        source: `job:${job.type}`,
        message: `${job.type} job exhausted its lease retries.`,
        details: { jobId: job.id, attempts: job.attempts },
      });
    }
    return { recovered, dead };
  }

  private claimNext(): ClaimedJob | undefined {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM forge_jobs
         WHERE status IN ('queued','failed')
           AND run_after <= ?
           AND attempts < max_attempts
         ORDER BY priority DESC, run_after ASC, created_at ASC
         LIMIT 1`,
      ).get(now.toISOString()) as JobRow | undefined;
      if (!row) return undefined;
      const leaseToken = randomUUID();
      const result = this.db.prepare(
        `UPDATE forge_jobs
         SET status = 'leased', lease_until = ?, lease_token = ?,
             attempts = attempts + 1
         WHERE id = ? AND status IN ('queued','failed')`,
      ).run(leaseUntil, leaseToken, row.id);
      if (result.changes !== 1) return undefined;
      const claimed = this.db.prepare(
        "SELECT * FROM forge_jobs WHERE id = ?",
      ).get(row.id) as JobRow;
      return { ...decodeJob(claimed), leaseToken };
    }).immediate();
  }

  private claimById(id: string): ClaimedJob | undefined {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM forge_jobs
         WHERE id = ? AND status IN ('queued','failed')
           AND run_after <= ? AND attempts < max_attempts`,
      ).get(id, now.toISOString()) as JobRow | undefined;
      if (!row) return undefined;
      const leaseToken = randomUUID();
      const result = this.db.prepare(
        `UPDATE forge_jobs
         SET status = 'leased', lease_until = ?, lease_token = ?,
             attempts = attempts + 1
         WHERE id = ? AND status IN ('queued','failed')`,
      ).run(leaseUntil, leaseToken, row.id);
      if (result.changes !== 1) return undefined;
      const claimed = this.db.prepare(
        "SELECT * FROM forge_jobs WHERE id = ?",
      ).get(row.id) as JobRow;
      return { ...decodeJob(claimed), leaseToken };
    }).immediate();
  }

  private recordRunnerFailure(error: unknown, job?: ScheduledJob): void {
    const occurredAt = this.now().toISOString();
    const message = errorText(error);
    try {
      this.db.transaction(() => {
        recordReceiptInDatabase(this.db, {
          source: "scheduler",
          startedAt: occurredAt,
          finishedAt: occurredAt,
          summary: "Scheduler runner failed outside a job handler.",
          actions: { jobId: job?.id, type: job?.type, error: message },
          outcome: "failed",
          surfaceFailure: false,
        });
        recordFailureInDatabase(this.db, {
          source: "scheduler",
          sourceId: job?.id ?? "claim",
          message: `Scheduler runner failed: ${message}`,
          details: { jobId: job?.id, type: job?.type, error: message },
          occurredAt,
        });
      })();
    } catch (recordError) {
      console.error("Could not record scheduler runner failure.", recordError);
    }
  }

  private async execute(job: ClaimedJob): Promise<"done" | "failed" | "dead" | "lost"> {
    const startedAt = this.now().toISOString();
    const renewLease = () => {
      try {
        const leaseUntil = new Date(
          this.now().getTime() + this.leaseMs,
        ).toISOString();
        this.db.prepare(
          `UPDATE forge_jobs
           SET lease_until = ?
           WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        ).run(leaseUntil, job.id, job.leaseToken);
      } catch {
        // A brief SQLITE_BUSY is safe: the next heartbeat still has time to
        // renew, and the completion compare-and-swap remains authoritative.
      }
    };
    const heartbeat = setInterval(
      renewLease,
      Math.max(250, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`No handler is registered for ${job.type}.`);
      const handlerResult = await handler(job);
      const finishedAt = this.now().toISOString();
      const updated = this.db.transaction(() => {
        const result = this.db.prepare(
          `UPDATE forge_jobs
           SET status = 'done', lease_until = NULL, lease_token = NULL,
               finished_at = ?, last_error = NULL
           WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        ).run(finishedAt, job.id, job.leaseToken);
        if (result.changes !== 1) return false;
        recordReceiptInDatabase(this.db, {
          source: "scheduler",
          startedAt,
          finishedAt,
          summary: handlerResult?.summary ?? `Completed ${job.type} job.`,
          actions: {
            jobId: job.id,
            type: job.type,
            result: handlerResult?.actions ?? {},
          },
          retryCount: Math.max(0, job.attempts - 1),
          outcome: "success",
        });
        recordReceiptInDatabase(this.db, {
          source: job.type,
          startedAt,
          finishedAt,
          summary: handlerResult?.summary ?? `Completed ${job.type} action.`,
          actions: {
            jobId: job.id,
            type: job.type,
            result: handlerResult?.actions ?? {},
          },
          retryCount: Math.max(0, job.attempts - 1),
          outcome: "success",
        });
        this.db.prepare(
          `UPDATE forge_failure_inbox
           SET dismissed_at = ?
           WHERE source = 'job' AND source_id = ? AND dismissed_at IS NULL`,
        ).run(finishedAt, job.id);
        return true;
      })();
      return updated ? "done" : "lost";
    } catch (error) {
      const finishedAt = this.now().toISOString();
      const message = errorText(error);
      const nextStatus: "failed" | "dead" = job.attempts >= job.maxAttempts
        ? "dead"
        : "failed";
      const runAfter = new Date(
        this.now().getTime() + this.backoff(job.attempts),
      ).toISOString();
      const updated = this.db.transaction(() => {
        const result = this.db.prepare(
          `UPDATE forge_jobs
           SET status = ?, run_after = ?, lease_until = NULL, lease_token = NULL,
               finished_at = ?, last_error = ?
           WHERE id = ? AND status = 'leased' AND lease_token = ?`,
        ).run(
          nextStatus,
          runAfter,
          nextStatus === "dead" ? finishedAt : null,
          message,
          job.id,
          job.leaseToken,
        );
        if (result.changes !== 1) return false;
        recordReceiptInDatabase(this.db, {
          source: "scheduler",
          startedAt,
          finishedAt,
          summary: `${job.type} job failed.`,
          actions: {
            jobId: job.id,
            type: job.type,
            error: message,
            nextStatus,
          },
          retryCount: Math.max(0, job.attempts - 1),
          outcome: "failed",
          surfaceFailure: false,
        });
        recordReceiptInDatabase(this.db, {
          source: job.type,
          startedAt,
          finishedAt,
          summary: `${job.type} action failed: ${message}`,
          actions: {
            jobId: job.id,
            type: job.type,
            error: message,
            nextStatus,
          },
          retryCount: Math.max(0, job.attempts - 1),
          outcome: "failed",
          surfaceFailure: false,
        });
        recordFailureInDatabase(this.db, {
          source: "job",
          sourceId: job.id,
          message: `${job.type} job ${nextStatus === "dead" ? "stopped retrying" : "will retry"}: ${message}`,
          details: {
            jobId: job.id,
            type: job.type,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
          },
          occurredAt: finishedAt,
        });
        return true;
      })();
      if (!updated) return "lost";
      if (nextStatus === "dead") {
        notifyHardFailure({
          source: `job:${job.type}`,
          message: `${job.type} job exhausted its retries: ${message}`,
          details: { jobId: job.id, attempts: job.attempts },
        });
      }
      return nextStatus;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async runAvailable(options: {
    concurrency?: number;
    maxJobs?: number;
  } = {}): Promise<{
    claimed: number;
    done: number;
    failed: number;
    dead: number;
    recovered: number;
  }> {
    const concurrency = Math.min(2, Math.max(1, Math.trunc(options.concurrency ?? 1)));
    const maxJobs = Math.min(100, Math.max(1, Math.trunc(options.maxJobs ?? 25)));
    this.sweepRetention();
    const recovered = this.recoverExpiredLeases();
    const result = {
      claimed: 0,
      done: 0,
      failed: 0,
      dead: recovered.dead,
      recovered: recovered.recovered,
    };
    const worker = async () => {
      while (result.claimed < maxJobs) {
        let job: ClaimedJob | undefined;
        try {
          job = this.claimNext();
        } catch (error) {
          this.recordRunnerFailure(error);
          result.failed += 1;
          return;
        }
        if (!job) return;
        result.claimed += 1;
        let status: Awaited<ReturnType<JobScheduler["execute"]>>;
        try {
          status = await this.execute(job);
        } catch (error) {
          this.recordRunnerFailure(error, job);
          result.failed += 1;
          continue;
        }
        if (status === "done") result.done += 1;
        else if (status === "failed") result.failed += 1;
        else if (status === "dead") result.dead += 1;
      }
    };
    await Promise.allSettled(
      Array.from({ length: concurrency }, () => worker()),
    );
    return result;
  }

  async runJob(id: string): Promise<"done" | "failed" | "dead" | "lost" | "unavailable"> {
    this.recoverExpiredLeases();
    const job = this.claimById(id);
    if (!job) return "unavailable";
    try {
      return await this.execute(job);
    } catch (error) {
      this.recordRunnerFailure(error, job);
      return "failed";
    }
  }
}
