import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { applyDedupePlan, buildDedupePlan } from '../scripts/cove-contact-dedupe.mjs';
import { openLocalDatabase } from '../src/lib/local/database.ts';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-dedupe-'));
  const dbPath = path.join(dir, 'cove.db');
  openLocalDatabase(dbPath).close();
  return { dir, dbPath };
}

function contact(db, id, name, email, phone, created = '2026-01-01') {
  db.prepare(`INSERT INTO contacts
    (id, name, email, normalized_email, phone, tags, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '[]', '', ?, ?)`)
    .run(id, name, email, email?.toLowerCase() ?? null, phone, created, created);
}

test('dedupe plan groups name, phone, and alias duplicates and dry run writes nothing', () => {
  const { dbPath } = fixture();
  const db = openLocalDatabase(dbPath);
  try {
    contact(db, 'name-a', 'Taylor Reed', 'ta@example.com', null);
    contact(db, 'name-b', 'TAYLOR REED', 'tb@example.com', null);
    contact(db, 'phone-a', 'Phone One', 'pa@example.com', '(310) 555-1000');
    contact(db, 'phone-b', 'Phone Two', 'pb@example.com', '3105551000');
    contact(db, 'alias-a', 'Alias One', 'aa@example.com', null);
    contact(db, 'alias-b', 'Alias Two', 'shared@example.com', null);
    db.prepare(`INSERT INTO contact_emails
      (id, contact_id, email, normalized_email, is_primary, created_at)
      VALUES ('shared-alias', 'alias-a', 'shared@example.com', 'shared@example.com', 0, '2026-01-01')`).run();
    db.prepare(`INSERT INTO contact_activities
      (id, contact_id, activity_type, title, metadata, created_at, updated_at)
      VALUES ('activity', 'name-b', 'note', 'History', '{}', '2026-01-02', '2026-01-02')`).run();
  } finally {
    db.close();
  }
  const readOnly = new Database(dbPath, { readonly: true });
  const plan = buildDedupePlan(readOnly, '2026-09-02T00:00:00.000Z');
  readOnly.close();
  assert.equal(plan.groups.length, 3);
  assert.deepEqual(plan.groups.map((group) => group.contacts.map((entry) => entry.id).sort()).sort(), [
    ['alias-a', 'alias-b'], ['name-a', 'name-b'], ['phone-a', 'phone-b'],
  ]);
  assert.equal(plan.groups.find((group) => group.contacts.some((entry) => entry.id === 'name-a')).suggestedWinnerId, 'name-b');
  const check = openLocalDatabase(dbPath);
  assert.equal(check.prepare('SELECT count(*) FROM contacts').pluck().get(), 6);
  check.close();
  const planPath = path.join(path.dirname(dbPath), 'dedupe-plan.json');
  execFileSync(process.execPath, [
    '--import', 'tsx', path.resolve('scripts/cove-contact-dedupe.mjs'),
    '--write-plan', planPath,
  ], { env: { ...process.env, COVE_DB_PATH: dbPath } });
  assert.equal(JSON.parse(readFileSync(planPath, 'utf8')).groups.length, 3);
  const afterCli = openLocalDatabase(dbPath);
  assert.equal(afterCli.prepare('SELECT count(*) FROM contacts').pluck().get(), 6);
  afterCli.close();
});

test('apply merges only approved groups, backs up once, and records a receipt', async () => {
  const { dir, dbPath } = fixture();
  const db = openLocalDatabase(dbPath);
  try {
    contact(db, 'approved-a', 'Approved', 'a@example.com', null);
    contact(db, 'approved-b', 'Approved', 'b@example.com', null);
    contact(db, 'held-a', 'Held', 'c@example.com', null);
    contact(db, 'held-b', 'Held', 'd@example.com', null);
  } finally { db.close(); }
  const inspect = new Database(dbPath, { readonly: true });
  const plan = buildDedupePlan(inspect);
  inspect.close();
  const approved = plan.groups.find((group) => group.contacts.some((entry) => entry.id === 'approved-a'));
  approved.approved = true;
  approved.winnerId = 'approved-a';
  assert.deepEqual(await applyDedupePlan(dbPath, plan), ['merged']);
  const check = openLocalDatabase(dbPath);
  try {
    assert.equal(check.prepare('SELECT count(*) FROM contacts').pluck().get(), 3);
    assert.equal(check.prepare("SELECT count(*) FROM contacts WHERE name = 'Held'").pluck().get(), 2);
    assert.equal(check.prepare("SELECT count(*) FROM cove_receipts WHERE source = 'contact-dedupe'").pluck().get(), 1);
  } finally { check.close(); }
  assert.equal(existsSync(path.join(dir, 'backups')), true);
  assert.equal(readdirSync(path.join(dir, 'backups')).filter((name) => name.endsWith('.db')).length, 1);
});

test('apply refuses stale groups and open-deal collisions', async () => {
  for (const mode of ['stale', 'collision']) {
    const { dbPath } = fixture();
    const db = openLocalDatabase(dbPath);
    try {
      contact(db, `${mode}-a`, mode, `${mode}-a@example.com`, null);
      contact(db, `${mode}-b`, mode, `${mode}-b@example.com`, null);
      if (mode === 'collision') {
        const insert = db.prepare(`INSERT INTO pipeline_deals
          (id, contact_id, stage, next_action, source, notes, stage_changed_at, created_at, updated_at)
          VALUES (?, ?, 'interested', '', '', '', '2026-01-01', '2026-01-01', '2026-01-01')`);
        insert.run('deal-a', `${mode}-a`);
        insert.run('deal-b', `${mode}-b`);
      }
    } finally { db.close(); }
    const inspect = new Database(dbPath, { readonly: true });
    const plan = buildDedupePlan(inspect);
    inspect.close();
    plan.groups[0].approved = true;
    plan.groups[0].winnerId = `${mode}-a`;
    if (mode === 'stale') {
      const change = openLocalDatabase(dbPath);
      change.prepare("UPDATE contacts SET updated_at = '2026-02-01' WHERE id = 'stale-b'").run();
      change.close();
    }
    assert.deepEqual(await applyDedupePlan(dbPath, plan), [mode]);
    const check = openLocalDatabase(dbPath);
    assert.equal(check.prepare('SELECT count(*) FROM contacts').pluck().get(), 2);
    check.close();
  }
});

test('dedupe backup opens cleanly and contains the pre-merge contacts', async () => {
  const { dir, dbPath } = fixture();
  const live = openLocalDatabase(dbPath);
  try {
    live.pragma('wal_autocheckpoint = 0');
    contact(live, 'winner', 'Duplicate', 'winner@example.com', null);
    contact(live, 'loser', 'Duplicate', 'loser@example.com', null);
    const inspect = new Database(dbPath, { readonly: true });
    const plan = buildDedupePlan(inspect);
    inspect.close();
    plan.groups[0].approved = true;
    plan.groups[0].winnerId = 'winner';
    assert.deepEqual(await applyDedupePlan(dbPath, plan), ['merged']);
  } finally {
    live.close();
  }
  const backupFiles = readdirSync(path.join(dir, 'backups'));
  const backupName = backupFiles.find((name) => name.endsWith('.db'));
  assert.ok(backupName);
  assert.equal(backupFiles.some((name) => name.endsWith('-shm') || name.endsWith('-wal')), false);
  const backup = new Database(path.join(dir, 'backups', backupName), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(
      backup.prepare('SELECT id FROM contacts ORDER BY id').pluck().all(),
      ['loser', 'winner'],
    );
  } finally {
    backup.close();
  }
});
