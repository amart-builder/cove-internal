/**
 * The Jev ledger's table shapes, kept in a module with no imports.
 *
 * `migrations.ts` needs this constant, and the ledger reader needs the database
 * factory that `migrations.ts` sits behind. Holding the schema here is what
 * keeps those two from importing each other in a circle.
 *
 * Two tables, because a call and a judgment have different lifetimes. An
 * assessment is evidence about meaning and is pruned on the shorter clock; an
 * attempt is the record that a call happened at all, including the ones that
 * failed before any answer existed, and it outlives the detail so spend history
 * stays readable.
 */
export const JEV_LEDGER_SCHEMA = `
CREATE TABLE cove_jev_assessments (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  mode TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  question_key TEXT NOT NULL,
  answer_kind TEXT NOT NULL CHECK(answer_kind IN ('choice','noul')),
  choice TEXT,
  noul REAL,
  confidence REAL,
  baseline TEXT,
  agreed INTEGER,
  detail_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cove_jev_assessments_ref
  ON cove_jev_assessments(feature, ref_kind, ref_id);
CREATE INDEX cove_jev_assessments_created ON cove_jev_assessments(created_at);
CREATE TABLE cove_jev_attempts (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status INTEGER,
  usage_known INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX cove_jev_attempts_created ON cove_jev_attempts(created_at);`;
