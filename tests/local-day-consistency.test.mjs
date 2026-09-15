import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localDateKey, localDayBounds, nextLocalMorning } from '../src/lib/local-time.mjs';
import { completedTasksForToday } from '../src/lib/day-plan/presentation.ts';
import { createWorkSuggestion, resolveWorkSuggestion, setQuietCurrentNowForTests, setQuietCurrentStorePathForTests } from '../src/lib/quiet-current/store.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { dailyAttentionUsage } from '../src/lib/attention/ledger.mjs';

test('local day boundaries and morning return follow spring and fall clock changes', () => {
  const zone = 'America/Los_Angeles';
  assert.deepEqual(localDayBounds(new Date('2026-03-08T20:00:00Z'), zone), { start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z' });
  assert.deepEqual(localDayBounds(new Date('2026-11-01T20:00:00Z'), zone), { start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' });
  assert.equal(nextLocalMorning(new Date('2026-03-08T07:00:00Z'), zone).toISOString(), '2026-03-08T12:00:00.000Z');
  assert.equal(nextLocalMorning(new Date('2026-11-01T06:00:00Z'), zone).toISOString(), '2026-11-01T13:00:00.000Z');
  assert.equal(nextLocalMorning(new Date('2026-09-15T20:00:00Z'), 'Asia/Tokyo').toISOString(), '2026-09-16T20:00:00.000Z');
  // Chile skips midnight when spring DST begins; the day starts at 01:00.
  assert.deepEqual(localDayBounds(new Date('2026-09-06T15:00:00Z'), 'America/Santiago'), { start: '2026-09-06T04:00:00.000Z', end: '2026-09-07T03:00:00.000Z' });
});

test('Done today uses the plan timezone across UTC date changes', () => {
  const tasks = [
    { id: 'today', status: 'done', updatedAt: Date.parse('2026-09-16T01:00:00Z') },
    { id: 'yesterday', columnId: 'done', updatedAt: Date.parse('2026-09-15T06:00:00Z') },
    { id: 'open', status: 'open', updatedAt: Date.parse('2026-09-16T01:00:00Z') },
  ];
  const now = new Date('2026-09-16T02:00:00Z');
  assert.equal(localDateKey(now, 'America/Los_Angeles'), '2026-09-15');
  assert.deepEqual(completedTasksForToday(tasks, 'done', 'America/Los_Angeles', now).map(row => row.id), ['today']);
});

test('Quiet Current return and attention quotas use the operator timezone on a different-zone host', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-local-clock-'));
  const keys = ['COVE_PROFILE_PATH', 'COVE_TIMEZONE', 'TZ'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.COVE_PROFILE_PATH = path.join(dir, 'profile.json');
  writeFileSync(process.env.COVE_PROFILE_PATH, JSON.stringify({ timezone: 'Asia/Tokyo' }));
  process.env.TZ = 'UTC';
  setQuietCurrentStorePathForTests(path.join(dir, 'quiet-current.json'));
  const now = new Date('2026-09-15T16:00:00Z'); // Tokyo 01:00 September 16.
  setQuietCurrentNowForTests(now);
  const db = openLocalDatabase(path.join(dir, 'ledger.db'));
  t.after(() => {
    db.close();
    setQuietCurrentNowForTests(undefined);
    setQuietCurrentStorePathForTests(undefined);
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  });
  const item = createWorkSuggestion({ title: 'Review idea', reason: 'Useful work', source: 'fixture' });
  assert.equal(resolveWorkSuggestion(item.id, { state: 'deferred', source: 'human' }).deferredUntil, '2026-09-15T20:00:00.000Z');
  const insert = db.prepare("INSERT INTO cove_attention_ledger(id,kind,ref_kind,ref_id,level,reason,delivered_at,created_at) VALUES(?, 'floor_nudge', 'task', ?, 'banner', 'fixture', ?, ?)");
  insert.run('old', 'old', '2026-09-15T14:00:00Z', '2026-09-15T14:00:00Z');
  insert.run('current', 'current', '2026-09-15T15:30:00Z', '2026-09-15T15:30:00Z');
  assert.equal(dailyAttentionUsage(db, now).banners, 1);
});

test('installer backup-success path is resolved from the actual backup setting', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-backup-label-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.env.local'), 'COVE_DATA_DIR="private-data"\nCOVE_BACKUP_DIR="private-recovery"\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COVE|FORGE)_/.test(key)));
  const result = spawnSync(process.execPath, [path.resolve('scripts/lib/cove-install-runtime.mjs'), dir, 'backupDir'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, path.join(dir, 'private-recovery'));
  const installer = readFileSync(new URL('../scripts/install-cove-local.sh', import.meta.url), 'utf8');
  assert.match(installer, /COVE_BACKUP_DIR="\$\("\$NODE_REAL" "\$INSTALL_RUNTIME" "\$REPO_DIR" backupDir\)"/);
  assert.match(installer, /Daily database backups: \$COVE_BACKUP_DIR/);
});
