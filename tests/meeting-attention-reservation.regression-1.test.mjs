import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';
import { allocateAttention, dailyAttentionUsage } from '../src/lib/attention/ledger.mjs';
import { runFollowThrough } from '../src/lib/attention/follow-through.mjs';
import { runLocalMigrations } from '../src/lib/local/migrations.ts';

const at = time => new Date(`2026-09-15T${time.padStart(5, "0")}:00-07:00`);
function fixture(t) {
  const db = new Database(':memory:'); runLocalMigrations(db); t.after(() => db.close());
  const calendar = (events, status = 'ready') => db.prepare("INSERT INTO cove_follow_through_state(key,value,updated_at) VALUES('calendar',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify({ status, timezone: 'America/Los_Angeles', events }), at('08:00').toISOString());
  const allocate = (id, now, extra = {}) => allocateAttention(db, { kind: 'chief_of_staff', refKind: 'task', refId: id, requestedLevel: 'banner', reason: 'Fixture', now, ...extra });
  const meeting = (event, now) => {
    const result = allocate(`${event.id}:${event.start}`, now, { refKind: 'meeting' });
    if (result.row) db.prepare("INSERT INTO cove_follow_through_notices(id,ref_kind,ref_id,title,stage,due_at,status,updated_at) VALUES(?,'meeting',?,'Meeting','meeting',?,'delivered',?)").run(event.id, event.id, event.start, now.toISOString());
    return result;
  };
  return { db, calendar, allocate, meeting };
}
const event = (id, time) => ({ id, start: at(time).toISOString() });
test('morning optional work and noon floor preserve all four known meeting slots including afternoon', t => {
  const f = fixture(t); const events = [event('a','09:00'), event('b','10:00'), event('c','11:00'), event('d','15:00')];
  f.calendar(events);
  assert.equal(f.allocate('backlog1',at('08:00')).finalLevel,'banner');
  assert.equal(f.allocate('backlog2',at('08:00')).finalLevel,'banner');
  const held = f.allocate('backlog3',at('08:00'));
  assert.equal(held.finalLevel,'suppressed');
  assert.equal(held.suppressionRows[0].suppressedReason,'reserved_upcoming_meetings');
  for (let i=0;i<3;i++) assert.equal(f.meeting(events[i],new Date(Date.parse(events[i].start)-15*60000)).finalLevel,'banner');
  assert.equal(f.allocate('floor',at('12:00'),{kind:'floor_nudge',requestedLevel:'text'}).finalLevel,'suppressed');
  assert.equal(f.meeting(events[3],at('14:45')).finalLevel,'banner');
  assert.equal(dailyAttentionUsage(f.db,at('16:00')).banners,6);
});
test('more than six real meetings still obey the existing six-interruption cap', t => {
  const f=fixture(t);const events=Array.from({length:7},(_,i)=>event(`meeting${i}`,`${9+i}:00`));f.calendar(events);
  assert.equal(f.allocate('optional',at('08:00')).finalLevel,'suppressed');
  const results=events.map(e=>f.meeting(e,new Date(Date.parse(e.start)-15*60000)).finalLevel);
  assert.deepEqual(results,['banner','banner','banner','banner','banner','banner','suppressed']);
  assert.equal(dailyAttentionUsage(f.db,at('16:00')).banners,6);
});
test('duplicate, cancelled, declined, past and outside-hours meetings do not waste reservations', t => {
  const f=fixture(t);const real=event('real','15:00');
  f.calendar([real,real,{...event('cancelled','16:00'),status:'cancelled'}, {...event('declined','17:00'),attendees:[{self:true,responseStatus:'declined'}]},event('past','07:00'),event('night','20:00')]);
  for(let i=0;i<3;i++) assert.equal(f.allocate(`optional${i}`,at('08:00')).finalLevel,'banner');
  assert.equal(f.allocate('floor',at('12:00'),{kind:'floor_nudge'}).finalLevel,'banner');
  assert.equal(f.meeting(real,at('14:45')).finalLevel,'banner');
});
test('already delivered meetings are not reserved again and unknown refresh retains future reservations', t => {
  const f=fixture(t);const events=Array.from({length:4},(_,i)=>event(`m${i}`,`${12+i}:00`));f.calendar(events);
  assert.equal(f.meeting(events[0],at('11:45')).finalLevel,'banner');
  assert.equal(f.allocate('backlog1',at('11:46')).finalLevel,'banner');
  assert.equal(f.allocate('backlog2',at('11:46')).finalLevel,'banner');
  f.calendar(events,'unavailable');
  assert.equal(f.allocate('backlog3',at('11:46')).finalLevel,'suppressed');
  // A fresh cancellation removes the future occurrences from the cache.
  f.calendar([]);
  assert.equal(f.allocate('floor',at('12:01'),{kind:'floor_nudge'}).finalLevel,'banner');
});

test('calendar outage retains known future reservations until a fresh cancellation refresh', async t => {
  const f=fixture(t);const events=[event('meeting','15:00')];f.calendar(events);
  await runFollowThrough({db:f.db,now:at('10:00'),timezone:'America/Los_Angeles',calendar:async()=>{throw new Error('Unavailable');},notify:async()=>{throw new Error('No notification expected');}});
  const cached=JSON.parse(f.db.prepare("SELECT value FROM cove_follow_through_state WHERE key='calendar'").pluck().get());
  assert.equal(cached.status,'unavailable');assert.deepEqual(cached.events,events);
  await runFollowThrough({db:f.db,now:at('10:06'),timezone:'America/Los_Angeles',calendar:async()=>({listEvents:async()=>[]}),notify:async()=>{throw new Error('No notification expected');}});
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT value FROM cove_follow_through_state WHERE key='calendar'").pluck().get()).events,[]);
});

test('reservation uses the pre-meeting notification window at quiet-hour boundaries', t => {
  const f=fixture(t);
  const five=Array.from({length:5},(_,i)=>event(`late${i}`,`17:0${i+1}`));
  f.calendar([...five,event('evening','18:05')]);
  assert.equal(f.allocate('optional-evening',at('17:00')).finalLevel,'suppressed');
  f.calendar([...five,event('too-late','18:15')]);
  assert.equal(f.allocate('optional-after-refresh',at('17:00')).finalLevel,'banner');
  const other=fixture(t);const morning=Array.from({length:5},(_,i)=>event(`morning${i}`,`09:0${i}`));
  other.calendar([...morning,event('early','08:00')]);
  assert.equal(other.allocate('optional-early',at('07:00')).finalLevel,'banner');
  other.calendar([...morning,event('eligible','08:05')]);
  assert.equal(other.allocate('optional-eligible',at('07:00')).finalLevel,'suppressed');
});
