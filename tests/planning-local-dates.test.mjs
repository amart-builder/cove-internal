import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import { sourceRecord, sourceVersion } from '../src/lib/responsibility/store.ts';

function fixture(t, { timeZone, now }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-planning-dates-'));
  const profile = path.join(dir, 'profile.json');
  writeFileSync(profile, JSON.stringify({ timezone: timeZone }));
  const previous = process.env.COVE_PROFILE_PATH;
  process.env.COVE_PROFILE_PATH = profile;
  const db = openLocalDatabase(path.join(dir, 'cove.db'));
  const store = createDayPlanStore({ dbPath: path.join(dir, 'cove.db'), now: () => new Date(now) });
  t.after(() => {
    store.close(); db.close();
    if (previous === undefined) delete process.env.COVE_PROFILE_PATH;
    else process.env.COVE_PROFILE_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, store };
}
function task(db, due) {
  db.prepare("INSERT INTO tasks(id,title,status,priority,due_at,created_at,updated_at) VALUES('deadline-task','Library deadline','open','medium',?,'2026-03-01T00:00:00Z','2026-03-01T00:00:00Z')").run(due);
}
function event(start, end) {
  return { id: 'call', summary: 'Call', status: 'confirmed', description: '', location: '', htmlLink: '', meetingUrl: '', start, end, attendees: [] };
}

test('planning source labels use operator timezone across UTC dates without changing raw sources', t => {
  const { db, store } = fixture(t, { timeZone: 'America/Los_Angeles', now: '2026-09-19T02:00:00Z' });
  task(db, '2026-09-20T17:00:00Z');
  db.prepare("INSERT INTO commitments(id,title,status,confirmed,kind,source_kind,due_at,created_at,updated_at) VALUES('promise','Return the book','open',1,'promise','manual','2026-09-20','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z')").run();
  const sourceBefore = sourceRecord(db, 'task', 'deadline-task');
  const context = store.planningContext('2026-09-18', [event('2026-09-19T03:00:00Z', '2026-09-19T04:00:00Z')]);
  const view = JSON.parse(context.text);
  assert.equal(view.timeZone, 'America/Los_Angeles');
  assert.equal(view.now, '2026-09-19T02:00:00.000Z');
  assert.equal(view.nowLocal, 'Friday, September 18, 2026 at 7:00 PM PDT');
  const deadline = view.records.find(row => row.source.id === 'deadline-task');
  assert.equal(deadline.deadline, '2026-09-20T17:00:00Z');
  assert.equal(deadline.deadlineLocal, 'Sunday, September 20, 2026 at 10:00 AM PDT');
  assert.equal(deadline.source.version, sourceVersion(sourceBefore));
  assert.deepEqual(sourceRecord(db, 'task', 'deadline-task'), sourceBefore);
  const promise = view.records.find(row => row.source.id === 'promise');
  assert.equal(promise.deadline, '2026-09-20');
  assert.equal(promise.deadlineLocal, 'Sunday, September 20, 2026 (date only)');
  const calendar = view.records.find(row => row.source.kind === 'calendar').event;
  assert.equal(calendar.start, '2026-09-19T03:00:00Z');
  assert.equal(calendar.startLocal, 'Friday, September 18, 2026 at 8:00 PM PDT');
  assert.equal(calendar.endLocal, 'Friday, September 18, 2026 at 9:00 PM PDT');
});

test('planning calendar labels handle a DST jump and preserve all-day dates', t => {
  const { db, store } = fixture(t, { timeZone: 'America/Los_Angeles', now: '2026-03-08T09:30:00Z' });
  task(db, '2026-03-08T10:30:00Z');
  const context = store.planningContext('2026-03-08', [
    event('2026-03-08T09:30:00Z', '2026-03-08T10:30:00Z'),
    { ...event('2026-03-09', '2026-03-10'), id: 'all-day' },
  ]);
  const view = JSON.parse(context.text);
  assert.equal(view.nowLocal, 'Sunday, March 8, 2026 at 1:30 AM PST');
  const timed = view.records.find(row => row.event?.id === 'call').event;
  assert.equal(timed.startLocal, 'Sunday, March 8, 2026 at 1:30 AM PST');
  assert.equal(timed.endLocal, 'Sunday, March 8, 2026 at 3:30 AM PDT');
  const allDay = view.records.find(row => row.event?.id === 'all-day').event;
  assert.equal(allDay.startLocal, 'Monday, March 9, 2026 (date only)');
  assert.equal(allDay.endLocal, 'Tuesday, March 10, 2026 (date only)');
  assert.match(view.localDateTimeMeaning, /end dates are exclusive/);
});

test('planning labels follow a non-Pacific operator timezone before a plan exists', t => {
  const { db, store } = fixture(t, { timeZone: 'Asia/Tokyo', now: '2026-09-19T17:00:00Z' });
  task(db, '2026-09-20T17:00:00Z');
  const view = JSON.parse(store.planningContext('2026-09-20').text);
  assert.equal(view.timeZone, 'Asia/Tokyo');
  assert.match(view.nowLocal, /^Sunday, September 20, 2026 at 2:00 AM /);
  assert.match(view.records[0].deadlineLocal, /^Monday, September 21, 2026 at 2:00 AM /);
});
