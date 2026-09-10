import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createEmailClassificationHandler,createEmailArtifactHandler} from '../src/lib/email/classification-job.ts';
import {observeInboundMessage} from '../src/lib/email/state-machine.ts';
import {openLocalDatabase} from '../src/lib/local/database.ts';

function fixture(t) {
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-charge-notice-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'cove.db');
 const db=openLocalDatabase(dbPath);db.close();
 return {dir,dbPath};
}
function query(dbPath,sql,...values) {
 const db=openLocalDatabase(dbPath);try{return db.prepare(sql).get(...values);}finally{db.close();}
}
async function classify(t,subject,text=subject,bucket='noise') {
 const {dir,dbPath}=fixture(t);
 const observed=observeInboundMessage({messageId:'m1',threadId:'t1',internalDate:'1000',accountEmail:'owner@example.com',subject,bodyExcerpt:text,dbPath});
 const handler=createEmailClassificationHandler({dbPath,dataDir:dir,accountEmail:'owner@example.com',
  gateway:{getMessage:async()=>({id:'m1',threadId:'t1',labelIds:['INBOX'],internalDate:'1000',headers:[{name:'From',value:'Example Bank <notice@example.com>'},{name:'Subject',value:subject}],snippet:text,text}),modifyThreadLabels:async()=>{}},
  classifier:async()=>({bucket,summary:'Routine automated notice.',recommendedAction:null,draftBody:null,modelVersion:'fixture',commitments:[],recordCorrespondence:false,urgent:false}),
 });
 await handler({id:'classify-job',type:'email-classify',payload:{messageId:'m1',emailItemId:observed.emailItemId,threadVersion:observed.threadVersion}});
 const item=query(dbPath,'SELECT * FROM email_items WHERE id=?',observed.emailItemId);
 const stored=query(dbPath,"SELECT * FROM cove_jobs WHERE type='email-artifacts'");
 return {dir,dbPath,item,job:{id:stored.id,type:stored.type,payload:JSON.parse(stored.payload)}};
}

test('a bank charge cannot be noise or archived even when the model calls it routine',async t=>{
 const {dbPath,item,job}=await classify(t,'HARBOR CLUB has charged your bank account $500.00 by ACH');
 assert.equal(item.bucket,'action');assert.equal(item.workflow_state,'open');assert.equal(item.status,'pending');
 assert.match(item.recommended_action,/charge/i);assert.doesNotMatch(item.summary,/Routine/);
 assert.equal(query(dbPath,"SELECT count(*) AS n FROM cove_gmail_operations WHERE kind='archive_messages'").n,0);
 assert.equal(job.payload.financialChargeNotice,true);
});

test('a small recurring card payment cannot be quietly recorded as FYI',async t=>{
 const {item,job}=await classify(t,'Your subscription renewed','Your card was charged $0.99 for your subscription.','fyi');
 assert.equal(item.bucket,'action');assert.equal(item.status,'pending');assert.equal(job.payload.financialChargeNotice,true);
});

for(const subject of ['Your account statement is ready','Your incoming ACH transfer of $500 is complete','Payment received from a customer: $500','Your $500 refund is complete','Charge your phone faster, now $20','Free membership with no charge']) {
 test(`ordinary information is not promoted: ${subject}`,async t=>{
  const {item,job}=await classify(t,subject);
  assert.equal(item.bucket,'noise');assert.equal(job.payload.financialChargeNotice,false);
 });
}

test('charge delivery is durable, native-only, and deduplicates a job replay',async t=>{
 const {dbPath,job}=await classify(t,'Your card was charged $12.00');
 const calls=[];const handler=createEmailArtifactHandler({dbPath,chargeNotifier:(...args)=>calls.push(args)});
 const first=await handler(job);assert.equal(first.actions.chargeNotice,'accepted');
 assert.equal((await handler(job)).actions.chargeNotice,'deduped');
 assert.equal(calls.length,1);assert.match(calls[0][1],/email=1/);
 assert.equal(query(dbPath,'SELECT workflow_state FROM email_items').workflow_state,'open');
 assert.equal(query(dbPath,"SELECT outcome FROM cove_receipts WHERE source='email-charge-notification'").outcome,'success');
});

test('a failed native notification keeps the charge visible, surfaces failure and never blindly resends',async t=>{
 const {dbPath,job}=await classify(t,'Your card was charged $12.00');
 let calls=0;const handler=createEmailArtifactHandler({dbPath,chargeNotifier:()=>{calls++;throw new Error('Native delivery failed');}});
 await assert.rejects(handler(job),/Native delivery failed/);
 await assert.rejects(handler(job),/could not confirm/);
 assert.equal(calls,1);
 assert.equal(query(dbPath,'SELECT workflow_state FROM email_items').workflow_state,'open');
 assert.equal(query(dbPath,"SELECT count(*) AS n FROM cove_failure_inbox WHERE source='receipt'").n,1);
});

test('an interrupted attempt is not resent and a reviewed charge is not notified',async t=>{
 const {dbPath,job}=await classify(t,'Your card was charged $12.00');
 const db=openLocalDatabase(dbPath);
 db.prepare("UPDATE cove_jobs SET payload=json_set(payload,'$.financialNoticeDelivery','attempting') WHERE id=?").run(job.id);db.close();
 let calls=0;const handler=createEmailArtifactHandler({dbPath,chargeNotifier:()=>calls++});
 await assert.rejects(handler(job),/could not confirm/);
 const update=openLocalDatabase(dbPath);update.prepare("UPDATE email_items SET workflow_state='terminal',status='actioned'").run();update.close();
 assert.equal((await handler(job)).actions.chargeNotice,'stale');assert.equal(calls,0);
});

for(const [subject,text] of [
 ['Card payment','You spent $42.00 at a coffee shop using your card.'],
 ['Purchase approved','A card purchase of $42.00 was approved at a coffee shop.'],
 ['Bank transaction','ACH debit of $500.00 from your checking account.'],
 ['Invoice #123 paid','We received your $35.00 payment.'],
 ['Your payment confirmation','Total: $19.00'],
]) {
 test(`outgoing payment language is protected: ${subject}`,async t=>{
  const {item,job}=await classify(t,subject,text);
  assert.equal(item.bucket,'action');assert.equal(job.payload.financialChargeNotice,true);
 });
}
for(const text of ['You have not been charged $50.00.','Your customer was charged $500.00.','Your card will not be charged $5.00.']) {
 test(`negated and customer charges remain ordinary: ${text}`,async t=>{
  const {item}=await classify(t,'Account update',text);assert.equal(item.bucket,'noise');
 });
}

test('notification failure does not discard grounded commitments',async t=>{
 const {dbPath,job}=await classify(t,'Your card was charged $12.00');
 const commitment={kind:'follow_up',title:'Check the statement',sourceQuote:'Check the statement',dueAt:null};
 job.payload.commitments=[commitment];
 const db=openLocalDatabase(dbPath);db.prepare('UPDATE cove_jobs SET payload=? WHERE id=?').run(JSON.stringify(job.payload),job.id);db.close();
 const handler=createEmailArtifactHandler({dbPath,chargeNotifier:()=>{throw new Error('Native delivery failed');}});
 await assert.rejects(handler(job),/Native delivery failed/);
 assert.equal(query(dbPath,"SELECT count(*) AS n FROM commitments WHERE title='Check the statement'").n,1);
});


test('contact artifact errors do not prevent the charge notification',async t=>{
 const {dbPath,job}=await classify(t,'Your card was charged $12.00');
 job.payload.recordCorrespondence=true;delete job.payload.senderEmail;
 let calls=0;const handler=createEmailArtifactHandler({dbPath,chargeNotifier:()=>calls++});
 await assert.rejects(handler(job),/senderEmail/);assert.equal(calls,1);
 assert.equal(query(dbPath,"SELECT json_extract(payload,'$.financialNoticeDelivery') AS delivery FROM cove_jobs WHERE id=?",job.id).delivery,'accepted');
});
