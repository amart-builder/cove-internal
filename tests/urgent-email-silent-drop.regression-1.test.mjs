// An email judged urgent that alerts nobody is the exact drop this lane exists
// to prevent. Most ways it stays quiet are returns, not throws, so the caller
// used to discard them and the Failure Inbox stayed empty. Reaching the
// interruption budget is the policy working and already reaches the board, so
// it must stay quiet.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createEmailClassificationHandler} from '../src/lib/email/classification-job.ts';
import {observeInboundMessage} from '../src/lib/email/state-machine.ts';
import {openLocalDatabase} from '../src/lib/local/database.ts';
import {listFailures} from '../src/lib/reliability/failures.ts';

async function classifyUrgent(t,urgentHandler) {
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-urgent-drop-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'cove.db');
 const db=openLocalDatabase(dbPath);db.close();
 const subject='Wire deadline is today';
 const observed=observeInboundMessage({messageId:'m1',threadId:'t1',internalDate:'1000',accountEmail:'owner@example.com',subject,bodyExcerpt:subject,dbPath});
 const handler=createEmailClassificationHandler({dbPath,dataDir:dir,accountEmail:'owner@example.com',urgentHandler,
  gateway:{getMessage:async()=>({id:'m1',threadId:'t1',labelIds:['INBOX'],internalDate:'1000',headers:[{name:'From',value:'Counsel <counsel@example.com>'},{name:'Subject',value:subject}],snippet:subject,text:subject}),modifyThreadLabels:async()=>{}},
  classifier:async()=>({bucket:'action',summary:'Closing wire must go out today.',recommendedAction:'Send the wire.',draftBody:null,modelVersion:'fixture',commitments:[],recordCorrespondence:false,urgent:true,urgencyReason:'Closing wire deadline.'}),
 });
 await handler({id:'classify-job',type:'email-classify',payload:{messageId:'m1',emailItemId:observed.emailItemId,threadVersion:observed.threadVersion}});
 return listFailures({dbPath}).filter(item=>item.source==='urgent-email');
}

test('an urgent alert nobody received reaches the Failure Inbox',async t=>{
 const failures=await classifyUrgent(t,()=>({status:'suppressed',reason:'delivery_failed'}));
 assert.equal(failures.length,1);
 assert.match(failures[0].message,/could not get your attention/);
 assert.match(failures[0].message,/Check your inbox/);
});

test('an install with no attention records says so rather than staying silent',async t=>{
 const failures=await classifyUrgent(t,()=>({status:'suppressed',reason:'no_ledger'}));
 assert.equal(failures.length,1);
 assert.match(failures[0].message,/attention records are not set up/);
});

test('reaching the interruption budget is the policy working, not a failure',async t=>{
 assert.deepEqual(await classifyUrgent(t,()=>({status:'suppressed',reason:'budget'})),[]);
});

// A new install runs this lane in shadow mode, so nothing was ever going to be
// delivered. A failed shadow write loses a log line, not the person's alert.
test('a shadow run that could not record itself is not a missed alert',async t=>{
 assert.deepEqual(await classifyUrgent(t,()=>({status:'suppressed',reason:'shadow_only'})),[]);
});

// The caller decides on an allowlist, so a suppression with no reason at all --
// an older build, or a path that forgot to say -- is treated as a drop rather
// than waved through.
test('a suppression that does not say why is treated as a drop',async t=>{
 const rows=await classifyUrgent(t,()=>({status:'suppressed'}));
 assert.equal(rows.length,1);
 assert.match(rows[0].message,/could not get your attention/);
});

test('a delivered alert records nothing',async t=>{
 assert.deepEqual(await classifyUrgent(t,()=>({status:'live',row:{id:'row1'}})),[]);
});

test('a thrown alert failure keeps its diagnostic out of what the person reads',async t=>{
 const failures=await classifyUrgent(t,()=>{throw new Error('SQLITE_BUSY: database is locked');});
 assert.equal(failures.length,1);
 assert.doesNotMatch(failures[0].message,/SQLITE_BUSY/);
 assert.match(failures[0].message,/could not get your attention/);
 assert.match(String(failures[0].details?.error ?? ''),/SQLITE_BUSY/);
});
