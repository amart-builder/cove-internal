// The floor's one daily text is the off-machine signal: the only thing that
// reaches the person when they are away from the Mac. Meeting reminders only
// ever land on the Mac, yet a full calendar reserved every banner slot and
// suppressed that text -- on exactly the heavy day the reminder run's own
// contract says must not leave it unsent.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {allocateAttention} from '../src/lib/attention/ledger.mjs';
import {runLocalMigrations} from '../src/lib/local/migrations.ts';

// 10:00 in America/Los_Angeles, which the gate sets as the local zone.
const now=new Date('2026-09-03T17:00:00Z');
function fixture(t){
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-floor-text-'));
 const db=new Database(path.join(dir,'cove.db'));runLocalMigrations(db);
 t.after(()=>{if(db.open)db.close();rmSync(dir,{recursive:true,force:true});});
 return db;
}
function calendar(db,count){
 const events=Array.from({length:count},(_,i)=>({id:`meeting-${i}`,start:new Date(+now+(i+1)*3600_000).toISOString(),title:`Call ${i}`}));
 db.prepare("INSERT INTO cove_follow_through_state(key,value,updated_at) VALUES('calendar',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
  .run(JSON.stringify({status:'ready',events,timezone:'America/Los_Angeles'}),now.toISOString());
}
function floorText(db){
 return allocateAttention(db,{kind:'floor_nudge',refKind:'task',refId:'__floor_daily__:2026-09-03',requestedLevel:'text',maximumLevel:'text',reason:'Due today and still open in Cove: Send the signed lease.',now});
}

test('a day full of meetings cannot cancel the one text that leaves the Mac',t=>{
 const db=fixture(t);calendar(db,6);
 const allocation=floorText(db);
 assert.ok(allocation.row,'the floor text is allocated');
 assert.equal(allocation.finalLevel,'text');
});

test('only the first floor text of the day escapes the meeting reservation',t=>{
 const db=fixture(t);calendar(db,6);
 assert.equal(floorText(db).finalLevel,'text');
 // A second one is ordinary work again, so the meetings still hold the slots
 // and it cannot fall back to a banner either.
 const second=allocateAttention(db,{kind:'floor_nudge',refKind:'task',refId:'__floor_daily__:2026-09-03-again',requestedLevel:'text',maximumLevel:'text',reason:'A second text.',now});
 assert.notEqual(second.finalLevel,'text');
 assert.equal(second.row,null);
 assert.equal(second.suppressionRows.at(-1)?.suppressedReason,'reserved_upcoming_meetings');
});

test('a per-item floor banner is still reserved for the meetings', t=>{
 const db=fixture(t);calendar(db,6);
 const banner=allocateAttention(db,{kind:'floor_nudge',refKind:'task',refId:'lease',requestedLevel:'banner',maximumLevel:'banner',reason:'Due today and still open in Cove: Send the signed lease.',now});
 assert.equal(banner.row,null);
 assert.equal(banner.suppressionRows.at(-1)?.suppressedReason,'reserved_upcoming_meetings');
});

test('an ordinary day is unchanged',t=>{
 const db=fixture(t);calendar(db,2);
 assert.ok(floorText(db).row);
});
