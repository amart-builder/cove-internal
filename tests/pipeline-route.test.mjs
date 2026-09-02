import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/crm/route.ts';
import { localDateInTimezone } from '../src/lib/day-plan/brief.ts';

function withEnv(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function routeFixture(t, name, extraEnv = {}) {
  const dir = path.join(
    os.tmpdir(),
    `cove-pipeline-route-${name}-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  withEnv(t, {
    COVE_DATA_DIR: dir,
    COVE_DB_PATH: dbPath,
    COVE_TIMEZONE: 'America/Los_Angeles',
    NEXT_PUBLIC_COVE_RUNTIME: 'local',
    COVE_DAY_PLAN_ACCESS_MODE: undefined,
    COVE_DAY_PLAN_REMOTE_TOKEN: undefined,
    ...extraEnv,
  });
  return { dir, dbPath };
}

function get(url, headers) {
  return GET(new NextRequest(url, { headers }));
}

function post(csrfToken, action, input, headers = {}) {
  return POST(new NextRequest('http://127.0.0.1:3200/api/crm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cove-CSRF': csrfToken,
      ...headers,
    },
    body: JSON.stringify({ action, input }),
  }));
}

test('pipeline route keeps the local, session, and CSRF gates', {
  concurrency: false,
}, async (t) => {
  routeFixture(t, 'gates', {
    COVE_DAY_PLAN_ACCESS_MODE: 'session',
    COVE_DAY_PLAN_REMOTE_TOKEN: 'pipeline-session',
  });

  const denied = await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline&today=2026-09-01',
  );
  assert.equal(denied.status, 403);

  const allowed = await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline&today=2026-09-01',
    { 'X-Cove-Day-Plan-Session': 'pipeline-session' },
  );
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.deepEqual(payload.deals, []);
  assert.equal(payload.today, '2026-09-01');
  assert.equal(payload.stages.length, 11);
  assert.equal(typeof payload.csrfToken, 'string');

  const deniedWrite = await post(payload.csrfToken, 'pipeline_upsert', {
    contactId: 'missing',
    stage: 'reach_out',
    patch: {},
  });
  assert.equal(deniedWrite.status, 403);

  const missingCsrf = await POST(new NextRequest(
    'http://127.0.0.1:3200/api/crm',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cove-Day-Plan-Session': 'pipeline-session',
      },
      body: JSON.stringify({ action: 'pipeline_remove', input: { contactId: 'x' } }),
    },
  ));
  assert.equal(missingCsrf.status, 403);
});

test('pipeline route rejects non-local runtime before opening the database', {
  concurrency: false,
}, async (t) => {
  routeFixture(t, 'non-local', { NEXT_PUBLIC_COVE_RUNTIME: 'supabase' });
  const response = await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline&today=2026-09-01',
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /only in local runtime mode/);
});

test('pipeline route derives today in the configured timezone when omitted', {
  concurrency: false,
}, async (t) => {
  routeFixture(t, 'derived-today');
  const before = localDateInTimezone(new Date(), 'America/Los_Angeles');
  const response = await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  );
  const after = localDateInTimezone(new Date(), 'America/Los_Angeles');
  assert.equal(response.status, 200);
  assert.ok([before, after].includes((await response.json()).today));
});

test('contact context route returns the shared record and explicit identity failures', {
  concurrency: false,
}, async (t) => {
  const { dbPath } = routeFixture(t, 'context');
  const db = new Database(dbPath);
  try {
    db.exec(`PRAGMA foreign_keys = ON`);
    // Open the route once so migrations exist before fixture rows are inserted.
  } finally {
    db.close();
  }
  await get('http://127.0.0.1:3200/api/crm?operation=list');
  const seeded = new Database(dbPath);
  try {
    const now = '2026-09-02T16:00:00.000Z';
    seeded.prepare(`INSERT INTO contacts
      (id, name, email, normalized_email, tags, notes, created_at, updated_at)
      VALUES ('context-person', 'Context Person', 'context@example.com', 'context@example.com', '[]', '', ?, ?)`).run(now, now);
    seeded.prepare(`INSERT INTO contact_emails
      (id, contact_id, email, normalized_email, is_primary, created_at)
      VALUES ('context-alias', 'context-person', 'alias@example.com', 'alias@example.com', 0, ?)`).run(now);
    for (const id of ['ambiguous-a', 'ambiguous-b']) {
      seeded.prepare(`INSERT INTO contacts
        (id, name, email, normalized_email, tags, notes, created_at, updated_at)
        VALUES (?, ?, 'same@example.com', 'same@example.com', '[]', '', ?, ?)`).run(id, id, now, now);
    }
  } finally {
    seeded.close();
  }
  const matched = await get('http://127.0.0.1:3200/api/crm?operation=context&email=alias%40example.com');
  assert.equal(matched.status, 200);
  const payload = await matched.json();
  assert.equal(payload.context.contact.id, 'context-person');
  assert.match(payload.rendered, /^<cove_record>/);
  const ambiguous = await get('http://127.0.0.1:3200/api/crm?operation=context&email=same%40example.com');
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json()).candidates.length, 2);
  assert.equal((await get('http://127.0.0.1:3200/api/crm?operation=context&id=missing')).status, 404);
});

test('pipeline route creates, updates, moves, logs, reads, and removes deals', {
  concurrency: false,
}, async (t) => {
  routeFixture(t, 'actions');
  const initial = await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline&today=2026-09-01',
  );
  const { csrfToken } = await initial.json();

  const resolvedResponse = await post(csrfToken, 'resolve', {
    name: 'Pipeline Person',
    email: 'pipeline@example.com',
    source: 'manual',
  });
  assert.equal(resolvedResponse.status, 200);
  const resolved = await resolvedResponse.json();
  const contactId = resolved.resolution.contact.id;
  assert.equal(resolved.csrfToken, csrfToken);

  const unknown = await post(csrfToken, 'pipeline_upsert', {
    contactId: 'unknown-contact',
    stage: 'reach_out',
    patch: {},
  });
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /Contact was not found/);

  const createdResponse = await post(csrfToken, 'pipeline_upsert', {
    contactId,
    stage: 'interested',
    patch: {
      monthlyValue: 5000,
      discoveryPrice: 1000,
      nextAction: 'Book discovery',
      nextFollowUpAt: '2026-09-02',
      source: 'Zac',
    },
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.deal.stage, 'interested');
  assert.equal(created.deal.name, 'Pipeline Person');

  const illegalStageUpdate = await post(csrfToken, 'pipeline_upsert', {
    contactId,
    stage: 'proposal',
    patch: { notes: 'Still interested' },
  });
  assert.equal(illegalStageUpdate.status, 400);
  assert.match((await illegalStageUpdate.json()).error, /pipeline_move/);

  const updated = await post(csrfToken, 'pipeline_upsert', {
    contactId,
    patch: { notes: '  Wants sales operations help.  ' },
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).deal.notes, 'Wants sales operations help.');

  const moved = await post(csrfToken, 'pipeline_move', {
    contactId,
    stage: 'discovery_ready',
    note: 'Ready to book',
  });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).deal.stage, 'discovery_ready');

  const invalidMove = await post(csrfToken, 'pipeline_move', {
    contactId,
    stage: 'won',
  });
  assert.equal(invalidMove.status, 400);
  assert.match((await invalidMove.json()).error, /stage is invalid/);

  const touched = await post(csrfToken, 'pipeline_log_touch', {
    contactId,
    activityType: 'call',
    title: 'Discovery call',
    content: 'They asked for a proposal.',
    nextAction: 'Send proposal',
    nextFollowUpAt: '2026-09-05',
    stage: 'proposal',
  });
  assert.equal(touched.status, 200);
  const touchedDeal = (await touched.json()).deal;
  assert.equal(touchedDeal.stage, 'proposal');
  assert.equal(touchedDeal.next_action, 'Send proposal');
  assert.equal(typeof touchedDeal.last_touch_at, 'string');

  const board = await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline&today=2026-09-01',
  );
  const boardPayload = await board.json();
  assert.equal(boardPayload.deals.length, 1);
  assert.deepEqual(boardPayload.summary, {
    mrr: 0,
    openCount: 1,
    overdueCount: 0,
    dueSoonCount: 1,
  });
  assert.deepEqual(boardPayload.attention, []);

  const removed = await post(csrfToken, 'pipeline_remove', { contactId });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).ok, true);
  const missingRemoval = await post(csrfToken, 'pipeline_remove', { contactId });
  assert.equal(missingRemoval.status, 404);
});

test('merge reparents a loser deal to the winner before merging contacts', {
  concurrency: false,
}, async (t) => {
  routeFixture(t, 'merge-reparent');
  const { csrfToken } = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  )).json();
  const winner = await (await post(csrfToken, 'resolve', {
    name: 'Pipeline Merge Winner',
    email: 'pipeline-winner@example.com',
    source: 'manual',
  })).json();
  const loser = await (await post(csrfToken, 'resolve', {
    name: 'Pipeline Merge Loser',
    email: 'pipeline-loser@example.com',
    source: 'manual',
  })).json();
  const winnerId = winner.resolution.contact.id;
  const loserId = loser.resolution.contact.id;
  await post(csrfToken, 'pipeline_upsert', {
    contactId: loserId,
    stage: 'interested',
    patch: { nextAction: 'Send scope', nextFollowUpAt: '2026-09-04' },
  });

  const merged = await post(csrfToken, 'merge', { winnerId, loserId });
  assert.equal(merged.status, 200);
  assert.equal((await merged.json()).contact.id, winnerId);

  const board = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  )).json();
  assert.equal(board.deals.length, 1);
  assert.equal(board.deals[0].contact_id, winnerId);
  assert.equal(board.deals[0].name, 'Pipeline Merge Winner');
});

test('delete blocks active pipeline deals and allows parked deal cascades', {
  concurrency: false,
}, async (t) => {
  const { dbPath } = routeFixture(t, 'delete-guard');
  const { csrfToken } = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  )).json();
  const active = await (await post(csrfToken, 'resolve', {
    name: 'Active Pipeline Person',
    email: 'active-pipeline@example.com',
    source: 'manual',
  })).json();
  const parked = await (await post(csrfToken, 'resolve', {
    name: 'Parked Pipeline Person',
    email: 'parked-pipeline@example.com',
    source: 'manual',
  })).json();
  const activeId = active.resolution.contact.id;
  const parkedId = parked.resolution.contact.id;
  await post(csrfToken, 'pipeline_upsert', {
    contactId: activeId,
    stage: 'client',
    patch: { monthlyValue: 6000 },
  });
  await post(csrfToken, 'pipeline_upsert', {
    contactId: parkedId,
    stage: 'parked',
    patch: {},
  });

  const blocked = await post(csrfToken, 'delete', { contactId: activeId });
  assert.equal(blocked.status, 409);
  assert.equal(
    (await blocked.json()).error,
    'This person is in the sales pipeline (Client). Mark them lost or parked first.',
  );

  const removed = await post(csrfToken, 'delete', { contactId: `  ${parkedId}  ` });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).ok, true);
  const db = new Database(dbPath);
  t.after(() => db.close());
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM pipeline_deals WHERE contact_id = ?')
      .pluck().get(parkedId),
    0,
  );
  const board = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  )).json();
  assert.deepEqual(board.deals.map((deal) => deal.contact_id), [activeId]);
});

test('invalid touch date writes no activity and leaves contact recency unchanged', {
  concurrency: false,
}, async (t) => {
  const { dbPath } = routeFixture(t, 'invalid-touch-date');
  const { csrfToken } = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  )).json();
  const resolved = await (await post(csrfToken, 'resolve', {
    name: 'Atomic Touch Person',
    email: 'atomic-touch@example.com',
    source: 'manual',
  })).json();
  const contactId = resolved.resolution.contact.id;
  await post(csrfToken, 'pipeline_upsert', {
    contactId,
    stage: 'interested',
    patch: {},
  });

  const db = new Database(dbPath);
  t.after(() => db.close());
  db.prepare('DELETE FROM contact_activities WHERE contact_id = ?').run(contactId);
  const before = db.prepare(
    'SELECT last_interaction_at, last_contact_date FROM contacts WHERE id = ?',
  ).get(contactId);

  const invalid = await post(csrfToken, 'pipeline_log_touch', {
    contactId,
    activityType: 'call',
    title: 'Invalid follow-up test',
    nextAction: 'Send recap',
    nextFollowUpAt: '2026-02-30',
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /calendar date/);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM contact_activities WHERE contact_id = ?')
      .get(contactId).count,
    0,
  );
  assert.deepEqual(
    db.prepare(
      'SELECT last_interaction_at, last_contact_date FROM contacts WHERE id = ?',
    ).get(contactId),
    before,
  );
});

test('merge returns 409 and keeps both contacts when both have pipeline deals', {
  concurrency: false,
}, async (t) => {
  routeFixture(t, 'merge-collision');
  const read = await get('http://127.0.0.1:3200/api/crm?operation=pipeline');
  const { csrfToken } = await read.json();
  const first = await (await post(csrfToken, 'resolve', {
    name: 'Merge Winner',
    email: 'winner@example.com',
    source: 'manual',
  })).json();
  const second = await (await post(csrfToken, 'resolve', {
    name: 'Merge Loser',
    email: 'loser@example.com',
    source: 'manual',
  })).json();
  const winnerId = first.resolution.contact.id;
  const loserId = second.resolution.contact.id;
  await post(csrfToken, 'pipeline_upsert', {
    contactId: winnerId,
    stage: 'client',
    patch: { monthlyValue: 3000 },
  });
  await post(csrfToken, 'pipeline_upsert', {
    contactId: loserId,
    stage: 'proposal',
    patch: {},
  });

  const collision = await post(csrfToken, 'merge', { winnerId, loserId });
  assert.equal(collision.status, 409);
  assert.match((await collision.json()).error, /Both contacts already have pipeline deals/);

  const contacts = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=list',
  )).json();
  assert.deepEqual(
    contacts.contacts.map((contact) => contact.id).sort(),
    [winnerId, loserId].sort(),
  );
  const pipeline = await (await get(
    'http://127.0.0.1:3200/api/crm?operation=pipeline',
  )).json();
  assert.equal(pipeline.deals.length, 2);
});
