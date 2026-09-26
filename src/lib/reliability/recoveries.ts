import type Database from "better-sqlite3";

/** Recover service warnings from durable success evidence; keep job history. */
export function reconcileRecoveredFailures(db: Database.Database, now = new Date()) {
  db.prepare(`UPDATE cove_failure_inbox SET dismissed_at=?
    WHERE dismissed_at IS NULL AND source='job' AND source_id IN (
      SELECT old.id FROM cove_jobs old WHERE old.type='chief-of-staff-wake'
      AND CASE WHEN json_valid(old.payload) THEN json_extract(old.payload,'$.reason') END IN ('sweep','follow_through','nightly')
      AND CASE WHEN json_valid(old.payload) THEN json_extract(old.payload,'$.payload') END='{}'
      AND CASE WHEN json_valid(old.payload) THEN json_extract(old.payload,'$.note') END IS NULL
      AND EXISTS (SELECT 1 FROM cove_jobs newer WHERE newer.type=old.type
        AND newer.status='done' AND newer.created_at>=old.created_at
        AND NOT EXISTS (SELECT 1 FROM chief_of_staff_actions action
          WHERE action.wake_job_id=newer.id AND action.status='rejected')
        AND CASE WHEN json_valid(newer.payload) THEN json_extract(newer.payload,'$.reason') END=json_extract(old.payload,'$.reason')
        AND CASE WHEN json_valid(newer.payload) THEN json_extract(newer.payload,'$.payload') END='{}'
        AND newer.finished_at>cove_failure_inbox.occurred_at))`)
    .run(now.toISOString());
  // Backup and the service check are whole-system periodic runs: each one
  // starts fresh and supersedes the last, so a later success is durable
  // evidence that the earlier failure no longer describes anything. The email
  // and Gmail job types are deliberately absent. Each of those is one message,
  // so another message succeeding says nothing about this one.
  db.prepare(`UPDATE cove_failure_inbox SET dismissed_at=?
    WHERE dismissed_at IS NULL AND source='job' AND source_id IN (
      SELECT old.id FROM cove_jobs old
      WHERE old.type IN ('backup','health-collector')
      AND EXISTS (SELECT 1 FROM cove_jobs newer
        WHERE newer.type=old.type AND newer.status='done' AND newer.id<>old.id
        AND newer.finished_at>cove_failure_inbox.occurred_at))`)
    .run(now.toISOString());
  // A signed-out provider is a fact about the Mac, not about the piece of work
  // that happened to hit it: every lane fails the same way until somebody signs
  // in, and the moment one succeeds the sign-in is back. That is why any later
  // success clears these, where the email job types just above are deliberately
  // left out -- there, another message succeeding says nothing about this one.
  // Without this the row would outlive the condition and have to be dismissed
  // by hand, which is the same defect as the backup warning that used to sit in
  // Issues after the backup started working again.
  db.prepare(`UPDATE cove_failure_inbox SET dismissed_at=?
    WHERE dismissed_at IS NULL AND source='job'
      AND CASE WHEN json_valid(details_json)
        THEN json_extract(details_json,'$.error') END IN ('Codex is signed out.','Claude is signed out.')
      AND EXISTS (SELECT 1 FROM cove_jobs newer
        WHERE newer.status='done' AND newer.finished_at>cove_failure_inbox.occurred_at)`)
    .run(now.toISOString());
  db.prepare(`UPDATE cove_failure_inbox SET dismissed_at=?
    WHERE dismissed_at IS NULL AND source='meeting-analysis-degraded'
      AND source_id IN (SELECT id FROM meeting_analysis_jobs WHERE status='succeeded')`)
    .run(now.toISOString());
  // Older aggregate watcher receipts did not identify the individual job.
  // Resolve only this exact failure shape, once no failed/dead analysis remains.
  const analysisProblem = db.prepare("SELECT 1 FROM meeting_analysis_jobs WHERE status<>'succeeded' LIMIT 1").get();
  if (!analysisProblem) {
    const failures = db.prepare(`SELECT id,message,occurred_at FROM cove_failure_inbox
      WHERE dismissed_at IS NULL AND source='receipt' AND source_id='meeting-watch:meeting-watch-run'`)
      .all() as Array<{ id: string; message: string; occurred_at: string }>;
    for (const failure of failures) {
      if (/^Meeting analysis jobs failed=\d+ dead=\d+\.$/.test(failure.message) &&
          db.prepare("SELECT 1 FROM meeting_analysis_jobs WHERE status='succeeded' AND updated_at>? LIMIT 1").get(failure.occurred_at)) {
        db.prepare("UPDATE cove_failure_inbox SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL")
          .run(now.toISOString(), failure.id);
      }
    }
  }
}
