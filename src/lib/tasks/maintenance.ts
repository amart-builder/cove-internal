import path from "node:path";
import { localDateInTimezone } from "../day-plan/brief";
import type { JobScheduler } from "../reliability/jobs";
import { operatorTimezone } from "../operator";
import { purgeArchivedTasks } from "./archive";
import { spawnRecurringTasks } from "./recurrence";
import { fileStaleTaskSuggestions } from "./stale";

export const TASK_JOB_TYPES = {
  recurrence: "recurring-task-spawn",
  stale: "stale-task-watchdog",
  archivePurge: "archived-task-purge",
} as const;

export function registerTaskMaintenanceHandlers(
  scheduler: JobScheduler,
  options: { dbPath: string; dataDir?: string },
): JobScheduler {
  scheduler.register(TASK_JOB_TYPES.recurrence, (job) => {
    const payload = job.payload as {
      requestedAt?: unknown;
      timezone?: unknown;
      localDate?: unknown;
    };
    const requestedAt = typeof payload?.requestedAt === "string"
      ? new Date(payload.requestedAt)
      : new Date();
    const now = Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt;
    const result = spawnRecurringTasks({
      dbPath: options.dbPath,
      now,
      timezone: typeof payload?.timezone === "string"
        ? payload.timezone
        : undefined,
      localDate: typeof payload?.localDate === "string"
        ? payload.localDate
        : undefined,
    });
    return {
      summary: `Recurring rhythm checked: ${result.spawned} spawned, ${result.missed} missed.`,
      actions: result,
    };
  });
  scheduler.register(TASK_JOB_TYPES.stale, (job) => {
    const requestedAt = typeof (job.payload as { requestedAt?: unknown })
      ?.requestedAt === "string"
      ? new Date((job.payload as { requestedAt: string }).requestedAt)
      : new Date();
    const result = fileStaleTaskSuggestions({
      dbPath: options.dbPath,
      dataDir: options.dataDir ?? path.dirname(options.dbPath),
      now: Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt,
    });
    return {
      summary: `Stale-task watchdog found ${result.stale.length} task${result.stale.length === 1 ? "" : "s"}.`,
      actions: {
        stale: result.stale.length,
        suggestionsFiled: result.suggested,
      },
    };
  });
  scheduler.register(TASK_JOB_TYPES.archivePurge, (job) => {
    const requestedAt = typeof (job.payload as { requestedAt?: unknown })
      ?.requestedAt === "string"
      ? new Date((job.payload as { requestedAt: string }).requestedAt)
      : new Date();
    const result = purgeArchivedTasks({
      dbPath: options.dbPath,
      now: Number.isNaN(requestedAt.getTime()) ? new Date() : requestedAt,
    });
    return {
      summary: `Archived-task retention purged ${result.purged} task${result.purged === 1 ? "" : "s"}.`,
      actions: result,
    };
  });
  return scheduler;
}

export function enqueueDailyTaskMaintenance(
  scheduler: JobScheduler,
  now = new Date(),
): void {
  const timezone = operatorTimezone();
  const localDate = localDateInTimezone(now, timezone);
  const payload = {
    requestedAt: now.toISOString(),
    timezone,
    localDate,
  };
  scheduler.enqueue({
    type: TASK_JOB_TYPES.recurrence,
    payload,
    priority: 90,
    maxAttempts: 5,
    idempotencyKey: `${TASK_JOB_TYPES.recurrence}:${localDate}`,
  });
  scheduler.enqueue({
    type: TASK_JOB_TYPES.stale,
    payload,
    priority: 30,
    maxAttempts: 5,
    idempotencyKey: `${TASK_JOB_TYPES.stale}:${localDate}`,
  });
  scheduler.enqueue({
    type: TASK_JOB_TYPES.archivePurge,
    payload,
    priority: 20,
    maxAttempts: 5,
    idempotencyKey: `${TASK_JOB_TYPES.archivePurge}:${localDate}`,
  });
}

export function runTaskMaintenanceCatchup(input: {
  dbPath?: string;
  dataDir?: string;
  now?: Date;
} = {}): {
  recurrence: ReturnType<typeof spawnRecurringTasks>;
  stale: ReturnType<typeof fileStaleTaskSuggestions>;
  archive: ReturnType<typeof purgeArchivedTasks>;
} {
  const now = input.now ?? new Date();
  return {
    recurrence: spawnRecurringTasks({ dbPath: input.dbPath, now }),
    stale: fileStaleTaskSuggestions({
      dbPath: input.dbPath,
      dataDir: input.dataDir,
      now,
    }),
    archive: purgeArchivedTasks({ dbPath: input.dbPath, now }),
  };
}

let scheduledCatchupLocalDate: string | undefined;

export function scheduleTaskMaintenanceCatchup(input: {
  dbPath?: string;
  dataDir?: string;
  now?: Date;
  defer?: (run: () => void) => void;
  onError?: (error: unknown) => void;
} = {}): boolean {
  const now = input.now ?? new Date();
  const localDate = localDateInTimezone(now, operatorTimezone());
  if (scheduledCatchupLocalDate === localDate) return false;
  scheduledCatchupLocalDate = localDate;
  const defer = input.defer ?? ((run: () => void) => setImmediate(run));
  defer(() => {
    try {
      runTaskMaintenanceCatchup({
        dbPath: input.dbPath,
        dataDir: input.dataDir,
        now,
      });
    } catch (error) {
      scheduledCatchupLocalDate = undefined;
      (input.onError ?? ((caught) =>
        console.error("Task maintenance catch-up failed on app open.", caught)))(
          error,
        );
    }
  });
  return true;
}

export function resetTaskMaintenanceScheduleForTests(): void {
  scheduledCatchupLocalDate = undefined;
}
