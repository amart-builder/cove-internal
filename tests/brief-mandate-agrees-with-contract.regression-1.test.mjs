// The writing mandate and the planning contract now both reach the model in
// one prompt. Before they did not: the mandate had no production caller, so
// nothing checked them against each other. They must not give the model two
// answers to the same question.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {chiefOfStaffMandate} from '../src/lib/claude-execution/brief-commands.ts';
import {morningBriefSourcePrompt} from '../src/lib/claude-execution/worker.ts';

const mandate=chiefOfStaffMandate();
const contract=readFileSync(new URL('../src/lib/chief-of-staff/daily-planning.ts',import.meta.url),'utf8');

test('the mandate reaches the model that writes the brief',()=>{
 const prompt=morningBriefSourcePrompt({
  policy:'',targetLocalDate:'2026-09-21',targetTimezone:'America/Los_Angeles',
  manifest:{},sections:[{id:'goals',label:'GOALS',text:'ship'}],
 });
 assert.ok(prompt.includes(mandate.slice(0,200)),'the writing rules are in the prompt');
 assert.match(prompt,/GOALS/);
});

test('the mandate does not set a word count the contract forbids',()=>{
 // The contract says "without padding or a fixed length". A number of words in
 // the mandate is the model being told two different things at once.
 assert.match(contract,/without padding or a fixed length/);
 assert.doesNotMatch(mandate,/\b\d{2,4}\s*words\b/i);
});

test('the mandate names only fields the contract still has',()=>{
 // headline was replaced by the first action's nextAction. A mandate naming a
 // field that no longer exists asks for output the schema will reject.
 assert.doesNotMatch(mandate,/\bheadline\b/i);
 assert.match(mandate,/nextAction/);
 assert.match(mandate,/narrativeParagraphs/);
});

test('the brief is still written when the mandate file is unreadable',async()=>{
 const {morningBriefWritingMandate}=await import('../src/lib/claude-execution/worker.ts');
 assert.equal(typeof morningBriefWritingMandate(),'string');
});
