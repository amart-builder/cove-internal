// The snapshot reported the attention day from two clocks at once. The usage
// counters come from dailyAttentionUsage, which bounds the day with the
// operator's configured timezone, while the itemised "suppressed or shadowed
// today" rows were bounded by the machine's own midnight. Where the two
// disagree the agent reads counters and rows scoped to different days, and
// reasons about a budget it is not being shown.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildChiefOfStaffSnapshot} from '../src/lib/chief-of-staff/snapshot.ts';
import {openLocalDatabase} from '../src/lib/local/database.ts';

// 2026-09-03T16:00Z is 09:00 on the 3rd in Los Angeles and 04:00 on the 4th in
// Auckland, so the two zones disagree about which day it is. The operator's
// day (Auckland) runs 2026-09-03T12:00Z to 2026-09-04T12:00Z; the machine's
// (Los Angeles, this gate's TZ) runs 2026-09-03T07:00Z to 2026-09-04T07:00Z.
const now=new Date('2026-09-03T16:00:00Z');
const TZ='Pacific/Auckland';
// Inside the machine's day and outside the operator's: yesterday, to the
// person whose budget this is.
const yesterdayForTheOperator='2026-09-03T09:00:00.000Z';

function fixture(t){
 const dataDir=mkdtempSync(path.join(os.tmpdir(),'cove-snapshot-tz-'));
 mkdirSync(path.join(dataDir,'operator-codex'),{recursive:true});
 writeFileSync(path.join(dataDir,'operator-codex','auth.json'),'{"auth":"operator"}\n');
 const dbPath=path.join(dataDir,'cove.db');
 const db=openLocalDatabase(dbPath);db.close();
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 return {dataDir,dbPath};
}

async function snapshot(dataDir,dbPath){
 return buildChiefOfStaffSnapshot({
  jobId:'job-1',
  wake:{reason:'manual',note:'check',payload:{}},
  session:{sessionId:null,createdAt:now.toISOString(),mandateHash:'hash',wakes:0,lastWakeAt:null,lastWakeReason:null},
  dataDir,dbPath,now,timezone:TZ,calendar:null,
 });
}

test('the itemised rows use the same day as the counters they sit under',async t=>{
 const {dataDir,dbPath}=fixture(t);
 const db=openLocalDatabase(dbPath);
 db.prepare("INSERT INTO cove_attention_ledger(id,kind,ref_kind,ref_id,level,reason,suppressed_reason,created_at) VALUES('s1','chief_of_staff','task','lease','suppressed','Scheduled follow-through','daily_banner_cap',?)").run(yesterdayForTheOperator);
 db.close();
 const text=await snapshot(dataDir,dbPath);
 const line=text.split('\n').find(l=>l.startsWith('Suppressed or shadowed today:'));
 assert.ok(line,'the attention section is present');
 // Read from the machine clock this row is today and the section said 1,
 // while the usage counters above it -- which use the operator's day -- said
 // nothing had happened.
 assert.equal(line,'Suppressed or shadowed today: 0');
 assert.doesNotMatch(text,/task:lease/);
});

test('a row inside the operator day is still reported',async t=>{
 const {dataDir,dbPath}=fixture(t);
 const db=openLocalDatabase(dbPath);
 db.prepare("INSERT INTO cove_attention_ledger(id,kind,ref_kind,ref_id,level,reason,suppressed_reason,created_at) VALUES('s2','chief_of_staff','task','lease','suppressed','Scheduled follow-through','daily_banner_cap',?)").run('2026-09-03T15:00:00.000Z');
 db.close();
 const text=await snapshot(dataDir,dbPath);
 assert.equal(text.split('\n').find(l=>l.startsWith('Suppressed or shadowed today:')),'Suppressed or shadowed today: 1');
 assert.match(text,/task:lease/);
});
