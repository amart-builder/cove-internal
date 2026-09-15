import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDailyDecision, readStoredDailyDecision } from '../src/lib/chief-of-staff/daily-planning.ts';
const source = { kind:'task', id:'proposal', version:'current', revision:0 };
const context = { plan:null, references:[source], now:'2026-09-15T15:00:00Z', text:JSON.stringify({timeZone:'America/Los_Angeles', nowLocal:'Tuesday, September 15, 2026 at 8:00 AM PDT'}) };
const raw = () => ({ actions:[{source,proposal:null,nextAction:'Prepare the proposal',rationale:'Preserve the promise.',assumptions:[],owner:'me',state:'ready',plannedFor:null,nextCheckAt:'2026-09-15T21:00:00-07:00'}],watches:[],questions:[],narrativeParagraphs:['The proposed check is {{action.1.nextCheckAt}}.'] });
test('generated check prose renders the same saved instant, including timezone rollover',()=>{
 const result=validateDailyDecision(raw(),context,{requireNarrative:true});
 assert.equal(result.actions[0].nextCheckAt,'2026-09-16T04:00:00.000Z');
 assert.deepEqual(result.narrativeParagraphs,['The proposed check is Tuesday, September 15, 2026 at 9:00 PM PDT.']);
 assert.deepEqual(readStoredDailyDecision(result),result);
});
test('captured Fable 2PM prose versus 9PM saved check is rejected before persistence',()=>{
 const input=raw();input.narrativeParagraphs=['The check is set for 2:00 PM PDT today.'];
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_prose_clock_requires_reference/);
});
test('unavailable, malformed and missing planned-time references fail closed',()=>{
 for(const token of ['{{action.2.nextCheckAt}}','{{action.1.plannedFor}}','{{time.999}}','{{action.1.nextCheckAt','{{unknown}}']){
 const input=raw();input.narrativeParagraphs=[token];
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_time_reference/);
 }
});
test('legacy stored prose stays readable and invalid calendar dates are rejected for new decisions',()=>{
 const input=raw();input.narrativeParagraphs=['Historical 2 PM check.'];
 assert.equal(validateDailyDecision(input,context).narrativeParagraphs[0],'Historical 2 PM check.');
 input.actions[0].nextCheckAt='2026-02-30T12:00:00Z';
 assert.throws(()=>validateDailyDecision(input,{...context,now:'2026-02-28T00:00:00Z'}),/planning_check_invalid/);
});
test('source clock references and question references render without editing sources',()=>{
 const input=raw();input.questions=[{source,outcomeKey:'proposal',decisionKey:'scope',question:'Decide scope before {{question.1.expiresAt}}.',nextCheckAt:'2026-09-15T17:00:00Z',expiresAt:'2026-09-16T17:00:00Z'}];
 input.narrativeParagraphs=['As of {{time.1}}, scope remains undecided.'];
 const result=validateDailyDecision(input,context,{requireNarrative:true});
 assert.match(result.narrativeParagraphs[0],/8:00 AM PDT/);
 assert.match(result.questions[0].question,/Wednesday, September 16, 2026 at 10:00 AM PDT/);
 assert.equal(input.narrativeParagraphs[0],'As of {{time.1}}, scope remains undecided.');
});

test('a proposed check cannot become a promise of future agent execution',()=>{
 const input=raw();input.narrativeParagraphs=['I will review the proposal again at {{action.1.nextCheckAt}}.'];
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_unactivated_follow_through_claim/);
 input.narrativeParagraphs=['A proposed review of progress is {{action.1.nextCheckAt}}.'];
 assert.doesNotThrow(()=>validateDailyDecision(input,context,{requireNarrative:true}));
});

test('supporting rationale can quote a supplied clock but cannot invent another',()=>{
 const input=raw();input.actions[0].rationale='The supplied note said 2 pm; that old date is unverified.';
 const options={requireNarrative:true,sourcePrompt:'Older note said 2 pm.'};
 assert.doesNotThrow(()=>validateDailyDecision(input,context,options));
 input.actions[0].rationale='The proposed check is 7 pm.';
 assert.throws(()=>validateDailyDecision(input,context,options),/planning_prose_clock_requires_reference/);
});

test('an exact full source date label can be quoted without a second timezone conversion',()=>{
 const input=raw();input.narrativeParagraphs=['As of Tuesday, September 15, 2026 at 8:00 AM PDT, the promise remains open.'];
 assert.doesNotThrow(()=>validateDailyDecision(input,context,{requireNarrative:true}));
 input.narrativeParagraphs=['As of Tuesday, September 15, 2026 at 2:00 PM PDT, the promise remains open.'];
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_prose_clock_requires_reference/);
});

test('short model references resolve the frozen source without transcribing version hashes',()=>{
 const input=raw();input.actions[0].source='ref.1';input.watches=['ref.1'];
 const decision=validateDailyDecision(input,context,{requireNarrative:true});
 assert.deepEqual(decision.actions[0].source,source);
 assert.deepEqual(readStoredDailyDecision(decision).watches,[source]);
 input.actions[0].source='ref.2';
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_reference_unavailable/);
});


test('a proposed watch cannot be presented as the only active check', () => {
 const input=raw(); input.narrativeParagraphs=['Treat the watch on this proposal as the only active check here.'];
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_unactivated_follow_through_claim/);
});
