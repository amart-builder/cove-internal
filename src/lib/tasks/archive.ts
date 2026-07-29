import { openLocalDatabase } from "../local/database";

export const ARCHIVE_RETENTION_DAYS = 30;

export function purgeArchivedTasks(input: {
  dbPath?: string;
  now?: Date;
  retentionDays?: number;
} = {}): { purged: number; cutoff: string } {
  const now = input.now ?? new Date();
  const retentionDays = Math.max(
    1,
    Math.trunc(input.retentionDays ?? ARCHIVE_RETENTION_DAYS),
  );
  const cutoff = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60_000,
  ).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    const result = db.prepare(
      `DELETE FROM tasks
       WHERE status = 'archived'
         AND COALESCE(archived_at, updated_at) < ?`,
    ).run(cutoff);
    return { purged: result.changes, cutoff };
  } finally {
    db.close();
  }
}
