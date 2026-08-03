import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  createCRMBackend,
  EXTERNAL_CRM_MESSAGE,
  LocalCRMBackend,
  resolveAndAppendMeetingActivity,
} from '../src/lib/crm/index.ts';
import { normalizeContactName } from '../src/lib/crm/identity.ts';
import { LOCAL_MIGRATIONS } from '../src/lib/local/migrations.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  const backend = new LocalCRMBackend({
    dbPath,
    now: () => new Date('2026-07-28T12:00:00.000Z'),
  });
  t.after(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, dbPath, dir };
}

function resolve(backend, input) {
  return backend.resolveOrCreateContact({
    source: 'manual',
    ...input,
  });
}

test('email match wins over a different normalized name match', (t) => {
  const { backend } = fixture(t);
  const emailWinner = resolve(backend, {
    name: 'Email Winner',
    email: 'winner@example.com',
  });
  const nameWinner = resolve(backend, {
    name: 'Name Winner',
    email: 'other@example.com',
  });
  assert.equal(emailWinner.status, 'created');
  assert.equal(nameWinner.status, 'created');

  const result = resolve(backend, {
    name: '  NAME WINNER ',
    email: ' WINNER@EXAMPLE.COM ',
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.contact.id, emailWinner.contact.id);
});

test('a new email that contradicts a same-name contact is ambiguous', (t) => {
  const { backend } = fixture(t);
  const existing = resolve(backend, {
    name: 'John Smith',
    email: 'john.one@example.com',
  });
  assert.equal(existing.status, 'created');

  const result = resolve(backend, {
    name: 'John Smith',
    email: 'john.two@example.com',
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.candidates.map((item) => item.id), [existing.contact.id]);
  assert.equal(backend.listContacts().length, 1);
});

test('a name match locks the first learned email and rejects the next different email', (t) => {
  const { backend } = fixture(t);
  const seeded = resolve(backend, { name: 'John Smith' });
  assert.equal(seeded.status, 'created');
  assert.equal(seeded.contact.email, null);

  const locked = backend.resolveOrCreateContact({
    name: 'John Smith',
    email: ' John@Acme.com ',
    source: 'email',
  });
  assert.equal(locked.status, 'matched');
  assert.equal(locked.contact.id, seeded.contact.id);
  assert.equal(locked.contact.email, 'john@acme.com');

  const differentPerson = backend.resolveOrCreateContact({
    name: 'John Smith',
    email: 'jsmith@othercorp.io',
    source: 'email',
  });
  assert.equal(differentPerson.status, 'ambiguous');
  assert.deepEqual(
    differentPerson.candidates.map((item) => item.id),
    [seeded.contact.id],
  );
  assert.equal(backend.listContacts().length, 1);
});

test('ordinary matched resolution does not mutate the contact row', (t) => {
  const { backend, dbPath } = fixture(t);
  const created = resolve(backend, {
    name: 'No Change Person',
    email: 'stable@example.com',
    phone: '310-555-0100',
    role: 'Founder',
  });
  assert.equal(created.status, 'created');
  const inspect = new Database(dbPath);
  t.after(() => inspect.close());
  const before = inspect.prepare(
    'SELECT * FROM contacts WHERE id = ?',
  ).get(created.contact.id);

  const matched = backend.resolveOrCreateContact({
    name: 'A Different Display Name',
    email: ' STABLE@example.com ',
    phone: '310-555-9999',
    role: 'Changed Role',
    source: 'email',
  });
  assert.equal(matched.status, 'matched');
  assert.deepEqual(
    inspect.prepare('SELECT * FROM contacts WHERE id = ?').get(created.contact.id),
    before,
  );
});

test('name matching normalizes case, whitespace, punctuation, and diacritics', (t) => {
  const { backend } = fixture(t);
  const created = resolve(backend, {
    name: "  José   O'Neill  ",
  });
  assert.equal(created.status, 'created');

  const matched = resolve(backend, {
    name: 'jose oneill',
  });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.contact.id, created.contact.id);
});

test('ambiguous identity returns candidates and never creates a contact', (t) => {
  const { dbPath } = fixture(t);
  const db = new Database(dbPath);
  const insert = db.prepare(
    `INSERT INTO contacts
       (id, name, normalized_name, email, normalized_email, tier, tags, notes,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'C', '[]', '', ?, ?)`,
  );
  const now = '2026-07-28T12:00:00.000Z';
  insert.run(
    'sarah-1',
    'Sarah Chen',
    normalizeContactName('Sarah Chen'),
    'one@example.com',
    'one@example.com',
    now,
    now,
  );
  insert.run(
    'sarah-2',
    'Sarah Chen',
    normalizeContactName('Sarah Chen'),
    'two@example.com',
    'two@example.com',
    now,
    now,
  );
  db.close();

  const reopened = new LocalCRMBackend({ dbPath });
  t.after(() => reopened.close());
  const exact = resolve(reopened, { name: 'Sarah Chen' });
  assert.equal(exact.status, 'ambiguous');
  assert.deepEqual(exact.candidates.map((item) => item.id), ['sarah-1', 'sarah-2']);

  const partial = resolve(reopened, { name: 'Sarah' });
  assert.equal(partial.status, 'ambiguous');
  assert.deepEqual(partial.candidates.map((item) => item.id), ['sarah-1', 'sarah-2']);
  assert.equal(reopened.listContacts().length, 2);
});

test('multi-token partial input returns per-token candidates', (t) => {
  const { backend } = fixture(t);
  const first = resolve(backend, { name: 'Bob Jones' });
  const second = resolve(backend, { name: 'Bob Martin' });
  assert.equal(first.status, 'created');
  assert.equal(second.status, 'created');

  const partial = resolve(backend, { name: 'Bob 3' });
  assert.equal(partial.status, 'ambiguous');
  assert.deepEqual(
    partial.candidates.map((item) => item.id).sort(),
    [first.contact.id, second.contact.id].sort(),
  );
});

test('duplicate legacy emails are ambiguous and updates cannot create another', (t) => {
  const { backend, dbPath } = fixture(t);
  const db = new Database(dbPath);
  const now = '2026-07-28T12:00:00.000Z';
  const insert = db.prepare(
    `INSERT INTO contacts
       (id, name, normalized_name, email, normalized_email, tier, tags, notes,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'C', '[]', '', ?, ?)`,
  );
  insert.run(
    'duplicate-email-1',
    'First Person',
    'first person',
    'shared@example.com',
    'shared@example.com',
    now,
    now,
  );
  insert.run(
    'duplicate-email-2',
    'Second Person',
    'second person',
    'shared@example.com',
    'shared@example.com',
    now,
    now,
  );
  db.close();

  const result = resolve(backend, {
    name: 'Unrelated Name',
    email: 'SHARED@example.com',
  });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(
    result.candidates.map((item) => item.id),
    ['duplicate-email-1', 'duplicate-email-2'],
  );
  assert.throws(
    () => backend.updateContact('duplicate-email-2', {
      email: 'shared@example.com',
    }),
    /already belongs to another contact/,
  );
});

test('no match creates a contact with provenance', (t) => {
  const { backend, dbPath } = fixture(t);
  const result = backend.resolveOrCreateContact({
    name: 'Amina Rivera',
    email: ' Amina@Example.com ',
    source: 'meeting-notes',
  });
  assert.equal(result.status, 'created');
  assert.equal(result.contact.email, 'amina@example.com');
  assert.equal(result.contact.provenance_source, 'meeting-notes');

  const db = new Database(dbPath, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare(
      `SELECT normalized_name, normalized_email, provenance_source
       FROM contacts WHERE id = ?`,
    ).get(result.contact.id),
    {
      normalized_name: 'amina rivera',
      normalized_email: 'amina@example.com',
      provenance_source: 'meeting-notes',
    },
  );
});

test('explicit manual creation preserves entered facts despite a same-name candidate', (t) => {
  const { backend } = fixture(t);
  const existing = resolve(backend, {
    name: 'John Smith',
    email: 'john@example.com',
  });
  assert.equal(existing.status, 'created');

  const result = backend.createContact({
    name: 'John Smith',
    email: 'other@example.com',
    phone: '310-555-0199',
    role: 'Buyer',
    source: 'manual',
  });
  assert.equal(result.contact.name, 'John Smith');
  assert.equal(result.contact.email, 'other@example.com');
  assert.equal(result.contact.phone, '310-555-0199');
  assert.equal(result.contact.role, 'Buyer');
  assert.notEqual(result.contact.id, existing.contact.id);
  assert.deepEqual(result.candidates.map((item) => item.id), [existing.contact.id]);
});

test('a CJK mononym can be created and then matched', (t) => {
  const { backend } = fixture(t);
  const created = backend.resolveOrCreateContact({
    name: '李强',
    source: 'meeting-notes',
  });
  assert.equal(created.status, 'created');

  const matched = backend.resolveOrCreateContact({
    name: '李强',
    source: 'email',
  });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.contact.id, created.contact.id);
});

test('exact normalized email lookup does not return broad search matches', (t) => {
  const { backend } = fixture(t);
  resolve(backend, {
    name: 'target@example.com Fan',
    email: 'other@example.com',
    tags: ['target@example.com'],
  });
  const exact = resolve(backend, {
    name: 'Exact Person',
    email: 'target@example.com',
  });
  assert.equal(exact.status, 'created');

  assert.deepEqual(
    backend.findByNormalizedEmail(' TARGET@example.com ')
      .map((contact) => contact.id),
    [exact.contact.id],
  );
});

test('server-side search finds a contact outside the initial list cap', (t) => {
  const { backend, dbPath } = fixture(t);
  const db = new Database(dbPath);
  const now = '2026-07-28T12:00:00.000Z';
  const insert = db.prepare(
    `INSERT INTO contacts
       (id, name, normalized_name, email, normalized_email, tier, tags, notes,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'C', '[]', '', ?, ?)`,
  );
  const transaction = db.transaction(() => {
    for (let index = 1; index <= 1_050; index += 1) {
      const name = `Person ${String(index).padStart(3, '0')}`;
      const email = `person-${index}@example.com`;
      insert.run(`person-${index}`, name, normalizeContactName(name), email, email, now, now);
    }
  });
  transaction();
  db.close();

  assert.equal(backend.listContacts().length, 1_000);
  assert.deepEqual(
    backend.listContacts({ search: 'person-1050@example.com' })
      .map((contact) => contact.id),
    ['person-1050'],
  );
});

test('CRM identity migration tolerates legacy contacts with a null name', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT
    );
    INSERT INTO contacts (id, name, email)
    VALUES ('null-name', NULL, 'nobody@example.com');
  `);
  const migration = LOCAL_MIGRATIONS.find((item) => item.version === 5);
  assert.ok(migration);
  assert.doesNotThrow(() => migration.up(db));
  assert.deepEqual(
    db.prepare(
      `SELECT normalized_name, normalized_email
       FROM contacts WHERE id = 'null-name'`,
    ).get(),
    {
      normalized_name: '',
      normalized_email: 'nobody@example.com',
    },
  );
  db.close();
});

test('meeting helper resolves and appends relationship history round trip', (t) => {
  const { backend } = fixture(t);
  const result = resolveAndAppendMeetingActivity({
    contact: {
      name: 'David Park',
      email: 'david@example.com',
    },
    title: 'Product planning call',
    content: 'Agreed to review the pilot scope.',
    occurredAt: '2026-07-27T18:30:00.000Z',
    metadata: { meetingId: 'meeting-1' },
  }, backend);

  assert.equal(result.status, 'created');
  assert.equal(result.activity.activity_type, 'meeting');
  assert.deepEqual(result.activity.metadata, {
    meetingId: 'meeting-1',
    source: 'meeting-notes',
  });
  const roundTrip = backend.getContactWithRecentActivities(result.contactId, 5);
  assert.equal(roundTrip.contact.id, result.contactId);
  assert.equal(roundTrip.contact.last_interaction_at, '2026-07-27T18:30:00.000Z');
  assert.equal(roundTrip.activities.length, 1);
  assert.equal(roundTrip.activities[0].title, 'Product planning call');
});

test('meeting helper rolls back a newly created contact when append fails', (t) => {
  const { backend } = fixture(t);
  assert.throws(
    () => resolveAndAppendMeetingActivity({
      contact: {
        name: 'Rollback Person',
        email: 'rollback@example.com',
      },
      title: 'Meeting that cannot serialize',
      metadata: { unsupported: 1n },
    }, backend),
    /BigInt/,
  );
  assert.equal(backend.listContacts().length, 0);
});

test('CRM config defaults local and external selection throws the setup message', (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-config-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const local = createCRMBackend({ dataDir: dir, dbPath });
  assert.equal(local.kind, 'local');
  local.close();

  writeFileSync(
    path.join(dir, 'cove-crm.json'),
    JSON.stringify({ backend: 'external' }),
  );
  const external = createCRMBackend({ dataDir: dir, dbPath });
  assert.equal(external.kind, 'external');
  assert.throws(
    () => external.listContacts(),
    { message: EXTERNAL_CRM_MESSAGE },
  );
  external.close();
});
