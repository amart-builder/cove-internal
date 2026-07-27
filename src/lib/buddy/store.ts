import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BuddySpawnedSessionState } from "./spawned-session-state";

export { BUDDY_STALE_TURN_MS } from "./timing";

export type BuddyTurnState = "running" | "succeeded" | "failed";

export type BuddyTurn = {
  id: string;
  user_text: string;
  page_context: string;
  model: "sonnet" | "opus";
  effort: "low" | "medium" | "high";
  router_reason: string;
  state: BuddyTurnState;
  assistant_text: string;
  receipts_json: string | null;
  session_id: string | null;
  cost_usd: number;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
};

export type BuddyState = {
  headSessionId: string | null;
  createdAt: string;
  turnCount: number;
  totalCostUsd: number;
};

export type BuddySpawnedSession = {
  id: string;
  session_id: string;
  dir: string;
  title: string;
  state: BuddySpawnedSessionState;
  error: string | null;
  created_at: string;
};

const TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS buddy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  head_session_id TEXT,
  created_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS buddy_turns (
  id TEXT PRIMARY KEY,
  user_text TEXT NOT NULL,
  page_context TEXT NOT NULL,
  model TEXT NOT NULL CHECK (model IN ('sonnet','opus')),
  effort TEXT NOT NULL CHECK (effort IN ('low','medium','high')),
  router_reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','succeeded','failed')),
  assistant_text TEXT NOT NULL DEFAULT '',
  receipts_json TEXT,
  session_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS buddy_pending_deletes (
  token TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  label TEXT NOT NULL,
  consumed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS buddy_spawned_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  dir TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);`;

const INDEX_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS buddy_one_running_turn
  ON buddy_turns(state) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS buddy_turns_recent
  ON buddy_turns(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS buddy_spawned_session_id
  ON buddy_spawned_sessions(session_id);`;

const REQUIRED_COLUMNS = {
  buddy_state: {
    head_session_id: "TEXT",
    created_at: "TEXT NOT NULL DEFAULT ''",
    turn_count: "INTEGER NOT NULL DEFAULT 0",
    total_cost_usd: "REAL NOT NULL DEFAULT 0",
  },
  buddy_turns: {
    user_text: "TEXT NOT NULL DEFAULT ''",
    page_context: "TEXT NOT NULL DEFAULT 'null'",
    model: "TEXT NOT NULL DEFAULT 'sonnet'",
    effort: "TEXT NOT NULL DEFAULT 'medium'",
    router_reason: "TEXT NOT NULL DEFAULT 'Legacy turn'",
    state: "TEXT NOT NULL DEFAULT 'failed'",
    assistant_text: "TEXT NOT NULL DEFAULT ''",
    receipts_json: "TEXT",
    session_id: "TEXT",
    cost_usd: "REAL NOT NULL DEFAULT 0",
    error_code: "TEXT",
    started_at: "TEXT NOT NULL DEFAULT ''",
    finished_at: "TEXT",
  },
  buddy_spawned_sessions: {
    session_id: "TEXT NOT NULL DEFAULT ''",
    dir: "TEXT NOT NULL DEFAULT ''",
    title: "TEXT NOT NULL DEFAULT 'Buddy session'",
    state: "TEXT NOT NULL DEFAULT 'failed'",
    error: "TEXT",
    created_at: "TEXT NOT NULL DEFAULT ''",
  },
} as const;

function migrateRequiredColumns(db: Database.Database): void {
  for (const [table, definitions] of Object.entries(REQUIRED_COLUMNS)) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name));
    for (const [column, definition] of Object.entries(definitions)) {
      if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

type Clock = () => Date;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000);
const BUDDY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const BUDDY_MIN_RETAINED_TURNS = 500;

export function createBuddyStore(options: { dbPath: string; now?: Clock; processStartedAt?: Date }) {
  mkdirSync(path.dirname(options.dbPath), { recursive: true });
  const db = new Database(options.dbPath);
  const now = options.now ?? (() => new Date());
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(TABLE_SCHEMA);
  migrateRequiredColumns(db);
  db.exec(INDEX_SCHEMA);
  db.prepare(`INSERT OR IGNORE INTO buddy_state
    (id, head_session_id, created_at, turn_count, total_cost_usd)
    VALUES (1, NULL, ?, 0, 0)`).run(now().toISOString());

  const failRunningTurnsBefore = db.transaction((cutoff: string, errorCode: string) => {
    const result = db.prepare(`UPDATE buddy_turns SET state = 'failed', error_code = ?,
      finished_at = ? WHERE state = 'running' AND started_at < ?`)
      .run(errorCode, now().toISOString(), cutoff);
    if (result.changes) {
      db.prepare("UPDATE buddy_state SET turn_count = turn_count + ? WHERE id = 1")
        .run(result.changes);
    }
    return result.changes;
  });

  function recoverOrphanedTurns(): number {
    return failRunningTurnsBefore(
      (options.processStartedAt ?? PROCESS_STARTED_AT).toISOString(),
      "orphaned_on_restart",
    );
  }

  function sweepRetention(): { turns: number; pendingDeletes: number; spawnedSessions: number } {
    const cutoff = new Date(now().getTime() - BUDDY_RETENTION_MS).toISOString();
    return db.transaction(() => ({
      turns: db.prepare(`DELETE FROM buddy_turns
        WHERE started_at < ? AND id NOT IN (
          SELECT id FROM buddy_turns ORDER BY started_at DESC, id DESC LIMIT ?
        )`).run(cutoff, BUDDY_MIN_RETAINED_TURNS).changes,
      pendingDeletes: db.prepare("DELETE FROM buddy_pending_deletes WHERE expires_at < ?")
        .run(cutoff).changes,
      spawnedSessions: db.prepare("DELETE FROM buddy_spawned_sessions WHERE created_at < ?")
        .run(cutoff).changes,
    }))();
  }

  recoverOrphanedTurns();
  sweepRetention();

  const claimTransaction = db.transaction((input: {
    userText: string;
    pageContext: unknown;
    model: BuddyTurn["model"];
    effort: BuddyTurn["effort"];
    routerReason: string;
  }): BuddyTurn | null => {
    const running = db.prepare("SELECT 1 FROM buddy_turns WHERE state = 'running' LIMIT 1").get();
    if (running) return null;
    const id = randomUUID();
    const startedAt = now().toISOString();
    db.prepare(`INSERT INTO buddy_turns
      (id, user_text, page_context, model, effort, router_reason, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
      .run(id, input.userText, JSON.stringify(input.pageContext ?? null), input.model,
        input.effort, input.routerReason, startedAt);
    return db.prepare("SELECT * FROM buddy_turns WHERE id = ?").get(id) as BuddyTurn;
  });

  function claimTurn(input: {
    userText: string;
    pageContext: unknown;
    model: BuddyTurn["model"];
    effort: BuddyTurn["effort"];
    routerReason: string;
  }): BuddyTurn | null {
    try {
      return claimTransaction(input);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === "string" && (code.startsWith("SQLITE_CONSTRAINT") || code === "SQLITE_BUSY")) {
        return null;
      }
      throw error;
    }
  }

  function getBuddyState(): BuddyState {
    const row = db.prepare("SELECT * FROM buddy_state WHERE id = 1").get() as {
      head_session_id: string | null; created_at: string; turn_count: number; total_cost_usd: number;
    };
    return {
      headSessionId: row.head_session_id,
      createdAt: row.created_at,
      turnCount: row.turn_count,
      totalCostUsd: row.total_cost_usd,
    };
  }

  function setHeadSession(sessionId: string): void {
    db.prepare("UPDATE buddy_state SET head_session_id = ? WHERE id = 1").run(sessionId);
  }

  function resetBuddySession(): BuddyState | null {
    return db.transaction(() => {
      const running = db.prepare("SELECT 1 FROM buddy_turns WHERE state = 'running' LIMIT 1").get();
      if (running) return null;
      db.prepare(`
        UPDATE buddy_state
        SET head_session_id = NULL, created_at = ?, turn_count = 0, total_cost_usd = 0
        WHERE id = 1
      `)
        .run(now().toISOString());
      return getBuddyState();
    })();
  }

  type FinishResult = {
    state: Exclude<BuddyTurnState, "running">;
    assistant_text: string;
    session_id?: string | null;
    cost_usd?: number;
    error_code?: string | null;
    receipts_json?: string | null;
  };

  const transitionTurn = db.transaction((id: string, result: FinishResult, advanceHead: boolean) => {
      const current = db.prepare("SELECT * FROM buddy_turns WHERE id = ?").get(id) as BuddyTurn | undefined;
      if (!current || current.state !== "running") return current;
      const cost = result.cost_usd ?? 0;
      db.prepare(`UPDATE buddy_turns SET state = ?, assistant_text = ?, receipts_json = ?, session_id = ?,
        cost_usd = ?, error_code = ?, finished_at = ? WHERE id = ?`)
        .run(result.state, result.assistant_text, result.receipts_json ?? null, result.session_id ?? null, cost,
          result.error_code ?? null, now().toISOString(), id);
      db.prepare(`UPDATE buddy_state SET turn_count = turn_count + 1,
        total_cost_usd = total_cost_usd + ? WHERE id = 1`).run(cost);
      if (advanceHead && result.session_id) {
        db.prepare("UPDATE buddy_state SET head_session_id = ? WHERE id = 1")
          .run(result.session_id);
      }
      return db.prepare("SELECT * FROM buddy_turns WHERE id = ?").get(id) as BuddyTurn;
  });

  function finishTurn(id: string, result: FinishResult): BuddyTurn | undefined {
    return transitionTurn(id, result, false);
  }

  function completeTurn(id: string, result: FinishResult & { session_id: string }): BuddyTurn | undefined {
    return transitionTurn(id, result, true);
  }

  function sweepStaleTurns(olderThanMs: number): number {
    const cutoff = new Date(now().getTime() - olderThanMs).toISOString();
    return failRunningTurnsBefore(cutoff, "interrupted");
  }

  function mintPendingDelete(input: { table: string; rowId: string; label: string; ttlMs?: number }) {
    const token = randomUUID();
    const expiresAt = new Date(now().getTime() + (input.ttlMs ?? 10 * 60_000)).toISOString();
    db.prepare(`INSERT INTO buddy_pending_deletes
      (token, table_name, row_id, label, consumed_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(token, input.table, input.rowId, input.label, expiresAt);
    return { token, expiresAt };
  }

  const consumePendingDelete = db.transaction((input: { token: string; table: string; rowId: string }) => {
    const row = db.prepare("SELECT * FROM buddy_pending_deletes WHERE token = ?").get(input.token) as {
      table_name: string; row_id: string; consumed_at: string | null; expires_at: string;
    } | undefined;
    if (!row) return { ok: false as const, error: "not_found" as const };
    if (row.consumed_at) return { ok: false as const, error: "consumed" as const };
    if (new Date(row.expires_at).getTime() <= now().getTime()) {
      return { ok: false as const, error: "expired" as const };
    }
    if (row.table_name !== input.table || row.row_id !== input.rowId) {
      return { ok: false as const, error: "mismatch" as const };
    }
    const consumedAt = now().toISOString();
    const result = db.prepare(`UPDATE buddy_pending_deletes SET consumed_at = ?
      WHERE token = ? AND consumed_at IS NULL`).run(consumedAt, input.token);
    return result.changes === 1
      ? { ok: true as const, consumedAt }
      : { ok: false as const, error: "consumed" as const };
  });

  function setTurnReceipts(id: string, receiptsJson: string): boolean {
    return db.prepare("UPDATE buddy_turns SET receipts_json = ? WHERE id = ?")
      .run(receiptsJson, id).changes === 1;
  }

  function createSpawnedSession(input: {
    sessionId: string;
    dir: string;
    title: string;
  }): BuddySpawnedSession {
    const id = randomUUID();
    db.prepare(`INSERT INTO buddy_spawned_sessions
      (id, session_id, dir, title, state, error, created_at)
      VALUES (?, ?, ?, ?, 'seeding', NULL, ?)`).run(
      id,
      input.sessionId,
      input.dir,
      input.title,
      now().toISOString(),
    );
    return db.prepare("SELECT * FROM buddy_spawned_sessions WHERE id = ?")
      .get(id) as BuddySpawnedSession;
  }

  function finishSpawnedSession(
    sessionId: string,
    result: { state: "started" | "ready" | "incomplete" | "launch_failed"; error?: string | null },
  ): BuddySpawnedSession | undefined {
    const priorState = result.state === "started" || result.state === "launch_failed" ? "seeding" : "started";
    db.prepare(`UPDATE buddy_spawned_sessions SET state = ?, error = ?
      WHERE session_id = ? AND state = ?`).run(
      result.state,
      result.error?.slice(0, 2_000) ?? null,
      sessionId,
      priorState,
    );
    return db.prepare("SELECT * FROM buddy_spawned_sessions WHERE session_id = ?")
      .get(sessionId) as BuddySpawnedSession | undefined;
  }

  return {
    getBuddyState,
    setHeadSession,
    resetBuddySession,
    claimTurn,
    finishTurn,
    completeTurn,
    getTurn: (id: string) => db.prepare("SELECT * FROM buddy_turns WHERE id = ?").get(id) as BuddyTurn | undefined,
    getRunningTurn: () => db.prepare(
      "SELECT * FROM buddy_turns WHERE state = 'running' ORDER BY started_at LIMIT 1",
    ).get() as BuddyTurn | undefined,
    listRecentTurns: (limit = 50) => db.prepare(
      "SELECT * FROM buddy_turns ORDER BY started_at DESC, id DESC LIMIT ?",
    ).all(Math.max(1, Math.min(100, limit))) as BuddyTurn[],
    sweepStaleTurns,
    recoverOrphanedTurns,
    sweepRetention,
    mintPendingDelete,
    consumePendingDelete,
    setTurnReceipts,
    createSpawnedSession,
    finishSpawnedSession,
    getSpawnedSession: (sessionId: string) => db.prepare(
      "SELECT * FROM buddy_spawned_sessions WHERE session_id = ?",
    ).get(sessionId) as BuddySpawnedSession | undefined,
    close: () => { if (db.open) db.close(); },
  };
}

export type BuddyStore = ReturnType<typeof createBuddyStore>;
export const BUDDY_STORE_API_VERSION = 7;
type BuddyGlobal = {
  __forgeBuddyStore?: BuddyStore;
  __forgeBuddyStoreVersion?: number;
};

export function getBuddyStore(): BuddyStore {
  const global = globalThis as unknown as BuddyGlobal;
  const current = global.__forgeBuddyStore;
  const stale = current && (
    global.__forgeBuddyStoreVersion !== BUDDY_STORE_API_VERSION ||
    typeof current.completeTurn !== "function" || typeof current.consumePendingDelete !== "function" ||
    typeof current.createSpawnedSession !== "function"
  );
  if (stale) {
    if (!current.getRunningTurn?.()) current.close?.();
    global.__forgeBuddyStore = undefined;
  }
  if (!global.__forgeBuddyStore) {
    global.__forgeBuddyStore = createBuddyStore({
      dbPath: process.env.FORGE_DB_PATH ?? path.join(process.cwd(), "data", "forge.db"),
    });
    global.__forgeBuddyStoreVersion = BUDDY_STORE_API_VERSION;
  }
  return global.__forgeBuddyStore;
}
