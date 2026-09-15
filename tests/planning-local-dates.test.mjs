import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import { rememberCalendarOccurrences, collectPlanningContext } from '../src/lib/chief-of-staff/daily-planning.ts';
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
  assert.equal(promise.source.version, sourceVersion(sourceRecord(db, 'commitment', 'promise')));
  const calendarRecord = view.records.find(row => row.source.kind === 'calendar');
  assert.equal(calendarRecord.source.version, sourceVersion(sourceRecord(db, 'calendar', calendarRecord.source.id)));
  const calendar = calendarRecord.event;
  assert.equal(calendar.start, '2026-09-19T03:00:00Z');
  assert.equal(calendar.startLocal, 'Friday, September 18, 2026 at 8:00 PM PDT');
  assert.equal(calendar.endLocal, 'Friday, September 18, 2026 at 9:00 PM PDT (exclusive end)');
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
  assert.equal(timed.endLocal, 'Sunday, March 8, 2026 at 3:30 AM PDT (exclusive end)');
  const allDay = view.records.find(row => row.event?.id === 'all-day').event;
  assert.equal(allDay.startLocal, 'Monday, March 9, 2026 (date only)');
  assert.equal(allDay.endLocal, 'Tuesday, March 10, 2026 (date only; exclusive end, this date is not covered)');
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

test('date labels mark unsupported and invalid source dates instead of silently inviting conversion', async () => {
  const { localDateLabel } = await import('../src/lib/chief-of-staff/planning-dates.ts');
  for (const value of ['2026-09-20T10:00:00', '2026-09-20T10:00:00-0700', 'tomorrow']) {
    assert.match(localDateLabel(value, 'America/Los_Angeles'), /^Unlabelled date\/time:/);
  }
  for (const value of ['2026-02-30', '2026-02-30T10:00:00Z', '2026-09-20T25:00:00Z']) {
    assert.match(localDateLabel(value, 'America/Los_Angeles'), /^Invalid date\/time:/);
  }
  assert.equal(localDateLabel(null, 'America/Los_Angeles'), null);
  assert.equal(localDateLabel('2026-09-20T10:00-07:00', 'America/Los_Angeles'), 'Sunday, September 20, 2026 at 10:00 AM PDT');
});

test('planning date fields preserve source bytes and consistently label checks, windows and closeouts', async () => {
  const { withPlanningDateLabels } = await import('../src/lib/chief-of-staff/planning-dates.ts');
  const source = {
    nextCheckAt: '2026-09-20T17:00:00Z', plannedFor: '2026-09-20T18:00:00Z',
    observedAt: '2026-09-20T16:59:00Z', timeMin: '2026-09-20T07:00:00Z', timeMax: '2026-09-21T07:00:00Z',
    closedAt: '2026-09-20T03:00:00Z', settledAt: '2026-09-20T03:01:00Z',
    nestedSourceBody: { nextCheckAt: 'untrusted text' },
  };
  const before = JSON.stringify(source);
  const result = withPlanningDateLabels(source, 'America/Los_Angeles');
  assert.equal(JSON.stringify(source), before);
  for (const [key, value] of Object.entries(source)) assert.equal(result[key], value);
  assert.equal(result.nextCheckAtLocal, 'Sunday, September 20, 2026 at 10:00 AM PDT');
  assert.equal(result.plannedForLocal, 'Sunday, September 20, 2026 at 11:00 AM PDT');
  assert.equal(result.observedAtLocal, 'Sunday, September 20, 2026 at 9:59 AM PDT');
  assert.equal(result.timeMinLocal, 'Sunday, September 20, 2026 at 12:00 AM PDT');
  assert.equal(result.timeMaxLocal, 'Monday, September 21, 2026 at 12:00 AM PDT (exclusive end)');
  assert.equal(result.closedAtLocal, 'Saturday, September 19, 2026 at 8:00 PM PDT');
  assert.equal(result.settledAtLocal, 'Saturday, September 19, 2026 at 8:01 PM PDT');
  const question = withPlanningDateLabels({ next_check_at: source.nextCheckAt, answered_at: source.observedAt }, 'America/Los_Angeles');
  assert.equal(question.nextCheckAtLocal, result.nextCheckAtLocal);
  assert.equal(question.answeredAtLocal, result.observedAtLocal);
});

test('planning context labels question checks and the complete observed calendar window', t => {
  const now = '2026-09-19T02:00:00Z';
  const { db, store } = fixture(t, { timeZone: 'America/Los_Angeles', now });
  task(db, '2026-09-20T17:00:00Z');
  db.prepare("INSERT INTO cove_planning_questions(id,outcome_key,decision_key,question,ref_kind,ref_id,state,next_check_at,expires_at,created_at,updated_at) VALUES('q','book','return','When?','task','deadline-task','answered','2026-09-20T17:00:00Z','2026-09-21T17:00:00Z',?,?)").run(now, now);
  const observation = { calendarId: 'primary', timeMin: '2026-09-18T07:00:00Z', timeMax: '2026-09-19T07:00:00Z', timeZone: 'America/Los_Angeles', observedAt: now, complete: true };
  const view = JSON.parse(store.planningContext('2026-09-18', [event('2026-09-19T03:00:00Z', '2026-09-19T04:00:00Z')], observation).text);
  assert.equal(view.questions[0].nextCheckAtLocal, 'Sunday, September 20, 2026 at 10:00 AM PDT');
  assert.equal(view.questions[0].updatedAtLocal, 'Friday, September 18, 2026 at 7:00 PM PDT');
  assert.equal(view.records.find(row => row.event).observedAtLocal, view.nowLocal);
  const schedule = view.coverage.calendarSchedule;
  for (const [key, value] of Object.entries(observation)) assert.equal(schedule[key], value);
  assert.equal(schedule.timeMinLocal, 'Friday, September 18, 2026 at 12:00 AM PDT');
  assert.equal(schedule.timeMaxLocal, 'Saturday, September 19, 2026 at 12:00 AM PDT (exclusive end)');
  assert.equal(schedule.observedAtLocal, view.nowLocal);
});

test('closeout provenance preserves raw save time and labels it locally without shifting its calendar day', async () => {
  const { closeoutTimestampHeader } = await import('../src/lib/day-plan/brief-sources.ts');
  const header = closeoutTimestampHeader({ asOf: '2026-09-20T17:00:00Z', closeoutLocalDate: '2026-09-20', targetLocalDate: '2026-09-21', targetTimezone: 'Pacific/Auckland' });
  assert.match(header, /Saved: 2026-09-20T17:00:00Z/);
  assert.match(header, /Saved local: Monday, September 21, 2026 at 5:00 AM/);
  assert.match(header, /Covers the working day Sunday, Sep 20/);
  assert.match(header, /This brief is for Monday, Sep 21/);
});


test('cached calendar compares instants across offsets and all-day exclusive ends in the operator timezone', t => {
  const now = new Date('2026-09-16T01:00:00Z');
  const { db } = fixture(t, { timeZone: 'America/Los_Angeles', now: now.toISOString() });
  rememberCalendarOccurrences(db, [
    { ...event('2026-09-15T23:00:00-05:00','2026-09-15T23:30:00-05:00'), id:'still-upcoming' },
    { ...event('2026-09-16T01:00:00+02:00','2026-09-16T02:00:00+02:00'), id:'already-ended' },
    { ...event('2026-09-15','2026-09-16'), id:'all-day-today' },
    { ...event('2026-09-14','2026-09-15'), id:'all-day-ended' },
  ], new Date('2026-09-15T00:00:00Z'));
  const view = JSON.parse(collectPlanningContext(db, null, now).text);
  const events = view.records.filter(row=>row.source.kind==='calendar').map(row=>row.event);
  assert.deepEqual(events.map(e=>e.id), ['all-day-today','still-upcoming']);
  assert.equal(events[1].end,'2026-09-15T23:30:00-05:00','Raw source and identity remain intact');
});
