import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { runFollowThrough,followThroughStatus,snoozeFollowThrough } from '../src/lib/attention/follow-through.mjs';
function fixture(t) {const dir=mkdtempSync(path.join(os.tmpdir(),'cove-follow-through-'));const db=openLocalDatabase(path.join(dir,'cove.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return db;}
const timezone='America/Los_Angeles';
const instant=new Date('2026-09-03T22:00:00Z');
function task(db,id,due,extra={}) {db.prepare("INSERT INTO tasks(id,title,due_at,status,remind_native,notification_policy) VALUES(?,?,?,'open',1,?)").run(id,`Prepare ${id}`,due,extra.policy??null);}
function run(db,now=instant,extra={}) {return runFollowThrough({db,now,timezone,calendar:async()=>null,notify:()=>{},...extra});}
test('date-only advance is local 3pm the preceding day, dedupes across restarts, completion cancels',async t=>{
 const db=fixture(t);task(db,'proposal','2026-09-04');const messages=[];
 await run(db,new Date('2026-09-03T21:59:00Z'),{notify:x=>messages.push(x)});assert.equal(messages.length,0);
 await run(db,instant,{notify:x=>messages.push(x)});await run(db,new Date(+instant+60000),{notify:x=>messages.push(x)});assert.equal(messages.length,1);assert.match(messages[0].message,/Coming due/);
 const id=followThroughStatus(db,instant).notices[0].id;assert.ok(snoozeFollowThrough(db,id,instant));db.prepare("UPDATE tasks SET status='done' WHERE id='proposal'").run();
 await run(db,new Date(+instant+3600000),{notify:x=>messages.push(x)});assert.equal(messages.length,1);assert.equal(followThroughStatus(db,instant).notices[0].status,'expired');
});
test('meeting prep excludes cancelled, declined, and all-day events and never uses stale failed calendar',async t=>{
 const db=fixture(t);const messages=[];const events=[{id:'good',summary:'Planning',start:new Date(+instant+15*60000).toISOString(),attendees:[]},{id:'cancelled',status:'cancelled',start:new Date(+instant+60000).toISOString()},{id:'declined',start:new Date(+instant+60000).toISOString(),attendees:[{self:true,responseStatus:'declined'}]},{id:'all-day',start:'2026-09-03'}];
 await run(db,instant,{calendar:async()=>({listEvents:async()=>events}),notify:x=>messages.push(x)});assert.equal(messages.length,1);assert.match(messages[0].message,/15 minutes/);
 await run(db,new Date(+instant+5*60000),{calendar:async()=>{throw Error('offline');},notify:x=>messages.push(x)});assert.equal(messages.length,1);assert.equal(followThroughStatus(db,new Date(+instant+5*60000)).calendar.fresh,false);
});
test('quiet hours, policy opt-out, engagement, and failed notification retries stay bounded',async t=>{
 const db=fixture(t);task(db,'disabled','2026-09-04',{policy:'none'});task(db,'working','2026-09-04');task(db,'failure','2026-09-04');db.prepare("UPDATE tasks SET engaged_at=? WHERE id='working'").run(instant.toISOString());let sends=0;
 const notify=()=>{sends++;throw Object.assign(Error('unavailable'),{deliveryNotAttempted:true});};
 for(const minutes of [0,1,5,10,15]) await run(db,new Date(+instant+minutes*60000),{notify});assert.equal(sends,3);assert.equal(followThroughStatus(db,instant).notices[0].status,'failed');
 task(db,'night','2026-09-05');await run(db,new Date('2026-09-05T02:00:00Z'),{notify});assert.equal(sends,3);
});
test('interrupted delivery remains visible, hourly snooze does not silently succeed, and unhealthy heartbeat is explicit',async t=>{
 const db=fixture(t);task(db,'proposal','2026-09-04');await run(db);const notice=followThroughStatus(db,instant).notices[0];
 db.prepare("UPDATE cove_follow_through_notices SET status='sending'").run();await run(db,new Date(+instant+6*60000));assert.equal(followThroughStatus(db,instant).notices[0].status,'uncertain');assert.equal(followThroughStatus(db,new Date(+instant+20*60000)).healthy,false);
 assert.ok(snoozeFollowThrough(db,notice.id,new Date(+instant+6*60000)));
});

test('explicit due-only and advance-only preferences are respected',async t=>{
 const db=fixture(t);task(db,'due-only','2026-09-04',{policy:'due'});task(db,'advance-only','2026-09-02',{policy:'predeadline'});let sends=0;
 await run(db,instant,{notify:()=>sends++});assert.equal(sends,0);
});
test('snoozed advance returns in one hour, within the shared banner budget',async t=>{
 const db=fixture(t);task(db,'snoozed','2026-09-04');let sends=0;const notify=()=>sends++;
 await run(db,instant,{notify});const id=followThroughStatus(db,instant).notices[0].id;snoozeFollowThrough(db,id,instant);
 await run(db,new Date(+instant+59*60000),{notify});assert.equal(sends,1);
 await run(db,new Date(+instant+60*60000),{notify});assert.equal(sends,2);
});

test('a timed-out native handoff is uncertain and never automatically retried',async t=>{
 const db=fixture(t);task(db,'uncertain','2026-09-04');let attempts=0;const notify=()=>{attempts++;throw Error('timed out');};
 await run(db,instant,{notify});await run(db,new Date(+instant+6*60000),{notify});assert.equal(attempts,1);assert.equal(followThroughStatus(db,instant).notices[0].status,'uncertain');
});


test('archived tasks cannot produce or repeat follow-through reminders',async t=>{
 const db=fixture(t);task(db,'archived','2026-09-04');task(db,'snoozed-then-archived','2026-09-04');
 db.prepare("UPDATE tasks SET archived_at=? WHERE id='archived'").run(instant.toISOString());let sends=0;
 await run(db,instant,{notify:()=>sends++});assert.equal(sends,1);
 const notice=followThroughStatus(db,instant).notices[0];assert.equal(notice.refId,'snoozed-then-archived');snoozeFollowThrough(db,notice.id,instant);
 db.prepare("UPDATE tasks SET archived_at=? WHERE id='snoozed-then-archived'").run(instant.toISOString());
 await run(db,new Date(+instant+3600000),{notify:()=>sends++});assert.equal(sends,1);assert.equal(followThroughStatus(db,instant).notices[0].status,'expired');
});


test('an explicit reminder added after nomination takes ownership before advance delivery',async t=>{
 const db=fixture(t);task(db,'first','2026-09-04');task(db,'second','2026-09-04');const messages=[];
 await run(db,instant,{notify:message=>{messages.push(message);db.prepare("UPDATE tasks SET remind_at=? WHERE id='second'").run(new Date(+instant+7200000).toISOString());}});
 assert.equal(messages.length,1);assert.match(messages[0].message,/first/);
 assert.equal(followThroughStatus(db,instant).notices.find(x=>x.refId==='second').status,'pending');
});

test('five earlier banners cannot hide the imminent meeting; acknowledgement prevents a duplicate',async t=>{
 const db=fixture(t);for(let i=0;i<5;i++)db.prepare("INSERT INTO cove_attention_ledger(id,kind,ref_kind,ref_id,level,reason,delivered_at,created_at) VALUES(?,'chief_of_staff','task',?,'banner','old',?,?)").run(`old-${i}`,`old-${i}`,instant.toISOString(),instant.toISOString());
 const messages=[];const calendar=async()=>({listEvents:async()=>[{id:'meeting',summary:'Planning',start:new Date(+instant+10*60000).toISOString()}]});await run(db,instant,{calendar,notify:x=>messages.push(x)});assert.equal(messages.length,1);
 const {acknowledgeFollowThrough}=await import('../src/lib/attention/follow-through.mjs');const notice=followThroughStatus(db,instant).notices[0];assert.equal(acknowledgeFollowThrough(db,notice.id,instant),true);await run(db,new Date(+instant+60000),{calendar,notify:x=>messages.push(x)});assert.equal(messages.length,1);
});
test('a suppressed meeting becomes visibly missed, while a cancelled future meeting expires',async t=>{
 const db=fixture(t);for(let i=0;i<6;i++)db.prepare("INSERT INTO cove_attention_ledger(id,kind,ref_kind,ref_id,level,reason,delivered_at,created_at) VALUES(?,'chief_of_staff','task',?,'banner','old',?,?)").run(`old-${i}`,`old-${i}`,instant.toISOString(),instant.toISOString());
 const calendar=async()=>({listEvents:async()=>[{id:'meeting',summary:'Planning',start:new Date(+instant+10*60000).toISOString()}]});let s=await run(db,instant,{calendar});assert.equal(s.protection,'attention_required');assert.equal(s.notices[0].status,'pending');
 s=await run(db,new Date(+instant+11*60000),{calendar:async()=>({listEvents:async()=>[]})});assert.equal(s.notices[0].status,'missed');assert.equal(s.protection,'attention_required');
});
test('confirmed commitments receive deadline coverage without being copied to tasks',async t=>{
 const db=fixture(t);db.prepare("INSERT INTO commitments(id,kind,title,source_kind,due_at,confirmed,created_at,updated_at) VALUES('promise','promise','Send Bob the proposal','manual','2026-09-04',1,?,?)").run(instant.toISOString(),instant.toISOString());const messages=[];await run(db,instant,{notify:x=>messages.push(x)});assert.equal(messages.length,1);assert.match(messages[0].message,/Bob/);assert.equal(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(),0);
});

test('responsibility acknowledgement quiets the native follow-through for one hour',async t=>{
 const db=fixture(t);task(db,'proposal',new Date(+instant+20*60000).toISOString());const {reconcileResponsibilities,listResponsibilities,acknowledgeResponsibility}=await import('../src/lib/responsibility/store.ts');reconcileResponsibilities(db,instant);const row=listResponsibilities(db)[0];acknowledgeResponsibility(db,'task','proposal',row.revision,instant);let sends=0;await run(db,new Date(+instant+60000),{notify:()=>sends++});assert.equal(sends,0);
});
