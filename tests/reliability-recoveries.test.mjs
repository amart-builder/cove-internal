import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import path from 'node:path';import os from 'node:os';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { recordFailureInDatabase } from '../src/lib/reliability/failures.ts';
import { reconcileRecoveredFailures } from '../src/lib/reliability/recoveries.ts';
test('new review success resolves the old service warning without changing failed jobs or unrelated work',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-recoveries-'));const db=openLocalDatabase(path.join(dir,'cove.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const insert=db.prepare("INSERT INTO cove_jobs(id,type,run_after,status,idempotency_key,created_at,finished_at) VALUES(?,?,?, ?,?,?,?)");
 const start='2026-09-10T10:00:00Z';const end='2026-09-10T11:00:00Z';
 insert.run('old','chief-of-staff-wake',start,'dead','old',start,start);
 insert.run('new','chief-of-staff-wake',end,'done','new',end,end);
 insert.run('backup','backup',start,'dead','backup',start,start);
 db.prepare("UPDATE cove_jobs SET payload=? WHERE type='chief-of-staff-wake'").run(JSON.stringify({reason:'follow_through',payload:{}}));
 for(const id of ['old','backup'])recordFailureInDatabase(db,{source:'job',sourceId:id,message:'Failed',occurredAt:start});
 reconcileRecoveredFailures(db,new Date(end));
 assert.deepEqual(db.prepare('SELECT source_id FROM cove_failure_inbox WHERE dismissed_at IS NULL').pluck().all(),['backup']);
 assert.equal(db.prepare("SELECT status FROM cove_jobs WHERE id='old'").pluck().get(),'dead');
 recordFailureInDatabase(db,{source:'job',sourceId:'old',message:'Later failure',occurredAt:'2026-09-10T12:00:00Z'});
 reconcileRecoveredFailures(db,new Date('2026-09-10T12:01:00Z'));
 assert.equal(db.prepare('SELECT count(*) FROM cove_failure_inbox WHERE dismissed_at IS NULL').pluck().get(),2);
});

test('an aggregate warning survives a pending retry and clears only after all analysis succeeds',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-recovery-aggregate-'));const db=openLocalDatabase(path.join(dir,'cove.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const insert=db.prepare('INSERT INTO meeting_analysis_jobs(id,group_key,input_hash,not_before,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
 const values=(id,status,at)=>[id,id,id,at,status,at,at];
 const before='2026-09-10T10:00:00Z';const after='2026-09-10T11:00:00Z';
 insert.run(...values('retry','pending',before));insert.run(...values('other','succeeded',after));
 recordFailureInDatabase(db,{source:'receipt',sourceId:'meeting-watch:meeting-watch-run',message:'Meeting analysis jobs failed=1 dead=0.',occurredAt:before});
 reconcileRecoveredFailures(db,new Date(after));
 assert.equal(db.prepare('SELECT count(*) FROM cove_failure_inbox WHERE dismissed_at IS NULL').pluck().get(),1);
 db.prepare("UPDATE meeting_analysis_jobs SET status='succeeded',updated_at=? WHERE id='retry'").run(after);
 reconcileRecoveredFailures(db,new Date(after));
 assert.equal(db.prepare('SELECT count(*) FROM cove_failure_inbox WHERE dismissed_at IS NULL').pluck().get(),0);
});


test('a completed chief wake with rejected actions cannot clear the previous warning',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-recovery-rejected-'));const db=openLocalDatabase(path.join(dir,'cove.db'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const start='2026-09-10T10:00:00Z';const end='2026-09-10T11:00:00Z';
 const insert=db.prepare("INSERT INTO cove_jobs(id,type,payload,run_after,status,idempotency_key,created_at,finished_at) VALUES(?,'chief-of-staff-wake',?,?,?,?,?,?)");
 const payload=JSON.stringify({reason:'follow_through',payload:{}});
 insert.run('old',payload,start,'dead','old',start,start);insert.run('new',payload,end,'done','new',end,end);
 recordFailureInDatabase(db,{source:'job',sourceId:'old',message:'Failed',occurredAt:start});
 db.prepare("INSERT INTO chief_of_staff_actions(wake_job_id,content_hash,action_id,kind,payload_json,status,error) VALUES('new','hash','notification','notify','{}','rejected','native_delivery_failed')").run();
 reconcileRecoveredFailures(db,new Date(end));
 assert.equal(db.prepare("SELECT dismissed_at FROM cove_failure_inbox WHERE source_id='old'").pluck().get(),null);
 insert.run('clean',payload,end,'done','clean',end,end);
 reconcileRecoveredFailures(db,new Date(end));
 assert.notEqual(db.prepare("SELECT dismissed_at FROM cove_failure_inbox WHERE source_id='old'").pluck().get(),null);
});
