// Issues is where someone goes when something has gone wrong, so a warning
// that is no longer true is worse than no warning. Recovery from durable
// success evidence -- which is what this module is for -- was implemented for
// the chief-of-staff wake only, so a failed backup stayed on the screen
// telling the person not to rely on today's backup, night after night, while
// every backup since had succeeded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openLocalDatabase} from '../src/lib/local/database.ts';
import {recordFailureInDatabase} from '../src/lib/reliability/failures.ts';
import {reconcileRecoveredFailures} from '../src/lib/reliability/recoveries.ts';

const before='2026-09-10T10:00:00Z';
const after='2026-09-10T11:00:00Z';
function fixture(t){
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-recovery-periodic-'));
 const db=openLocalDatabase(path.join(dir,'cove.db'));
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 return db;
}
function job(db,id,type,status,at){
 db.prepare("INSERT INTO cove_jobs(id,type,run_after,status,idempotency_key,created_at,finished_at) VALUES(?,?,?,?,?,?,?)").run(id,type,at,status,id,at,at);
}
function open(db){return db.prepare('SELECT source_id FROM cove_failure_inbox WHERE dismissed_at IS NULL').pluck().all();}

for(const type of ['backup','health-collector']){
 test(`a later successful ${type} clears the warning the old one left`,t=>{
  const db=fixture(t);
  job(db,'failed',type,'dead',before);
  recordFailureInDatabase(db,{source:'job',sourceId:'failed',message:'Failed',occurredAt:before});
  assert.deepEqual(open(db),['failed']);
  job(db,'succeeded',type,'done',after);
  reconcileRecoveredFailures(db,new Date(after));
  assert.deepEqual(open(db),[]);
 });

 test(`a ${type} that has not succeeded since keeps its warning`,t=>{
  const db=fixture(t);
  job(db,'failed',type,'dead',before);
  recordFailureInDatabase(db,{source:'job',sourceId:'failed',message:'Failed',occurredAt:before});
  // A success from before the failure proves nothing about it.
  job(db,'earlier',type,'done','2026-09-10T09:00:00Z');
  reconcileRecoveredFailures(db,new Date(after));
  assert.deepEqual(open(db),['failed']);
 });
}

test('a per-message email failure is never cleared by another message succeeding',t=>{
 const db=fixture(t);
 for(const type of ['email-classify','gmail-operation','email-artifacts']){
  job(db,`failed-${type}`,type,'dead',before);
  recordFailureInDatabase(db,{source:'job',sourceId:`failed-${type}`,message:'Failed',occurredAt:before});
  job(db,`succeeded-${type}`,type,'done',after);
 }
 reconcileRecoveredFailures(db,new Date(after));
 assert.equal(open(db).length,3,'a different message succeeding is not evidence about this one');
});

test('a fresh failure after the recovery stands on its own',t=>{
 const db=fixture(t);
 job(db,'failed','backup','dead',before);
 recordFailureInDatabase(db,{source:'job',sourceId:'failed',message:'Failed',occurredAt:before});
 job(db,'succeeded','backup','done',after);
 reconcileRecoveredFailures(db,new Date(after));
 assert.deepEqual(open(db),[]);
 job(db,'failed-again','backup','dead','2026-09-11T10:00:00Z');
 recordFailureInDatabase(db,{source:'job',sourceId:'failed-again',message:'Failed',occurredAt:'2026-09-11T10:00:00Z'});
 reconcileRecoveredFailures(db,new Date('2026-09-11T10:01:00Z'));
 assert.deepEqual(open(db),['failed-again']);
});
