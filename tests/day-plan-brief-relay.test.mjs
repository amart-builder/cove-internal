import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import {
  validateMorningBrief,
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
} from '../src/lib/day-plan/brief.ts';
import { collectMorningBriefSources } from '../src/lib/day-plan/brief-sources.ts';
import {
  buildSettlementSummary,
  exportBriefArtifact,
  liveRemoteBriefAttempt,
  parseRelayFile,
  readDumpRelay,
  readSettlementRelay,
  scanAndImportBriefRelay,
  sweepBriefRelayOutbox,
  verifySourceCheckpoint,
  writeBriefAttemptStatus,
  writeDumpRelay,
  writeSourceCheckpoint,
} from '../src/lib/day-plan/brief-relay.ts';
import {
  maybeQueueMorningBrief,
  withQueuedAttemptStatus,
} from '../src/lib/day-plan/brief-triggers.ts';
import { enqueueDueMorningBrief } from '../src/lib/claude-execution/worker.ts';
import { shouldAttemptLateBriefAttach } from '../src/lib/day-plan/presentation.ts';

const CLOCK = '2026-07-14T13:00:00.000Z';
const DATE = '2026-07-14';
const TZ = 'America/Los_Angeles';
// Relay validation requires UUID artifact ids (finding: a non-UUID far-future
// artifact must never import). Store-level tests may still use short ids.
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const VERSIONS = { promptVersion: MORNING_BRIEF_PROMPT_VERSION, schemaVersion: MORNING_BRIEF_SCHEMA_VERSION };
const PROVENANCE = { modelAlias: 'opus', effort: 'high', budgetUsd: 1.5 };

const WIRE_BRIEF = {
  lens_narrative: 'Protect client delivery first, then push the Pilot Pro funnel.',
  existing_task_candidates: [
    {
      task_id: 'task-c',
      why_today: 'The funnel is the scoreboard and this ask is stage one.',
      suggested_owner: 'claude',
      what_claude_can_start: 'Draft the referral messages for review.',
      evidence_refs: ['goals:jarvis-pro'],
    },
    {
      task_id: 'task-a',
      why_today: 'Client delivery blocks are protected on the calendar first.',
      suggested_owner: 'me',
      what_claude_can_start: '',
    },
  ],
  suggested_additions: [],
  watch_items: [],
  board_actions: [],
};

function briefJson() {
  return JSON.stringify(validateMorningBrief(WIRE_BRIEF).brief);
}

function fixture(t) {
  const dir = path.join(os.tmpdir(), `cove-relay-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  let nowIso = CLOCK;
  const store = createDayPlanStore({ dbPath: path.join(dir, 'cove.db'), now: () => new Date(nowIso) });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, setNow: (value) => { nowIso = value; } };
}

function candidatePool() {
  return buildDayPlanCandidates({
    localDate: DATE,
    timezone: TZ,
    tasks: [
      { id: 'task-a', title: 'Deliver the Meridian weekly block', description: 'The weekly Meridian advisory work is delivered.', priority: 'high', position: 0, column: 'today', status: 'open', updatedAt: '2026-07-14T12:00:00.000Z', refreshedAt: CLOCK },
      { id: 'task-b', title: 'Send referral blast batch two', description: 'Eight more referral asks go out.', priority: 'medium', position: 1, column: 'today', status: 'open', updatedAt: '2026-07-14T12:00:00.000Z', refreshedAt: CLOCK },
      { id: 'task-c', title: 'Follow up with Gio on the setup', description: 'Gio gets a concrete setup proposal.', priority: 'low', position: 2, column: 'in_flight', status: 'open', updatedAt: '2026-07-14T12:00:00.000Z', refreshedAt: CLOCK },
    ],
  }, 10);
}

function succeededArtifact(store, json, { date = DATE, inputHash } = {}) {
  const artifact = store.enqueueMorningBrief(date, PROVENANCE).brief;
  store.claimNextMorningBrief();
  store.recordMorningBriefInputs(artifact.id, {
    inputHash: inputHash ?? `hash-${Math.random()}`,
    sourceManifest: { sources: [], coverage: {}, trims: [], totalChars: 0 },
    ...VERSIONS,
  });
  return store.completeMorningBrief(artifact.id, json);
}

function makeArtifact({
  id = UUID_A,
  date = DATE,
  inputHash = 'remote-hash',
  createdAt = '2026-07-14T13:00:00.000Z',
  startedAt = '2026-07-14T13:30:00.000Z',
  finishedAt = '2026-07-14T14:00:00.000Z',
  json,
} = {}) {
  return {
    id,
    targetLocalDate: date,
    status: 'succeeded',
    inputHash,
    promptVersion: MORNING_BRIEF_PROMPT_VERSION,
    schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
    sourceManifest: undefined,
    modelAlias: 'opus',
    effort: 'high',
    budgetUsd: 1.5,
    briefJson: json ?? briefJson(),
    createdAt,
    updatedAt: finishedAt,
    startedAt,
    finishedAt,
  };
}

// ---------------------------------------------------------------------------
// Artifact export: write-once, atomic, checksum-bearing.
// ---------------------------------------------------------------------------

test('export writes one checksum-bearing file, write-once, atomically (no partial or tmp files)', (t) => {
  const { dir } = fixture(t);
  const artifact = makeArtifact();
  assert.equal(exportBriefArtifact(artifact, { dataDir: dir }), true);

  const relayDir = path.join(dir, 'brief-relay');
  const files = readdirSync(relayDir);
  // Exactly one JSON named for the date + host + artifact id, no lingering temp
  // file — the rename committed atomically.
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 1);
  assert.equal(files.some((name) => name.includes('.tmp')), false);
  assert.match(files[0], new RegExp(`^2026-07-14-.+-${UUID_A}\\.json$`));

  const envelope = JSON.parse(readFileSync(path.join(relayDir, files[0]), 'utf8'));
  assert.equal(envelope.relay_version, 1);
  assert.equal(envelope.id, UUID_A);
  assert.equal(typeof envelope.checksum, 'string');
  assert.equal(typeof envelope.origin_host, 'string');

  // Write-once: a second export of the same artifact leaves the file untouched.
  const before = readFileSync(path.join(relayDir, files[0]), 'utf8');
  assert.equal(exportBriefArtifact(artifact, { dataDir: dir }), false);
  assert.equal(readFileSync(path.join(relayDir, files[0]), 'utf8'), before);
});

test('export fails open on a filesystem error and leaves no partial file', (t) => {
  const { dir } = fixture(t);
  // Block the relay directory with a regular file so mkdir/write cannot succeed.
  writeFileSync(path.join(dir, 'brief-relay'), 'blocker');
  const logs = [];
  assert.equal(exportBriefArtifact(makeArtifact(), { dataDir: dir, log: (m) => logs.push(m) }), false);
  assert.equal(logs.length, 1);
  // The blocker is still a file; no artifact was written.
  assert.equal(readFileSync(path.join(dir, 'brief-relay'), 'utf8'), 'blocker');
});

// ---------------------------------------------------------------------------
// Relay validation: checksum, size, versions.
// ---------------------------------------------------------------------------

test('parseRelayFile rejects corrupt, foreign-version, checksum-mismatched, and oversize files', () => {
  const good = makeArtifact();
  const raw = (() => {
    // Round-trip through export by hand: reuse the writer's envelope shape.
    let captured;
    const dir = path.join(os.tmpdir(), `relay-parse-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    exportBriefArtifact(good, { dataDir: dir });
    const file = readdirSync(path.join(dir, 'brief-relay'))[0];
    captured = readFileSync(path.join(dir, 'brief-relay', file), 'utf8');
    rmSync(dir, { recursive: true, force: true });
    return captured;
  })();

  assert.ok(parseRelayFile(raw), 'a well-formed envelope parses');
  assert.equal(parseRelayFile('{not json'), undefined);

  const foreignRelay = JSON.parse(raw);
  foreignRelay.relay_version = 2;
  assert.equal(parseRelayFile(JSON.stringify(foreignRelay)), undefined);

  const foreignSchema = JSON.parse(raw);
  foreignSchema.schema_version = 99;
  assert.equal(parseRelayFile(JSON.stringify(foreignSchema)), undefined);

  const tampered = JSON.parse(raw);
  tampered.brief_json = JSON.stringify({ lensNarrative: 'evil', existingTaskCandidates: [], suggestedAdditions: [], watchItems: [] });
  assert.equal(parseRelayFile(JSON.stringify(tampered)), undefined, 'checksum no longer matches the mutated content');

  const oversize = JSON.stringify({ ...JSON.parse(raw), pad: 'x'.repeat(1_100_000) });
  assert.equal(parseRelayFile(oversize), undefined);
});

// ---------------------------------------------------------------------------
// Import: idempotent, adopt-on-race, transactional.
// ---------------------------------------------------------------------------

test('importMorningBrief is idempotent and keeps the earliest finished_at on a same-key race', (t) => {
  const { store } = fixture(t);
  const json = briefJson();
  const first = store.importMorningBrief(makeArtifact({ id: 'a', inputHash: 'H', finishedAt: '2026-07-14T15:00:00.000Z', json }));
  assert.deepEqual(first, { imported: true, adopted: false, briefId: 'a' });
  // Same envelope again → no-op.
  assert.deepEqual(store.importMorningBrief(makeArtifact({ id: 'a', inputHash: 'H', finishedAt: '2026-07-14T15:00:00.000Z', json })), { imported: false, adopted: false });
  // A same-key artifact with an earlier finished_at wins deterministically.
  assert.deepEqual(store.importMorningBrief(makeArtifact({ id: 'b', inputHash: 'H', finishedAt: '2026-07-14T14:00:00.000Z', json })), { imported: false, adopted: false });
  const rows = store.listMorningBriefs(DATE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].finishedAt, '2026-07-14T14:00:00.000Z');
});

test('import adopts a local running row and a late local finisher then no-ops', (t) => {
  const { store } = fixture(t);
  const json = briefJson();
  const running = store.enqueueMorningBrief(DATE, PROVENANCE).brief;
  store.claimNextMorningBrief();
  const result = store.importMorningBrief(makeArtifact({ id: 'remote', inputHash: 'remote-h', json }));
  assert.deepEqual(result, { imported: true, adopted: true, briefId: running.id });
  const adopted = store.getMorningBrief(running.id);
  assert.equal(adopted.status, 'succeeded');
  assert.equal(adopted.inputHash, 'remote-h');
  assert.equal(adopted.briefJson, json);
  // The still-running local generation's completion is now a no-op.
  assert.equal(store.completeMorningBrief(running.id, JSON.stringify({ other: true })), undefined);
  assert.equal(store.getMorningBrief(running.id).briefJson, json);
  assert.equal(store.listMorningBriefs(DATE).length, 1);
});

test('import is a no-op when a local succeeded row already holds the same envelope', (t) => {
  const { store } = fixture(t);
  const json = briefJson();
  const local = succeededArtifact(store, json, { inputHash: 'shared' });
  const result = store.importMorningBrief(makeArtifact({ id: 'remote', inputHash: 'shared', json }));
  assert.deepEqual(result, { imported: false, adopted: false });
  const rows = store.listMorningBriefs(DATE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, local.id);
});

// ---------------------------------------------------------------------------
// Scan: fail-open, never deletes, dedupes filenames, skips foreign files.
// ---------------------------------------------------------------------------

test('scan imports only valid files, skips corrupt/foreign/sync-conflict, and never deletes', (t) => {
  const { dir, store } = fixture(t);
  const relayDir = path.join(dir, 'brief-relay');
  mkdirSync(relayDir, { recursive: true });
  // One valid file via the real writer.
  exportBriefArtifact(makeArtifact({ id: UUID_B }), { dataDir: dir });
  const validName = readdirSync(relayDir)[0];
  // Foreign + corrupt siblings that must be skipped, not deleted.
  writeFileSync(path.join(relayDir, `${DATE}-mini-corrupt.json`), '{ not json');
  const foreign = JSON.parse(readFileSync(path.join(relayDir, validName), 'utf8'));
  writeFileSync(path.join(relayDir, `${DATE}-mini-foreign.json`), JSON.stringify({ ...foreign, relay_version: 2, id: 'foreign' }));
  writeFileSync(path.join(relayDir, `${DATE}-mini-art.sync-conflict-20260101.json`), readFileSync(path.join(relayDir, validName), 'utf8'));

  const imported = new Set();
  const count = scanAndImportBriefRelay({ store, targetLocalDate: DATE, dataDir: dir, imported });
  assert.equal(count, 1);
  assert.equal(store.listMorningBriefs(DATE).length, 1);
  // Nothing was deleted.
  assert.equal(readdirSync(relayDir).length, 4);
  // Re-scan is cheap and idempotent (filenames already seen, DB dedupes).
  assert.equal(scanAndImportBriefRelay({ store, targetLocalDate: DATE, dataDir: dir, imported }), 0);
});

test('relay import stages and activates board actions end to end', (t) => {
  const { dir, store } = fixture(t);
  const db = new Database(path.join(dir, 'cove.db'));
  db.exec(`
    CREATE TABLE task_columns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, column_id TEXT, title TEXT NOT NULL, description TEXT,
      priority TEXT, due_at TEXT, due_date TEXT, tags TEXT, project TEXT,
      position REAL, status TEXT, archived_at TEXT, archived_from_status TEXT,
      recurring_template_id TEXT, occurrence_local_date TEXT,
      created_at TEXT, updated_at TEXT
    );
    INSERT INTO task_columns VALUES ('col-ns', 'Not Started', 0);
    INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, updated_at)
    VALUES
      ('task-x', 'col-ns', 'Relay task', '', 'medium', '[]', 0, 'open',
       '2026-07-14T12:00:00.000Z');
  `);
  const brief = validateMorningBrief({
    ...WIRE_BRIEF,
    board_actions: [{
      op: 'set_priority', task_id: 'task-x', priority: 'high', why: 'Goal fit.',
    }],
  }, {
    knownTaskIds: new Set(['task-x']),
    taskUpdatedAtById: new Map([['task-x', '2026-07-14T12:00:00.000Z']]),
  }).brief;
  const artifact = makeArtifact({
    id: UUID_C,
    inputHash: 'board-action-relay',
    json: JSON.stringify(brief),
  });
  exportBriefArtifact(artifact, { dataDir: dir, host: 'mini' });
  const seen = new Set();
  assert.equal(scanAndImportBriefRelay({
    store, targetLocalDate: DATE, dataDir: dir, imported: seen,
  }), 1);
  assert.equal(store.getMorningBrief(artifact.id).boardActionsPending, true);
  assert.equal(store.latestEligibleMorningBrief(DATE), undefined);
  assert.equal(scanAndImportBriefRelay({
    store, targetLocalDate: DATE, dataDir: dir, imported: seen,
  }), 0);
  assert.equal(store.stageMorningBriefBoardActions(artifact.id), 0);
  assert.deepEqual(store.activateBriefBoardActions(DATE, new Date(CLOCK)), {
    activated: true,
    artifactId: artifact.id,
    applied: 1,
    skippedConflict: 0,
    skippedOfflimits: 0,
  });
  assert.equal(db.prepare("SELECT priority FROM tasks WHERE id = 'task-x'").pluck().get(), 'high');
  assert.equal(store.latestEligibleMorningBrief(DATE).id, artifact.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM cove_receipts WHERE source = 'morning-brief-management'").pluck().get(),
    1,
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Attempt-status relay: grace-period + host filtering + failed supersedes.
// ---------------------------------------------------------------------------

test('liveRemoteBriefAttempt honors expiry, failed-supersedes, and self-host filtering', (t) => {
  const { dir } = fixture(t);
  const now = new Date('2026-07-14T15:00:00.000Z');
  // A fresh running attempt from the Mini is live to the MBP.
  writeBriefAttemptStatus(
    { targetLocalDate: DATE, attemptId: 'run-1', state: 'running', startedAt: '2026-07-14T14:55:00.000Z' },
    { dataDir: dir, host: 'mini', now },
  );
  const live = liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now });
  assert.equal(live?.state, 'running');
  assert.equal(live?.startedAt, '2026-07-14T14:55:00.000Z');
  // The Mini itself ignores its own attempt.
  assert.equal(liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mini', dataDir: dir, now }), undefined);
  // Expired (started 20 minutes ago, TTL 15).
  assert.equal(
    liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now: new Date('2026-07-14T15:20:00.000Z') }),
    undefined,
  );
  // A failed status for the same attempt supersedes the running one.
  writeBriefAttemptStatus(
    { targetLocalDate: DATE, attemptId: 'run-1', state: 'failed', errorCode: 'source_checkpoint_mismatch' },
    { dataDir: dir, host: 'mini', now },
  );
  assert.equal(liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now }), undefined);
});

test('a fresh queued attempt is live and a stale queued attempt is not', (t) => {
  const { dir } = fixture(t);
  writeBriefAttemptStatus(
    { targetLocalDate: DATE, attemptId: 'q-1', state: 'queued' },
    { dataDir: dir, host: 'mini', now: new Date('2026-07-14T15:00:00.000Z') },
  );
  assert.equal(
    liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now: new Date('2026-07-14T15:05:00.000Z') })?.state,
    'queued',
  );
  assert.equal(
    liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now: new Date('2026-07-14T15:20:00.000Z') }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Settlement relay: canonical builder + fallback freshness labeling.
// ---------------------------------------------------------------------------

test('the settlement relay round-trips and the collector falls back to it with freshness labeling', async (t) => {
  const { dir } = fixture(t);
  // Write a relay file directly (single-writer overwrite path).
  const relayPath = path.join(dir, 'settlement-relay', 'latest.json');
  mkdirSync(path.dirname(relayPath), { recursive: true });
  writeFileSync(relayPath, JSON.stringify({
    relay_version: 1,
    content: '- 2026-07-13: completed=2 unresolved=none',
    as_of: '2026-07-10T09:00:00.000Z',
    snapshot_ids: ['snap-1'],
    written_at: '2026-07-13T09:00:00.000Z',
  }));
  assert.deepEqual(readSettlementRelay({ dataDir: dir }), {
    content: '- 2026-07-13: completed=2 unresolved=none',
    asOf: '2026-07-10T09:00:00.000Z',
  });

  // The collector, given an empty local store, uses the relay as the settlement
  // source; its old as_of makes the source stale under the 96h threshold.
  const emptyStore = { listRecentSnapshots: () => [] };
  const collected = await collectMorningBriefSources({
    store: emptyStore,
    dataDir: dir,
    goalsPath: path.join(dir, 'missing-goals.md'),
    sprintMemoPath: path.join(dir, 'missing-memo.md'),
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  const settlement = collected.sources.find((source) => source.id === 'settlement_summary');
  assert.equal(settlement.content, '- 2026-07-13: completed=2 unresolved=none');
  assert.equal(settlement.asOf, '2026-07-10T09:00:00.000Z');
  assert.equal(settlement.required, true);
});

// The dump is typed on the MBP and the 7:30 brief runs on the Mini, whose
// day_dumps table is machine-private and empty. Without the relay the freshest
// statement of direction Jordan Rivers makes never reaches the brief that frames his day.
test('the dump relay carries last night’s brain dump to a machine with no local dumps', async (t) => {
  const { dir } = fixture(t);
  const dumpStore = {
    listDayDumps: () => [
      { id: 'old', targetLocalDate: '2026-07-11', rawText: 'older dump', status: 'succeeded', createdAt: '2026-07-12T02:00:00.000Z' },
      { id: 'new', targetLocalDate: '2026-07-13', rawText: 'The hotel guest agent is now a top three priority.', status: 'succeeded', createdAt: '2026-07-14T02:00:00.000Z' },
      { id: 'bad', targetLocalDate: '2026-07-13', rawText: 'failed run', status: 'failed', createdAt: '2026-07-14T03:00:00.000Z' },
    ],
  };
  assert.equal(writeDumpRelay({ store: dumpStore, dataDir: dir, now: new Date(CLOCK) }), true);

  // Newest succeeded wins; the failed run is never published.
  const relayed = readDumpRelay({ dataDir: dir, now: new Date(CLOCK) });
  assert.equal(relayed.content, 'The hotel guest agent is now a top three priority.');
  assert.equal(relayed.asOf, '2026-07-14T02:00:00.000Z');
  assert.equal(relayed.targetLocalDate, '2026-07-13');

  // A store with no listDayDumps at all stands in for the Mini.
  const collected = await collectMorningBriefSources({
    store: { listRecentSnapshots: () => [] },
    dataDir: dir,
    now: new Date(CLOCK),
    goalsPath: path.join(dir, 'missing-goals.md'),
    sprintMemoPath: path.join(dir, 'missing-memo.md'),
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  const dump = collected.sources.find((source) => source.id === 'day_dump');
  assert.match(dump.content, /The hotel guest agent is now a top three priority\.$/);
  // A relayed closeout carries the same provenance line as a local one: the
  // relay records the working day it covers, so the gap is still computable.
  assert.ok(dump.content.startsWith('CLOSEOUT PROVENANCE'));
  assert.match(dump.content, /Covers the working day Monday, Jul 13\./);
  assert.equal(dump.freshness, 'current');
  // Priority 0: it outranks the hand-written goals and sprint memo, which is
  // the whole point. Anything above 0 lets a stale file win a disagreement.
  assert.equal(dump.priority, 0);
  assert.equal(collected.sources[0].id, 'day_dump');
});

test('a brain dump older than the relay window is dropped rather than presented as current', async (t) => {
  const { dir } = fixture(t);
  const stale = {
    listDayDumps: () => [
      { id: 'stale', targetLocalDate: '2026-07-01', rawText: 'last week', status: 'succeeded', createdAt: '2026-07-02T02:00:00.000Z' },
    ],
  };
  assert.equal(writeDumpRelay({ store: stale, dataDir: dir, now: new Date(CLOCK) }), true);
  assert.equal(readDumpRelay({ dataDir: dir, now: new Date(CLOCK) }), undefined);

  const collected = await collectMorningBriefSources({
    store: { listRecentSnapshots: () => [] },
    dataDir: dir,
    now: new Date(CLOCK),
    goalsPath: path.join(dir, 'missing-goals.md'),
    sprintMemoPath: path.join(dir, 'missing-memo.md'),
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  const dump = collected.sources.find((source) => source.id === 'day_dump');
  assert.equal(dump.content, undefined);
  assert.equal(dump.note, 'day_dump_unavailable');
});

test('an empty local store with no relay records the settlement source as missing', async (t) => {
  const { dir } = fixture(t);
  const collected = await collectMorningBriefSources({
    store: { listRecentSnapshots: () => [] },
    dataDir: dir,
    goalsPath: path.join(dir, 'missing-goals.md'),
    sprintMemoPath: path.join(dir, 'missing-memo.md'),
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  const settlement = collected.sources.find((source) => source.id === 'settlement_summary');
  assert.equal(settlement.content, undefined);
  assert.equal(settlement.note, 'settlement_summary_unavailable');
});

test('buildSettlementSummary labels progress, not-moved carry, and carry streaks', () => {
  const summary = buildSettlementSummary([
    {
      id: 's1', localDate: '2026-07-13', createdAt: '2026-07-13T09:00:00.000Z',
      body: {
        completedHumanTaskIds: ['t1', 't2'],
        unresolvedItems: [
          {
            taskId: 'task-progress', title: 'Ship the thing', disposition: 'progress',
            progressNote: 'Draft is complete.', nextStep: 'Review the pricing.',
          },
          { taskId: 'task-carry', title: 'Call the client', disposition: 'carry' },
        ],
        nextDayRecommendationSeed: { title: 'Ship the thing' },
      },
    },
    {
      id: 's0', localDate: '2026-07-12', createdAt: '2026-07-12T09:00:00.000Z',
      body: {
        completedHumanTaskIds: [],
        unresolvedItems: [
          { taskId: 'task-carry', title: 'Call the client', disposition: 'carry' },
        ],
      },
    },
    {
      id: 's-gap', localDate: '2026-07-10', createdAt: '2026-07-10T09:00:00.000Z',
      body: {
        completedHumanTaskIds: [],
        unresolvedItems: [
          { taskId: 'task-carry', title: 'Call the client', disposition: 'carry' },
        ],
      },
    },
    {
      id: 's-old', localDate: '2026-07-01', createdAt: '2026-07-01T09:00:00.000Z',
      body: {
        completedHumanTaskIds: [],
        unresolvedItems: [
          { taskId: 'task-carry', title: 'Call the client', disposition: 'carry' },
        ],
      },
    },
  ]);
  const [latestLine, previousLine, gapLine] = summary.content.split('\n');
  assert.match(latestLine, /2026-07-13: completed=2/);
  assert.match(latestLine, /continuing_work=\[title="Ship the thing" progress_note="Draft is complete\." next_step="Review the pricing\."\]/);
  assert.match(latestLine, /carried_not_moved=\[title="Call the client" carried_days_running=2\]/);
  assert.match(previousLine, /2026-07-12:.*carried_days_running=1/);
  assert.match(gapLine, /2026-07-10:.*carried_days_running=1/);
  assert.match(summary.content, /continue_first="Ship the thing"/);
  assert.equal(summary.asOf, '2026-07-13T09:00:00.000Z');
  assert.deepEqual(summary.snapshotIds, ['s1', 's0', 's-gap']);
  assert.equal(buildSettlementSummary([]).content, 'No settlement snapshots exist yet.');
});

// ---------------------------------------------------------------------------
// Outbox sweep: exports missing files, idempotent on re-run.
// ---------------------------------------------------------------------------

test('the outbox sweep exports succeeded rows missing a relay file and is idempotent', (t) => {
  const { store, dir } = fixture(t);
  const prevTz = process.env.COVE_BRIEF_TIMEZONE;
  process.env.COVE_BRIEF_TIMEZONE = TZ;
  t.after(() => {
    if (prevTz === undefined) delete process.env.COVE_BRIEF_TIMEZONE;
    else process.env.COVE_BRIEF_TIMEZONE = prevTz;
  });
  succeededArtifact(store, briefJson(), { inputHash: 'sweep-1' });
  const now = new Date('2026-07-14T20:00:00.000Z'); // 13:00 PT → recent dates include 2026-07-14
  const first = sweepBriefRelayOutbox({ store, now, dataDir: dir, host: 'mbp' });
  assert.equal(first, 1);
  assert.equal(readdirSync(path.join(dir, 'brief-relay')).filter((n) => n.endsWith('.json')).length, 1);
  // Idempotent: the file now exists, so a second sweep exports nothing.
  assert.equal(sweepBriefRelayOutbox({ store, now, dataDir: dir, host: 'mbp' }), 0);
});

// ---------------------------------------------------------------------------
// Guarded late-attach (P1 addendum + v2 guard matrix).
// ---------------------------------------------------------------------------

// Creates a pristine plan BEFORE any brief exists, then seeds a succeeded brief
// for the same date so a subsequent ensure exercises the late-attach path.
function planThenBrief(t) {
  const { store, dir, setNow } = fixture(t);
  const plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  assert.equal(plan.briefId, undefined);
  const artifact = succeededArtifact(store, briefJson());
  return { store, dir, plan, artifact, setNow };
}

test('late-attach overlays a brief onto a pristine arrival and bumps the version once', (t) => {
  const { store, plan, artifact } = planThenBrief(t);
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() });
  assert.equal(result.plan.briefId, artifact.id);
  assert.equal(result.plan.version, plan.version + 1);
  assert.equal(result.plan.items[0].taskId, 'task-c');
  assert.equal(result.plan.items[0].brief.whyToday, 'The funnel is the scoreboard and this ask is stage one.');
  const events = store.listEvents(plan.id).map((event) => event.eventType);
  assert.ok(events.includes('brief_attach'));
  // Replaying the same ensure never re-attaches (idempotent, untouched).
  const replay = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() });
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.version, result.plan.version);
});

test('late-attach refuses once the durable interaction marker is set', (t) => {
  const { store, plan } = planThenBrief(t);
  store.markArrivalInteraction(plan.id, 'interact:1');
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() });
  assert.equal(result.plan.briefId, undefined);
});

test('a content mutation auto-stamps the marker so late-attach refuses afterward', (t) => {
  const { store, plan } = planThenBrief(t);
  store.mutateDayPlan({ planId: plan.id, mutationId: 'open:1', expectedVersion: plan.version, action: 'arrival_open' });
  const opened = store.getPlan(plan.id);
  // arrival_open alone does NOT stamp — a brief can still attach to an opened arrival.
  assert.equal(opened.arrivalInteractedAt, undefined);
  store.mutateDayPlan({ planId: plan.id, mutationId: 'owner:1', expectedVersion: opened.version, action: 'item_owner', itemId: opened.items[0].id, owner: 'claude' });
  const touched = store.getPlan(plan.id);
  assert.ok(touched.arrivalInteractedAt, 'the owner change stamped the interaction marker');
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() });
  assert.equal(result.plan.briefId, undefined);
});

test('late-attach refuses when the arrival is no longer proposed/due (bypassed)', (t) => {
  const { store, plan } = planThenBrief(t);
  store.mutateDayPlan({ planId: plan.id, mutationId: 'bypass:1', expectedVersion: plan.version, action: 'arrival_bypass' });
  const bypassed = store.getPlan(plan.id);
  assert.equal(bypassed.arrivalInteractedAt, undefined, 'bypass is not a content interaction');
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() });
  assert.equal(result.plan.briefId, undefined);
});

test('late-attach with empty candidates attaches the brief without healing items', (t) => {
  const { store, artifact } = planThenBrief(t);
  const original = store.getReadModel().currentPlan;
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: [] });
  assert.equal(result.plan.briefId, artifact.id);
  assert.equal(result.plan.version, original.version + 1);
  assert.deepEqual(result.plan.items, original.items);
  assert.equal(store.listEvents(result.plan.id).at(-1).eventType, 'brief_attach');
});

test('late-attach with empty candidates ignores a version-ineligible brief', (t) => {
  const { store } = fixture(t);
  const plan = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'ensure:1',
    candidates: [],
  }).plan;
  store.importMorningBrief({
    ...makeArtifact({ id: UUID_C }),
    schemaVersion: MORNING_BRIEF_SCHEMA_VERSION + 1,
  });
  const result = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'ensure:2',
    candidates: [],
    attachOnly: true,
  });
  assert.equal(result.plan.briefId, undefined);
  assert.equal(result.plan.version, plan.version);
  assert.equal(store.listEvents(plan.id).length, 1);
});

test('late-attach enforces candidate-evidence rules (invalid candidates skip cleanly)', (t) => {
  const { store } = planThenBrief(t);
  const bad = candidatePool();
  bad[0] = { ...bad[0], sourceRefs: [{ ...bad[0].sourceRefs[0], freshness: 'stale' }] };
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: bad });
  // Fail-open: bad evidence means no attach, not a thrown ensure.
  assert.equal(result.plan.briefId, undefined);
});

test('late-attach fails open on a corrupt stored brief', (t) => {
  const { store, dir } = fixture(t);
  const plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  assert.equal(plan.briefId, undefined);
  // A succeeded row whose brief_json cannot rehydrate.
  succeededArtifact(store, JSON.stringify({ lensNarrative: 123 }));
  const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() });
  assert.equal(result.plan.briefId, undefined);
  void dir;
});

test('arrival open heals an empty pristine plan from fresh candidates exactly once', (t) => {
  const { store } = fixture(t);
  const empty = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'ensure:empty',
    candidates: [],
  }).plan;
  const baselineEvents = store.listEvents(empty.id).length;
  const healed = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'arrival-heal:1',
    candidates: candidatePool(),
    attachOnly: true,
  }).plan;
  assert.equal(healed.items.length, 3);
  assert.equal(healed.items.every((item) => item.decision === 'preselected'), true);
  assert.equal(healed.version, empty.version + 1);
  const events = store.listEvents(empty.id);
  assert.equal(events.length, baselineEvents + 1);
  assert.equal(events.at(-1).eventType, 'ensure');

  const repeat = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'arrival-heal:2',
    candidates: candidatePool(),
    attachOnly: true,
  }).plan;
  assert.equal(repeat.version, healed.version);
  assert.deepEqual(
    repeat.items.map((item) => [item.id, item.taskId, item.position, item.decision]),
    healed.items.map((item) => [item.id, item.taskId, item.position, item.decision]),
  );
  assert.equal(store.listEvents(empty.id).length, events.length);
});

test('arrival open heals an empty plan and attaches a succeeded brief in the existing late-attach mutation', (t) => {
  const { store } = fixture(t);
  const empty = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'ensure:empty',
    candidates: [],
  }).plan;
  const artifact = succeededArtifact(store, briefJson());
  const healed = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'arrival-heal:brief',
    candidates: candidatePool(),
    attachOnly: true,
  }).plan;
  assert.equal(healed.briefId, artifact.id);
  assert.equal(healed.items.length, 3);
  assert.equal(healed.version, empty.version + 1);
  assert.equal(
    store.listEvents(empty.id).find((event) => event.id === 'arrival-heal:brief').eventType,
    'brief_attach',
  );
});

test('arrival open heals a brief-backed plan that was originally created with zero candidates', (t) => {
  const { store } = fixture(t);
  const artifact = succeededArtifact(store, briefJson());
  const empty = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'ensure:brief-backed-empty',
    candidates: [],
  }).plan;
  assert.equal(empty.briefId, artifact.id);
  assert.equal(empty.items.length, 0);
  assert.equal(shouldAttemptLateBriefAttach({
    planState: empty.state,
    arrivalState: empty.arrivalState,
    hasConsumedBrief: true,
    itemCount: 0,
    arrivalInteractedAt: empty.arrivalInteractedAt,
    interacted: false,
    documentVisible: true,
    candidatesReady: true,
    candidateCount: candidatePool().length,
    alreadyAttempted: false,
  }), true);

  const healed = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'arrival-heal:brief-backed',
    candidates: candidatePool(),
    attachOnly: true,
  }).plan;
  assert.equal(healed.briefId, artifact.id);
  assert.equal(healed.items.length, 3);
  assert.equal(healed.version, empty.version + 1);
});

test('arrival heal leaves non-empty, active, and settled plans untouched', (t) => {
  const { store } = fixture(t);
  const nonEmpty = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'ensure:non-empty',
    candidates: candidatePool(),
  }).plan;
  const originalItems = store.getPlan(nonEmpty.id).items;
  const untouched = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'heal:non-empty',
    candidates: candidatePool().slice().reverse(),
    attachOnly: true,
  }).plan;
  assert.equal(untouched.version, nonEmpty.version);
  assert.deepEqual(untouched.items, originalItems);

  let plan = store.mutateDayPlan({
    planId: nonEmpty.id,
    mutationId: 'open:guard',
    expectedVersion: nonEmpty.version,
    action: 'arrival_open',
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    mutationId: 'start:guard',
    expectedVersion: plan.version,
    action: 'start_day',
  }).plan;
  const active = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'heal:active',
    candidates: candidatePool(),
    attachOnly: true,
  }).plan;
  assert.equal(active.state, 'active');
  assert.equal(active.version, plan.version);

  plan = store.mutateDayPlan({
    planId: active.id,
    mutationId: 'settlement-start:guard',
    expectedVersion: active.version,
    action: 'settlement_start',
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    mutationId: 'settlement-commit:guard',
    expectedVersion: plan.version,
    action: 'settlement_commit',
    completedHumanTaskIds: plan.items.map((item) => item.taskId),
  }).plan;
  const settled = store.ensureDayPlan({
    localDate: DATE,
    timezone: TZ,
    mutationId: 'heal:settled',
    candidates: candidatePool(),
    attachOnly: true,
  }).plan;
  assert.equal(settled.state, 'settled');
  assert.equal(settled.version, plan.version);
});

// ---------------------------------------------------------------------------
// Review finding 5: strict relay validation — UUID ids, strict ISO ordering,
// required finish time, bounded future skew, filename/envelope identity.
// ---------------------------------------------------------------------------

test('relay validation rejects non-UUID ids, future finishes, unordered timestamps, and missing finishes', (t) => {
  const { dir } = fixture(t);
  const rawFor = (artifact) => {
    rmSync(path.join(dir, 'brief-relay'), { recursive: true, force: true });
    assert.equal(exportBriefArtifact(artifact, { dataDir: dir }), true);
    const name = readdirSync(path.join(dir, 'brief-relay'))[0];
    return readFileSync(path.join(dir, 'brief-relay', name), 'utf8');
  };

  // The reviewer's reproduction: a non-UUID artifact finishing in 2099 must
  // never parse (it would outrank every honest brief indefinitely).
  assert.equal(parseRelayFile(rawFor(makeArtifact({ id: 'evil-2099' }))), undefined);
  assert.equal(
    parseRelayFile(
      rawFor(makeArtifact({ startedAt: '2099-01-01T00:00:00.000Z', finishedAt: '2099-01-01T01:00:00.000Z' })),
      { now: new Date(CLOCK) },
    ),
    undefined,
  );
  // created > finished violates causal ordering.
  assert.equal(
    parseRelayFile(
      rawFor(makeArtifact({ createdAt: '2026-07-14T15:00:00.000Z', startedAt: '2026-07-14T15:30:00.000Z', finishedAt: '2026-07-14T14:00:00.000Z' })),
    ),
    undefined,
  );
  // A succeeded artifact without a finish time cannot even be exported.
  assert.equal(exportBriefArtifact(makeArtifact({ finishedAt: undefined }), { dataDir: dir }), false);
});

test('relay validation enforces filename/envelope identity agreement', (t) => {
  const { dir } = fixture(t);
  assert.equal(exportBriefArtifact(makeArtifact(), { dataDir: dir }), true);
  const name = readdirSync(path.join(dir, 'brief-relay'))[0];
  const raw = readFileSync(path.join(dir, 'brief-relay', name), 'utf8');
  // The writer's own filename agrees with the envelope.
  assert.ok(parseRelayFile(raw, { fileName: name }));
  // A renamed/cross-copied file does not.
  assert.equal(parseRelayFile(raw, { fileName: `${DATE}-otherhost-${UUID_A}.json` }), undefined);
  assert.equal(parseRelayFile(raw, { fileName: `${DATE}-${UUID_C}.json` }), undefined);
});

// ---------------------------------------------------------------------------
// Review finding 3: cross-machine clock skew — future timestamps are rejected
// or clamped for attempt TTL and checkpoint freshness.
// ---------------------------------------------------------------------------

test('a fast peer clock cannot extend attempt liveness (future start rejected, expires_at clamped)', (t) => {
  const { dir } = fixture(t);
  const now = new Date('2026-07-14T15:00:00.000Z');
  // Fast clock: a start far in the future is rejected outright.
  writeBriefAttemptStatus(
    { targetLocalDate: DATE, attemptId: 'fast', state: 'running', startedAt: '2099-01-01T00:00:00.000Z' },
    { dataDir: dir, host: 'mini', now },
  );
  assert.equal(liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now }), undefined);
  // Fabricated expires_at: expiry is clamped to start + TTL, so an attempt that
  // started 20 minutes ago is dead no matter what it claims.
  const statusDir = path.join(dir, 'brief-relay', 'status');
  writeFileSync(path.join(statusDir, `${DATE}-mini-fake-running.json`), JSON.stringify({
    relay_version: 1,
    target_local_date: DATE,
    origin_host: 'mini',
    attempt_id: 'fake',
    state: 'running',
    started_at: '2026-07-14T14:40:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    written_at: '2026-07-14T14:40:00.000Z',
  }));
  assert.equal(liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now }), undefined);
});

test('a moderately slow peer clock still reads as live within the TTL', (t) => {
  const { dir } = fixture(t);
  const now = new Date('2026-07-14T15:00:00.000Z');
  // Started "10 minutes ago" by the peer's slow clock: still inside start + TTL.
  writeBriefAttemptStatus(
    { targetLocalDate: DATE, attemptId: 'slow', state: 'running', startedAt: '2026-07-14T14:50:00.000Z' },
    { dataDir: dir, host: 'mini', now: new Date('2026-07-14T14:50:00.000Z') },
  );
  assert.equal(
    liveRemoteBriefAttempt({ targetLocalDate: DATE, selfHost: 'mbp', dataDir: dir, now })?.state,
    'running',
  );
});

test('a source checkpoint stamped in the future fails closed like a stale one', (t) => {
  const { dir } = fixture(t);
  const goalsPath = path.join(dir, 'GOALS.md');
  writeFileSync(goalsPath, 'North star: 30k a month.');
  const sources = { goals: goalsPath };
  const now = new Date('2026-07-14T15:00:00.000Z');
  // Fresh, matching checkpoint verifies.
  assert.equal(writeSourceCheckpoint({ sources, now, dataDir: dir }), true);
  assert.deepEqual(verifySourceCheckpoint({ sources, now, dataDir: dir }), { ok: true });
  // Fast MBP clock: written an hour in the future → fail closed.
  assert.equal(writeSourceCheckpoint({ sources, now: new Date('2026-07-14T16:30:00.000Z'), dataDir: dir }), true);
  assert.deepEqual(verifySourceCheckpoint({ sources, now, dataDir: dir }), { ok: false, reason: 'stale' });
  // And a content mismatch still fails closed regardless of freshness.
  assert.equal(writeSourceCheckpoint({ sources, now, dataDir: dir }), true);
  writeFileSync(goalsPath, 'Edited after the checkpoint.');
  assert.deepEqual(verifySourceCheckpoint({ sources, now, dataDir: dir }), { ok: false, reason: 'mismatch' });
});

test('optional checkpoint files absent on both machines verify successfully', (t) => {
  const { dir } = fixture(t);
  const goalsPath = path.join(dir, 'GOALS.md');
  writeFileSync(goalsPath, 'North star.');
  const sources = {
    goals: goalsPath,
    operator_profile: path.join(dir, 'missing-operator-profile.md'),
    leadup: path.join(dir, 'missing-leadup.md'),
  };
  const now = new Date('2026-07-14T15:00:00.000Z');

  assert.equal(writeSourceCheckpoint({ sources, now, dataDir: dir }), true);
  const checkpoint = JSON.parse(readFileSync(path.join(dir, 'source-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.sources.operator_profile, null);
  assert.equal(checkpoint.sources.leadup, null);
  assert.deepEqual(verifySourceCheckpoint({ sources, now, dataDir: dir }), { ok: true });
});

test('an optional checkpoint file present on the writer but absent on the verifier mismatches', (t) => {
  const { dir } = fixture(t);
  const goalsPath = path.join(dir, 'GOALS.md');
  const operatorPath = path.join(dir, 'operator-profile.md');
  writeFileSync(goalsPath, 'North star.');
  writeFileSync(operatorPath, 'Operator profile.');
  const sources = { goals: goalsPath, operator_profile: operatorPath };
  const now = new Date('2026-07-14T15:00:00.000Z');

  assert.equal(writeSourceCheckpoint({ sources, now, dataDir: dir }), true);
  rmSync(operatorPath);
  assert.deepEqual(verifySourceCheckpoint({ sources, now, dataDir: dir }), {
    ok: false,
    reason: 'mismatch',
  });
});

test('an optional checkpoint file absent on the writer but present on the verifier mismatches', (t) => {
  const { dir } = fixture(t);
  const goalsPath = path.join(dir, 'GOALS.md');
  const leadupPath = path.join(dir, 'brief-leadup.md');
  writeFileSync(goalsPath, 'North star.');
  const sources = { goals: goalsPath, leadup: leadupPath };
  const now = new Date('2026-07-14T15:00:00.000Z');

  assert.equal(writeSourceCheckpoint({ sources, now, dataDir: dir }), true);
  writeFileSync(leadupPath, 'Leadup now exists.');
  assert.deepEqual(verifySourceCheckpoint({ sources, now, dataDir: dir }), {
    ok: false,
    reason: 'mismatch',
  });
});

test('old-format checkpoints without the new optional ids remain compatible', (t) => {
  const { dir } = fixture(t);
  const goalsPath = path.join(dir, 'GOALS.md');
  const operatorPath = path.join(dir, 'operator-profile.md');
  writeFileSync(goalsPath, 'North star.');
  const now = new Date('2026-07-14T15:00:00.000Z');

  assert.equal(writeSourceCheckpoint({ sources: { goals: goalsPath }, now, dataDir: dir }), true);
  writeFileSync(operatorPath, 'A source the old checkpoint did not know about.');
  assert.deepEqual(verifySourceCheckpoint({
    sources: { goals: goalsPath, operator_profile: operatorPath },
    now,
    dataDir: dir,
  }), { ok: true });
});

// ---------------------------------------------------------------------------
// Review finding 4: the earliest-finished same-key winner adopts the FULL
// canonical payload, but never under a plan that already consumed the brief.
// ---------------------------------------------------------------------------

test('an earlier same-key finisher replaces the full payload on an unpinned row', (t) => {
  const { store } = fixture(t);
  const laterJson = briefJson();
  const earlierJson = JSON.stringify({
    ...JSON.parse(laterJson),
    lensNarrative: 'The earlier finisher said something different.',
  });
  store.importMorningBrief(makeArtifact({ id: UUID_A, inputHash: 'K', finishedAt: '2026-07-14T15:00:00.000Z', json: laterJson }));
  const result = store.importMorningBrief(makeArtifact({ id: UUID_B, inputHash: 'K', finishedAt: '2026-07-14T14:00:00.000Z', json: earlierJson }));
  assert.deepEqual(result, { imported: false, adopted: false });
  const rows = store.listMorningBriefs(DATE);
  assert.equal(rows.length, 1);
  // Row identity is preserved; the winner's complete payload is adopted.
  assert.equal(rows[0].id, UUID_A);
  assert.equal(rows[0].finishedAt, '2026-07-14T14:00:00.000Z');
  assert.equal(JSON.parse(rows[0].briefJson).lensNarrative, 'The earlier finisher said something different.');
});

test('a brief already consumed by a plan is pinned: no payload swap under the arrival', (t) => {
  const { store } = fixture(t);
  const consumedJson = briefJson();
  const local = succeededArtifact(store, consumedJson, { inputHash: 'PIN' });
  const plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  assert.equal(plan.briefId, local.id);
  const rivalJson = JSON.stringify({
    ...JSON.parse(consumedJson),
    lensNarrative: 'A rival payload that must never surface.',
  });
  // Earlier finisher, same key — would win if unpinned.
  store.importMorningBrief(makeArtifact({ id: UUID_C, inputHash: 'PIN', finishedAt: '2026-07-14T11:00:00.000Z', json: rivalJson }));
  const kept = store.getMorningBrief(local.id);
  assert.equal(kept.briefJson, consumedJson);
  assert.equal(kept.finishedAt, local.finishedAt);
});

// ---------------------------------------------------------------------------
// Review finding 2: every real enqueue announces `queued` to the relay at once
// (never first at claim), killing the enqueue→claim duplicate window.
// ---------------------------------------------------------------------------

test('the scheduled lane publishes a queued attempt-status file at enqueue', (t) => {
  const { store, dir } = fixture(t);
  const prevTz = process.env.COVE_BRIEF_TIMEZONE;
  process.env.COVE_BRIEF_TIMEZONE = TZ;
  t.after(() => {
    if (prevTz === undefined) delete process.env.COVE_BRIEF_TIMEZONE;
    else process.env.COVE_BRIEF_TIMEZONE = prevTz;
  });
  const now = new Date('2026-07-14T20:00:00.000Z'); // 13:00 PT
  const brief = enqueueDueMorningBrief(store, now, { relay: { dataDir: dir, host: 'mini' } });
  assert.ok(brief, 'a brief was enqueued');
  const statusDir = path.join(dir, 'brief-relay', 'status');
  const files = readdirSync(statusDir);
  assert.deepEqual(files, [`${DATE}-mini-${brief.id}-queued.json`]);
  const status = JSON.parse(readFileSync(path.join(statusDir, files[0]), 'utf8'));
  assert.equal(status.state, 'queued');
  assert.equal(status.attempt_id, brief.id);
});

test('trigger-driven enqueues publish queued through the wrapped store (runtime path)', (t) => {
  const { store, dir } = fixture(t);
  const now = new Date('2026-07-14T20:00:00.000Z'); // 13:00 PT → today is DATE
  const plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  const wrapped = withQueuedAttemptStatus(store, { dataDir: dir, host: 'mbp' });
  maybeQueueMorningBrief(wrapped, 'ensure', { plan, replayed: false }, now);
  const statusDir = path.join(dir, 'brief-relay', 'status');
  const files = readdirSync(statusDir);
  assert.equal(files.length, 1);
  assert.match(files[0], new RegExp(`^${DATE}-mbp-.+-queued\\.json$`));
  // A second trigger while the attempt is still active enqueues nothing new.
  maybeQueueMorningBrief(wrapped, 'ensure', { plan, replayed: false }, now);
  assert.equal(readdirSync(statusDir).length, 1);
});

// ---------------------------------------------------------------------------
// Review finding 7: settlement relay strictness + epoch comparison.
// ---------------------------------------------------------------------------

test('a settlement relay missing as_of, written_at, or snapshot_ids is rejected', (t) => {
  const { dir } = fixture(t);
  const relayPath = path.join(dir, 'settlement-relay', 'latest.json');
  mkdirSync(path.dirname(relayPath), { recursive: true });
  const base = {
    relay_version: 1,
    content: '- 2026-07-13: completed=2 unresolved=none',
    as_of: '2026-07-13T09:00:00.000Z',
    snapshot_ids: ['snap-1'],
    written_at: '2026-07-13T09:00:00.000Z',
  };
  const writeVariant = (patch) => writeFileSync(relayPath, JSON.stringify({ ...base, ...patch }));
  writeVariant({});
  assert.ok(readSettlementRelay({ dataDir: dir }));
  writeVariant({ as_of: undefined });
  assert.equal(readSettlementRelay({ dataDir: dir }), undefined);
  writeVariant({ written_at: undefined });
  assert.equal(readSettlementRelay({ dataDir: dir }), undefined);
  writeVariant({ snapshot_ids: [] });
  assert.equal(readSettlementRelay({ dataDir: dir }), undefined);
  // Future-stamped files are rejected too (clock-skew hardening).
  writeVariant({ as_of: '2099-01-01T00:00:00.000Z', written_at: '2099-01-01T00:00:00.000Z' });
  assert.equal(readSettlementRelay({ dataDir: dir, now: new Date(CLOCK) }), undefined);
});

test('a newer local settlement beats an older relay by epoch comparison', async (t) => {
  const { dir } = fixture(t);
  const relayPath = path.join(dir, 'settlement-relay', 'latest.json');
  mkdirSync(path.dirname(relayPath), { recursive: true });
  writeFileSync(relayPath, JSON.stringify({
    relay_version: 1,
    content: '- 2026-07-10: completed=1 unresolved=none',
    as_of: '2026-07-10T09:00:00.000Z',
    snapshot_ids: ['snap-old'],
    written_at: '2026-07-10T09:00:00.000Z',
  }));
  const localStore = {
    listRecentSnapshots: () => [
      { id: 's-new', localDate: '2026-07-13', createdAt: '2026-07-13T09:00:00.000Z', body: { completedHumanTaskIds: ['t1'], unresolvedItems: [], nextDayRecommendationSeed: undefined } },
    ],
  };
  const collected = await collectMorningBriefSources({
    store: localStore,
    dataDir: dir,
    goalsPath: path.join(dir, 'missing-goals.md'),
    sprintMemoPath: path.join(dir, 'missing-memo.md'),
    fetchImpl: async () => ({ ok: true, json: async () => [] }),
  });
  const settlement = collected.sources.find((source) => source.id === 'settlement_summary');
  assert.match(settlement.content, /2026-07-13: completed=1/);
  assert.equal(settlement.asOf, '2026-07-13T09:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Review finding 8: settlement provenance excludes machine-recorded events.
// ---------------------------------------------------------------------------

test('humanDecisionEventIds exclude ensure, brief_attach, and arrival_interact', (t) => {
  const { store } = fixture(t);
  let plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  succeededArtifact(store, briefJson());
  plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() }).plan;
  assert.ok(plan.briefId, 'the late-attach fired');

  const mutate = (action, patch = {}) => {
    plan = store.mutateDayPlan({
      planId: plan.id,
      mutationId: `${action}:${plan.version}`,
      expectedVersion: plan.version,
      action,
      ...patch,
    }).plan;
  };
  mutate('arrival_open');
  store.markArrivalInteraction(plan.id, 'interact:1');
  plan = store.getPlan(plan.id);
  mutate('item_owner', { itemId: plan.items[0].id, owner: 'me' });
  mutate('start_day');
  mutate('settlement_start');
  mutate('settlement_decide', { itemId: plan.items[1].id, disposition: 'carry' });
  mutate('settlement_decide', { itemId: plan.items[2].id, disposition: 'drop' });
  const committed = store.mutateDayPlan({
    planId: plan.id,
    mutationId: 'commit:1',
    expectedVersion: plan.version,
    action: 'settlement_commit',
    completedHumanTaskIds: [plan.items[0].taskId],
  });
  const ids = committed.snapshot.body.humanDecisionEventIds;
  assert.equal(ids.includes('ensure:1'), false);
  assert.equal(ids.includes('ensure:2'), false, 'the brief_attach event is machine provenance');
  assert.equal(ids.includes('interact:1'), false, 'the interaction marker is not a decision');
  assert.equal(ids.some((id) => id.startsWith('item_owner:')), true);
  assert.equal(ids.some((id) => id.startsWith('start_day:')), true);
  assert.equal(ids.includes('commit:1'), true);
});

// ---------------------------------------------------------------------------
// Review finding 9: attach-only polling appends a ledger event only on a real
// attach; silent no-ops leave the ledger untouched.
// ---------------------------------------------------------------------------

test('attach-only ensure is a silent no-op until a brief attaches, then records exactly one event', (t) => {
  const { store } = fixture(t);
  const plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  const baseline = store.listEvents(plan.id).length;

  // Repeated polls with fresh mutation ids: no brief yet → nothing recorded.
  for (const id of ['poll:1', 'poll:2', 'poll:3']) {
    const result = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: id, candidates: candidatePool(), attachOnly: true });
    assert.equal(result.plan.version, plan.version);
    assert.equal(result.plan.briefId, undefined);
  }
  assert.equal(store.listEvents(plan.id).length, baseline);

  // The brief lands; the next poll attaches and records exactly one event.
  succeededArtifact(store, briefJson());
  const attached = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'poll:4', candidates: candidatePool(), attachOnly: true });
  assert.ok(attached.plan.briefId);
  assert.equal(attached.plan.version, plan.version + 1);
  const events = store.listEvents(plan.id);
  assert.equal(events.length, baseline + 1);
  assert.equal(events[events.length - 1].eventType, 'brief_attach');

  // Replaying the attach id stays idempotent; a reused silent-poll id stays silent.
  const replay = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'poll:4', candidates: candidatePool(), attachOnly: true });
  assert.equal(replay.replayed, true);
  const silent = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'poll:1', candidates: candidatePool(), attachOnly: true });
  assert.equal(silent.replayed, false);
  assert.equal(store.listEvents(plan.id).length, baseline + 1);
});

test('attach-only ensure never creates a plan', (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'poll:1', candidates: candidatePool(), attachOnly: true }),
    /Day plan/,
  );
  assert.equal(store.getReadModel().currentPlan, undefined);
});

// ---------------------------------------------------------------------------
// Live-acceptance gap: the one-shot init/visibility attach for the "brief
// finished while the app was closed" state — plan without a brief, generation
// IDLE, artifact already local. The interval poll never engages there; the
// shouldAttemptLateBriefAttach gate must fire exactly one attach-only ensure.
// ---------------------------------------------------------------------------

// Drives the client's init state machine against a real store: evaluate the
// gate off the read-model plan, fire at most one attach-only ensure when open.
function driveInitAttach(store, { interacted = false, mutationId = 'init-attach:1' } = {}) {
  const plan = store.getReadModel().currentPlan;
  let attempted = false;
  let ensuresFired = 0;
  const gate = () =>
    shouldAttemptLateBriefAttach({
      planState: plan?.state,
      arrivalState: plan?.arrivalState,
      hasConsumedBrief: Boolean(plan?.briefId),
      arrivalInteractedAt: plan?.arrivalInteractedAt,
      interacted,
      documentVisible: true,
      candidatesReady: true,
      candidateCount: candidatePool().length,
      alreadyAttempted: attempted,
    });
  if (gate()) {
    attempted = true;
    ensuresFired += 1;
    store.ensureDayPlan({
      localDate: DATE,
      timezone: TZ,
      mutationId,
      candidates: candidatePool(),
      attachOnly: true,
    });
  }
  return { ensuresFired, gateAfter: gate() };
}

test('init fires exactly one attach-only ensure for a pristine plan with an idle generation, and the brief attaches', (t) => {
  const { store } = fixture(t);
  let plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  // Arrival was opened (still pristine), then the app closed; the brief lands
  // afterward with no queued/running row — generation reads idle.
  plan = store.mutateDayPlan({ planId: plan.id, mutationId: 'open:1', expectedVersion: plan.version, action: 'arrival_open' }).plan;
  const artifact = succeededArtifact(store, briefJson());
  assert.equal(store.listMorningBriefs(DATE).some((row) => row.status === 'queued' || row.status === 'running'), false);

  const { ensuresFired, gateAfter } = driveInitAttach(store);
  assert.equal(ensuresFired, 1);
  assert.equal(gateAfter, false, 'the once-guard closes the gate after firing');

  const attached = store.getReadModel().currentPlan;
  assert.equal(attached.briefId, artifact.id);
  assert.equal(attached.version, plan.version + 1);
  // Re-running the init machine (a reload) fires nothing further: the brief is
  // consumed, so the gate stays closed even with the once-guard reset.
  const rerun = driveInitAttach(store, { mutationId: 'init-attach:2' });
  assert.equal(rerun.ensuresFired, 0);
});

test('negative: an interacted arrival fires no attach ensure, locally or via the durable marker', (t) => {
  const { store } = fixture(t);
  let plan = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:1', candidates: candidatePool() }).plan;
  plan = store.mutateDayPlan({ planId: plan.id, mutationId: 'open:1', expectedVersion: plan.version, action: 'arrival_open' }).plan;
  succeededArtifact(store, briefJson());

  // Local this-session interaction blocks the gate before any request.
  assert.equal(driveInitAttach(store, { interacted: true }).ensuresFired, 0);

  // The durable marker (set in an earlier session) blocks it too — and it is
  // visible on the read model, which is what the client gate reads.
  store.markArrivalInteraction(plan.id, 'interact:1');
  const marked = store.getReadModel().currentPlan;
  assert.ok(marked.arrivalInteractedAt, 'the read model exposes arrival_interacted_at');
  assert.equal(driveInitAttach(store).ensuresFired, 0);
  assert.equal(store.getReadModel().currentPlan.briefId, undefined);
});

test('the attach gate matrix: visibility, candidates, plan state, and arrival state all gate', () => {
  const base = {
    planState: 'proposed',
    arrivalState: 'due',
    hasConsumedBrief: false,
    arrivalInteractedAt: undefined,
    interacted: false,
    documentVisible: true,
    candidatesReady: true,
    candidateCount: 3,
    alreadyAttempted: false,
  };
  assert.equal(shouldAttemptLateBriefAttach(base), true);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, arrivalState: 'opened' }), true);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, documentVisible: false }), false);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, candidateCount: 0 }), false);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, candidatesReady: false }), false);
  assert.equal(shouldAttemptLateBriefAttach({
    ...base,
    candidateCount: 0,
    candidatesReady: false,
    generationState: 'succeeded',
  }), true);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, planState: 'settling' }), false);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, arrivalState: 'confirmed' }), false);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, alreadyAttempted: true }), false);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, hasConsumedBrief: true }), false);
  assert.equal(shouldAttemptLateBriefAttach({ ...base, arrivalInteractedAt: CLOCK }), false);
});

// ---------------------------------------------------------------------------
// Orphan upgrade: a better brief written after the arrival was built.
// ---------------------------------------------------------------------------

test('a plan upgrades to a strictly newer brief instead of orphaning it', (t) => {
  const { store, setNow } = planThenBrief(t);
  const first = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() }).plan;
  assert.ok(first.briefId);

  // He settles last night at 11pm and the regenerated brief lands afterwards.
  // Without the upgrade this artifact is written, paid for, and never read.
  setNow('2026-07-14T15:00:00.000Z');
  const better = succeededArtifact(store, briefJson(), { inputHash: 'after-settlement' });
  const upgraded = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:3', candidates: candidatePool() }).plan;
  assert.equal(upgraded.briefId, better.id);
  assert.equal(upgraded.version, first.version + 1);
  assert.ok(store.listEvents(upgraded.id).some((event) => event.eventType === 'brief_attach'));
});

test('an older brief that finishes last never clobbers the newer one', (t) => {
  const { store, setNow } = planThenBrief(t);
  setNow('2026-07-14T15:00:00.000Z');
  const newest = succeededArtifact(store, briefJson(), { inputHash: 'newest-request' });
  const attached = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() }).plan;
  assert.equal(attached.briefId, newest.id);

  // A generation requested at 7:30am that only finished at 4pm. It saw less of
  // the world than the 11am request, so finish order is the wrong ordering and
  // selection must go by request time.
  store.importMorningBrief(makeArtifact({
    id: 'slow-old-run',
    inputHash: 'earliest-request',
    createdAt: '2026-07-14T12:00:00.000Z',
    startedAt: '2026-07-14T12:30:00.000Z',
    finishedAt: '2026-07-14T16:00:00.000Z',
  }));
  assert.equal(
    store.latestEligibleMorningBrief(DATE).id,
    newest.id,
    'selection is by request time; finish-time ordering would pick the stale one',
  );

  const after = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:3', candidates: candidatePool() }).plan;
  assert.equal(after.briefId, newest.id);
  assert.equal(after.version, attached.version, 'nothing changed, so nothing bumped');
});

test('the no-hot-swap rule outranks the upgrade: a touched arrival never changes underneath him', (t) => {
  const { store, setNow } = planThenBrief(t);
  const first = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:2', candidates: candidatePool() }).plan;
  store.markArrivalInteraction(first.id, 'interact:1');
  setNow('2026-07-14T15:00:00.000Z');
  succeededArtifact(store, briefJson(), { inputHash: 'too-late' });
  const after = store.ensureDayPlan({ localDate: DATE, timezone: TZ, mutationId: 'ensure:3', candidates: candidatePool() }).plan;
  assert.equal(after.briefId, first.briefId);
});
