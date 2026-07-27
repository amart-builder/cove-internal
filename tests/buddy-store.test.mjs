import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createBuddyStore, getBuddyStore } from '../src/lib/buddy/store.ts';

function setup(t) {
  const file = path.join(os.tmpdir(), `forge-buddy-${process.pid}-${Date.now()}-${Math.random()}.db`);
  let now = new Date('2026-07-15T20:00:00.000Z');
  const store = createBuddyStore({ dbPath: file, now: () => now });
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
  return { store, advance: (milliseconds) => { now = new Date(now.getTime() + milliseconds); } };
}

test('Buddy store enforces one running turn and records completion totals', (t) => {
  const { store } = setup(t);
  const turn = store.claimTurn({
    userText: 'Hello', pageContext: { view: 'tasks' }, model: 'sonnet', effort: 'medium',
    routerReason: 'General conversation',
  });
  assert.ok(turn);
  assert.equal(store.claimTurn({
    userText: 'Second', pageContext: null, model: 'sonnet', effort: 'low',
    routerReason: 'Short action',
  }), null);
  assert.equal(store.resetBuddySession(), null);
  const finished = store.completeTurn(turn.id, {
    state: 'succeeded', assistant_text: 'Hi', session_id: 'session-1', cost_usd: 0.25,
  });
  assert.equal(finished.state, 'succeeded');
  assert.deepEqual(store.getBuddyState(), {
    headSessionId: 'session-1', createdAt: '2026-07-15T20:00:00.000Z',
    turnCount: 1, totalCostUsd: 0.25,
  });
});

test('a swept turn cannot advance the session head when its late result arrives', (t) => {
  const { store, advance } = setup(t);
  store.setHeadSession('existing-head');
  const turn = store.claimTurn({
    userText: 'Slow turn', pageContext: null, model: 'sonnet', effort: 'medium',
    routerReason: 'General conversation',
  });
  advance(7 * 60_000);
  assert.equal(store.sweepStaleTurns(6 * 60_000), 1);
  const late = store.completeTurn(turn.id, {
    state: 'succeeded', assistant_text: 'Late answer', session_id: 'late-session', cost_usd: 0.1,
  });
  assert.equal(late.state, 'failed');
  assert.equal(store.getBuddyState().headSessionId, 'existing-head');
  assert.equal(store.getBuddyState().totalCostUsd, 0);
});

test('reset marks a boundary without deleting history and stale turns are interrupted', (t) => {
  const { store, advance } = setup(t);
  store.setHeadSession('old-session');
  const completed = store.claimTurn({
    userText: 'Finished', pageContext: null, model: 'sonnet', effort: 'medium',
    routerReason: 'General conversation',
  });
  store.completeTurn(completed.id, {
    state: 'succeeded', assistant_text: 'Done', session_id: 'old-session', cost_usd: 0.3,
  });
  const turn = store.claimTurn({
    userText: 'Waiting', pageContext: null, model: 'opus', effort: 'high',
    routerReason: 'Planning request',
  });
  advance(7 * 60_000);
  assert.equal(store.sweepStaleTurns(6 * 60_000), 1);
  assert.equal(store.getTurn(turn.id).error_code, 'interrupted');
  const reset = store.resetBuddySession();
  assert.equal(reset.headSessionId, null);
  assert.equal(reset.createdAt, '2026-07-15T20:07:00.000Z');
  assert.equal(reset.turnCount, 0);
  assert.equal(reset.totalCostUsd, 0);
  assert.equal(store.listRecentTurns().length, 2);
});

test('pending delete tokens are exact, expiring, and single-use', (t) => {
  const { store, advance } = setup(t);
  const first = store.mintPendingDelete({ table: 'contacts', rowId: 'c1', label: 'Jane' });
  assert.deepEqual(store.consumePendingDelete({ token: first.token, table: 'contacts', rowId: 'wrong' }), {
    ok: false, error: 'mismatch',
  });
  assert.equal(store.consumePendingDelete({ token: first.token, table: 'contacts', rowId: 'c1' }).ok, true);
  assert.deepEqual(store.consumePendingDelete({ token: first.token, table: 'contacts', rowId: 'c1' }), {
    ok: false, error: 'consumed',
  });
  const second = store.mintPendingDelete({ table: 'tasks', rowId: 't1', label: 'Old task' });
  advance(10 * 60_000 + 1);
  assert.deepEqual(store.consumePendingDelete({ token: second.token, table: 'tasks', rowId: 't1' }), {
    ok: false, error: 'expired',
  });
});

test('store initialization immediately fails running turns from an earlier process', (t) => {
  const file = path.join(os.tmpdir(), `forge-buddy-restart-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const firstNow = new Date('2026-07-15T20:00:00.000Z');
  const first = createBuddyStore({
    dbPath: file,
    now: () => firstNow,
    processStartedAt: new Date('2026-07-15T19:59:00.000Z'),
  });
  const turn = first.claimTurn({
    userText: 'Still running', pageContext: null, model: 'sonnet', effort: 'medium',
    routerReason: 'Restart test',
  });
  first.close();

  const second = createBuddyStore({
    dbPath: file,
    now: () => new Date('2026-07-15T20:01:00.000Z'),
    processStartedAt: new Date('2026-07-15T20:00:30.000Z'),
  });
  assert.equal(second.getTurn(turn.id).state, 'failed');
  assert.equal(second.getTurn(turn.id).error_code, 'orphaned_on_restart');
  assert.equal(second.getBuddyState().turnCount, 1);
  second.close();
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
});

test('store initialization preserves a running turn started after this process', (t) => {
  const file = path.join(os.tmpdir(), `forge-buddy-hmr-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const first = createBuddyStore({
    dbPath: file,
    now: () => new Date('2026-07-15T20:01:00.000Z'),
    processStartedAt: new Date('2026-07-15T19:59:00.000Z'),
  });
  const turn = first.claimTurn({
    userText: 'Still active', pageContext: null, model: 'sonnet', effort: 'medium',
    routerReason: 'HMR guard test',
  });
  first.close();

  const reopened = createBuddyStore({
    dbPath: file,
    now: () => new Date('2026-07-15T20:02:00.000Z'),
    processStartedAt: new Date('2026-07-15T20:00:30.000Z'),
  });
  assert.equal(reopened.getTurn(turn.id).state, 'running');
  assert.equal(reopened.getTurn(turn.id).error_code, null);
  assert.equal(reopened.getBuddyState().turnCount, 0);
  reopened.close();
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
});

test('store initialization retains the newest 500 turns and removes old auxiliary rows', (t) => {
  const file = path.join(os.tmpdir(), `forge-buddy-retention-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const initial = createBuddyStore({
    dbPath: file,
    now: () => new Date('2026-07-15T20:00:00.000Z'),
    processStartedAt: new Date('2026-07-15T19:59:00.000Z'),
  });
  initial.close();

  const seed = new Database(file);
  const insertTurn = seed.prepare(`INSERT INTO buddy_turns
    (id, user_text, page_context, model, effort, router_reason, state, assistant_text,
      cost_usd, started_at, finished_at)
    VALUES (?, 'old', 'null', 'sonnet', 'low', 'retention', 'failed', '', 0, ?, ?)`);
  const insertTurns = seed.transaction(() => {
    for (let index = 0; index < 505; index += 1) {
      const startedAt = new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString();
      insertTurn.run(`old-${String(index).padStart(3, '0')}`, startedAt, startedAt);
    }
    insertTurn.run('recent', '2026-07-15T19:00:00.000Z', '2026-07-15T19:00:01.000Z');
  });
  insertTurns();
  seed.prepare(`INSERT INTO buddy_pending_deletes
    (token, table_name, row_id, label, consumed_at, expires_at) VALUES (?, 'tasks', ?, 'row', NULL, ?)`)
    .run('old-token', 'old', '2026-05-01T00:10:00.000Z');
  seed.prepare(`INSERT INTO buddy_pending_deletes
    (token, table_name, row_id, label, consumed_at, expires_at) VALUES (?, 'tasks', ?, 'row', NULL, ?)`)
    .run('recent-token', 'recent', '2026-07-15T20:10:00.000Z');
  seed.prepare(`INSERT INTO buddy_spawned_sessions
    (id, session_id, dir, title, state, error, created_at) VALUES (?, ?, '/tmp', 'session', 'ready', NULL, ?)`)
    .run('old-session-row', 'old-session', '2026-05-01T00:00:00.000Z');
  seed.prepare(`INSERT INTO buddy_spawned_sessions
    (id, session_id, dir, title, state, error, created_at) VALUES (?, ?, '/tmp', 'session', 'ready', NULL, ?)`)
    .run('recent-session-row', 'recent-session', '2026-07-15T19:00:00.000Z');
  seed.close();

  const swept = createBuddyStore({
    dbPath: file,
    now: () => new Date('2026-07-15T20:00:00.000Z'),
    processStartedAt: new Date('2026-07-15T19:59:00.000Z'),
  });
  swept.close();
  const inspect = new Database(file, { readonly: true });
  assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM buddy_turns').get().count, 500);
  assert.ok(inspect.prepare("SELECT 1 FROM buddy_turns WHERE id = 'recent'").get());
  assert.deepEqual(inspect.prepare('SELECT token FROM buddy_pending_deletes ORDER BY token').all(), [
    { token: 'recent-token' },
  ]);
  assert.deepEqual(inspect.prepare('SELECT session_id FROM buddy_spawned_sessions ORDER BY session_id').all(), [
    { session_id: 'recent-session' },
  ]);
  inspect.close();
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
});

test('Buddy store migrates legacy tables that are missing current columns', (t) => {
  const file = path.join(os.tmpdir(), `forge-buddy-legacy-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE buddy_state (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);
    INSERT INTO buddy_state (id, created_at) VALUES (1, '2026-07-01T00:00:00.000Z');
    CREATE TABLE buddy_turns (
      id TEXT PRIMARY KEY,
      user_text TEXT NOT NULL,
      state TEXT NOT NULL,
      assistant_text TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);
  legacy.close();

  const store = createBuddyStore({ dbPath: file });
  const turn = store.claimTurn({
    userText: 'Migrated', pageContext: { view: 'tasks' }, model: 'sonnet', effort: 'low',
    routerReason: 'Migration test',
  });
  assert.ok(turn);
  assert.equal(turn.page_context, '{"view":"tasks"}');
  store.finishTurn(turn.id, { state: 'succeeded', assistant_text: 'Done', receipts_json: '{"changes":[]}' });
  store.close();

  const migrated = new Database(file, { readonly: true });
  const stateColumns = new Set(migrated.prepare('PRAGMA table_info(buddy_state)').all().map((row) => row.name));
  const turnColumns = new Set(migrated.prepare('PRAGMA table_info(buddy_turns)').all().map((row) => row.name));
  migrated.close();
  for (const column of ['head_session_id', 'created_at', 'turn_count', 'total_cost_usd']) {
    assert.ok(stateColumns.has(column), `missing buddy_state.${column}`);
  }
  for (const column of [
    'page_context', 'model', 'effort', 'router_reason', 'receipts_json', 'session_id', 'cost_usd', 'error_code',
  ]) {
    assert.ok(turnColumns.has(column), `missing buddy_turns.${column}`);
  }
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
});

test('getBuddyStore replaces an HMR-stale singleton whose API predates completeTurn', (t) => {
  const previousPath = process.env.FORGE_DB_PATH;
  const previousStore = globalThis.__forgeBuddyStore;
  const currentFile = path.join(os.tmpdir(), `forge-buddy-current-${process.pid}-${Date.now()}.db`);
  const staleFile = path.join(os.tmpdir(), `forge-buddy-stale-${process.pid}-${Date.now()}.db`);
  const staleStore = createBuddyStore({ dbPath: staleFile });
  delete staleStore.completeTurn;
  globalThis.__forgeBuddyStore = staleStore;
  delete globalThis.__forgeBuddyStoreVersion;
  process.env.FORGE_DB_PATH = currentFile;
  t.after(() => {
    const currentStore = globalThis.__forgeBuddyStore;
    if (currentStore && currentStore !== staleStore) currentStore.close();
    if (staleStore.getBuddyState) staleStore.close();
    if (previousStore) globalThis.__forgeBuddyStore = previousStore;
    else delete globalThis.__forgeBuddyStore;
    delete globalThis.__forgeBuddyStoreVersion;
    if (previousPath === undefined) delete process.env.FORGE_DB_PATH;
    else process.env.FORGE_DB_PATH = previousPath;
    for (const file of [currentFile, staleFile]) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    }
  });

  const currentStore = getBuddyStore();
  assert.notEqual(currentStore, staleStore);
  assert.equal(typeof currentStore.completeTurn, 'function');
});
