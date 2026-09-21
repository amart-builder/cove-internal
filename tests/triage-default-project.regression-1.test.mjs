// "Atlas" is the folder name on the machine Cove was built on. It was baked
// into the triage protocol as the default project and into the validator as an
// always-allowed name, so every general capture on anyone else's install was
// filed under a project word they had never seen.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {validateTriageOutput} from '../src/lib/triage/protocol.ts';
import {operatorDefaultProject} from '../src/lib/operator.ts';

function triage(overrides={}){
 return {
  title:'Send the signed lease',description:'Closing depends on it.',project:'Atlas',
  priority:'high',due_at:'2026-09-22T17:00:00Z',autonomy:'none',groundwork_notes:null,
  surface:'board',surface_at:null,urgency_reason:'Closing date.',offer:'Want the draft?',
  ...overrides,
 };
}

test('the default project comes from the person, not from the build machine',()=>{
 assert.equal(operatorDefaultProject(undefined,{COVE_DEFAULT_PROJECT:'Home'}),'Home');
 assert.equal(validateTriageOutput(triage({project:'Home'}),[],'Home').project,'Home');
});

test('a name from someone else\'s install is not silently accepted',()=>{
 assert.throws(()=>validateTriageOutput(triage({project:'Atlas'}),[],'Home'),/triage_project_invalid/);
});

test('an install that set nothing still behaves exactly as before',()=>{
 assert.equal(operatorDefaultProject(undefined,{}),'Atlas');
 assert.equal(validateTriageOutput(triage(),[]).project,'Atlas');
});

test('the person\'s own project folders are still allowed',()=>{
 assert.equal(validateTriageOutput(triage({project:'cove'}),['cove'],'Home').project,'cove');
});

test('the protocol does not name a project the reader has never seen',()=>{
 const protocol=readFileSync(new URL('../prompts/triage.md',import.meta.url),'utf8');
 assert.doesNotMatch(protocol,/`Atlas`/,'the default is supplied as context, not written into the rules');
 assert.match(protocol,/DEFAULT_PROJECT/);
});
