// A board with no sources forces the planning schema to maxItems:0, so the
// decision has no actions and the brief falls back to a headline. That is not
// an edge case on a new install -- it is the first morning, before the person
// has captured anything. The line has to be written for them to read.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLocalDatabase} from '../src/lib/local/database.ts';
import {createDayPlanStore} from '../src/lib/day-plan/store.ts';
import {validateDailyDecision,decisionAsBrief,dailyPlanningSchema} from '../src/lib/chief-of-staff/daily-planning.ts';

const date='2026-09-11';
const now=new Date('2026-09-11T15:00:00Z');
function fixture(t){
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-first-morning-'));
 const file=path.join(dir,'cove.db');
 const db=openLocalDatabase(file);
 const store=createDayPlanStore({dbPath:file,now:()=>now});
 t.after(()=>{store.close();db.close();rmSync(dir,{recursive:true,force:true});});
 return {db,store};
}

test('an empty board leaves the model no choice but an empty decision',t=>{
 const {store}=fixture(t);
 const schema=dailyPlanningSchema(store.planningContext(date));
 assert.equal(schema.properties.actions.maxItems,0);
});

test('the first morning opens with a sentence written for the person',t=>{
 const {store}=fixture(t);
 const context=store.planningContext(date);
 const decision=validateDailyDecision(
  {actions:[],watches:[],questions:[],narrativeParagraphs:['Nothing has been captured in Cove yet.']},
  context,
 );
 const brief=decisionAsBrief(decision);
 assert.doesNotMatch(brief.headline,/proposed/i,'not the language of a planner talking to itself');
 assert.match(brief.headline,/\byou\b|\byour\b/i,'addressed to the person');
 assert.ok(brief.headline.length<=90);
 // The opening line is printed above the body; it must not also start it.
 assert.notEqual(brief.narrativeParagraphs[0],brief.headline);
});
