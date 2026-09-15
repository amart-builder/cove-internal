import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { createDayPlanStore } from "../src/lib/day-plan/store.ts";
import {
  validateDailyDecision,
  decisionAsBrief,
  rememberCalendarOccurrences,
} from "../src/lib/chief-of-staff/daily-planning.ts";
const date = "2026-09-11";
const now = new Date("2026-09-11T15:00:00Z");
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-daily-plan-"));
  const file = path.join(dir, "cove.db");
  const db = openLocalDatabase(file);
  const store = createDayPlanStore({ dbPath: file, now: () => now });
  t.after(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const oldDb=process.env.COVE_DB_PATH, oldDir=process.env.COVE_DATA_DIR;
  process.env.COVE_DB_PATH=file; process.env.COVE_DATA_DIR=dir;
  setQuietCurrentNowForTests(now);
  t.after(()=>{setQuietCurrentNowForTests();if(oldDb===undefined)delete process.env.COVE_DB_PATH;else process.env.COVE_DB_PATH=oldDb;if(oldDir===undefined)delete process.env.COVE_DATA_DIR;else process.env.COVE_DATA_DIR=oldDir;});
  return { db, store, dir, file };
}
function task(db, id = "strategic") {
  db.prepare(
    "INSERT INTO tasks(id,title,description,status,priority,created_at,updated_at) VALUES(?,?,'Make meaningful progress','open','high',?,?)",
  ).run(id, `Work on ${id}`, now.toISOString(), now.toISOString());
}
const event = {
  id: "generic-call",
  status: "confirmed",
  summary: "Alex and Sam",
  description: "Discovery call",
  location: "",
  htmlLink: "https://example.test/event",
  meetingUrl: "",
  start: "2026-09-11T18:00:00Z",
  end: "2026-09-11T20:00:00Z",
  attendees: [],
};
function wire(context, { proposal = false } = {}) {
  const source = context.references.find(
    (r) => r.kind === (proposal ? "calendar" : "task"),
  );
  return {
    actions: [
      {
        source,
        proposal: proposal
          ? {
              key: "review-questionnaire",
              title: "Review the discovery questionnaire",
              description:
                "Check the available answers and make a short call brief.",
            }
          : null,
        nextAction: proposal
          ? "Review the questionnaire before the call"
          : "Work on strategic",
        rationale: proposal
          ? "Prepare while there is time before the call."
          : "This advances the current goal.",
        assumptions: proposal
          ? ["Response receipt has not been verified."]
          : [],
        owner: "me",
        state: "ready",
        plannedFor: null,
        nextCheckAt: "2026-09-11T16:00:00Z",
      },
    ],
    watches: [],
    questions: [],
  };
}
function generate(store, context, raw = wire(context)) {
  const { brief } = store.enqueueMorningBrief(date, {
    modelAlias: "opus",
    effort: "high",
    budgetUsd: 1.5,
  });
  const claimed = store.claimNextMorningBrief();
  assert.equal(claimed.id, brief.id);
  store.completeDailyPlanning(
    brief.id,
    decisionAsBrief(validateDailyDecision(raw, context)),
    "codex",
  );
  return brief.id;
}
function ensure(store) {
  return store.ensureDayPlan({
    localDate: date,
    timezone: "America/Los_Angeles",
    mutationId: "ensure",
    candidates: [],
  }).plan;
}
function mutate(store, plan, action, extra = {}) {
  return store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: `${action}:${plan.version}`,
    action,
    ...extra,
  }).plan;
}
import { reconcileResponsibilities } from "../src/lib/responsibility/store.ts";
import { acceptWorkSuggestion, undoWorkSuggestionAcceptance, getQuietCurrentSnapshot, setQuietCurrentNowForTests, createWorkSuggestion } from "../src/lib/quiet-current/store.ts";
import { runFollowThrough } from "../src/lib/attention/follow-through.mjs";
import { attachBuddyRun } from "../src/app/api/buddy/turn/implementation.ts";
import { createBuddyStore } from "../src/lib/buddy/store.ts";
import { JobScheduler } from "../src/lib/reliability/jobs.ts";

test("R1 commitment completion Undo restores the canonical source and rejects intervening edits",t=>{
 const {db,store}=fixture(t);
 db.prepare("INSERT INTO commitments(id,title,status,confirmed,kind,source_kind,created_at,updated_at) VALUES('promise','Send the proposal','open',1,'promise','manual',?,?)").run(now.toISOString(),now.toISOString());
 const context=store.planningContext(date); const raw=wire(context);raw.actions[0].source=context.references.find(r=>r.kind==='commitment');
 generate(store,context,raw);let plan=mutate(store,ensure(store),'arrival_open');
 plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});
 assert.equal(db.prepare("SELECT status FROM commitments WHERE id='promise'").pluck().get(),'done');
 plan=mutate(store,plan,'item_reopen',{itemId:plan.items[0].id});
 assert.equal(db.prepare("SELECT status FROM commitments WHERE id='promise'").pluck().get(),'open');
 plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});
 db.prepare("UPDATE commitments SET title='A different promise' WHERE id='promise'").run();
 assert.throws(()=>mutate(store,plan,'item_reopen',{itemId:plan.items[0].id}),/changed after completion/);
});
test("R2 reconciled parent observation cannot authorize an obsolete Quiet Current proposal",t=>{
 const {db,store}=fixture(t);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));
 const plan=ensure(store); const id=plan.items[0].planningRef.id;
 rememberCalendarOccurrences(db,[{...event,start:'2026-09-11T19:00:00Z'}],new Date(+now+60000));
 reconcileResponsibilities(db,now);
 assert.throws(()=>acceptWorkSuggestion(id,{source:'explicit_accept'}),/source for this proposal changed/);
 assert.equal(db.prepare('SELECT count(*) FROM tasks').pluck().get(),0);
 assert.equal(getQuietCurrentSnapshot().suggestions.find(s=>s.id===id).state,'proposed');
});
test("R3 atomic accept retries once, Undo preserves the check, and reaccept retains its parent",t=>{
 const {db,store}=fixture(t);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));
 const id=ensure(store).items[0].planningRef.id;
 const accepted=acceptWorkSuggestion(id,{source:'explicit_accept'});
 const duplicate=acceptWorkSuggestion(id,{source:'explicit_accept'});
 assert.equal(duplicate.taskId,accepted.taskId);assert.equal(db.prepare('SELECT count(*) FROM tasks').pluck().get(),1);
 undoWorkSuggestionAcceptance(id,accepted.acceptanceId);
 assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").pluck().get(accepted.taskId),'archived');
 const check=db.prepare("SELECT * FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?").get(id);
 assert.equal(check.parent_kind,'calendar');assert.equal(check.next_check_at,'2026-09-11T16:00:00.000Z');
 const again=acceptWorkSuggestion(id,{source:'explicit_accept'});
 assert.equal(db.prepare("SELECT parent_kind FROM cove_responsibilities WHERE ref_kind='task' AND ref_id=?").pluck().get(again.taskId),'calendar');
 db.prepare("UPDATE tasks SET title='Human edit' WHERE id=?").run(again.taskId);
 assert.throws(()=>undoWorkSuggestionAcceptance(id,again.acceptanceId),/task changed after acceptance/);
});
test("R3 duplicate observed-progress acceptance cannot roll completed work back",t=>{
 const {db}=fixture(t);task(db,'observed');
 const today=db.prepare("SELECT id FROM task_columns WHERE name='Must happen today'").pluck().get();
 db.prepare("UPDATE tasks SET column_id=?,position=4 WHERE id='observed'").run(today);
 const s=createWorkSuggestion({kind:'observed_progress',title:'Progress is ready',reason:'Verified output',source:'worker',targetTaskId:'observed'});
 const accepted=acceptWorkSuggestion(s.id,{source:'explicit_accept'});
 const duplicate=acceptWorkSuggestion(s.id,{source:'explicit_accept'});
 assert.equal(accepted.acceptanceId,duplicate.acceptanceId);
 assert.equal(db.prepare("SELECT status FROM tasks WHERE id='observed'").pluck().get(),'done');
 assert.equal(db.prepare("SELECT name FROM task_columns JOIN tasks ON tasks.column_id=task_columns.id WHERE tasks.id='observed'").pluck().get(),'Done');
 undoWorkSuggestionAcceptance(s.id,accepted.acceptanceId);
 assert.equal(db.prepare("SELECT status FROM tasks WHERE id='observed'").pluck().get(),'open');
 assert.deepEqual(db.prepare("SELECT column_id,position FROM tasks WHERE id='observed'").get(),{column_id:today,position:4});
});
test("R4 calendar preparation respects explicit notification_policy none",async t=>{
 const {db,store}=fixture(t);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));
 const id=ensure(store).items[0].planningRef.id;const accepted=acceptWorkSuggestion(id,{source:'explicit_accept'});
 db.prepare("UPDATE tasks SET notification_policy='none' WHERE id=?").run(accepted.taskId);
 const notifications=[];
 await runFollowThrough({db,now:new Date('2026-09-11T16:01:00Z'),timezone:'America/Los_Angeles',calendar:async()=>null,notify:payload=>notifications.push(payload)});
 assert.deepEqual(notifications,[]);
});
test("R5 context overflow preserves confirmed effects and does not replay",async t=>{
 const {file}=fixture(t);const buddy=createBuddyStore({dbPath:file});t.after(()=>buddy.close());
 const turn=buddy.claimTurn({userText:'Finish this task',model:'sonnet',effort:'low',routerReason:'test'});
 let calls=0;const sent=[];
 await attachBuddyRun({store:buddy,turn,buildCommand:()=>({}),runCommand:async(_command,send)=>{calls++;send({kind:'data-result',changes:[{table:'tasks',action:'update',id:'task-one',summary:'Updated task'}],sessions:[],errors:[]});return {kind:'done',resultText:'context window exceeded',sessionId:'session',costUsd:0,isError:true,errorSubtype:'context_length_exceeded'};},compaction:{buildSummaryCommand:()=>({}),buildSeedCommand:()=>({}),buildRetryCommand:()=>({})},send:e=>sent.push(e),close:()=>{}});
 assert.equal(calls,1);const saved=buddy.getTurn(turn.id);assert.equal(saved.state,'failed');assert.match(saved.receipts_json,/task-one/);assert.equal(saved.error_code,'context_overflow_after_changes');
});
test("R6 recovery does not revoke a freshly renewed lease",t=>{
 const {file,db}=fixture(t);const scheduler=new JobScheduler({dbPath:file,now:()=>now});t.after(()=>scheduler.close());
 const {job}=scheduler.enqueue({type:'test',idempotencyKey:'renew-race'});
 db.prepare("UPDATE cove_jobs SET status='leased',attempts=1,lease_token='token',lease_until=? WHERE id=?").run(new Date(+now-1000).toISOString(),job.id);
 const originalPrepare=scheduler.db.prepare.bind(scheduler.db);let renewed=false;
 scheduler.db.prepare=(sql)=>{const statement=originalPrepare(sql);if(sql.includes("ORDER BY lease_until ASC")){const originalAll=statement.all.bind(statement);statement.all=(...args)=>{const rows=originalAll(...args);db.prepare('UPDATE cove_jobs SET lease_until=? WHERE id=?').run(new Date(+now+60000).toISOString(),job.id);renewed=true;return rows;};}return statement;};
 assert.deepEqual(scheduler.recoverExpiredLeases(),{recovered:0,dead:0});assert.equal(renewed,true);assert.equal(scheduler.getJob(job.id).status,'leased');
});
test("R7/R8 approved task replan persists atomically and survives later human edits",t=>{
 const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));let plan=mutate(store,ensure(store),'arrival_open');
 plan=store.applyAssistantOperations({expectedVersion:plan.version,operations:[{operation:'edit_item',itemId:plan.items[0].id,title:'Human-approved next action'}]}).plan;
 assert.deepEqual(store.listPendingTaskMutations(),[]);
 assert.equal(db.prepare("SELECT title FROM tasks WHERE id='strategic'").pluck().get(),'Human-approved next action');
 assert.equal(store.planningReadBundle().model.currentPlan.items[0].title,'Human-approved next action');
 db.prepare("UPDATE tasks SET title='Later human title' WHERE id='strategic'").run();
 assert.deepEqual(store.listPendingTaskMutations(),[]);
 assert.throws(()=>store.applyAssistantOperations({expectedVersion:plan.version,operations:[{operation:'edit_item',itemId:plan.items[0].id,title:'Outdated proposal'}]}),/source changed/);
 assert.equal(db.prepare("SELECT title FROM tasks WHERE id='strategic'").pluck().get(),'Later human title');
});
test("R7 proposal replan completion creates and completes its true task",t=>{
 const {db,store}=fixture(t);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));let plan=mutate(store,ensure(store),'arrival_open');
 plan=store.applyAssistantOperations({expectedVersion:plan.version,operations:[{operation:'complete_item',itemId:plan.items[0].id}]}).plan;
 const taskId=plan.items[0].taskId;assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').pluck().get(taskId),'done');assert.deepEqual(store.listPendingTaskMutations(),[]);
});

test("R1 task completion Undo refuses a later human archive",t=>{
 const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));let plan=mutate(store,ensure(store),'arrival_open');
 plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});
 db.prepare("UPDATE tasks SET status='archived',archived_at=? WHERE id='strategic'").run(now.toISOString());
 assert.throws(()=>mutate(store,plan,'item_reopen',{itemId:plan.items[0].id}),/task changed after completion/);
 assert.equal(db.prepare("SELECT status FROM tasks WHERE id='strategic'").pluck().get(),'archived');
});
test("R3 attention notices cannot create committed tasks",t=>{
 const {db}=fixture(t);const suggestion=createWorkSuggestion({kind:'attention_nudge',title:'Check the connection',reason:'Needs attention',source:'worker'});
 assert.throws(()=>acceptWorkSuggestion(suggestion.id,{source:'explicit_accept'}),/marked seen/);
 assert.equal(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(),0);
});


function legacyCompletion(db, plan) {
  for (const item of plan.items) delete item.completionSourceVersion;
  db.prepare("UPDATE day_plans SET items_json=? WHERE id=?").run(JSON.stringify(plan.items), plan.id);
  // Model a pre-upgrade event too, rather than keeping a new fingerprint in its audit payload.
  for (const row of db.prepare("SELECT id,after_json FROM day_plan_events WHERE day_plan_id=?").all(plan.id)) {
    const after = JSON.parse(row.after_json);
    for (const item of (after.plan ?? after).items ?? []) delete item.completionSourceVersion;
    db.prepare("UPDATE day_plan_events SET after_json=? WHERE id=?").run(JSON.stringify(after), row.id);
  }
}

test("completion guard records already-done task and commitment sources", t => {
  for (const kind of ['task', 'commitment']) {
    const {db,store}=fixture(t);
    if (kind === 'task') task(db);
    else db.prepare("INSERT INTO commitments(id,title,status,confirmed,kind,source_kind,created_at,updated_at) VALUES('promise','Send proposal','open',1,'promise','manual',?,?)").run(now.toISOString(),now.toISOString());
    const context=store.planningContext(date); const raw=wire(context);
    raw.actions[0].source=context.references.find(r=>r.kind===kind);
    generate(store,context,raw);let plan=mutate(store,ensure(store),'arrival_open');
    const table=kind==='task'?'tasks':'commitments';
    db.prepare(`UPDATE ${table} SET status='done'`).run();
    plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});
    assert.match(plan.items[0].completionSourceVersion, /^v:/);
    plan=mutate(store,plan,'item_reopen',{itemId:plan.items[0].id});
    assert.equal(db.prepare(`SELECT status FROM ${table}`).pluck().get(),'open');
    assert.equal(plan.items[0].decision,'accepted');
  }
});

test("legacy completion reopens unchanged Done task with a matching completion event", t => {
  const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));
  let plan=mutate(store,ensure(store),'arrival_open');
  plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});legacyCompletion(db,plan);
  plan=mutate(store,plan,'item_reopen',{itemId:plan.items[0].id});
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='strategic'").pluck().get(),'open');
  assert.equal(plan.items[0].decision,'accepted');
});

test("legacy completion rejects later task edits, moves, archives and missing audit evidence", t => {
  for (const change of ['edit','move','archive','missing-event']) {
    const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));
    let plan=mutate(store,ensure(store),'arrival_open');
    plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});legacyCompletion(db,plan);
    if(change==='edit')db.prepare("UPDATE tasks SET description='Later notes',updated_at=? WHERE id='strategic'").run(new Date(+now+1000).toISOString());
    if(change==='move')db.prepare("UPDATE tasks SET column_id=NULL WHERE id='strategic'").run();
    if(change==='archive')db.prepare("UPDATE tasks SET status='archived',archived_at=? WHERE id='strategic'").run(now.toISOString());
    if(change==='missing-event')db.prepare("DELETE FROM day_plan_events WHERE event_type='item_complete'").run();
    const before=db.prepare("SELECT * FROM tasks WHERE id='strategic'").get();
    assert.throws(()=>mutate(store,plan,'item_reopen',{itemId:plan.items[0].id}),/older completion.*All Work/);
    assert.deepEqual(db.prepare("SELECT * FROM tasks WHERE id='strategic'").get(),before);
  }
});

test("legacy completion can follow an explicit All Work reopen without rewriting newer notes or tags", t => {
  for (const moved of [false,true]) {
    const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));
    let plan=mutate(store,ensure(store),'arrival_open');
    plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});legacyCompletion(db,plan);
    const today=db.prepare("SELECT id FROM task_columns WHERE name='Must happen today'").pluck().get();
    assert.ok(today);
    db.prepare("UPDATE tasks SET status='open',column_id=?,description='Reviewed notes',tags='[\"reviewed\"]',updated_at=? WHERE id='strategic'").run(moved?null:today,new Date(+now+1000).toISOString());
    const before=db.prepare("SELECT * FROM tasks WHERE id='strategic'").get();
    if(moved)assert.throws(()=>mutate(store,plan,'item_reopen',{itemId:plan.items[0].id}),/older completion.*All Work/);
    else { plan=mutate(store,plan,'item_reopen',{itemId:plan.items[0].id});assert.equal(plan.items[0].decision,'accepted'); }
    assert.deepEqual(db.prepare("SELECT * FROM tasks WHERE id='strategic'").get(),before);
  }
});


test("legacy commitment completion checks audit time and preserves an explicit source reopen", t => {
  for (const change of ['unchanged','edited','reopened']) {
    const {db,store}=fixture(t);
    db.prepare("INSERT INTO commitments(id,title,status,confirmed,kind,source_kind,created_at,updated_at) VALUES('promise','Send proposal','open',1,'promise','manual',?,?)").run(now.toISOString(),now.toISOString());
    const context=store.planningContext(date);const raw=wire(context);raw.actions[0].source=context.references.find(r=>r.kind==='commitment');
    generate(store,context,raw);let plan=mutate(store,ensure(store),'arrival_open');
    plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});legacyCompletion(db,plan);
    if(change!=='unchanged')db.prepare("UPDATE commitments SET status=?,title='Reviewed promise',updated_at=? WHERE id='promise'").run(change==='reopened'?'open':'done',new Date(+now+1000).toISOString());
    const before=db.prepare("SELECT * FROM commitments WHERE id='promise'").get();
    if(change==='edited')assert.throws(()=>mutate(store,plan,'item_reopen',{itemId:plan.items[0].id}),/older completion.*original commitment/);
    else { plan=mutate(store,plan,'item_reopen',{itemId:plan.items[0].id});assert.equal(plan.items[0].decision,'accepted'); }
    if(change!=='unchanged')assert.deepEqual(db.prepare("SELECT * FROM commitments WHERE id='promise'").get(),before);
  }
});

test("completion guard refuses a same-timestamp edit after observing an already-done task", t => {
  const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));let plan=mutate(store,ensure(store),'arrival_open');
  db.prepare("UPDATE tasks SET status='done' WHERE id='strategic'").run();
  plan=mutate(store,plan,'item_complete',{itemId:plan.items[0].id});
  db.prepare("UPDATE tasks SET description='Later user notes' WHERE id='strategic'").run();
  assert.throws(()=>mutate(store,plan,'item_reopen',{itemId:plan.items[0].id}),/changed after completion/);
  assert.equal(db.prepare("SELECT description FROM tasks WHERE id='strategic'").pluck().get(),'Later user notes');
});
