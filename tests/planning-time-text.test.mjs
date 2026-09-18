import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDailyDecision, readStoredDailyDecision } from '../src/lib/chief-of-staff/daily-planning.ts';
import { planningTimeReferences } from '../src/lib/chief-of-staff/planning-time-text.ts';
const source = { kind:'task', id:'proposal', version:'current', revision:0 };
const context = { plan:null, references:[source], now:'2026-09-15T15:00:00Z', text:JSON.stringify({timeZone:'America/Los_Angeles', nowLocal:'Tuesday, September 15, 2026 at 8:00 AM PDT'}) };
const raw = () => ({ actions:[{source,proposal:null,nextAction:'Prepare the proposal',rationale:'Preserve the promise.',assumptions:[],owner:'me',state:'ready',plannedFor:null,nextCheckAt:'2026-09-15T21:00:00-07:00'}],watches:[],questions:[],narrativeParagraphs:['The proposed check is {{action.1.nextCheckAt}}.'] });
test('an AI-selected clock carries its proposed meaning into a question', () => {
 const input=raw();
 input.questions=[{source,outcomeKey:'booking-follow-up',decisionKey:'absence',question:'Your check whether Sam Lee has booked at {{action.1.nextCheckAt}} overlaps your absence. Keep it or defer it?',nextCheckAt:'2026-09-15T17:00:00Z',expiresAt:'2026-09-16T17:00:00Z'}];
 const result=validateDailyDecision(input,context,{requireNarrative:true});
 assert.match(result.questions[0].question,/9:00 PM PDT \(proposed review time\)/);
 assert.equal(readStoredDailyDecision(result).questions[0].question,result.questions[0].question);
});
test('a prior internal review retains its meaning when selected as source evidence', () => {
 const text=JSON.stringify({timeZone:'America/Los_Angeles',records:[{nextCheckAtLocal:'Wednesday, September 16, 2026 at 8:30 AM PDT'}]});
 const refs=planningTimeReferences(text,'');
 assert.deepEqual(refs.labels,['Wednesday, September 16, 2026 at 8:30 AM PDT (internal review time)']);
 const input=raw();input.narrativeParagraphs=['The saved review is {{time.1}}.'];
 assert.match(validateDailyDecision(input,{...context,text},{requireNarrative:true}).narrativeParagraphs[0],/internal review time/);
});
test('generated check prose renders the same saved instant, including timezone rollover',()=>{
 const result=validateDailyDecision(raw(),context,{requireNarrative:true});
 assert.equal(result.actions[0].nextCheckAt,'2026-09-16T04:00:00.000Z');
 assert.deepEqual(result.narrativeParagraphs,['The proposed check is Tuesday, September 15, 2026 at 9:00 PM PDT (proposed review time).']);
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


// Cove renders time labels after the authored fields are bounded, so a valid
// response grows on the way to storage. These cases sit just inside the authored
// bound and must still read back from storage unchanged.
const reference='{{action.1.nextCheckAt}}';
const fill=(prefix,length)=>`${prefix}${'context. '.repeat(200)}`.slice(0,length);
test('a near-limit action survives rendering and reads back from storage',()=>{
 const input=raw();
 input.actions[0].nextAction=fill(`Confirm whether Sam Lee has booked; a proposed review is ${reference}. `,200);
 input.actions[0].rationale=fill(`The promise is open and a proposed review is ${reference}. `,600);
 input.actions[0].assumptions=[fill(`Receipt is unverified before ${reference}. `,300)];
 input.questions=[{source,outcomeKey:'booking-follow-up',decisionKey:'absence',question:fill(`Keep the check whether Sam Lee has booked at ${reference} or defer it? `,500),nextCheckAt:'2026-09-15T17:00:00Z',expiresAt:'2026-09-16T17:00:00Z'}];
 assert.deepEqual([input.actions[0].nextAction.length,input.actions[0].rationale.length,input.actions[0].assumptions[0].length,input.questions[0].question.length],[200,600,300,500]);
 const decision=validateDailyDecision(input,context,{requireNarrative:true});
 assert.ok(decision.actions[0].nextAction.length>200);
 assert.ok(decision.actions[0].rationale.length>600);
 assert.ok(decision.actions[0].assumptions[0].length>300);
 assert.ok(decision.questions[0].question.length>500);
 assert.match(decision.actions[0].nextAction,/9:00 PM PDT \(proposed review time\)/);
 assert.deepEqual(readStoredDailyDecision(decision),decision);
});
test('the authored bound still rejects text one character too long',()=>{
 for(const [field,length] of [['nextAction',201],['rationale',601]]){
  const input=raw();input.actions[0][field]=fill('Authored text. ',length);
  assert.equal(input.actions[0][field].length,length);
  assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_text_invalid/);
 }
 const overLongQuestion=raw();
 overLongQuestion.questions=[{source,outcomeKey:'scope',decisionKey:'scope',question:fill('Which outcome is needed? ',501),nextCheckAt:'2026-09-15T17:00:00Z',expiresAt:'2026-09-16T17:00:00Z'}];
 assert.throws(()=>validateDailyDecision(overLongQuestion,context,{requireNarrative:true}),/planning_text_invalid/);
});
test('stuffing one field with time references fails instead of storing unreadable text',()=>{
 const input=raw();input.actions[0].assumptions=[reference.repeat(12)];
 assert.ok(input.actions[0].assumptions[0].length<=300);
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_rendered_text_too_long/);
});
test('an unbounded source label cannot be rendered into stored prose',()=>{
 const text=JSON.stringify({timeZone:'America/Los_Angeles',records:[{deadlineLocal:`Friday, ${'September 18, 2026 at 5:00 PM PDT '.repeat(4)}`}]});
 const input=raw();input.narrativeParagraphs=['The supplied deadline is {{time.1}}.'];
 assert.throws(()=>validateDailyDecision(input,{...context,text},{requireNarrative:true}),/planning_time_reference_invalid/);
});
test('a stored decision written under the authored bound stays readable',()=>{
 const legacy={version:1,basePlanId:null,basePlanVersion:null,actions:[{source,supportingSources:[],proposal:null,nextAction:'Prepare the proposal',rationale:'Saved last year.',assumptions:[],owner:'me',state:'ready',plannedFor:null,nextCheckAt:'2026-09-15T21:00:00.000Z'}],watches:[],questions:[],narrativeParagraphs:['A historical saved paragraph at 2 PM.']};
 assert.equal(readStoredDailyDecision(legacy).narrativeParagraphs[0],'A historical saved paragraph at 2 PM.');
});

test('a proposed watch cannot be presented as the only active check', () => {
 const input=raw(); input.narrativeParagraphs=['Treat the watch on this proposal as the only active check here.'];
 assert.throws(()=>validateDailyDecision(input,context,{requireNarrative:true}),/planning_unactivated_follow_through_claim/);
});
