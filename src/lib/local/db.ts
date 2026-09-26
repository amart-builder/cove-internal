/**
 * Local SQLite backend for Cove.
 *
 * This is the default data layer: everything lives in a single file
 * (data/cove.db by default), no account and no login required. The app's
 * data layer talks to `/api/cove-rest/[table]` using a small subset of
 * PostgREST query syntax; this module answers those same requests against
 * SQLite so the existing UI works unchanged.
 *
 * Only runs on the server (Node runtime). Never imported into client code.
 */
import type Database from "better-sqlite3";
import { taskEditMatches, TASK_EDIT_CONFLICT } from "../tasks/edit-conflict";
import { randomUUID } from "node:crypto";
import { COVE_REST_TABLES } from "../data/cove-tables";
import { operatorTimezone } from "../operator";
import { TASK_COLUMNS, taskColumnKeyForName } from "../tasks/columns";
import { syncRecurringOccurrenceForTask } from "../tasks/recurrence";
import { recordFailureInDatabase } from "../reliability/failures";
import { localDatabasePath, openLocalDatabase } from "./database";

export type RestResult = { status: number; body?: unknown };
export type LocalRestOptions = { stampTaskEngagement?: boolean };

/** Tables the app is allowed to read/write. Mirrors the Supabase proxy. */
const ALLOWED_TABLES = new Set<string>(COVE_REST_TABLES);

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

/** Default Kanban columns, shared with every board consumer. */
const DEFAULT_COLUMNS = TASK_COLUMNS.map(({ name, position }) => ({
  name,
  position,
}));

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

type CoveGlobal = {
  __coveDb?: Database.Database;
};
const databasePaths = new WeakMap<Database.Database, string>();

function getDb(): Database.Database {
  const g = globalThis as unknown as CoveGlobal;
  const file = localDatabasePath();
  if (g.__coveDb && databasePaths.get(g.__coveDb) === file) return g.__coveDb;
  if (g.__coveDb?.open) g.__coveDb.close();

  const conn = openLocalDatabase(file);
  seedDefaults(conn);
  g.__coveDb = conn;
  databasePaths.set(conn, file);
  return conn;
}

function nowIso(): string {
  return new Date().toISOString();
}

const NOTIFICATION_POLICIES = new Set(["none", "predeadline", "due", "both"]);
const RFC3339_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function offsetForInstant(value: string, timezone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(value)).find((entry) => entry.type === "timeZoneName")?.value;
  if (!part) throw new Error("Could not resolve the operator timezone offset.");
  const offset = part.replace(/^GMT/, "");
  return offset === "" || offset === "+00:00" ? "Z" : offset;
}

export function validateTaskTiming(row: Record<string, unknown>): void {
  if ("notification_policy" in row) {
    const policy = row.notification_policy;
    if (policy !== null && (typeof policy !== "string" || !NOTIFICATION_POLICIES.has(policy))) {
      throw new Error("notification_policy must be none, predeadline, due, both, or null.");
    }
  }
  if (!("remind_at" in row) || row.remind_at === null) return;
  if (typeof row.remind_at !== "string") {
    throw new Error("remind_at must be an RFC 3339 timestamp with the operator timezone offset.");
  }
  const match = RFC3339_WITH_OFFSET.exec(row.remind_at);
  const parsed = new Date(row.remind_at);
  if (!match || Number.isNaN(parsed.getTime())) {
    throw new Error("remind_at must be an RFC 3339 timestamp with the operator timezone offset.");
  }
  const supplied = match[1] === "+00:00" ? "Z" : match[1];
  if (supplied !== offsetForInstant(row.remind_at, operatorTimezone())) {
    throw new Error("remind_at must use the operator timezone offset for that date.");
  }
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

export function resolveLocalInboundEvent(input: {
  id: string;
  state: string;
  taskId: string | null;
  error: string | null;
  updatedAt: string;
}): Record<string, unknown> | undefined {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(
      `UPDATE inbound_events
       SET state = ?, task_id = ?, error = ?,
           attempts = attempts + 1, updated_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(
      input.state,
      input.taskId,
      input.error,
      input.updatedAt,
      input.id,
    ) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    // "triaged" with an error is the degraded capture: triage threw, so the raw
    // text became a plain card and the reason was recorded on the event. That
    // used to take the branch below and dismiss failures instead of raising
    // one, so a person who was told Cove would work out what their note was got
    // the note back verbatim with nothing anywhere saying why. A still-retrying
    // "pending" is not a failure yet, and "dismissed" is a decision, not one.
    const degraded = input.state === "triaged" && Boolean(input.error);
    if (input.state === "failed" || degraded) {
      recordFailureInDatabase(db, {
        source: "inbound-event",
        sourceId: input.id,
        // Neither message carries the thrown diagnostic. A parse error from a
        // model that answered in prose put its own reply on the person's
        // screen, and none of these strings tells them what happened to their
        // note. The raw error stays in details for whoever has to fix it.
        message: degraded
          ? `Cove saved your ${String(row.source ?? "inbound")} item but could not sort it out, so it is on your board as you wrote it. Open it to set the deadline and where it belongs.`
          : "Cove could not turn something you captured into a card, and has stopped trying. It is not on your board. Send it again, or ask your Cove setup agent to look into it.",
        details: {
          eventId: input.id,
          eventSource: row.source,
          attempts: row.attempts,
          error: input.error,
          ...(degraded ? { degraded: true, taskId: input.taskId } : {}),
        },
        occurredAt: input.updatedAt,
      });
    } else {
      db.prepare(
        `UPDATE cove_failure_inbox
         SET dismissed_at = ?
         WHERE source = 'inbound-event' AND source_id = ?
           AND dismissed_at IS NULL`,
      ).run(input.updatedAt, input.id);
    }
    return decodeRow("inbound_events", row);
  })();
}

const RESERVED = new Set(["select", "order", "limit", "offset"]);

/** Parse PostgREST-style filters (col=op.value) into a WHERE clause + args. */
function parseWhere(table: string, params: URLSearchParams): {
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
    } else if (op === "cs" && JSON_COLUMNS[table]?.includes(key)) {
      const inner = rest.replace(/^\{/, "").replace(/\}$/, "");
      const items = inner.length ? inner.split(",") : [];
      if (items.length) {
        where.push(items.map(
          () =>
            `EXISTS (SELECT 1 FROM json_each("${key}") WHERE json_each.value = ?)`,
        ).join(" AND "));
        args.push(...items);
      } else {
        where.push("0");
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
  const effectiveParams = new URLSearchParams(params);
  if (table === "tasks" && !effectiveParams.has("status")) {
    effectiveParams.set("status", "neq.archived");
  }

  let columns = "*";
  const select = effectiveParams.get("select");
  if (select && select !== "*") {
    const cols = select
      .split(",")
      .map((c) => c.trim())
      .filter((c) => IDENTIFIER.test(c));
    if (cols.length) columns = cols.map((c) => `"${c}"`).join(", ");
  }

  let orderBy = "";
  const order = effectiveParams.get("order");
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
  const limitRaw = effectiveParams.get("limit");
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (Number.isInteger(limit) && limit >= 0) tail += ` LIMIT ${limit}`;
  }
  const offsetRaw = effectiveParams.get("offset");
  if (offsetRaw !== null) {
    const offset = Number(offsetRaw);
    if (Number.isInteger(offset) && offset >= 0) tail += ` OFFSET ${offset}`;
  }

  const { clause, args } = parseWhere(table, effectiveParams);
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
      if (table === "tasks") validateTaskTiming(row);
      if (!row.id) row.id = randomUUID();
      if (row.created_at == null) row.created_at = now;
      if (row.updated_at == null) row.updated_at = now;

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
  options: LocalRestOptions = {},
): RestResult {
  const db = getDb();
  const { clause, args } = parseWhere(table, params);
  if (!clause) {
    return { status: 400, body: "Refusing to update without a filter." };
  }

  const requestedKeys = Object.keys(payload as Record<string, unknown>);
  const row = encodeRow(table, { ...(payload as Record<string, unknown>) });
  if (table === "tasks") validateTaskTiming(row);
  delete row.id; // never reassign the primary key
  row.updated_at = nowIso();
  return db.transaction(() => {
    // Capture the matched primary keys before mutating so the returned
    // representation has PostgREST RETURNING semantics even when a filtered
    // column changes.
    const matchedRows = db.prepare(`SELECT * FROM "${table}"${clause}`).all(...args) as
      Record<string, unknown>[];
    const expected = (payload as Record<string, unknown>)._expected;
    if (table === "tasks" && expected !== undefined && (matchedRows.length === 0 || matchedRows.some(matched => !taskEditMatches(matched, expected)))) {
      return { status: 409, body: TASK_EDIT_CONFLICT };
    }
    const matchedIds = matchedRows.map((matched) => matched.id);
    const known = tableColumns(table);
    let engagedIds: unknown[] = [];
    if (table === "tasks" && matchedIds.length > 0) {
      const operatorFields = ["title", "description", "status", "due_at", "due_date"];
      if (options.stampTaskEngagement !== false) {
        engagedIds = matchedRows
          .filter((matched) => operatorFields.some(
            (field) => known.has(field) && requestedKeys.includes(field) && matched[field] !== row[field],
          ))
          .map((matched) => matched.id);
      }
      // The due reminder is a one-shot: fireDueReminders only looks at rows
      // whose notified_at is still null, and stamps it as it claims each one.
      // The stamp means "the person has been told about this task's deadline",
      // so a deadline the person moves makes it false -- nobody has been told
      // about the new one. Without this, dragging an overdue card to a later
      // date silently retired its reminder: the card stayed on the board, the
      // new date arrived, and nothing rang. The sibling rule for remind_at and
      // nudged_at, immediately below, is the same re-arm for the pre-deadline
      // nudge and was written first.
      //
      // Instants, not strings: due_at has no canonical form. The board writes a
      // calendar date at UTC midnight while intake and the cove-task skill
      // write local ISO datetimes, so the same moment arrives spelled two ways.
      // remind_at can compare as a string only because validateTaskTiming
      // forces it into one exact shape.
      if (requestedKeys.includes("due_at") && typeof row.due_at === "string") {
        const moved = Date.parse(row.due_at);
        if (
          Number.isFinite(moved) &&
          matchedRows.some((matched) =>
            typeof matched.due_at !== "string" ||
            Date.parse(matched.due_at) !== moved
          )
        ) {
          row.notified_at = null;
        }
      }
      // Every reminder lane selects status = 'open'; the board reads column_id.
      // KanbanBoard adds the derived status to any patch that moves a column
      // (KanbanBoard.tsx:531), so a person dragging a card keeps the two in
      // step. Anyone sending "only the fields that need changing" -- which is
      // what skills/cove-task/SKILL.md tells the agent to do, and what the
      // Apple Reminders bridge does -- did not, and a card parked in Done went
      // on ringing its deadline at someone who had already finished it.
      //
      // An explicit status in the same patch always wins: a caller that says
      // what it means is not guessing. And an archived card stays archived,
      // because a column move is not a restore; the restore paths set status
      // themselves.
      if (
        requestedKeys.includes("column_id") &&
        !requestedKeys.includes("status") &&
        typeof row.column_id === "string" &&
        matchedRows.every((matched) => matched.status === "open" || matched.status === "done")
      ) {
        const columnName = db.prepare("SELECT name FROM task_columns WHERE id = ?")
          .pluck().get(row.column_id) as string | undefined;
        const key = taskColumnKeyForName(columnName);
        if (key) row.status = key === "done" ? "done" : "open";
      }
      if (
        requestedKeys.includes("remind_at") &&
        typeof row.remind_at === "string" &&
        new Date(row.remind_at).getTime() > Date.now()
      ) {
        const placeholders = matchedIds.map(() => "?").join(", ");
        const rescheduled = db.prepare(
          `SELECT 1 FROM tasks
           WHERE id IN (${placeholders})
             AND COALESCE(remind_at, '') <> ?
           LIMIT 1`,
        ).get(...matchedIds, row.remind_at);
        if (rescheduled) row.nudged_at = null;
      }
    }
    if (
      table === "tasks" &&
      row.status === "archived" &&
      row.archived_at === undefined
    ) {
      db.prepare(
        `UPDATE tasks
         SET archived_at = COALESCE(archived_at, ?),
             archived_from_status = COALESCE(archived_from_status, status)
         ${clause}`,
      ).run(row.updated_at, ...args);
    }
    const cols = Object.keys(row).filter((column) => known.has(column));
    if (cols.length) {
      const setSql = cols.map((column) => `"${column}" = ?`).join(", ");
      db.prepare(`UPDATE "${table}" SET ${setSql}${clause}`).run(
        ...cols.map((column) => row[column]),
        ...args,
      );
    }
    if (table === "tasks" && engagedIds.length > 0) {
      db.prepare(
        `UPDATE tasks SET engaged_at = ? WHERE id IN (${
          engagedIds.map(() => "?").join(", ")
        })`,
      ).run(row.updated_at, ...engagedIds);
    }
    // Metadata edits must not turn a deliberately paused occurrence into a miss.
    // Only an explicit lifecycle change reconciles recurrence status.
    if (table === "tasks" && matchedIds.length > 0 && requestedKeys.includes("status")) {
      const updatedAt = typeof row.updated_at === "string"
        ? row.updated_at
        : nowIso();
      const statusRows = db.prepare(
        `SELECT id, status FROM tasks WHERE id IN (${
          matchedIds.map(() => "?").join(", ")
        })`,
      ).all(...matchedIds) as Array<{ id: string; status: string | null }>;
      for (const statusRow of statusRows) {
        syncRecurringOccurrenceForTask(
          db,
          statusRow.id,
          statusRow.status,
          updatedAt,
        );
      }
    }
    if (matchedIds.length === 0) return { status: 200, body: [] };
    const placeholders = matchedIds.map(() => "?").join(", ");
    const rows = db
      .prepare(`SELECT * FROM "${table}" WHERE id IN (${placeholders})`)
      .all(...matchedIds) as Record<string, unknown>[];
    return { status: 200, body: rows.map((result) => decodeRow(table, result)) };
  }).immediate();
}

function deleteRows(table: string, params: URLSearchParams): RestResult {
  const db = getDb();
  const { clause, args } = parseWhere(table, params);
  if (!clause) {
    return { status: 400, body: "Refusing to delete without a filter." };
  }
  db.prepare(`DELETE FROM "${table}"${clause}`).run(...args);
  return { status: 204 };
}

/**
 * Answer a cove-rest request against the local database.
 * `table` is the unprefixed table name. Direct callers may pass raw JSON;
 * routes that already parsed a request may pass the decoded payload.
 */
export function handleLocalRest(
  table: string,
  method: string,
  params: URLSearchParams,
  body: string | Record<string, unknown> | unknown[] | undefined,
  options: LocalRestOptions = {},
): RestResult {
  if (!ALLOWED_TABLES.has(table)) {
    return { status: 404, body: "Unknown Cove table." };
  }

  switch (method) {
    case "GET":
      return selectRows(table, params);
    case "POST":
      return insertRows(
        table,
        typeof body === "string" ? (body ? JSON.parse(body) : {}) : body ?? {},
      );
    case "PATCH":
      return updateRows(
        table,
        params,
        typeof body === "string" ? (body ? JSON.parse(body) : {}) : body ?? {},
        options,
      );
    case "DELETE":
      return deleteRows(table, params);
    default:
      return { status: 405, body: "Method not allowed." };
  }
}
