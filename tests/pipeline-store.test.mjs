import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { LocalCRMBackend } from '../src/lib/crm/local.ts';
import {
  LocalPipelineStore,
  PipelineCollisionError,
  PipelineNotFoundError,
} from '../src/lib/crm/pipeline-store.ts';

const NOW = '2026-09-01T18:30:00.000Z';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-pipeline-store-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  const crm = new LocalCRMBackend({ dbPath, now: () => new Date(NOW) });
  const createContact = (name, email) => crm.resolveOrCreateContact({
    name,
    email,
    source: 'manual',
  }).contact;
  const contacts = {
    alpha: createContact('Alpha Lead', 'alpha@example.com'),
    beta: createContact('Beta Lead', 'beta@example.com'),
    gamma: createContact('Gamma Lead', 'gamma@example.com'),
  };
  crm.close();
  const store = new LocalPipelineStore({ dbPath, now: () => new Date(NOW) });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dbPath, store, contacts };
}

test('create, update, move, and logTouch preserve pipeline invariants', (t) => {
  const { dbPath, store, contacts } = fixture(t);
  const created = store.create({
    contactId: contacts.alpha.id,
    stage: 'interested',
    monthlyValue: 5000,
    discoveryPrice: 1000,
    nextAction: '  Book discovery  ',
    nextFollowUpAt: '2026-09-03',
    source: '  Zac  ',
  });
  assert.equal(created.next_action, 'Book discovery');
  assert.equal(created.source, 'Zac');
  assert.equal(created.monthly_value, 5000);

  const db = new Database(dbPath);
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare(
      'SELECT last_interaction_at, last_contact_date FROM contacts WHERE id = ?',
    ).get(contacts.alpha.id),
    { last_interaction_at: null, last_contact_date: null },
  );
  const added = db.prepare(
    `SELECT activity_type, title, direction, metadata
     FROM contact_activities WHERE contact_id = ?`,
  ).get(contacts.alpha.id);
  assert.equal(added.activity_type, 'pipeline_stage');
  assert.equal(added.title, 'Added to pipeline: Interested');
  assert.equal(added.direction, 'internal');
  assert.deepEqual(JSON.parse(added.metadata), {
    from: null,
    to: 'interested',
    source: 'pipeline',
  });

  assert.throws(
    () => store.create({ contactId: contacts.alpha.id, stage: 'proposal' }),
    /already has a pipeline deal/,
  );
  assert.throws(
    () => store.update(contacts.alpha.id, { stage: 'proposal' }),
    /move action/,
  );
  assert.throws(
    () => store.update(contacts.alpha.id, { madeUp: true }),
    /Unknown pipeline patch field/,
  );

  const updated = store.update(contacts.alpha.id, {
    nextAction: 'Send outline',
    nextFollowUpAt: null,
    notes: '  Asked about sales operations.  ',
  });
  assert.equal(updated.next_action, 'Send outline');
  assert.equal(updated.next_follow_up_at, null);
  assert.equal(updated.notes, 'Asked about sales operations.');

  const beforeNoOp = db.prepare(
    'SELECT COUNT(*) FROM contact_activities WHERE contact_id = ?',
  ).pluck().get(contacts.alpha.id);
  store.move(contacts.alpha.id, 'interested', 'No change');
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM contact_activities WHERE contact_id = ?')
      .pluck().get(contacts.alpha.id),
    beforeNoOp,
  );

  const moved = store.move(contacts.alpha.id, 'discovery_ready', 'Ready to scope');
  assert.equal(moved.stage, 'discovery_ready');
  const moveActivity = db.prepare(
    `SELECT title, content, metadata FROM contact_activities
     WHERE contact_id = ? AND activity_type = 'pipeline_stage'
     ORDER BY rowid DESC LIMIT 1`,
  ).get(contacts.alpha.id);
  assert.equal(moveActivity.title, 'Moved to Discovery: ready to book');
  assert.equal(moveActivity.content, 'Ready to scope');
  assert.deepEqual(JSON.parse(moveActivity.metadata), {
    from: 'interested',
    to: 'discovery_ready',
    source: 'pipeline',
  });
  assert.equal(
    db.prepare('SELECT last_interaction_at FROM contacts WHERE id = ?')
      .pluck().get(contacts.alpha.id),
    null,
  );

  const touched = store.logTouch(contacts.alpha.id, {
    activityType: 'call',
    title: '  Discovery call  ',
    content: '  They want a proposal.  ',
    nextAction: '  Send proposal  ',
    nextFollowUpAt: '2026-09-04',
    stage: 'proposal',
  });
  assert.equal(touched.stage, 'proposal');
  assert.equal(touched.next_action, 'Send proposal');
  assert.equal(touched.next_follow_up_at, '2026-09-04');
  assert.equal(touched.last_touch_at, NOW);

  const touchedWithoutNextStep = store.logTouch(contacts.alpha.id, {
    activityType: 'note',
    title: 'Internal recap',
    content: 'No follow-up changes.',
  });
  assert.equal(touchedWithoutNextStep.next_action, 'Send proposal');
  assert.equal(touchedWithoutNextStep.next_follow_up_at, '2026-09-04');
  assert.deepEqual(
    db.prepare(
      'SELECT last_interaction_at, last_contact_date FROM contacts WHERE id = ?',
    ).get(contacts.alpha.id),
    { last_interaction_at: NOW, last_contact_date: NOW },
  );
  assert.deepEqual(
    db.prepare(
      `SELECT activity_type, direction, title, content
       FROM contact_activities
       WHERE contact_id = ? AND activity_type = 'call'`,
    ).get(contacts.alpha.id),
    {
      activity_type: 'call',
      direction: 'outbound',
      title: 'Discovery call',
      content: 'They want a proposal.',
    },
  );
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) FROM contact_activities
       WHERE contact_id = ? AND activity_type = 'pipeline_stage'`,
    ).pluck().get(contacts.alpha.id),
    3,
  );
});

test('list uses funnel order, follow-up order, and company fallback', (t) => {
  const { dbPath, store, contacts } = fixture(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  db.prepare('UPDATE contacts SET company = ? WHERE id = ?')
    .run('Legacy Co', contacts.beta.id);
  store.create({
    contactId: contacts.alpha.id,
    stage: 'interested',
    nextFollowUpAt: '2026-09-05',
  });
  store.create({
    contactId: contacts.beta.id,
    stage: 'reach_out',
    nextFollowUpAt: null,
  });
  store.create({
    contactId: contacts.gamma.id,
    stage: 'interested',
    nextFollowUpAt: '2026-09-02',
  });
  const rows = store.list();
  assert.deepEqual(rows.map((row) => row.contact_id), [
    contacts.beta.id,
    contacts.gamma.id,
    contacts.alpha.id,
  ]);
  assert.equal(rows[0].company, 'Legacy Co');
});

test('reparent moves a deal, rejects collisions, and no-ops without a source deal', (t) => {
  const { store, contacts } = fixture(t);
  store.create({ contactId: contacts.alpha.id, stage: 'reach_out' });
  const moved = store.reparent(contacts.alpha.id, contacts.beta.id);
  assert.equal(moved.contact_id, contacts.beta.id);
  assert.equal(store.get(contacts.alpha.id), null);
  assert.equal(store.reparent(contacts.alpha.id, contacts.gamma.id), null);

  store.create({ contactId: contacts.gamma.id, stage: 'keep_warm' });
  assert.throws(
    () => store.reparent(contacts.gamma.id, contacts.beta.id),
    PipelineCollisionError,
  );
  assert.equal(store.get(contacts.gamma.id).stage, 'keep_warm');

  assert.equal(store.remove(contacts.gamma.id), true);
  assert.equal(store.remove(contacts.gamma.id), false);
  assert.throws(
    () => store.move(contacts.gamma.id, 'client'),
    PipelineNotFoundError,
  );
});
