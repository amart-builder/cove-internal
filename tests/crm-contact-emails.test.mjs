import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { LocalCRMBackend } from '../src/lib/crm/index.ts';
import { normalizeContactName } from '../src/lib/crm/identity.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-emails-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  const backend = new LocalCRMBackend({
    dbPath,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
  });
  t.after(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, dbPath, dir };
}

function addSecondaryEmail(dbPath, contactId, email) {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO contact_emails
         (id, contact_id, email, normalized_email, is_primary, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(
      `alias-${email}`,
      contactId,
      email,
      email,
      '2026-08-03T12:00:00.000Z',
    );
  } finally {
    db.close();
  }
}

test('a second known address resolves to the same contact', (t) => {
  const { backend, dbPath } = fixture(t);
  const created = backend.resolveOrCreateContact({
    name: 'Sarah Chen',
    email: 'sarah@work.com',
    source: 'email',
  });
  assert.equal(created.status, 'created');
  addSecondaryEmail(dbPath, created.contact.id, 'sarah@personal.com');

  const matched = backend.resolveOrCreateContact({
    name: 'Sarah Chen',
    email: 'SARAH@Personal.com ',
    source: 'email',
  });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.contact.id, created.contact.id);
  assert.equal(matched.contact.email, 'sarah@work.com');
  assert.equal(backend.listContacts().length, 1);

  assert.deepEqual(
    backend.findByNormalizedEmail('sarah@personal.com')
      .map((contact) => contact.id),
    [created.contact.id],
  );
});

test('an unknown address with a matching clean name stays ambiguous', (t) => {
  const { backend } = fixture(t);
  const created = backend.resolveOrCreateContact({
    name: 'Sarah Chen',
    email: 'sarah@work.com',
    source: 'email',
  });
  assert.equal(created.status, 'created');

  const result = backend.resolveOrCreateContact({
    name: 'Sarah Chen',
    email: 'sarah@newco.com',
    source: 'email',
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map((item) => item.id), [created.contact.id]);
  assert.equal(backend.listContacts().length, 1);
});

test('an email-less name match locks the first email into both tables', (t) => {
  const { backend, dbPath } = fixture(t);
  const seeded = backend.resolveOrCreateContact({
    name: 'John Smith',
    source: 'manual',
  });
  assert.equal(seeded.status, 'created');

  const locked = backend.resolveOrCreateContact({
    name: 'John Smith',
    email: 'John@Acme.com',
    source: 'email',
  });
  assert.equal(locked.status, 'matched');
  assert.equal(locked.contact.email, 'john@acme.com');

  const db = new Database(dbPath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare(
      `SELECT contact_id, normalized_email, is_primary
       FROM contact_emails`,
    ).all(),
    [{
      contact_id: seeded.contact.id,
      normalized_email: 'john@acme.com',
      is_primary: 1,
    }],
  );
});

test('the contact_emails migration backfills a populated database', (t) => {
  const { dbPath } = fixture(t);
  const db = new Database(dbPath);
  const insert = db.prepare(
    `INSERT INTO contacts
       (id, name, normalized_name, email, normalized_email, tier, tags, notes,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'C', '[]', '', ?, ?)`,
  );
  insert.run(
    'backfill-1',
    'Backfill One',
    normalizeContactName('Backfill One'),
    'One@Example.com',
    'one@example.com',
    '2026-08-01T00:00:00.000Z',
    '2026-08-01T00:00:00.000Z',
  );
  insert.run(
    'backfill-2',
    'Backfill Two',
    normalizeContactName('Backfill Two'),
    null,
    null,
    '2026-08-02T00:00:00.000Z',
    '2026-08-02T00:00:00.000Z',
  );
  // Legacy duplicate address across two contacts.
  insert.run(
    'backfill-3',
    'Backfill Three',
    normalizeContactName('Backfill Three'),
    'shared@example.com',
    'shared@example.com',
    '2026-08-01T01:00:00.000Z',
    '2026-08-01T01:00:00.000Z',
  );
  insert.run(
    'backfill-4',
    'Backfill Four',
    normalizeContactName('Backfill Four'),
    'shared@example.com',
    'shared@example.com',
    '2026-08-01T02:00:00.000Z',
    '2026-08-01T02:00:00.000Z',
  );
  db.exec(`
    DELETE FROM contact_emails;
    DELETE FROM cove_schema_migrations WHERE version = 14;
    DROP TABLE contact_emails;
  `);
  db.close();

  openLocalDatabase(dbPath).close();
  const inspect = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      inspect.prepare(
        `SELECT contact_id, email, normalized_email, is_primary
         FROM contact_emails
         ORDER BY contact_id`,
      ).all(),
      [
        {
          contact_id: 'backfill-1',
          email: 'One@Example.com',
          normalized_email: 'one@example.com',
          is_primary: 1,
        },
        {
          contact_id: 'backfill-3',
          email: 'shared@example.com',
          normalized_email: 'shared@example.com',
          is_primary: 1,
        },
      ],
    );
  } finally {
    inspect.close();
  }

  // The duplicated legacy address must still resolve as ambiguous.
  const backend = new LocalCRMBackend({ dbPath });
  t.after(() => backend.close());
  const result = backend.resolveOrCreateContact({
    name: 'Someone Else',
    email: 'shared@example.com',
    source: 'email',
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.candidates.map((item) => item.id),
    ['backfill-3', 'backfill-4'],
  );
});

function seedMergePair(backend, dbPath) {
  const winner = backend.resolveOrCreateContact({
    name: 'Sarah Chen',
    email: 'sarah@work.com',
    source: 'manual',
    role: 'CTO',
  });
  const loser = backend.resolveOrCreateContact({
    name: 'Sarah C Chen',
    email: 'sarah@personal.com',
    source: 'manual',
    notes: 'Met at the Cabo summit.',
  });
  backend.appendActivity({
    contactId: loser.contact.id,
    activityType: 'email',
    title: 'Old thread',
    source: 'email',
    sourceRef: 'gmail:t1:m1:correspondence',
  });
  backend.appendActivity({
    contactId: winner.contact.id,
    activityType: 'meeting',
    title: 'Kickoff',
    source: 'manual',
  });
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO commitments
         (id, kind, title, source_kind, contact_id, status, created_at, updated_at)
       VALUES ('commitment-1', 'waiting_on', 'Send the deck', 'detector', ?,
               'open', '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z')`,
    ).run(loser.contact.id);
  } finally {
    db.close();
  }
  return { winner: winner.contact, loser: loser.contact };
}

test('merge moves emails, activities, and commitments in one transaction', (t) => {
  const { backend, dbPath } = fixture(t);
  const { winner, loser } = seedMergePair(backend, dbPath);

  const merged = backend.mergeContacts({
    winnerId: winner.id,
    loserId: loser.id,
  });
  assert.equal(merged.id, winner.id);
  assert.equal(merged.email, 'sarah@work.com');
  assert.equal(merged.role, 'CTO');
  assert.equal(merged.notes, 'Met at the Cabo summit.');
  assert.equal(backend.listContacts().length, 1);

  const db = new Database(dbPath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare(
      `SELECT contact_id, normalized_email, is_primary
       FROM contact_emails ORDER BY normalized_email`,
    ).all(),
    [
      { contact_id: winner.id, normalized_email: 'sarah@personal.com', is_primary: 0 },
      { contact_id: winner.id, normalized_email: 'sarah@work.com', is_primary: 1 },
    ],
  );
  assert.equal(
    db.prepare(
      'SELECT COUNT(*) AS count FROM contact_activities WHERE contact_id = ?',
    ).get(winner.id).count,
    2,
  );
  assert.equal(
    db.prepare(
      "SELECT contact_id FROM commitments WHERE id = 'commitment-1'",
    ).pluck().get(),
    winner.id,
  );

  // Both addresses now resolve to the surviving contact.
  const byOldAddress = backend.resolveOrCreateContact({
    name: 'Sarah Chen',
    email: 'sarah@personal.com',
    source: 'email',
  });
  assert.equal(byOldAddress.status, 'matched');
  assert.equal(byOldAddress.contact.id, winner.id);
});

test('a mid-transaction merge failure rolls back every moved row', (t) => {
  const { backend, dbPath } = fixture(t);
  const { winner, loser } = seedMergePair(backend, dbPath);

  const db = new Database(dbPath);
  db.exec(`
    CREATE TRIGGER block_contact_delete BEFORE DELETE ON contacts
    BEGIN
      SELECT RAISE(ABORT, 'delete blocked by test');
    END;
  `);
  db.close();

  assert.throws(
    () => backend.mergeContacts({ winnerId: winner.id, loserId: loser.id }),
    /delete blocked by test/,
  );

  const inspect = new Database(dbPath, { readonly: true });
  t.after(() => inspect.close());
  assert.equal(
    inspect.prepare('SELECT COUNT(*) AS count FROM contacts').get().count,
    2,
  );
  assert.equal(
    inspect.prepare(
      'SELECT COUNT(*) AS count FROM contact_activities WHERE contact_id = ?',
    ).get(loser.id).count,
    1,
  );
  assert.equal(
    inspect.prepare(
      'SELECT contact_id FROM contact_emails WHERE normalized_email = ?',
    ).pluck().get('sarah@personal.com'),
    loser.id,
  );
  assert.equal(
    inspect.prepare(
      "SELECT contact_id FROM commitments WHERE id = 'commitment-1'",
    ).pluck().get(),
    loser.id,
  );
});

test('merge refuses self-merges and unknown contacts', (t) => {
  const { backend } = fixture(t);
  const created = backend.resolveOrCreateContact({
    name: 'Solo Person',
    email: 'solo@example.com',
    source: 'manual',
  });
  assert.throws(
    () => backend.mergeContacts({
      winnerId: created.contact.id,
      loserId: created.contact.id,
    }),
    /cannot be merged into itself/,
  );
  assert.throws(
    () => backend.mergeContacts({
      winnerId: created.contact.id,
      loserId: 'missing-contact',
    }),
    /loser contact was not found/,
  );
});

test('reassigning a taken email points at the merge action', (t) => {
  const { backend } = fixture(t);
  const first = backend.resolveOrCreateContact({
    name: 'First Person',
    email: 'first@example.com',
    source: 'manual',
  });
  const second = backend.resolveOrCreateContact({
    name: 'Second Person',
    email: 'second@example.com',
    source: 'manual',
  });
  assert.throws(
    () => backend.updateContact(second.contact.id, { email: 'first@example.com' }),
    /already belongs to another contact.*merge/i,
  );
  void first;
});
