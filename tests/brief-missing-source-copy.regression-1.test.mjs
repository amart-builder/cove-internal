// A brief that fails for a missing required source cannot succeed on a retry:
// the source is a file on disk. Both failure messages threw away the source id
// the code already carries and told the person to try again, which on a fresh
// install with no goals file is advice that fails identically every morning.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {morningBriefFailureDetail} from '../src/lib/day-plan/brief.ts';
import {morningBriefFailureMessage} from '../src/lib/claude-execution/worker.ts';

test('goals is a required source, so a fresh install can hit this',()=>{
 const sources=readFileSync(new URL('../src/lib/day-plan/brief-sources.ts',import.meta.url),'utf8');
 assert.match(sources,/goals: \{[\s\S]{0,200}required: true/);
});

for(const [name,copy] of [['arrival',morningBriefFailureDetail],['worker',morningBriefFailureMessage]]){
 test(`the ${name} message names the missing source instead of saying try again`,()=>{
  const text=copy('required_source_missing:goals');
  assert.match(text,/goals/i,'names what is missing');
  assert.doesNotMatch(text,/try again/i,'a retry cannot fix a missing file');
 });

 test(`the ${name} message keeps the retry for a source that can read again`,()=>{
  const text=copy('required_source_missing:task_snapshot');
  assert.match(text,/try again/i,'a failed read is worth repeating');
  assert.doesNotMatch(text,/task_snapshot/,'no internal identifier in product copy');
 });

 test(`the ${name} message never leaks the source id`,()=>{
  for(const code of ['required_source_missing:goals','required_source_missing:something_new','required_source_missing:']){
   const text=copy(code);
   assert.ok(text.length>0);
   assert.doesNotMatch(text,/required_source_missing|something_new|undefined/);
  }
 });

 test(`the ${name} message leaves other failures alone`,()=>{
  assert.match(copy('runner_unavailable'),/signed in/i);
 });
}
