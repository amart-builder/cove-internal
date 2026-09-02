import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mergeContactAtomic } from '../src/lib/crm/merge.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';

test('forced CRM merge failure rolls back pipeline reparent on the same connection', () => {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'cove-merge-atomic-')), 'cove.db');
  const db = openLocalDatabase(dbPath);
  try {
    const now = '2026-09-02T16:00:00.000Z';
    for (const id of ['winner', 'loser']) {
      db.prepare(`INSERT INTO contacts (id, name, tags, notes, created_at, updated_at)
        VALUES (?, ?, '[]', '', ?, ?)`).run(id, id, now, now);
    }
    db.prepare(`INSERT INTO pipeline_deals
      (id, contact_id, stage, next_action, source, notes, stage_changed_at, created_at, updated_at)
      VALUES ('deal', 'loser', 'interested', '', '', '', ?, ?, ?)`).run(now, now, now);
    db.exec(`CREATE TRIGGER force_contact_merge_failure
      BEFORE DELETE ON contacts WHEN OLD.id = 'loser'
      BEGIN SELECT RAISE(ABORT, 'forced CRM merge failure'); END;`);
  } finally {
    db.close();
  }
  assert.throws(() => mergeContactAtomic({
    winnerId: 'winner', loserId: 'loser', dbPath,
  }), /forced CRM merge failure/);
  const check = openLocalDatabase(dbPath);
  try {
    assert.equal(check.prepare("SELECT contact_id FROM pipeline_deals WHERE id = 'deal'").pluck().get(), 'loser');
    assert.equal(check.prepare("SELECT count(*) FROM contacts").pluck().get(), 2);
  } finally {
    check.close();
  }
});

test("merging promotes the loser's raw and normalized email", () => {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'cove-merge-email-')), 'cove.db');
  const now = '2026-09-02T16:00:00.000Z';
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(`INSERT INTO contacts (id, name, tags, notes, created_at, updated_at)
      VALUES ('winner', 'Winner', '[]', '', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO contacts
      (id, name, email, normalized_email, tags, notes, created_at, updated_at)
      VALUES ('loser', 'Loser', 'Loser.Person+Tag@Example.COM',
              'loser.person+tag@example.com', '[]', '', ?, ?)`).run(now, now);
  } finally {
    db.close();
  }
  mergeContactAtomic({ winnerId: 'winner', loserId: 'loser', dbPath, now: new Date(now) });
  const check = openLocalDatabase(dbPath);
  try {
    assert.deepEqual(
      check.prepare('SELECT email, normalized_email FROM contacts WHERE id = ?').get('winner'),
      {
        email: 'Loser.Person+Tag@Example.COM',
        normalized_email: 'loser.person+tag@example.com',
      },
    );
  } finally {
    check.close();
  }
});
