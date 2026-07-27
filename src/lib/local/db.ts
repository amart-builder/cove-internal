/**
 * Local SQLite backend for Forge.
 *
 * This is the default data layer: everything lives in a single file
 * (data/forge.db by default), no account and no login required. The app's
 * data layer talks to `/api/forge-rest/[table]` using a small subset of
 * PostgREST query syntax; this module answers those same requests against
 * SQLite so the existing UI works unchanged.
 *
 * Only runs on the server (Node runtime). Never imported into client code.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { FORGE_REST_TABLES } from "../data/forge-tables";

export type RestResult = { status: number; body?: unknown };

/** Tables the app is allowed to read/write. Mirrors the Supabase proxy. */
const ALLOWED_TABLES = new Set<string>(FORGE_REST_TABLES);

/** Columns stored as JSON text but exposed to the app as parsed values. */
const JSON_COLUMNS: Record<string, string[]> = {
  tasks: ["tags"],
  contacts: ["tags"],
  companies: ["tags"],
  email_items: ["source_payload"],
};

/** Columns stored as 0/1 but exposed to the app as booleans. */
const BOOLEAN_COLUMNS: Record<string, string[]> = {
  task_columns: ["is_default"],
  tasks: ["remind_native", "remind_text"],
  commitments: ["confirmed"],
};

/** Default Kanban columns, matching the canonical board in KanbanBoard.tsx. */
const DEFAULT_COLUMNS = [
  { name: "Not Started", position: 0 },
  { name: "Must happen today", position: 10 },
  { name: "In Flight / Waiting", position: 20 },
  { name: "Done", position: 30 },
];

/** Only allow plain identifiers as column/table names (no SQL injection). */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/** Filter operators we accept, mapped to SQL. */
const OPERATORS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "LIKE", // SQLite LIKE is already case-insensitive for ASCII
};

// Keep this schema in sync with src/lib/data/types.ts. There is no migration
// system; columns the app sends that don't exist here are silently dropped.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS task_columns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  column_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  priority TEXT DEFAULT 'medium',
  due_at TEXT,
  tags TEXT DEFAULT '[]',
  position INTEGER DEFAULT 0,
  status TEXT DEFAULT 'open',
  source_type TEXT DEFAULT 'manual',
  remind_native INTEGER DEFAULT 1,
  remind_text INTEGER DEFAULT 0,
  notified_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  industry TEXT,
  location TEXT,
  linkedin TEXT,
  description TEXT,
  tags TEXT DEFAULT '[]',
  notes TEXT DEFAULT '',
  last_interaction_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  linkedin TEXT,
  location TEXT,
  how_we_met TEXT,
  tier TEXT DEFAULT 'C',
  tags TEXT DEFAULT '[]',
  notes TEXT DEFAULT '',
  last_interaction_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS contact_activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  company_id TEXT,
  activity_type TEXT,
  title TEXT,
  content TEXT,
  direction TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS email_items (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  company_id TEXT,
  message_id TEXT,
  thread_id TEXT,
  classification TEXT,
  status TEXT DEFAULT 'pending',
  sender_name TEXT,
  sender_email TEXT,
  subject TEXT,
  body_excerpt TEXT,
  summary TEXT,
  context TEXT,
  source_payload TEXT,
  recommended_action TEXT,
  priority INTEGER DEFAULT 0,
  received_at TEXT,
  account_email TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  email_item_id TEXT,
  subject TEXT,
  body TEXT DEFAULT '',
  status TEXT DEFAULT 'needs_review',
  voice_version TEXT,
  humanizer_version TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS email_action_log (
  id TEXT PRIMARY KEY,
  email_item_id TEXT,
  action_type TEXT,
  description TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS email_triage_runs (
  id TEXT PRIMARY KEY,
  summary TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('follow_up','promise','waiting_on','open_decision','overnight_request','idea')),
  title TEXT NOT NULL,
  details TEXT,
  counterparty TEXT,
  contact_id TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('brain_dump','manual','chat','detector','brief')),
  source_quote TEXT,
  source_ref TEXT,
  due_at TEXT,
  review_at TEXT,
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high','medium','low')),
  confirmed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped','expired')),
  evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commitments_status_due_at_idx
  ON commitments(status, due_at);
CREATE INDEX IF NOT EXISTS commitments_status_review_at_idx
  ON commitments(status, review_at);
`;

type ForgeGlobal = { __forgeDb?: Database.Database };

function dbPath(): string {
  return (
    process.env.FORGE_DB_PATH || path.join(process.cwd(), "data", "forge.db")
  );
}

function getDb(): Database.Database {
  const g = globalThis as unknown as ForgeGlobal;
  if (g.__forgeDb) return g.__forgeDb;

  const file = dbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
  conn.exec(SCHEMA);
  migrate(conn);
  seedDefaults(conn);
  g.__forgeDb = conn;
  return conn;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Add columns introduced after a database may already exist. Idempotent. */
function migrate(conn: Database.Database): void {
  const cols = new Set(
    (conn.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!cols.has("remind_native"))
    conn.exec("ALTER TABLE tasks ADD COLUMN remind_native INTEGER DEFAULT 1");
  if (!cols.has("remind_text"))
    conn.exec("ALTER TABLE tasks ADD COLUMN remind_text INTEGER DEFAULT 0");
  if (!cols.has("notified_at"))
    conn.exec("ALTER TABLE tasks ADD COLUMN notified_at TEXT");

  const commitmentCols = new Set(
    (conn.prepare("PRAGMA table_info(commitments)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  if (!commitmentCols.has("confirmed"))
    conn.exec("ALTER TABLE commitments ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0");
}

function seedDefaults(conn: Database.Database): void {
  const row = conn.prepare("SELECT COUNT(*) AS n FROM task_columns").get() as {
    n: number;
  };
  if (row.n > 0) return;

  const insert = conn.prepare(
    "INSERT INTO task_columns (id, name, position, is_default, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
  );
  const now = nowIso();
  const tx = conn.transaction(() => {
    for (const col of DEFAULT_COLUMNS) {
      insert.run(randomUUID(), col.name, col.position, now, now);
    }
  });
  tx();
}

/** Columns that actually exist on a table, cached after first lookup. */
const columnCache: Record<string, Set<string>> = {};
function tableColumns(table: string): Set<string> {
  if (columnCache[table]) return columnCache[table];
  const info = getDb()
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as { name: string }[];
  const set = new Set(info.map((c) => c.name));
  columnCache[table] = set;
  return set;
}

/** Encode app values into what SQLite stores (JSON arrays/objects -> text, booleans -> 0/1). */
function encodeRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...row };
  for (const col of JSON_COLUMNS[table] ?? []) {
    if (col in out && out[col] !== null && typeof out[col] !== "string") {
      out[col] = JSON.stringify(out[col]);
    }
  }
  for (const col of BOOLEAN_COLUMNS[table] ?? []) {
    if (col in out && typeof out[col] === "boolean") {
      out[col] = out[col] ? 1 : 0;
    }
  }
  return out;
}

/** Decode SQLite values back into what the app expects. */
function decodeRow(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...row };
  for (const col of JSON_COLUMNS[table] ?? []) {
    if (typeof out[col] === "string") {
      try {
        out[col] = JSON.parse(out[col] as string);
      } catch {
        // Leave malformed JSON as the raw string.
      }
    }
  }
  for (const col of BOOLEAN_COLUMNS[table] ?? []) {
    if (typeof out[col] === "number") out[col] = out[col] === 1;
  }
  return out;
}

const RESERVED = new Set(["select", "order", "limit", "offset"]);

/** Parse PostgREST-style filters (col=op.value) into a WHERE clause + args. */
function parseWhere(params: URLSearchParams): {
  clause: string;
  args: unknown[];
} {
  const where: string[] = [];
  const args: unknown[] = [];

  for (const [key, value] of params.entries()) {
    if (RESERVED.has(key)) continue;
    if (!IDENTIFIER.test(key)) continue;

    const dot = value.indexOf(".");
    const op = dot >= 0 ? value.slice(0, dot) : "eq";
    const rest = dot >= 0 ? value.slice(dot + 1) : value;

    if (op === "is") {
      where.push(rest === "null" ? `"${key}" IS NULL` : `"${key}" IS NOT NULL`);
    } else if (op === "in") {
      const inner = rest.replace(/^\(/, "").replace(/\)$/, "");
      const items = inner.length ? inner.split(",") : [];
      if (items.length) {
        where.push(`"${key}" IN (${items.map(() => "?").join(", ")})`);
        args.push(...items);
      } else {
        where.push("0"); // empty IN matches nothing
      }
    } else if (OPERATORS[op]) {
      where.push(`"${key}" ${OPERATORS[op]} ?`);
      // PostgREST uses * as the wildcard for like/ilike; SQLite LIKE uses %.
      args.push(
        op === "like" || op === "ilike" ? rest.replace(/\*/g, "%") : rest,
      );
    }
  }

  return { clause: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
}

function selectRows(table: string, params: URLSearchParams): RestResult {
  const db = getDb();

  let columns = "*";
  const select = params.get("select");
  if (select && select !== "*") {
    const cols = select
      .split(",")
      .map((c) => c.trim())
      .filter((c) => IDENTIFIER.test(c));
    if (cols.length) columns = cols.map((c) => `"${c}"`).join(", ");
  }

  let orderBy = "";
  const order = params.get("order");
  if (order) {
    const clauses: string[] = [];
    for (const part of order.split(",").map((p) => p.trim()).filter(Boolean)) {
      const [col, dir, nulls] = part.split(".");
      if (!IDENTIFIER.test(col)) continue;
      let clause = `"${col}" ${dir === "desc" ? "DESC" : "ASC"}`;
      if (nulls === "nullslast") clause += " NULLS LAST";
      else if (nulls === "nullsfirst") clause += " NULLS FIRST";
      clauses.push(clause);
    }
    if (clauses.length) orderBy = ` ORDER BY ${clauses.join(", ")}`;
  }

  let tail = "";
  const limitRaw = params.get("limit");
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (Number.isInteger(limit) && limit >= 0) tail += ` LIMIT ${limit}`;
  }
  const offsetRaw = params.get("offset");
  if (offsetRaw !== null) {
    const offset = Number(offsetRaw);
    if (Number.isInteger(offset) && offset >= 0) tail += ` OFFSET ${offset}`;
  }

  const { clause, args } = parseWhere(params);
  const sql = `SELECT ${columns} FROM "${table}"${clause}${orderBy}${tail}`;
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  return { status: 200, body: rows.map((r) => decodeRow(table, r)) };
}

function insertRows(table: string, payload: unknown): RestResult {
  const db = getDb();
  const rows = Array.isArray(payload) ? payload : [payload];
  const known = tableColumns(table);
  const now = nowIso();
  const out: Record<string, unknown>[] = [];

  const tx = db.transaction(() => {
    for (const raw of rows) {
      const row = encodeRow(table, { ...(raw as Record<string, unknown>) });
      if (!row.id) row.id = randomUUID();
      if (row.created_at == null) row.created_at = now;
      row.updated_at = now;

      const cols = Object.keys(row).filter((c) => known.has(c));
      const sql = `INSERT INTO "${table}" (${cols
        .map((c) => `"${c}"`)
        .join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      db.prepare(sql).run(...cols.map((c) => row[c]));

      const inserted = db
        .prepare(`SELECT * FROM "${table}" WHERE id = ?`)
        .get(row.id) as Record<string, unknown>;
      out.push(decodeRow(table, inserted));
    }
  });
  tx();

  return { status: 201, body: out };
}

function updateRows(
  table: string,
  params: URLSearchParams,
  payload: unknown,
): RestResult {
  const db = getDb();
  const { clause, args } = parseWhere(params);
  if (!clause) {
    return { status: 400, body: "Refusing to update without a filter." };
  }

  // Capture the matched primary keys before mutating so the returned
  // representation is the rows this update actually changed, even when the
  // update rewrites a column the filter tested (PostgREST RETURNING semantics).
  // Re-selecting with the same clause after the update would drop exactly those
  // rows, which breaks compare-and-swap callers that filter on the value they
  // are about to overwrite.
  const matchedIds = (
    db.prepare(`SELECT id FROM "${table}"${clause}`).all(...args) as {
      id: unknown;
    }[]
  ).map((r) => r.id);

  const row = encodeRow(table, { ...(payload as Record<string, unknown>) });
  delete row.id; // never reassign the primary key
  row.updated_at = nowIso();

  const known = tableColumns(table);
  const cols = Object.keys(row).filter((c) => known.has(c));
  if (cols.length) {
    const setSql = cols.map((c) => `"${c}" = ?`).join(", ");
    db.prepare(`UPDATE "${table}" SET ${setSql}${clause}`).run(
      ...cols.map((c) => row[c]),
      ...args,
    );
  }

  if (matchedIds.length === 0) return { status: 200, body: [] };
  const placeholders = matchedIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM "${table}" WHERE id IN (${placeholders})`)
    .all(...matchedIds) as Record<string, unknown>[];
  return { status: 200, body: rows.map((r) => decodeRow(table, r)) };
}

function deleteRows(table: string, params: URLSearchParams): RestResult {
  const db = getDb();
  const { clause, args } = parseWhere(params);
  if (!clause) {
    return { status: 400, body: "Refusing to delete without a filter." };
  }
  db.prepare(`DELETE FROM "${table}"${clause}`).run(...args);
  return { status: 204 };
}

/**
 * Answer a forge-rest request against the local database.
 * `table` is the unprefixed table name; `body` is the raw request body text.
 */
export function handleLocalRest(
  table: string,
  method: string,
  params: URLSearchParams,
  body: string | undefined,
): RestResult {
  if (!ALLOWED_TABLES.has(table)) {
    return { status: 404, body: "Unknown Forge table." };
  }

  switch (method) {
    case "GET":
      return selectRows(table, params);
    case "POST":
      return insertRows(table, body ? JSON.parse(body) : {});
    case "PATCH":
      return updateRows(table, params, body ? JSON.parse(body) : {});
    case "DELETE":
      return deleteRows(table, params);
    default:
      return { status: 405, body: "Method not allowed." };
  }
}
