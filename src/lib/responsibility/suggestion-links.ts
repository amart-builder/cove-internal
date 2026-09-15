import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Responsibility } from "./store";
import type { WorkSuggestion } from "../quiet-current/store";
import { sourceRecord, sourceVersion, activeResponsibilitySource } from "./store";

/** Check the assumptions saved with the proposal, not a reconciled observation. */
export function assertSuggestionSourceCurrent(db: Database.Database, suggestion: WorkSuggestion): void {
  if (!suggestion.reviewMaterial) return;
  let origin: {kind: Parameters<typeof sourceRecord>[1]; id: string; version: string} | undefined;
  try { origin = JSON.parse(suggestion.reviewMaterial).source; }
  catch { return; } // Returned-work review material may be ordinary prose.
  if (!origin) return;
  const current = sourceRecord(db, origin.kind, origin.id);
  if (!current || !activeResponsibilitySource(current) || sourceVersion(current) !== origin.version)
    throw new Error("The source for this proposal changed. Review it before accepting.");
}

/** Preserve the proposal's check through every existing acceptance entrypoint. */
export function relinkSuggestionResponsibility(
  db: Database.Database,
  suggestionId: string,
  taskId: string,
  now: Date,
): void {
  const prior = db
    .prepare(
      "SELECT * FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?",
    )
    .get(suggestionId) as Responsibility | undefined;
  if (!prior) return;
  if (prior.parent_kind && prior.parent_id) {
    const parent = sourceRecord(db, prior.parent_kind, prior.parent_id);
    if (!parent || !activeResponsibilitySource(parent) || sourceVersion(parent) !== prior.parent_version)
      throw new Error("The source for this proposal changed. Review it before accepting.");
  }
  const source = sourceRecord(db, "task", taskId);
  if (!source || !activeResponsibilitySource(source))
    throw new Error("The accepted task is unavailable.");
  // An existing task may already have a reconciliation row. The original
  // proposal check is the identity being carried forward, not another watch.
  db.prepare(
    "DELETE FROM cove_responsibilities WHERE ref_kind='task' AND ref_id=?",
  ).run(taskId);
  db.prepare(
    "UPDATE cove_responsibilities SET ref_kind='task',ref_id=?,source_version=?,owner='you',revision=revision+1,updated_at=? WHERE ref_kind='suggestion' AND ref_id=?",
  ).run(taskId, sourceVersion(source), now.toISOString(), suggestionId);
  db.prepare("INSERT INTO cove_responsibility_events VALUES(?,?,?,?,?,?)").run(
    randomUUID(),
    "task",
    taskId,
    "proposal_accepted",
    JSON.stringify({ suggestionId }),
    now.toISOString(),
  );
}
