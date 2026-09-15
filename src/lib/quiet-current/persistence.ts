import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openLocalDatabase } from "../local/database";

function legacyBytes(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function fingerprint(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

function validateState(value: unknown): void {
  const invalid = () => { throw new Error("Quiet Current data has an unsupported shape. Restore or repair it before retrying."); };
  if (!value || typeof value !== "object") return invalid();
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.suggestions) || !Array.isArray(state.decisionEvents)) return invalid();
  for (const [key, entries] of [["suggestions", state.suggestions], ["decisionEvents", state.decisionEvents]] as const) {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) return invalid();
      ids.add(entry.id);
      if (typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt))) return invalid();
      if (key === "decisionEvents") {
        if (typeof entry.eventType !== "string") return invalid();
      } else {
        if (!["create_task", "returned_work", "observed_progress", "stale_task", "attention_nudge"].includes(entry.kind) ||
            !["proposed", "refined", "accepted", "deferred", "dismissed", "expired"].includes(entry.state) ||
            !["low", "medium", "high"].includes(entry.priority)) return invalid();
        for (const field of ["title", "description", "reason", "source"]) {
          if (typeof entry[field] !== "string") return invalid();
        }
        for (const field of ["updatedAt", "expiresAt"]) {
          if (typeof entry[field] !== "string" || !Number.isFinite(Date.parse(entry[field]))) return invalid();
        }
      }
    }
  }
}

/**
 * One state row preserves the existing bounded suggestion/event document.
 * BEGIN IMMEDIATE covers reading, lifecycle changes, deduplication and saving.
 * Keep the legacy file and an exact backup; changed legacy input means an old
 * process is still writing and must be reconciled, never silently re-imported.
 */
export function transactQuietCurrent<S, T>(
  database: string | Database.Database,
  file: string,
  empty: () => S,
  operation: (state: S, db: Database.Database) => T,
): T {
  const owned = typeof database === "string";
  const db = owned ? openLocalDatabase(database) : database;
  try {
    return db.transaction(() => {
      // Use the filename, not the absolute path, so database restores can move.
      const key = path.basename(file);
      const row = db.prepare("SELECT state_json, legacy_sha256 FROM cove_quiet_current WHERE store_key = ?")
        .get(key) as
          | { state_json: string; legacy_sha256: string | null } | undefined;
      const bytes = legacyBytes(file);
      const hash = fingerprint(bytes);
      // A database-only restore needs no legacy file. If one is present, it
      // must match the imported source; a stale writer cannot replace DB state.
      if (row && bytes !== null && row.legacy_sha256 !== hash) {
        throw new Error("Quiet Current's legacy file changed after migration. Stop older Cove processes and reconcile the saved JSON with the database before continuing.");
      }
      const state = (row ? JSON.parse(row.state_json) : bytes ? JSON.parse(bytes.toString("utf8")) : empty()) as S;
      validateState(state);
      if (!row && bytes) {
        const backup = `${file}.pre-sqlite-${hash}.bak`;
        try {
          writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (!readFileSync(backup).equals(bytes)) throw new Error("Quiet Current migration backup does not match the source.");
        }
      }
      const result = operation(state, db);
      const serialized = JSON.stringify(state);
      // Catch mixed-version writers during the operation as well as on entry.
      if (fingerprint(legacyBytes(file)) !== hash) throw new Error("Quiet Current's legacy file changed during migration. Stop older Cove processes and retry.");
      if (!row) {
        db.prepare("INSERT INTO cove_quiet_current (store_key, state_json, legacy_sha256, imported_at) VALUES (?, ?, ?, ?)")
          .run(key, serialized, hash, new Date().toISOString());
      } else if (serialized !== row.state_json) {
        db.prepare("UPDATE cove_quiet_current SET state_json = ? WHERE store_key = ?").run(serialized, key);
      }
      return result;
    }).immediate();
  } finally {
    if (owned) db.close();
  }
}
