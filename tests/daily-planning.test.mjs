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
import {
  sourceRecord,
  sourceVersion,
} from "../src/lib/responsibility/store.ts";
import { morningBriefFromArtifact } from "../src/lib/day-plan/brief.ts";
import { projectPlanningBrief } from "../src/lib/day-plan/planning.ts";
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
  return { db, store };
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
test("same ordered action supplies brief and Arrival without creating accepted preparation", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  generate(store, context, wire(context, { proposal: true }));
  const plan = ensure(store);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].commitment, "pencil");
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 1);
  const bundle = store.planningReadBundle();
  assert.equal(
    bundle.brief.headline,
    morningBriefFromArtifact(store.getMorningBrief(plan.briefId)).headline,
  );
  assert.equal(
    bundle.brief.watchItems[0].recordId,
    `suggestion:${plan.items[0].planningRef.id}`,
  );
});
test("explicit acceptance preserves responsibility and replay creates one task", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  generate(store, context, wire(context, { proposal: true }));
  let plan = ensure(store);
  const proposalId = plan.items[0].planningRef.id;
  plan = mutate(store, plan, "arrival_open");
  const input = {
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: "start-once",
    action: "start_day",
  };
  plan = store.mutateDayPlan(input).plan;
  const replay = store.mutateDayPlan(input);
  assert.equal(replay.replayed, true);
  assert.equal(plan.items[0].commitment, "ink");
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 2);
  const row = db
    .prepare(
      "SELECT * FROM cove_responsibilities WHERE ref_kind='task' AND ref_id=?",
    )
    .get(plan.items[0].taskId);
  assert.equal(row.next_check_at, "2026-09-11T16:00:00.000Z");
  assert.equal(
    db
      .prepare(
        "SELECT count(*) FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?",
      )
      .pluck()
      .get(proposalId),
    0,
  );
});
test("bypassing Arrival leaves inferred work unaccepted", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  generate(store, context, wire(context, { proposal: true }));
  let plan = ensure(store);
  plan = mutate(store, plan, "arrival_bypass");
  assert.equal(plan.items[0].commitment, "pencil");
  assert.notEqual(plan.items[0].decision, "accepted");
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 1);
});
test("human edit during generation survives and a reviewable proposal remains", (t) => {
  const { db, store } = fixture(t);
  task(db);
  let plan = ensure(store);
  plan = mutate(store, plan, "arrival_open");
  const context = store.planningContext(date);
  const edited = mutate(store, plan, "item_add", {
    title: "My chosen focus",
    outcome: "Finish the selected work",
    why: "Explicit choice",
    owner: "me",
  });
  const raw = {...wire(context), narrativeParagraphs: ["Your full written briefing remains available.", "This second paragraph explains the tradeoff."]};
  const artifactId = generate(store, context, raw);
  const bundle = store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.items[0].title, "My chosen focus");
  assert.ok(bundle.brief.proposalId);
  assert.equal(bundle.brief.proposedActions[0].title, "Work on strategic");
  assert.equal(bundle.model.currentPlan.briefId, artifactId);
  assert.equal(bundle.model.currentPlan.version, edited.version);
  assert.deepEqual(bundle.model.currentPlan.items, edited.items);
  assert.deepEqual(bundle.brief.narrativeParagraphs, raw.narrativeParagraphs);
});
test("source changes reject the complete decision atomically", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date);
  db.prepare("UPDATE tasks SET title='Changed' WHERE id='strategic'").run();
  assert.throws(() => generate(store, context), /planning_source_changed/);
  assert.equal(
    db.prepare("SELECT count(*) FROM cove_quiet_current").pluck().get(),
    0,
  );
});
test("unchanged calendar observations preserve semantic source version", (t) => {
  const { db } = fixture(t);
  rememberCalendarOccurrences(db, [event], now);
  const id = db
    .prepare("SELECT id FROM cove_calendar_occurrences")
    .pluck()
    .get();
  const before = sourceVersion(sourceRecord(db, "calendar", id));
  rememberCalendarOccurrences(db, [event], new Date(+now + 60000));
  assert.equal(sourceVersion(sourceRecord(db, "calendar", id)), before);
});
test("calendar cancellation invalidates proposal and blocks acceptance", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  generate(store, context, wire(context, { proposal: true }));
  let plan = ensure(store);
  plan = mutate(store, plan, "arrival_open");
  rememberCalendarOccurrences(
    db,
    [{ ...event, status: "cancelled" }],
    new Date(+now + 60000),
  );
  assert.throws(
    () => mutate(store, plan, "start_day"),
    /source.*changed|proposal.*(?:available|changed)/,
  );
  const bundle = store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.items[0].planningState, "resolved");
  assert.ok(bundle.brief.statusNote);
  assert.deepEqual(bundle.brief.narrativeParagraphs, morningBriefFromArtifact(store.getMorningBrief(bundle.model.currentPlan.briefId)).narrativeParagraphs);
});
test("source completion changes linked state without choosing replacement work", (t) => {
  const { db, store } = fixture(t);
  task(db);
  generate(store, store.planningContext(date));
  const plan = ensure(store);
  db.prepare("UPDATE tasks SET status='done' WHERE id='strategic'").run();
  const bundle = store.planningReadBundle();
  assert.equal(
    bundle.model.currentPlan.items[0].decision,
    plan.items[0].decision,
  );
  assert.equal(bundle.model.currentPlan.items[0].planningState, "resolved");
  assert.ok(bundle.model.currentPlan.version > plan.version);
  assert.equal(bundle.brief.headline, morningBriefFromArtifact(store.getMorningBrief(plan.briefId)).headline);
});
test("unknown refs and calendar-as-accepted-task are rejected", (t) => {
  const { store } = fixture(t);
  const context = store.planningContext(date, [event]);
  const raw = wire(context, { proposal: true });
  raw.actions[0].source = { ...raw.actions[0].source, id: "invented" };
  assert.throws(
    () => validateDailyDecision(raw, context),
    /reference_unavailable/,
  );
  const direct = wire(context, { proposal: true });
  direct.actions[0].proposal = null;
  assert.throws(
    () => validateDailyDecision(direct, context),
    /calendar_is_not/,
  );
});
test("no artifact never manufactures a brief from current tasks", (t) => {
  const { db, store } = fixture(t);
  const plan = ensure(store);
  const brief = projectPlanningBrief(db, plan, undefined);
  assert.equal(brief.planVersion, plan.version);
  assert.equal(brief.headline, undefined);
  assert.deepEqual(brief.narrativeParagraphs, []);
  assert.equal(brief.lensNarrative, "");
  assert.ok(brief.statusNote);
});

test("staging an existing suggestion does not invalidate explicit revision acceptance", (t) => {
  const { db, store } = fixture(t);
  task(db);
  generate(
    store,
    store.planningContext(date, [event]),
    wire(store.planningContext(date, [event]), { proposal: true }),
  );
  let plan = ensure(store);
  plan = mutate(store, plan, "arrival_open");
  plan = mutate(store, plan, "item_add", {
    title: "Human choice",
    outcome: "My choice",
    why: "Chosen",
    owner: "me",
  });
  const context = store.planningContext(date);
  const raw = wire(context);
  raw.actions[0].source = context.references.find(
    (r) => r.kind === "suggestion",
  );
  const revision = raw.actions[0].source.revision;
  const id = generate(store, context, raw);
  assert.equal(
    db
      .prepare(
        "SELECT revision FROM cove_responsibilities WHERE ref_kind='suggestion'",
      )
      .pluck()
      .get(),
    revision,
  );
  plan = mutate(
    store,
    store.planningReadBundle().model.currentPlan,
    "plan_revision_accept",
    { briefId: id },
  );
  assert.equal(plan.items[0].commitment, "pencil");
});
test("detected commitments cannot become accepted work without confirmation", (t) => {
  const { db, store } = fixture(t);
  db.prepare(
    "INSERT INTO commitments(id,title,status,confirmed,kind,source_kind,created_at,updated_at) VALUES('detected','Possible promise','open',0,'promise','detector','2026-09-11T15:00:00Z','2026-09-11T15:00:00Z')",
  ).run();
  const context = store.planningContext(date);
  assert.match(context.text, /needsConfirmation/);
  const raw = wire(context);
  raw.actions[0].source = context.references.find(
    (r) => r.kind === "commitment",
  );
  assert.throws(() => generate(store, context, raw), /requires_confirmation/);
  assert.equal(
    db
      .prepare("SELECT confirmed FROM commitments WHERE id='detected'")
      .pluck()
      .get(),
    0,
  );
});
test("stale generation retries once and does not create an automatic retry loop", (t) => {
  const { store } = fixture(t);
  const first = store.enqueueMorningBrief(date, {
    modelAlias: "opus",
    effort: "high",
    budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.failMorningBrief(first.id, "planning_source_changed");
  const retry = store.requeueStalePlanning(first.id);
  assert.ok(retry);
  assert.equal(store.requeueStalePlanning(first.id), undefined);
  store.claimNextMorningBrief();
  store.failMorningBrief(retry.id, "planning_source_changed");
  assert.equal(store.requeueStalePlanning(retry.id), undefined);
});
test("question deduplication, ambiguity, explicit answer and parking preserve source checks", async (t) => {
  const { answerPlanningQuestion, planningQuestions } =
    await import("../src/lib/chief-of-staff/questions.ts");
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date);
  const raw = wire(context);
  raw.questions = [
    {
      outcomeKey: "task:strategic",
      decisionKey: "scope",
      question: "Which outcome is needed?",
      source: raw.actions[0].source,
      nextCheckAt: "2026-09-11T16:00:00Z",
      expiresAt: "2026-09-12T16:00:00Z",
    },
  ];
  generate(store, context, raw);
  let q = planningQuestions(db, now)[0];
  assert.ok(q);
  q = answerPlanningQuestion(
    db,
    {
      id: q.id,
      revision: q.revision,
      answer: "Perhaps the shorter version",
      source: "closeout",
      disposition: "ambiguous",
    },
    now,
  );
  assert.equal(q.state, "open");
  assert.match(q.answer, /Perhaps/);
  assert.throws(
    () =>
      answerPlanningQuestion(
        db,
        {
          id: q.id,
          revision: q.revision - 1,
          answer: "yes",
          source: "chat",
          disposition: "answered",
        },
        now,
      ),
    /changed/,
  );
  q = answerPlanningQuestion(
    db,
    {
      id: q.id,
      revision: q.revision,
      answer: "The two-page version",
      source: "task-edit:strategic",
      disposition: "answered",
    },
    now,
  );
  assert.equal(q.state, "answered");
  assert.equal(q.answer_source, "task-edit:strategic");
  const fresh = store.planningContext(date);
  raw.actions[0].source = fresh.references.find((r) => r.kind === "task");
  raw.questions[0].source = raw.actions[0].source;
  generate(store, fresh, raw);
  assert.equal(planningQuestions(db, now).length, 0);
  assert.equal(
    db.prepare("SELECT count(*) FROM cove_planning_questions").pluck().get(),
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT state FROM cove_responsibilities WHERE ref_id='strategic'",
      )
      .pluck()
      .get(),
    "ready",
  );
});
test("model-free preparation check catches missed windows after sleep and stops after dismissal", async (t) => {
  const { runFollowThrough } =
    await import("../src/lib/attention/follow-through.mjs");
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  generate(store, context, wire(context, { proposal: true }));
  const messages = [];
  await runFollowThrough({
    db,
    now: new Date("2026-09-11T21:01:00Z"),
    timezone: "America/Los_Angeles",
    calendar: async () => {
      throw Error("offline");
    },
    notify: (x) => messages.push(x),
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /could not verify/);
  const row = db.prepare("SELECT * FROM cove_quiet_current").get();
  const state = JSON.parse(row.state_json);
  state.suggestions[0].state = "dismissed";
  db.prepare("UPDATE cove_quiet_current SET state_json=?").run(
    JSON.stringify(state),
  );
  db.prepare("DELETE FROM cove_follow_through_notices").run();
  await runFollowThrough({
    db,
    now: new Date("2026-09-11T22:01:00Z"),
    timezone: "America/Los_Angeles",
    calendar: async () => null,
    notify: (x) => messages.push(x),
  });
  assert.equal(messages.length, 1);
});

test("archive invalidates a selected task before the next model wake",t=>{
 const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));ensure(store);
 db.prepare("UPDATE tasks SET archived_at=? WHERE id='strategic'").run(now.toISOString());
 const bundle=store.planningReadBundle();assert.equal(bundle.model.currentPlan.items[0].planningState,"resolved");assert.doesNotMatch(bundle.brief.headline,/Start with: Work/);
});

test("rescheduled preparation can be reviewed and accepted with the same identity", t=>{
 const {db,store}=fixture(t);task(db);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));
 let plan=ensure(store);const suggestionId=plan.items[0].planningRef.id;
 rememberCalendarOccurrences(db,[{...event,start:"2026-09-11T19:00:00Z",end:"2026-09-11T21:00:00Z"}],new Date(+now+60000));
 assert.equal(store.planningReadBundle().model.currentPlan.items[0].planningState,"blocked");
 const fresh=store.planningContext(date);const raw=wire(fresh);raw.actions[0].source=fresh.references.find(r=>r.kind==="suggestion");
 raw.actions[0].nextAction="Review the questionnaire for the later call";
 // The coherent read queued a fresh attempt; generate reuses that queue entry.
 generate(store,fresh,raw);plan=store.planningReadBundle().model.currentPlan;
 if(store.planningReadBundle().brief.proposalId)plan=mutate(store,plan,"plan_revision_accept",{briefId:store.planningReadBundle().brief.proposalId});
 plan=mutate(store,plan,"arrival_open");plan=mutate(store,plan,"start_day");
 assert.equal(plan.items[0].commitment,"ink");assert.equal(db.prepare("SELECT count(*) FROM cove_quiet_current").pluck().get(),1);
 assert.equal(db.prepare("SELECT count(*) FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?").pluck().get(suggestionId),0);
});
test("malformed saved decisions cannot break a coherent plan read",t=>{
 const {db,store}=fixture(t);task(db);generate(store,store.planningContext(date));const plan=ensure(store);
 db.prepare("UPDATE day_plan_briefs SET brief_json=? WHERE id=?").run(JSON.stringify({dailyDecision:{version:1,watches:"not-an-array"}}),plan.briefId);
 const result=store.planningReadBundle();assert.equal(result.model.currentPlan.id,plan.id);assert.equal(result.brief.headline, undefined);assert.deepEqual(result.brief.narrativeParagraphs, []);
});

test("late planning retains a stale artifact without changing accepted preparation",t=>{
 const {db,store}=fixture(t);task(db);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));
 let plan=ensure(store);plan=mutate(store,plan,"arrival_open");plan=mutate(store,plan,"start_day");
 const fresh=store.planningContext(date);const raw=wire(fresh);raw.actions[0].source=fresh.references.find(r=>r.kind==="task"&&r.id===plan.items[0].taskId);
 rememberCalendarOccurrences(db,[{...event,start:"2026-09-11T19:00:00Z"}],new Date(+now+60000));
 const before=store.getPlan(plan.id);
 const artifactId=generate(store,fresh,raw);
 assert.equal(store.getMorningBrief(artifactId).status,"succeeded");
 assert.deepEqual(store.getPlan(plan.id),before);
});
test("park and expiry close the question without resolving its accepted source",async t=>{
 const {answerPlanningQuestion,planningQuestions}=await import("../src/lib/chief-of-staff/questions.ts");
 const {db,store}=fixture(t);task(db);const context=store.planningContext(date);const raw=wire(context);
 raw.questions=[{outcomeKey:"task:strategic",decisionKey:"timing",question:"Is tomorrow useful?",source:raw.actions[0].source,nextCheckAt:"2026-09-11T16:00:00Z",expiresAt:"2026-09-12T16:00:00Z"}];generate(store,context,raw);
 let q=planningQuestions(db,now)[0];q=answerPlanningQuestion(db,{id:q.id,revision:q.revision,answer:"Set this aside",source:"chat",disposition:"parked"},now);assert.equal(q.state,"parked");assert.equal(db.prepare("SELECT status FROM tasks WHERE id='strategic'").pluck().get(),"open");
 const fresh=store.planningContext(date);raw.actions[0].source=fresh.references.find(r=>r.kind==="task");raw.questions[0].source=raw.actions[0].source;raw.questions[0].decisionKey="scope";generate(store,fresh,raw);
 q=planningQuestions(db,now)[0];assert.ok(q);assert.equal(planningQuestions(db,new Date("2026-09-13T16:00:00Z")).length,0);
 assert.equal(db.prepare("SELECT state FROM cove_planning_questions WHERE id=?").pluck().get(q.id),"expired");assert.equal(db.prepare("SELECT status FROM tasks WHERE id='strategic'").pluck().get(),"open");
});

test("refinement elsewhere cannot change the work accepted from an older plan",t=>{
 const {db,store}=fixture(t);task(db);const context=store.planningContext(date,[event]);generate(store,context,wire(context,{proposal:true}));let plan=ensure(store);plan=mutate(store,plan,"arrival_open");
 const row=db.prepare("SELECT state_json FROM cove_quiet_current").get();const state=JSON.parse(row.state_json);state.suggestions[0].state="refined";state.suggestions[0].description="A different deliverable";state.suggestions[0].updatedAt="2026-09-11T15:01:00Z";
 db.prepare("UPDATE cove_quiet_current SET state_json=?").run(JSON.stringify(state));
 assert.throws(()=>mutate(store,plan,"start_day"),/proposal changed/);assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(),1);
});

test("full saved brief survives priority replacement, completion and reload", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date);
  const raw = wire(context);
  raw.narrativeParagraphs = [
    "Your last closeout carried this work forward. The current goal makes it worth protecting time for today.",
    "Calendar coverage is incomplete. Confirm the available time before promising another block.",
    "Keep the remaining work parked until this outcome is finished.",
  ];
  generate(store, context, raw);
  let plan = ensure(store);
  assert.deepEqual(store.planningReadBundle().brief.narrativeParagraphs, raw.narrativeParagraphs);
  const original = store.planningReadBundle().brief;
  plan = mutate(store, plan, "arrival_open");
  plan = mutate(store, plan, "item_later", { itemId: plan.items[0].id });
  for (const id of ["proposal", "ramp", "decisions", "review", "reply"]) {
    task(db, id);
    plan = mutate(store, plan, "item_add", { taskId: id });
    plan = mutate(store, plan, "item_accept", { itemId: plan.items.find(i => i.taskId === id).id });
  }
  plan = mutate(store, plan, "item_reorder", { itemId: plan.items.find(i => i.taskId === "reply").id, position: 0 });
  const reloaded = createDayPlanStore({ dbPath: db.name, now: () => now });
  t.after(() => reloaded.close());
  const bundle = reloaded.planningReadBundle();
  assert.deepEqual(bundle.brief.narrativeParagraphs, raw.narrativeParagraphs);
  assert.equal(bundle.brief.headline, original.headline);
  assert.equal(bundle.brief.lensNarrative, original.lensNarrative);
  assert.equal(bundle.model.currentPlan.items.filter(i => i.decision === "accepted").length, 5);
  assert.equal(bundle.model.currentPlan.items[0].taskId, "reply");
  assert.doesNotMatch(bundle.brief.lensNarrative, /Added from Not today/);
  db.prepare("UPDATE tasks SET status='done' WHERE id='proposal'").run();
  assert.deepEqual(reloaded.planningReadBundle().brief.narrativeParagraphs, raw.narrativeParagraphs);
});

test("new writer responses require real narrative while legacy decisions remain readable", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date);
  const raw = wire(context);
  assert.throws(() => validateDailyDecision(raw, context, { requireNarrative: true }));
  assert.doesNotThrow(() => validateDailyDecision(raw, context));
  for (const value of [[], [""], [3], "prose"]) {
    assert.throws(() => validateDailyDecision({ ...raw, narrativeParagraphs: value }, context, { requireNarrative: true }));
  }
});

test("a proposed preparation keeps its full brief after safe owner normalization", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  const raw = wire(context, { proposal: true });
  raw.actions[0].owner = 'together';
  raw.narrativeParagraphs = ['Review the questionnaire before the call. This is proposed preparation awaiting your acceptance.'];
  generate(store, context, raw);
  ensure(store);
  const bundle = store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.items[0].owner, 'me');
  assert.deepEqual(bundle.brief.narrativeParagraphs, raw.narrativeParagraphs);
});

test('fresh calendar keeps every schedule reference despite long invitations and excludes stale cached events', (t) => {
  const { db, store } = fixture(t);
  task(db);
  rememberCalendarOccurrences(db, [{ ...event, id: 'old-booking', summary: 'Old pipeline date', start: '2026-09-11T17:00:00Z' }], new Date(+now - 86400000));
  const meetings = Array.from({ length: 8 }, (_, n) => ({ ...event, id: `current-${n}`, summary: `Current meeting ${n}`, description: 'Dial-in instructions '.repeat(1000) }));
  const observation = { calendarId: 'primary', timeMin: '2026-09-11T07:00:00Z', timeMax: '2026-09-18T07:00:00Z', timeZone: 'America/Los_Angeles', observedAt: now.toISOString(), complete: true };
  const context = store.planningContext(date, meetings, observation);
  const view = JSON.parse(context.text);
  assert.equal(view.coverage.calendarSchedule.status, 'complete');
  assert.equal(view.coverage.calendarIncluded, 8);
  assert.equal(view.coverage.calendarSelected, 8);
  assert.doesNotMatch(context.text, /Dial-in instructions|Old pipeline date/);
  assert.equal(db.prepare('SELECT count(*) FROM cove_calendar_occurrences').pluck().get(), 9);
  assert.equal(view.records.filter(row => row.source.kind === 'calendar').length, 8);
});

test('only a fresh complete retrieval establishes calendar absence', (t) => {
  const { db, store } = fixture(t);
  rememberCalendarOccurrences(db, [event], now);
  const observation = { calendarId: 'primary', timeMin: '2026-09-11T07:00:00Z', timeMax: '2026-09-18T07:00:00Z', timeZone: 'America/Los_Angeles', observedAt: now.toISOString(), complete: true };
  const fresh = JSON.parse(store.planningContext(date, [], observation).text);
  assert.equal(fresh.coverage.calendarSchedule.status, 'complete');
  assert.equal(fresh.coverage.calendarIncluded, 0);
  const partial = JSON.parse(store.planningContext(date, [], { ...observation, complete: false }).text);
  assert.equal(partial.coverage.calendarSchedule.status, 'partial');
  const stale = JSON.parse(store.planningContext(date, [], { ...observation, observedAt: new Date(+now - 6 * 60000).toISOString() }).text);
  assert.equal(stale.coverage.calendarSchedule.status, 'unverified');
  assert.equal(JSON.parse(store.planningContext(date).text).coverage.calendarSchedule.status, 'unverified');
});

test("brief captured before arrival_open attaches complete narrative and initial recommendations", (t) => {
  const {db,store}=fixture(t); task(db);
  const plan=ensure(store);
  const context=store.planningContext(date);
  mutate(store,plan,"arrival_open");
  const raw={...wire(context),narrativeParagraphs:["The saved first paragraph.","The saved second paragraph."]};
  const id=generate(store,context,raw);
  const bundle=store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.briefId,id);
  assert.equal(bundle.model.currentPlan.arrivalState,"opened");
  assert.equal(bundle.model.currentPlan.items[0].title,"Work on strategic");
  assert.deepEqual(bundle.brief.narrativeParagraphs,raw.narrativeParagraphs);
  assert.equal(bundle.brief.proposalId,undefined);
});
test("explicit daily-decision narrative attachment preserves edited items and version", (t) => {
  const {db,store}=fixture(t);task(db);
  let plan=mutate(store,ensure(store),"arrival_open");
  const context=store.planningContext(date);
  plan=mutate(store,plan,"item_add",{title:"Chosen work",outcome:"Keep my choice",why:"Human decision",owner:"me"});
  const {brief}=store.enqueueMorningBrief(date,{modelAlias:"opus",effort:"high",budgetUsd:1.5});
  store.claimNextMorningBrief();
  const written=decisionAsBrief(validateDailyDecision({...wire(context),narrativeParagraphs:["The narrative is separate from the choices."]},context));
  store.completeMorningBrief(brief.id,JSON.stringify(written));
  assert.equal(store.forceAttachMorningBrief(date,brief.id),true);
  const bundle=store.planningReadBundle();
  assert.deepEqual(bundle.model.currentPlan.items,plan.items);
  assert.equal(bundle.model.currentPlan.version,plan.version);
  assert.deepEqual(bundle.brief.narrativeParagraphs,written.narrativeParagraphs);
});

test("historical saved daily narrative becomes readable without adopting its recommendations", (t) => {
  const {db,store}=fixture(t);task(db);
  let plan=mutate(store,ensure(store),"arrival_open");
  const context=store.planningContext(date);
  plan=mutate(store,plan,"item_add",{title:"My retained work",outcome:"Preserve this",why:"Human choice",owner:"me"});
  const {brief}=store.enqueueMorningBrief(date,{modelAlias:"opus",effort:"high",budgetUsd:1.5});store.claimNextMorningBrief();
  const written=decisionAsBrief(validateDailyDecision({...wire(context),narrativeParagraphs:["A historical saved paragraph."]},context));
  store.completeMorningBrief(brief.id,JSON.stringify(written));
  const bundle=store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.briefId,brief.id);
  assert.equal(store.getPlan(plan.id).briefId,brief.id);
  assert.deepEqual(bundle.model.currentPlan.items,plan.items);
  assert.deepEqual(bundle.brief.narrativeParagraphs,written.narrativeParagraphs);
  assert.equal(bundle.brief.proposalId,brief.id);
  mutate(store,bundle.model.currentPlan,"plan_revision_accept",{briefId:brief.id});
  assert.equal(store.planningReadBundle().brief.proposalId,undefined);
});


test("Start My Day pins the brief and chosen order while late output remains quiet", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const firstContext = store.planningContext(date);
  const first = generate(store, firstContext, { ...wire(firstContext), narrativeParagraphs: ["The morning briefing you chose."] });
  let plan = mutate(store, ensure(store), "arrival_open");
  plan = mutate(store, plan, "start_day");
  const chosen = structuredClone(plan);
  const fresh = store.planningContext(date, [event]);
  const raw = { ...wire(fresh, { proposal: true }), narrativeParagraphs: ["An unrequested midday replacement."] };
  raw.questions = [{ outcomeKey: "calendar:call", decisionKey: "prep", question: "Add more preparation?", source: raw.actions[0].source, nextCheckAt: "2026-09-11T16:00:00Z", expiresAt: "2026-09-12T16:00:00Z" }];
  const tables = ["cove_quiet_current", "cove_responsibilities", "cove_planning_questions", "tasks"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const late = generate(store, fresh, raw);
  assert.equal(store.getMorningBrief(late).status, "succeeded");
  assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
  assert.equal(store.forceAttachMorningBrief(date, late), false);
  const bundle = store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.briefId, first);
  assert.deepEqual(bundle.model.currentPlan.items, chosen.items);
  assert.equal(bundle.model.currentPlan.version, chosen.version);
  assert.deepEqual(bundle.brief.narrativeParagraphs, ["The morning briefing you chose."]);
  assert.equal(bundle.brief.proposalId, undefined);
  assert.equal(bundle.brief.proposedActions, undefined);
  assert.throws(() => mutate(store, bundle.model.currentPlan, "plan_revision_accept", { briefId: late }), /before Start My Day/);
  // A real explicit task completion remains available after the plan is pinned.
  plan = mutate(store, bundle.model.currentPlan, "item_complete", { itemId: chosen.items[0].id });
  assert.equal(plan.items[0].decision, "completed");
  assert.equal(plan.briefId, first);
});

test("started day source refresh and stale retry do not schedule replacement planning", (t) => {
  const { db, store } = fixture(t);
  task(db);
  generate(store, store.planningContext(date));
  const plan = mutate(store, ensure(store), "arrival_open");
  mutate(store, plan, "start_day");
  db.prepare("UPDATE tasks SET updated_at='2026-09-11T15:10:00Z' WHERE id='strategic'").run();
  const count = store.listMorningBriefs(date).length;
  const bundle = store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.items[0].planningStale, true);
  assert.equal(bundle.brief.statusNote, undefined);
  assert.equal(store.listMorningBriefs(date).length, count);
  const { brief } = store.enqueueMorningBrief(date, { modelAlias: "opus", effort: "high", budgetUsd: 1.5 });
  store.claimNextMorningBrief();
  store.failMorningBrief(brief.id, "planning_source_changed");
  assert.equal(store.requeueStalePlanning(brief.id), undefined);
  assert.equal(store.listMorningBriefs(date).length, count + 1);
});


test("first brief racing plan creation saves morning links without replacing ensured choices", (t) => {
  const { db, store } = fixture(t);
  task(db);
  const context = store.planningContext(date, [event]);
  const raw = { ...wire(context, { proposal: true }), narrativeParagraphs: ["Review the questionnaire, then answer the preparation question."] };
  raw.questions = [{ outcomeKey: "calendar:call", decisionKey: "prep", question: "Do the answers cover the call?", source: raw.actions[0].source, nextCheckAt: "2026-09-11T16:00:00Z", expiresAt: "2026-09-12T16:00:00Z" }];
  const plan = ensure(store);
  const before = structuredClone(plan);
  const artifactId = generate(store, context, raw);
  const bundle = store.planningReadBundle();
  assert.equal(bundle.model.currentPlan.briefId, artifactId);
  assert.deepEqual(bundle.model.currentPlan.items, before.items);
  assert.equal(bundle.model.currentPlan.version, before.version);
  assert.deepEqual(bundle.brief.narrativeParagraphs, raw.narrativeParagraphs);
  const state = JSON.parse(db.prepare("SELECT state_json FROM cove_quiet_current").get().state_json);
  assert.equal(state.suggestions.length, 1);
  assert.equal(state.suggestions[0].title, raw.actions[0].proposal.title);
  assert.equal(db.prepare("SELECT count(*) FROM cove_responsibilities WHERE ref_kind='suggestion'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT count(*) FROM cove_planning_questions WHERE state='open'").pluck().get(), 1);
  assert.ok(bundle.brief.watchItems.some(watch => watch.recordId === `suggestion:${state.suggestions[0].id}`));
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 1);
});
