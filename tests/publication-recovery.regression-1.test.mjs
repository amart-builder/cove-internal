import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProgressReconcile } from '../scripts/cove-progress-reconcile.mjs';
import { writeProgressSuggestionRelay } from '../src/lib/progress/relay.ts';
import { captureMeetingFollowUps } from '../scripts/meeting-followups.mjs';
import { writeWaitingCommitment } from '../src/lib/intake/meeting-pipeline.ts';

function directory(t) { const dir=mkdtempSync(path.join(os.tmpdir(),'cove-publication-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir; }

test('saved progress finishes interrupted second suggestion without another model call or changed titles', async t => {
  const dataDir=directory(t);const now=new Date('2026-09-15T20:30:00Z');let models=0,fetches=0,writes=0;
  const tasks=[{id:'task-a',title:'First original task'},{id:'task-b',title:'Second original task'}];
  const options={dataDir,now:()=>now,machineIdentity:{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',hostname:'fixture'},
    readPings:()=>[10,20].map(minute=>({ts:`2026-09-15T20:${minute}:00Z`,cwd:'/fixture/Atlas/Projects/test'})),
    gitEvidence:async()=>({lines:['Verified fixture'],head:'stable-head'}),readCurrentState:()=>'',collectSessionWrapups:()=>[],
    fetchTasks:async()=>{fetches++;return tasks;},analyzeProject:async()=>{models++;return {project_summary:'Verified fixture',tasks:tasks.map(task=>({task_id:task.id,progress:'likely_done',evidence_quote:'Verified fixture',note:'Review verified result',scope_changed:false}))};},
    writeSuggestionRelay:input=>{if(++writes===2)throw new Error('Injected second publication failure');return writeProgressSuggestionRelay(input);},
  };
  const first=await runProgressReconcile(options);assert.equal(first.summary.errors,1);
  assert.equal(readdirSync(path.join(dataDir,'progress-relay/suggestions')).length,1);
  tasks[1].title='Later changed title';
  const second=await runProgressReconcile(options);assert.equal(second.summary.errors,0);assert.equal(second.summary.skipped_no_new_evidence,1);
  const files=readdirSync(path.join(dataDir,'progress-relay/suggestions'));
  assert.equal(files.length,2);assert.equal(models,1);assert.equal(fetches,1);
  const saved=files.map(file=>JSON.parse(readFileSync(path.join(dataDir,'progress-relay/suggestions',file),'utf8')));
  assert.ok(saved.some(row=>row.title==='Review progress: Second original task'));
  await runProgressReconcile(options);assert.equal(readdirSync(path.join(dataDir,'progress-relay/suggestions')).length,2);assert.equal(models,1);
});

test('manual meeting retry preserves extraction and effect IDs after partial capture', async t => {
  const dataDir=directory(t);let models=0,waitingAttempts=0;const tasks=new Map(),waiting=new Map();
  const notes={occurrenceId:'doc:fixture',title:'Fixture meeting',text:'Original unchanged notes'};
  const options={dataDir,isOwned:owner=>owner==='Operator',extractFollowUps:async()=>{models++;return [{owner:'Operator',title:'Original task',detail:'Original detail'},{owner:'Other',title:'Original waiting',detail:'Other detail'}];},
    runIntake:async(text,id)=>{tasks.set(id,text);},recordEvent:async()=>({kind:'db',event:{id:'event-fixture'}}),resolveEvent:async()=>{},
    writeWaitingCommitment:async(item,context)=>{if(++waitingAttempts===1)throw new Error('Interrupted second write');waiting.set(context.sourceId,item);},
  };
  await assert.rejects(captureMeetingFollowUps(notes,options),/could not be captured/);
  assert.equal(tasks.size,1);assert.equal(waiting.size,0);
  options.extractFollowUps=async()=>{models++;throw new Error('Model must not run on retry');};
  await captureMeetingFollowUps(notes,options);await captureMeetingFollowUps(notes,options);
  assert.equal(models,1);assert.equal(tasks.size,1);assert.equal(waiting.size,1);
  assert.match([...tasks.values()][0],/Original task/);
});

test('corrupt saved manual extraction fails before any repeat model or effect', async t => {
  const dataDir=directory(t);const notes={occurrenceId:'text:fixture',title:'Fixture',text:'Fixture notes'};let effects=0,models=0;
  const options={dataDir,isOwned:()=>true,extractFollowUps:async()=>{models++;return [{owner:'Operator',title:'Task',detail:'Detail'}];},runIntake:async()=>{effects++;}};
  await captureMeetingFollowUps(notes,options);
  const dir=path.join(dataDir,'meeting-extractions');writeFileSync(path.join(dir,readdirSync(dir)[0]),'{broken');
  await assert.rejects(captureMeetingFollowUps(notes,options));assert.equal(models,1);assert.equal(effects,1);
});

test('waiting writer rejects a scratch database with the implicit default server before any HTTP', async t => {
  const dir=directory(t);let calls=0;
  const saved=Object.fromEntries(['COVE_BRIEF_WEB_BASE','FORGE_BRIEF_WEB_BASE'].map(key=>[key,process.env[key]]));
  for(const key of Object.keys(saved))delete process.env[key];
  try {
    await assert.rejects(writeWaitingCommitment({owner:'Other',title:'Waiting',detail:'Detail'}, {sourceId:'fixture',meetingTitle:'Meeting',baseUrl:'http://127.0.0.1:3200'}, {dbPath:path.join(dir,'cove.db'),fetchImpl:async()=>{calls++;throw new Error('Must not fetch');}}),/inbound_web_base_required/);
    assert.equal(calls,0);
    const id=await writeWaitingCommitment({owner:'Other',title:'Waiting',detail:'Detail'}, {sourceId:'fixture',meetingTitle:'Meeting',baseUrl:'http://127.0.0.1:3999'}, {dbPath:path.join(dir,'cove.db'),fetchImpl:async()=>{calls++;return new Response(JSON.stringify([{id:'existing-fixture'}]));}});
    assert.equal(typeof id,'string');assert.equal(calls,1);
  } finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('concurrent manual extraction uses only the first complete snapshot before effects', async t => {
  const dataDir=directory(t);const notes={occurrenceId:'doc:concurrent',title:'Meeting',text:'Same input'};
  let firstReady,secondReady;const effects=[];
  const base={dataDir,isOwned:()=>true,runIntake:async(text,id)=>effects.push({text,id})};
  const first=captureMeetingFollowUps(notes,{...base,extractFollowUps:()=>new Promise(resolve=>{firstReady=resolve;})});
  const second=captureMeetingFollowUps(notes,{...base,extractFollowUps:()=>new Promise(resolve=>{secondReady=resolve;})});
  secondReady([{owner:'Operator',title:'Winning task',detail:'Saved first'}]);await second;
  firstReady([{owner:'Operator',title:'Different generated title',detail:'Lost the race'}]);await first;
  assert.equal(effects.length,2);assert.equal(effects[0].id,effects[1].id);
  assert.ok(effects.every(effect=>effect.text.includes('Winning task')));
});

test('waiting writer guard and all write requests use the same configured endpoint', async t => {
  const dir=directory(t);const calls=[];const prior=process.env.COVE_BRIEF_WEB_BASE;
  process.env.COVE_BRIEF_WEB_BASE='http://127.0.0.1:3300/';
  try {
    await writeWaitingCommitment({owner:'Other',title:'Waiting',detail:'Detail'},
      {sourceId:'endpoint-fixture',meetingTitle:'Meeting',baseUrl:'http://127.0.0.1:3200'},
      {dbPath:path.join(dir,'cove.db'),fetchImpl:async(url,options={})=>{
        calls.push({url:String(url),method:options.method ?? 'GET'});
        return new Response(JSON.stringify(String(url).endsWith('/api/day-plan') ? {csrfToken:'fixture-token-at-least-16-characters'} : []));
      }});
    assert.ok(calls.some(call=>call.method==='POST'));
    assert.ok(calls.every(call=>call.url.startsWith('http://127.0.0.1:3300/')));
    assert.ok(calls.every(call=>!call.url.includes(':3200')));
  } finally {if(prior===undefined)delete process.env.COVE_BRIEF_WEB_BASE;else process.env.COVE_BRIEF_WEB_BASE=prior;}
});
