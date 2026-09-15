import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

// These are planning and review metadata for existing records, never a second
// task store. Source completion and deadlines remain owned by their source.
export const RESPONSIBILITY_SCHEMA = `
CREATE TABLE cove_responsibilities (
 ref_kind TEXT NOT NULL CHECK(ref_kind IN ('task','commitment')), ref_id TEXT NOT NULL,
 original_due_at TEXT, source_version TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','waiting','blocked','deferred','resolved')),
 owner TEXT NOT NULL DEFAULT 'you', next_action TEXT NOT NULL,
 next_check_at TEXT NOT NULL, planned_for TEXT, estimate_minutes INTEGER,
 blocker TEXT, goal TEXT, completion_criterion TEXT,
 last_reviewed_at TEXT, acknowledged_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(ref_kind,ref_id)
);
CREATE INDEX cove_responsibilities_check ON cove_responsibilities(state,next_check_at);
CREATE TABLE cove_responsibility_events (
 id TEXT PRIMARY KEY, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL,
 kind TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE cove_preparations (
 id TEXT PRIMARY KEY, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL,
 source_version TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
 created_at TEXT NOT NULL
);`;

export type RefKind = "task" | "commitment" | "suggestion" | "calendar";
type Source = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  updated_at: string | null;
  created_at: string | null;
  description?: string;
  details?: string;
  priority?: string;
  tags?: string;
  archived_at?: string | null;
  kind?: string;
  review_at?: string | null;
  source_ref?: string;
  source_quote?: string;
  confirmed?: number;
  confidence?: string;
  counterparty?: string;
};
export type Responsibility = {
  parent_kind?: RefKind | null;
  parent_id?: string | null;
  parent_version?: string | null;
  ref_kind: RefKind;
  ref_id: string;
  original_due_at: string | null;
  source_version: string;
  state: "ready" | "waiting" | "blocked" | "deferred" | "resolved";
  owner: string;
  next_action: string;
  next_check_at: string;
  planned_for: string | null;
  estimate_minutes: number | null;
  blocker: string | null;
  goal: string | null;
  completion_criterion: string | null;
  last_reviewed_at: string | null;
  acknowledged_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  title: string;
  due_at: string | null;
  priority: string;
  description: string;
  source_created_at: string;
  source_ref: string | null;
  source_quote: string | null;
  needs_confirmation: boolean;
};

export function sourceRecord(
  db: Database.Database,
  kind: RefKind,
  id: string,
): Source | undefined {
  if (kind === "calendar") {
    const row = db
      .prepare("SELECT * FROM cove_calendar_occurrences WHERE id=?")
      .get(id) as
      | {
          id: string;
          title: string;
          status: string;
          start_at: string;
          updated_at: string;
          observed_at: string;
          source_json: string;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          title: row.title,
          status: row.status === "cancelled" ? "cancelled" : "open",
          due_at: row.start_at,
          updated_at: row.updated_at,
          created_at: row.updated_at,
          description: row.source_json,
        }
      : undefined;
  }
  if (kind === "suggestion") {
    const rows = db
      .prepare("SELECT state_json FROM cove_quiet_current")
      .all() as { state_json: string }[];
    for (const row of rows) {
      const suggestion = (
        JSON.parse(row.state_json).suggestions as Array<{
          id: string;
          title: string;
          description: string;
          state: string;
          createdAt: string;
          updatedAt: string;
          expiresAt: string;
          reviewMaterial?: string;
        }>
      ).find((s) => s.id === id);
      if (suggestion) {
        let linkedState = "open";
        let linkVersion = "";
        if (suggestion.reviewMaterial) {
          try {
            const origin = JSON.parse(suggestion.reviewMaterial).source;
            if (origin && origin.kind !== "suggestion") {
              const linked = sourceRecord(db, origin.kind, origin.id);
              linkVersion = linked ? sourceVersion(linked) : "missing";
              if (!linked || !activeResponsibilitySource(linked))
                linkedState = "cancelled";
              else if (linkVersion !== origin.version) linkedState = "open";
            }
          } catch {
            linkedState = "changed";
          }
        }
        return {
          id,
          title: suggestion.title,
          description: suggestion.description,
          status: ["proposed", "refined", "deferred"].includes(suggestion.state)
            ? linkedState
            : suggestion.state,
          due_at: null,
          created_at: suggestion.createdAt,
          updated_at: suggestion.updatedAt,
          details: linkVersion,
        };
      }
    }
    return undefined;
  }
  if (kind !== "task" && kind !== "commitment")
    throw new Error("Unknown responsibility source.");
  return db
    .prepare(
      `SELECT * FROM ${kind === "task" ? "tasks" : "commitments"} WHERE id=?`,
    )
    .get(id) as Source | undefined;
}
export function sourceVersion(source: Source): string {
  // Short, namespaced digest survives model secret scrubbing while protecting
  // semantic source fields, including same-timestamp edits and completion.
  // Viewing work or delivering a reminder does not change the work to review.
  const semantic = Object.fromEntries(Object.entries(source).filter(([key]) =>
    !["engaged_at", "notified_at", "nudged_at"].includes(key),
  ));
  return `v:${createHash("sha256").update(JSON.stringify(semantic)).digest("hex").slice(0, 24)}`;
}
export function activeResponsibilitySource(source: Source) {
  return (
    source.status === "open" && !source.archived_at && source.kind !== "idea"
  );
}
function event(
  db: Database.Database,
  kind: RefKind,
  id: string,
  name: string,
  details: unknown,
  now: Date,
) {
  db.prepare("INSERT INTO cove_responsibility_events VALUES(?,?,?,?,?,?)").run(
    randomUUID(),
    kind,
    id,
    name,
    JSON.stringify(details),
    now.toISOString(),
  );
}
function defaultCheck(source: Source, now: Date): string {
  const proposed = source.review_at && Date.parse(source.review_at);
  return proposed && Number.isFinite(proposed) && proposed > +now
    ? boundedCheck(
        source,
        new Date(Math.min(proposed, +now + 7 * 86400000)),
        now,
      ).toISOString()
    : now.toISOString();
}
function boundedCheck(source: Source, check: Date, now: Date): Date {
  // A bare date is deliberately conservative: reviewing the preceding day
  // avoids inventing a due time or letting a later review conceal the deadline.
  const due = source.due_at ? Date.parse(source.due_at) : NaN;
  if (!Number.isFinite(due)) return check;
  const before = due - (source.due_at!.includes("T") ? 3600000 : 86400000);
  return new Date(
    Math.min(
      +check,
      before > +now
        ? before
        : due > +now
          ? Math.min(due, +now + 15 * 60000)
          : +now + 24 * 3600000,
    ),
  );
}

/** Reconcile every active source before selecting a bounded model view. */
export function reconcileResponsibilities(
  db: Database.Database,
  now = new Date(),
): void {
  db.transaction(() => {
    for (const kind of ["task", "commitment"] as const) {
      const rows = db
        .prepare(
          `SELECT * FROM ${kind === "task" ? "tasks" : "commitments"} WHERE status='open' ${kind === "task" ? "AND archived_at IS NULL" : "AND kind <> 'idea'"}`,
        )
        .all() as Source[];
      for (const source of rows) {
        const version = sourceVersion(source);
        const prior = db
          .prepare(
            "SELECT * FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?",
          )
          .get(kind, source.id) as Responsibility | undefined;
        if (!prior) {
          const waiting = source.kind === "waiting_on";
          db.prepare(
            `INSERT INTO cove_responsibilities(ref_kind,ref_id,original_due_at,source_version,state,owner,next_action,next_check_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            kind,
            source.id,
            source.due_at,
            version,
            waiting ? "waiting" : "ready",
            waiting ? source.counterparty || "waiting" : "you",
            waiting
              ? "Check for the expected response."
              : source.title,
            defaultCheck(source, now),
            now.toISOString(),
            now.toISOString(),
          );
          event(db, kind, source.id, "captured", { dueAt: source.due_at }, now);
        } else if (
          prior.source_version !== version ||
          prior.state === "resolved"
        ) {
          db.prepare(
            `UPDATE cove_responsibilities SET source_version=?, state='blocked',
       next_check_at=?, last_reviewed_at=NULL, revision=revision+1, updated_at=? WHERE ref_kind=? AND ref_id=?`,
          ).run(version, now.toISOString(), now.toISOString(), kind, source.id);
          event(
            db,
            kind,
            source.id,
            "source_changed",
            { dueAt: source.due_at, previousVersion: prior.source_version },
            now,
          );
        }
      }
    }
    const open = db
      .prepare(
        "SELECT ref_kind,ref_id FROM cove_responsibilities WHERE state <> 'resolved'",
      )
      .all() as Array<{ ref_kind: RefKind; ref_id: string }>;
    for (const ref of open) {
      const source = sourceRecord(db, ref.ref_kind, ref.ref_id);
      if (source && activeResponsibilitySource(source)) {
        const prior = db
          .prepare(
            "SELECT * FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?",
          )
          .get(ref.ref_kind, ref.ref_id) as Responsibility;
        const parent =
          prior.parent_kind && prior.parent_id
            ? sourceRecord(db, prior.parent_kind, prior.parent_id)
            : undefined;
        const parentChanged = Boolean(
          prior.parent_kind &&
          ((parent ? sourceVersion(parent) : "missing") !== prior.parent_version),
        );
        if (
          prior.source_version !== sourceVersion(source) ||
          parentChanged
        )
          db.prepare(
            "UPDATE cove_responsibilities SET source_version=?,state=?,next_check_at=?,last_reviewed_at=NULL,revision=revision+1,updated_at=?,parent_version=? WHERE ref_kind=? AND ref_id=?",
          ).run(
            sourceVersion(source),
            parentChanged || prior.source_version !== sourceVersion(source) ? "blocked" : prior.state,
            now.toISOString(),
            now.toISOString(),
            prior.parent_kind ? (parent ? sourceVersion(parent) : "missing") : null,
            ref.ref_kind,
            ref.ref_id,
          );
        continue;
      }
      db.prepare(
        "UPDATE cove_responsibilities SET state='resolved',revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=?",
      ).run(now.toISOString(), ref.ref_kind, ref.ref_id);
      event(
        db,
        ref.ref_kind,
        ref.ref_id,
        "source_resolved",
        { status: source?.status ?? "removed" },
        now,
      );
    }
  }).immediate();
}

export function listResponsibilities(db: Database.Database): Responsibility[] {
  const rows = db
    .prepare(
      "SELECT * FROM cove_responsibilities WHERE state <> 'resolved' ORDER BY next_check_at,ref_kind,ref_id",
    )
    .all() as Responsibility[];
  return rows.flatMap((row) => {
    const source = sourceRecord(db, row.ref_kind, row.ref_id);
    if (!source || !activeResponsibilitySource(source)) return [];
    return [
      {
        ...row,
        source_version: sourceVersion(source),
        title: source.title,
        due_at: source.due_at,
        source_created_at: source.created_at || row.created_at,
        description: source.description || source.details || "",
        priority: source.priority || "medium",
        source_ref: source.source_ref || null,
        source_quote: source.source_quote || null,
        needs_confirmation: row.ref_kind === "commitment" && !source.confirmed,
      },
    ];
  });
}

/** Separate reserved categories stop long backlogs crowding out new work. */
export function selectResponsibilities(
  rows: Responsibility[],
  now: Date,
  maximum = 24,
): Responsibility[] {
  const due = rows.filter((r) => Date.parse(r.next_check_at) <= +now);
  const byOldest = [...due].sort(
    (a, b) =>
      (a.last_reviewed_at || "").localeCompare(b.last_reviewed_at || "") ||
      a.next_check_at.localeCompare(b.next_check_at),
  );
  const groups = [
    due
      .filter((r) => !r.last_reviewed_at)
      .sort((a, b) => b.source_created_at.localeCompare(a.source_created_at)),
    due
      .filter(
        (r) =>
          r.due_at &&
          Date.parse(r.due_at) >= +now - 86400000 &&
          Date.parse(r.due_at) < +now + 2 * 86400000,
      )
      .sort((a, b) => a.due_at!.localeCompare(b.due_at!)),
    due.filter((r) => !r.due_at && r.priority === "high"),
    due.filter((r) => r.state === "waiting" || r.state === "blocked"),
    byOldest,
  ];
  const selected = new Map<string, Responsibility>();
  while (selected.size < maximum && groups.some((g) => g.length))
    for (const group of groups) {
      const row = group.shift();
      if (row) selected.set(`${row.ref_kind}:${row.ref_id}`, row);
      if (selected.size >= maximum) break;
    }
  return [...selected.values()];
}

export function responsibilityDesk(
  db: Database.Database,
  now = new Date(),
  maxChars = 9000,
): { text: string; seen: Responsibility[] } {
  reconcileResponsibilities(db, now);
  const all = listResponsibilities(db);
  const selected = selectResponsibilities(all, now);
  const text = (value: unknown, limit: number) =>
    String(value ?? "")
      .replace(/[<>]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, limit);
  const lines: string[] = [];
  const seen: Responsibility[] = [];
  let remaining = maxChars - 300;
  for (const row of selected) {
    const line = JSON.stringify({
      ref_kind: row.ref_kind,
      ref_id: row.ref_id,
      expected_version: row.source_version,
      expected_revision: row.revision,
      title: text(row.title, 100),
      deadline: row.due_at,
      state: row.state,
      owner: text(row.owner, 40),
      next_action: text(row.next_action, 100),
      next_check_at: row.next_check_at,
      planned_for: row.planned_for,
      estimate_minutes: row.estimate_minutes,
      blocker: text(row.blocker, 80),
      details: text(row.description, 220),
      source_ref: text(row.source_ref, 120),
      source_quote: text(row.source_quote, 180),
      needs_confirmation: row.needs_confirmation,
      parent: row.parent_kind
        ? {
            kind: row.parent_kind,
            id: row.parent_id,
            version: row.parent_version,
          }
        : undefined,
    });
    if (line.length + 1 > remaining) continue;
    lines.push(line);
    seen.push(row);
    remaining -= line.length + 1;
  }
  return {
    text: [
      `Active obligations: ${all.length}. Included: ${seen.length}. Omitted due checks: ${all.filter((r) => Date.parse(r.next_check_at) <= +now).length - seen.length}. Omitted checks remain pending for another batch.`,
      ...lines,
    ].join("\n"),
    seen,
  };
}

export function assertSourceVersion(
  db: Database.Database,
  kind: RefKind,
  id: string,
  expected: unknown,
): Source {
  const source = sourceRecord(db, kind, id);
  if (!source || !activeResponsibilitySource(source))
    throw new Error("The source is no longer open. Read the current record.");
  if (typeof expected !== "string" || expected !== sourceVersion(source))
    throw new Error(
      "The source changed or its version is missing. Read the current record before editing.",
    );
  return source;
}

export type PlanPatch = {
  ref_kind: RefKind;
  ref_id: string;
  expected_version: string;
  expected_revision: number;
  next_action: string;
  owner: string;
  state: Exclude<Responsibility["state"], "resolved">;
  next_check_at: string;
  planned_for?: string | null;
  estimate_minutes?: number | null;
  blocker?: string | null;
  goal?: string | null;
  completion_criterion?: string | null;
};
export function updateResponsibility(
  db: Database.Database,
  patch: PlanPatch,
  now = new Date(),
): void {
  db.transaction(() => {
    const source = assertSourceVersion(
      db,
      patch.ref_kind,
      patch.ref_id,
      patch.expected_version,
    );
    if (!["ready", "waiting", "blocked", "deferred"].includes(patch.state))
      throw new Error("A plan cannot complete its source.");
    for (const field of ["next_action", "owner"] as const)
      if (
        typeof patch[field] !== "string" ||
        !patch[field].trim() ||
        patch[field].length > (field === "owner" ? 160 : 500)
      )
        throw new Error(`Invalid ${field}.`);
    for (const field of ["blocker", "goal", "completion_criterion"] as const)
      if (
        patch[field] != null &&
        (typeof patch[field] !== "string" || patch[field]!.length > 1000)
      )
        throw new Error(`Invalid ${field}.`);
    const check = Date.parse(patch.next_check_at);
    if (!Number.isFinite(check) || check <= +now || check > +now + 7 * 86400000)
      throw new Error("Next check must be in the next seven days.");
    if (
      patch.planned_for &&
      (!Number.isFinite(Date.parse(patch.planned_for)) ||
        !patch.planned_for.includes("T"))
    )
      throw new Error("Planned work needs an explicit date and time.");
    if (
      patch.estimate_minutes != null &&
      (!Number.isInteger(patch.estimate_minutes) ||
        patch.estimate_minutes < 5 ||
        patch.estimate_minutes > 480)
    )
      throw new Error("Estimated work must be 5 to 480 minutes.");
    const changed = db
      .prepare(
        `UPDATE cove_responsibilities SET state=?,owner=?,next_action=?,next_check_at=?,planned_for=?,estimate_minutes=?,blocker=?,goal=?,completion_criterion=?,
   last_reviewed_at=?,revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=? AND revision=?`,
      )
      .run(
        patch.state,
        patch.owner.trim(),
        patch.next_action.trim(),
        boundedCheck(source, new Date(check), now).toISOString(),
        patch.planned_for ?? null,
        patch.estimate_minutes ?? null,
        patch.blocker ?? null,
        patch.goal ?? null,
        patch.completion_criterion ?? null,
        now.toISOString(),
        now.toISOString(),
        patch.ref_kind,
        patch.ref_id,
        patch.expected_revision,
      );
    if (changed.changes !== 1)
      throw new Error(
        "The plan changed. Read its current revision before editing.",
      );
    event(db, patch.ref_kind, patch.ref_id, "plan_updated", patch, now);
  }).immediate();
}

export function acknowledgeResponsibility(
  db: Database.Database,
  kind: RefKind,
  id: string,
  revision: number,
  now = new Date(),
): boolean {
  const source = sourceRecord(db, kind, id);
  if (!source || !activeResponsibilitySource(source)) return false;
  return (
    db
      .prepare(
        `UPDATE cove_responsibilities SET acknowledged_at=?,next_check_at=?,revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=? AND revision=? AND state<>'resolved'`,
      )
      .run(
        now.toISOString(),
        new Date(+now + 3600000).toISOString(),
        now.toISOString(),
        kind,
        id,
        revision,
      ).changes === 1
  );
}

/** A successful review moves only the exact rows it saw, leaving omissions due. */
export function markResponsibilitiesReviewed(
  db: Database.Database,
  seen: Responsibility[],
  now: Date,
): void {
  db.transaction(() => {
    for (const row of seen) {
      const source = sourceRecord(db, row.ref_kind, row.ref_id);
      if (!source || sourceVersion(source) !== row.source_version) continue;
      const deadline = row.due_at ? Date.parse(row.due_at) : NaN;
      const delay =
        deadline > +now && deadline < +now + 86400000
          ? 3 * 3600000
          : row.priority === "high"
            ? 86400000
            : 3 * 86400000;
      const next = new Date(+now + delay);
      // Once a deadline is already at risk, preserve a bounded revisit instead of
      // spinning continuously. Future deadlines can pull the review earlier.
      const nextCheck =
        row.due_at && Date.parse(row.due_at) > +now + 3600000
          ? boundedCheck(source, next, now)
          : next;
      db.prepare(
        "UPDATE cove_responsibilities SET last_reviewed_at=?,next_check_at=?,revision=revision+1,updated_at=? WHERE ref_kind=? AND ref_id=? AND revision=?",
      ).run(
        now.toISOString(),
        nextCheck.toISOString(),
        now.toISOString(),
        row.ref_kind,
        row.ref_id,
        row.revision,
      );
    }
  }).immediate();
}

export function savePreparation(
  db: Database.Database,
  input: {
    ref_kind: RefKind;
    ref_id: string;
    expected_version: string;
    title: string;
    content: string;
  },
  now = new Date(),
): string {
  return db
    .transaction(() => {
      assertSourceVersion(
        db,
        input.ref_kind,
        input.ref_id,
        input.expected_version,
      );
      if (
        !input.title?.trim() ||
        input.title.length > 160 ||
        !input.content?.trim() ||
        input.content.length > 12000
      )
        throw new Error("Preparation requires a bounded title and draft.");
      const prior = db
        .prepare(
          "SELECT id FROM cove_preparations WHERE ref_kind=? AND ref_id=? AND source_version=? AND title=? AND content=?",
        )
        .get(
          input.ref_kind,
          input.ref_id,
          input.expected_version,
          input.title,
          input.content,
        ) as { id: string } | undefined;
      if (prior) return prior.id;
      const id = randomUUID();
      db.prepare("INSERT INTO cove_preparations VALUES(?,?,?,?,?,?,?)").run(
        id,
        input.ref_kind,
        input.ref_id,
        input.expected_version,
        input.title,
        input.content,
        now.toISOString(),
      );
      event(
        db,
        input.ref_kind,
        input.ref_id,
        "draft_prepared",
        { id, title: input.title },
        now,
      );
      return id;
    })
    .immediate();
}
