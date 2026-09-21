// A reminder that never reached the person must leave a trace. The reaper used
// to rewrite every leftover pending notice to expired with error=NULL, which
// erased the two cases the notice table exists to record: a deadline reminder
// held by the attention allowance, and a snooze whose hour ran out inside quiet
// hours. Both vanished from the screen with nothing for the person to find.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openLocalDatabase} from '../src/lib/local/database.ts';
import {runFollowThrough,followThroughStatus,snoozeFollowThrough,acknowledgeFollowThrough} from '../src/lib/attention/follow-through.mjs';

const timezone='America/Los_Angeles';
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'cove-silent-expiry-'));const db=openLocalDatabase(path.join(dir,'cove.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return db;}
function run(db,now,extra={}){return runFollowThrough({db,now,timezone,calendar:async()=>null,notify:()=>{},...extra});}
function task(db,id,title){db.prepare("INSERT INTO tasks(id,title,due_at,status,remind_native) VALUES(?,?,'2026-09-04','open',1)").run(id,title);}
// 15:00 PDT on the day before the deadline: the start of the advance window,
// which closes at 18:00 when quiet hours begin.
const windowOpen=new Date('2026-09-03T22:00:00Z');
// 00:05 PDT on the deadline itself: the advance candidate is gone, so this is
// the sweep that reaps whatever is still pending.
const afterWindow=new Date('2026-09-04T07:05:00Z');

test('a snooze whose hour runs out in quiet hours is not a silent dismissal',async t=>{
 const db=fixture(t);task(db,'lease','Send the signed lease');
 let sends=0;const notify=()=>sends++;
 await run(db,windowOpen,{notify});
 assert.equal(sends,1);
 const notice=followThroughStatus(db,windowOpen).notices[0];
 // Snoozed at 17:10, so the hour is up at 18:10, after banners stop for the day.
 assert.ok(snoozeFollowThrough(db,notice.id,new Date('2026-09-04T00:10:00Z')));
 await run(db,new Date('2026-09-04T01:15:00Z'),{notify});
 await run(db,afterWindow,{notify});
 assert.equal(sends,1,'quiet hours still hold, so nothing is sent');
 const after=followThroughStatus(db,afterWindow);
 const reaped=after.notices[0];
 assert.equal(reaped.status,'expired');
 assert.ok(reaped.error,'the reason the snooze never came back is recorded');
 assert.equal(reaped.needsAttention,1);
 assert.equal(after.unresolved,1);
 assert.equal(after.protection,'attention_required');
 // The person can still clear it themselves.
 assert.equal(acknowledgeFollowThrough(db,reaped.id,afterWindow),true);
 assert.equal(followThroughStatus(db,afterWindow).unresolved,0);
});

test('a deadline reminder held by the attention allowance stays visible after its window closes',async t=>{
 const db=fixture(t);
 for(let i=0;i<8;i++)db.prepare("INSERT INTO cove_attention_ledger(id,kind,ref_kind,ref_id,level,reason,delivered_at,created_at) VALUES(?,'chief_of_staff','task',?,'banner','old',?,?)").run(`old-${i}`,`old-${i}`,windowOpen.toISOString(),windowOpen.toISOString());
 task(db,'extension','File the tax extension');
 let sends=0;const notify=()=>sends++;
 await run(db,windowOpen,{notify});
 assert.equal(sends,0,'the allowance holds the banner');
 assert.equal(followThroughStatus(db,windowOpen).unresolved,1);
 await run(db,afterWindow,{notify});
 const after=followThroughStatus(db,afterWindow);
 assert.equal(after.notices[0].status,'expired');
 assert.match(after.notices[0].error,/held by the attention allowance/);
 assert.equal(after.unresolved,1,'a held deadline reminder does not stop needing attention');
});

test('a reminder for work the person finished still expires quietly',async t=>{
 const db=fixture(t);task(db,'done','Book the venue');
 let sends=0;const notify=()=>sends++;
 await run(db,windowOpen,{notify});
 assert.equal(sends,1);
 const notice=followThroughStatus(db,windowOpen).notices[0];
 assert.ok(snoozeFollowThrough(db,notice.id,new Date('2026-09-04T00:10:00Z')));
 db.prepare("UPDATE tasks SET status='done' WHERE id='done'").run();
 await run(db,afterWindow,{notify});
 const after=followThroughStatus(db,afterWindow);
 assert.equal(after.notices[0].status,'expired');
 assert.equal(after.unresolved,0,'finished work raises nothing');
});

test('an archived task that was snoozed expires quietly too',async t=>{
 const db=fixture(t);task(db,'gone','Draft the renewal');
 await run(db,windowOpen);
 const notice=followThroughStatus(db,windowOpen).notices[0];
 assert.ok(snoozeFollowThrough(db,notice.id,new Date('2026-09-04T00:10:00Z')));
 db.prepare("UPDATE tasks SET archived_at=? WHERE id='gone'").run(windowOpen.toISOString());
 await run(db,afterWindow);
 assert.equal(followThroughStatus(db,afterWindow).unresolved,0);
});
