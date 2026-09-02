/**
 * Guards the SQLite -> domain-type boundary in the local CRM backend.
 *
 * The schema allows NULL in columns the Contact and ContactActivity types
 * declare as required strings, and stores `direction` as free text. These tests
 * write those hostile rows directly with SQL, bypassing the backend's own
 * writers, and assert the decoders repair them instead of handing callers a
 * value that lies about its type.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { LocalCRMBackend } from '../src/lib/crm/index.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-rows-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  const backend = new LocalCRMBackend({
    dbPath,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
  });
  t.after(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { backend, dbPath };
}

test('a contact row with NULL tier and notes decodes to schema defaults', (t) => {
  const { backend, dbPath } = fixture(t);
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO contacts (id, name, normalized_name, email, tier, tags, notes)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run('c-null', 'Null Tier', 'null tier', 'null@example.com');
  db.close();

  const result = backend.getContactWithRecentActivities('c-null');
  assert.ok(result, 'contact should be readable');
  const contact = result.contact;
  assert.equal(typeof contact.tier, 'string');
  assert.equal(contact.tier, 'C');
  assert.equal(typeof contact.notes, 'string');
  assert.equal(contact.notes, '');
  assert.deepEqual(contact.tags, []);
});

test('a contact row never leaks undeclared columns to callers', (t) => {
  const { backend, dbPath } = fixture(t);
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO contacts (id, name, normalized_name, company, last_contact_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('c-extra', 'Extra Cols', 'extra cols', 'Acme', '2026-01-01');
  db.close();

  const result = backend.getContactWithRecentActivities('c-extra');
  assert.ok(result);
  const contact = result.contact;
  assert.equal(
    Object.hasOwn(contact, 'company'),
    false,
    'undeclared `company` column must not ride along in the Contact object',
  );
  assert.equal(Object.hasOwn(contact, 'last_contact_date'), false);
  assert.equal(Object.hasOwn(contact, 'normalized_name'), false);
});

test('an activity row with NULL type and unrecognized direction is repaired', (t) => {
  const { backend, dbPath } = fixture(t);
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO contacts (id, name, normalized_name) VALUES (?, ?, ?)`,
  ).run('c-act', 'Act Owner', 'act owner');
  db.prepare(
    `INSERT INTO contact_activities
       (id, contact_id, activity_type, title, content, direction, metadata, created_at)
     VALUES (?, ?, NULL, NULL, NULL, 'sideways', NULL, NULL)`,
  ).run('a-null', 'c-act');
  db.close();

  const { activities } = backend.getContactWithRecentActivities('c-act');
  assert.equal(activities.length, 1);
  const activity = activities[0];
  assert.equal(typeof activity.activity_type, 'string');
  assert.equal(activity.activity_type, 'note');
  assert.equal(
    activity.direction,
    null,
    'a direction outside the union must become null, not pass through',
  );
  assert.equal(typeof activity.created_at, 'string');
  assert.deepEqual(activity.metadata, {});
  assert.equal(activity.title, null);
});

test('a valid direction still survives decoding', (t) => {
  const { backend, dbPath } = fixture(t);
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO contacts (id, name, normalized_name) VALUES (?, ?, ?)`,
  ).run('c-dir', 'Dir Owner', 'dir owner');
  db.prepare(
    `INSERT INTO contact_activities
       (id, contact_id, activity_type, direction, metadata, created_at)
     VALUES (?, ?, 'call', 'outbound', '{"note":"kept"}', '2026-09-01T00:00:00.000Z')`,
  ).run('a-ok', 'c-dir');
  db.close();

  const { activities } = backend.getContactWithRecentActivities('c-dir');
  assert.equal(activities[0].direction, 'outbound');
  assert.equal(activities[0].activity_type, 'call');
  assert.deepEqual(activities[0].metadata, { note: 'kept' });
  assert.equal(activities[0].created_at, '2026-09-01T00:00:00.000Z');
});
