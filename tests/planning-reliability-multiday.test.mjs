/** One synthetic preparation followed across a meeting reschedule, a database
 * reopen, an explicit completion and the next working day. Production storage
 * APIs only: no provider, calendar connector or notification transport is
 * started, and the database is a fresh file in an OS temp directory. */
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
import { planningTimeReferences } from "../src/lib/chief-of-staff/planning-time-text.ts";
import { answerPlanningQuestion, planningQuestions } from "../src/lib/chief-of-staff/questions.ts";
import { buildDayPlanCandidates, eligibleNotTodayTasks } from "../src/lib/day-plan/candidates.ts";

const timezone = "America/Los_Angeles";
const dayOne = "2026-09-14";
const dayTwo = "2026-09-15";
const sourcePrompt = `TARGET_LOCAL_DATE=${dayOne} TARGET_TIMEZONE=${timezone}`;
const meeting = (start, end) => ({
  id: "onboarding-call",
  status: "confirmed",
  summary: "Onboarding call with Sam Lee",
  description: "Kickoff",
  location: "",
  htmlLink: "https://example.test/onboarding",
  meetingUrl: "",
  start,
  end,
  attendees: [],
});
const observationAt = (clock, timeMin) => ({
  calendarId: "primary",
  timeMin,
  timeMax: "2026-09-21T07:00:00Z",
  timeZone: timezone,
  observedAt: clock.toISOString(),
  complete: true,
});

function board(db) {
  return db
    .prepare("SELECT id,status,updated_at FROM tasks WHERE archived_at IS NULL ORDER BY id")
    .all()
    .map((row, position) => ({
      id: row.id,
      columnId: "todo",
      priority: "medium",
      status: row.status === "done" ? "done" : "open",
      tags: [],
      position,
      updatedAt: Date.parse(row.updated_at),
    }));
}

test("one preparation survives a reschedule, a reopen and completion without reopening the next day", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-planning-multiday-"));
  const file = path.join(dir, "cove.db");
  let clock = new Date("2026-09-14T15:00:00Z");
  let db = openLocalDatabase(file);
  let store = createDayPlanStore({ dbPath: file, now: () => new Date(clock) });
  t.after(() => {
    store.close();
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const insert = db.prepare(
    "INSERT INTO tasks(id,title,description,status,priority,due_at,position,created_at,updated_at) VALUES(?,?,?,'open','high',?,?,?,?)",
  );
  const seeded = [
    ["sam-questionnaire", "Collect Sam Lee's onboarding questionnaire", "The questionnaire went out with the invitation. Nothing has come back.", "2026-09-16"],
    ["sam-scope", "Agree the scope note with Sam Lee", "A different outcome for the same person.", null],
    ["vendor-invoice", "Review the vendor invoice", "Unrelated work that must be preserved.", null],
  ];
  seeded.forEach(([id, title, description, due], position) =>
    insert.run(id, title, description, due, position, clock.toISOString(), clock.toISOString()),
  );

  // Day one: the model reuses the existing follow-up rather than inventing work.
  rememberCalendarOccurrences(db, [meeting("2026-09-14T18:00:00Z", "2026-09-14T19:00:00Z")], clock);
  const context = store.planningContext(dayOne, [meeting("2026-09-14T18:00:00Z", "2026-09-14T19:00:00Z")], observationAt(clock, "2026-09-14T07:00:00Z"));
  const questionnaireRef = context.references.find((ref) => ref.kind === "task" && ref.id === "sam-questionnaire");
  const calendarRef = context.references.find((ref) => ref.kind === "calendar");
  const labels = planningTimeReferences(context.text, sourcePrompt).labels;
  const savedDateIndex = labels.findIndex((label) => label.includes("September 16, 2026"));
  assert.ok(savedDateIndex >= 0, JSON.stringify(labels));
  const wire = {
    narrativeParagraphs: [
      "Your follow-up with Sam Lee already exists, so this uses that record instead of adding a second one.",
      `The saved follow-up date is {{time.${savedDateIndex + 1}}}; a proposed review is {{action.1.nextCheckAt}}.`,
    ],
    actions: [
      {
        source: calendarRef,
        proposal: {
          key: "onboarding-preparation",
          title: "Prepare for the onboarding call",
          description: "Chase the missing questionnaire and bring the short agenda.",
          existingTask: questionnaireRef,
        },
        nextAction: "Ask Sam Lee for the questionnaire, then send the agenda",
        rationale: "The call is on the connected calendar today and the questionnaire has not come back.",
        assumptions: ["The call happens at the time currently on the calendar."],
        owner: "me",
        state: "ready",
        plannedFor: null,
        nextCheckAt: "2026-09-14T17:00:00Z",
      },
    ],
    watches: [],
    questions: [
      {
        outcomeKey: "task:sam-questionnaire",
        decisionKey: "questionnaire-return",
        // The question names the person and action and uses the saved follow-up
        // date, not the internally generated review clock.
        question: `Has Sam Lee returned the onboarding questionnaire, or should the follow-up stay at {{time.${savedDateIndex + 1}}}?`,
        source: questionnaireRef,
        nextCheckAt: "2026-09-14T17:00:00Z",
        expiresAt: "2026-09-16T17:00:00Z",
      },
    ],
  };
  const decision = validateDailyDecision(wire, context, { requireNarrative: true, sourcePrompt });
  assert.match(decision.questions[0].question, /Has Sam Lee returned the onboarding questionnaire/);
  assert.match(decision.questions[0].question, /September 16, 2026/);
  assert.doesNotMatch(decision.questions[0].question, /proposed review time/);
  assert.deepEqual(decision.actions[0].supportingSources, [calendarRef]);
  assert.equal(decision.actions[0].proposal, null);
  assert.deepEqual(decision.actions[0].source, questionnaireRef);

  const artifact = store.enqueueMorningBrief(dayOne, { modelAlias: "fixture", effort: "high", budgetUsd: 0 }).brief;
  store.claimNextMorningBrief();
  store.completeDailyPlanning(artifact.id, decisionAsBrief(decision), "codex");
  let plan = store.ensureDayPlan({ localDate: dayOne, timezone, mutationId: "ensure:one", candidates: [] }).plan;
  const mutate = (action, extra = {}) =>
    store.mutateDayPlan({ planId: plan.id, expectedVersion: plan.version, mutationId: `${action}:${plan.version}`, action, ...extra }).plan;
  assert.deepEqual(plan.items.map((item) => item.taskId), ["sam-questionnaire"]);
  assert.deepEqual(eligibleNotTodayTasks(board(db), plan.items).map((row) => row.id), ["sam-scope", "vendor-invoice"]);
  plan = mutate("arrival_open");
  plan = mutate("start_day");
  assert.equal(plan.items[0].taskId, "sam-questionnaire");
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 3);
  assert.equal(db.prepare("SELECT count(*) FROM cove_quiet_current").pluck().get(), 0);

  const settled = store.planningReadBundle().model.currentPlan.items[0];
  assert.notEqual(settled.planningStale, true);
  assert.match(settled.whyToday, /on the connected calendar today/);

  // The meeting moves to the next day.
  clock = new Date("2026-09-14T15:20:00Z");
  rememberCalendarOccurrences(db, [meeting("2026-09-15T18:00:00Z", "2026-09-15T19:00:00Z")], new Date(clock));
  const afterReschedule = store.planningReadBundle().model.currentPlan.items[0];
  assert.equal(afterReschedule.planningStale, true);
  assert.notEqual(afterReschedule.planningState, "resolved");
  assert.equal(afterReschedule.decision, "accepted");
  assert.doesNotMatch(afterReschedule.whyToday, /on the connected calendar today/);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='sam-questionnaire'").pluck().get(), "open");
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 3);

  // The person answers the saved question; the recorded answer must survive the
  // reopen and the later completion.
  let question = planningQuestions(db, new Date(clock))[0];
  assert.match(question.question, /Has Sam Lee returned the onboarding questionnaire/);
  question = answerPlanningQuestion(
    db,
    { id: question.id, revision: question.revision, answer: "Not returned yet. Keep the follow-up open.", source: "closeout", disposition: "answered" },
    new Date(clock),
  );
  assert.equal(question.state, "answered");

  // Reopen the database in a new store, as a restart would.
  const beforeReopen = store.getPlan(plan.id);
  store.close();
  db.close();
  db = openLocalDatabase(file);
  store = createDayPlanStore({ dbPath: file, now: () => new Date(clock) });
  plan = store.getPlan(plan.id);
  assert.deepEqual(plan.items, beforeReopen.items);
  assert.deepEqual(plan.items[0].planningSupport, [{ kind: "calendar", id: calendarRef.id, version: calendarRef.version }]);
  assert.equal(store.planningReadBundle().model.currentPlan.items[0].planningStale, true);
  const savedAnswer = db.prepare("SELECT state,answer,answer_source FROM cove_planning_questions").get();
  assert.deepEqual(
    { state: savedAnswer.state, answer: savedAnswer.answer, answer_source: savedAnswer.answer_source },
    { state: "answered", answer: "Not returned yet. Keep the follow-up open.", answer_source: "closeout" },
  );

  // Explicit completion is the only thing that finishes the work.
  plan = store.planningReadBundle().model.currentPlan;
  plan = mutate("item_complete", { itemId: plan.items[0].id });
  assert.equal(plan.items[0].decision, "completed");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id='sam-questionnaire'").pluck().get(), "done");
  assert.equal(db.prepare("SELECT state FROM cove_planning_questions").pluck().get(), "answered");
  clock = new Date("2026-09-14T23:30:00Z");
  plan = mutate("settlement_start");
  store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: `close:${dayOne}`,
    action: "settlement_commit",
    completedHumanTaskIds: ["sam-questionnaire"],
    nextDayNote: "Sam Lee questionnaire follow-up is finished; the scope note is next.",
  });

  // The next working day cannot reopen completed work or reuse its old identity.
  clock = new Date("2026-09-15T15:00:00Z");
  const nextContext = store.planningContext(dayTwo, [meeting("2026-09-15T18:00:00Z", "2026-09-15T19:00:00Z")], observationAt(new Date(clock), "2026-09-15T07:00:00Z"));
  assert.equal(nextContext.references.some((ref) => ref.kind === "task" && ref.id === "sam-questionnaire"), false);
  const nextView = JSON.parse(nextContext.text);
  assert.equal(nextView.existingTasks.some((row) => row.source.id === "sam-questionnaire"), false);
  assert.deepEqual(nextView.existingTasks.map((row) => row.source.id).sort(), ["sam-scope", "vendor-invoice"]);
  const stale = structuredClone(wire);
  stale.questions = [];
  assert.throws(
    () => validateDailyDecision(stale, nextContext, { requireNarrative: true, sourcePrompt }),
    /planning_reference_unavailable/,
  );
  const openTasks = db
    .prepare("SELECT id,title,description,status,priority,position,updated_at AS updatedAt FROM tasks WHERE status='open' AND archived_at IS NULL ORDER BY position")
    .all()
    .map((row) => ({ ...row, column: "today", refreshedAt: clock.toISOString() }));
  const candidates = buildDayPlanCandidates({ localDate: dayTwo, timezone, tasks: openTasks }, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.taskId).sort(), ["sam-scope", "vendor-invoice"]);
  const nextPlan = store.ensureDayPlan({ localDate: dayTwo, timezone, mutationId: "ensure:two", candidates }).plan;
  assert.equal(nextPlan.items.some((item) => item.taskId === "sam-questionnaire"), false);
  assert.equal(eligibleNotTodayTasks(board(db), nextPlan.items).some((row) => row.id === "sam-questionnaire"), false);
  assert.equal(db.prepare("SELECT count(*) FROM tasks").pluck().get(), 3);
});
