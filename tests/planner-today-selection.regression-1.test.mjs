/**
 * Friday 2026-09-25: four of the six cards on Alex's board were Monday items.
 *
 * The planner had done its part. Every action carried the date it belonged
 * to in `nextCheckAt` (Monday 16:00Z for Kia, Monday for David, Monday for the
 * Edge OS dashboard, Monday for Radius) and one of them said so in its own
 * title: "Use Monday's existing reminder to review Kia's booking status".
 * `persistDecisionLinks` never read that date. Every action in the decision
 * became a preselected card, so the board could not tell "on my list today"
 * from "worth keeping current", and the card title was the planner's
 * bookkeeping about its own reminder rather than the move the person makes.
 *
 * The action now carries an explicit `today` flag, described in the schema,
 * and only actions marked for today become cards. The responsibility row is
 * still updated for every action, so a Monday follow-up keeps its wording
 * and check without appearing on Friday's list. Decisions stored before the
 * field existed read as today, which is what Cove did with them.
 *
 * This test rebuilds the saved Sep 25 decision (the project's
 * brief-2026-09-25.json, dates shifted onto the fixture's week) and checks
 * that two cards remain, four leave, and all six responsibilities are current.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { createDayPlanStore } from "../src/lib/day-plan/store.ts";
import {
  DAILY_PLANNING_SCHEMA,
  dailyPlanningPrompt,
  decisionAsBrief,
  readStoredDailyDecision,
  validateDailyDecision,
} from "../src/lib/chief-of-staff/daily-planning.ts";
import { persistDecisionLinks } from "../src/lib/day-plan/planning.ts";

// A Friday, like the morning this happened on. Monday is the 14th.
const date = "2026-09-11";
const now = new Date("2026-09-11T15:00:00Z");
const monday = "2026-09-14T16:00:00Z";

// The six actions as the planner wrote them on Sep 25, with the flag it can
// now set. Titles are shortened; the shape (state, check date) is the record's.
const saved = [
  { id: "plaid", today: true, state: "ready", nextCheckAt: "2026-09-11T18:23:36.436Z", nextAction: "Verify whether the new Claude device, passkey and Plaid bank connection were yours." },
  { id: "gary", today: true, state: "blocked", nextCheckAt: "2026-09-14T22:00:00Z", nextAction: "Confirm what remains of Gary's Dispatch and Cowork review." },
  { id: "edge-os", today: false, state: "ready", nextCheckAt: "2026-09-14T15:00:00Z", nextAction: "Finish the remaining Edge OS sales dashboard changes." },
  { id: "kia", today: false, state: "ready", nextCheckAt: monday, nextAction: "Send Kia the discovery link once her booking status is confirmed." },
  { id: "david", today: false, state: "ready", nextCheckAt: monday, nextAction: "Review David Jacobs's booking status and discovery-link text." },
  { id: "radius", today: false, state: "ready", nextCheckAt: "2026-09-14T22:00:00Z", nextAction: "Prepare Radius's focused team-onboarding agenda." },
];

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-today-selection-"));
  const file = path.join(dir, "cove.db");
  const db = openLocalDatabase(file);
  const store = createDayPlanStore({ dbPath: file, now: () => now });
  t.after(() => {
    store.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const action of saved) {
    db.prepare(
      "INSERT INTO tasks(id,title,description,status,priority,created_at,updated_at) VALUES(?,?,'','open','medium',?,?)",
    ).run(action.id, `Follow up: ${action.id}`, now.toISOString(), now.toISOString());
  }
  return { db, store };
}

function decision(context, overrides = {}) {
  return {
    narrativeParagraphs: ["Only the identity check and Gary's review need you today; the rest waits for Monday."],
    actions: saved.map((action) => ({
      source: context.references.find((ref) => ref.kind === "task" && ref.id === action.id),
      supportingSources: [],
      proposal: null,
      nextAction: action.nextAction,
      today: action.today,
      rationale: "Recorded on Friday the 25th.",
      assumptions: [],
      owner: "me",
      state: action.state,
      plannedFor: null,
      nextCheckAt: action.nextCheckAt,
      ...overrides,
    })),
    watches: [],
    questions: [],
  };
}

test("only actions the planner marks for today become cards; every action still updates its responsibility", (t) => {
  const { db, store } = fixture(t);
  const context = store.planningContext(date, []);
  const validated = validateDailyDecision(decision(context), context);
  const candidates = persistDecisionLinks(db, validated, now);

  assert.deepEqual(
    candidates.map((c) => c.taskId),
    ["plaid", "gary"],
    "the four Monday follow-ups leave today's list",
  );
  const rows = db
    .prepare("SELECT ref_id, next_action, next_check_at, state FROM cove_responsibilities WHERE ref_kind='task' ORDER BY ref_id")
    .all();
  assert.equal(rows.length, 6, "all six responsibilities are current, cards or not");
  const kia = rows.find((row) => row.ref_id === "kia");
  assert.equal(Date.parse(kia.next_check_at), Date.parse(monday));
  assert.equal(kia.next_action, saved[3].nextAction);

  const brief = decisionAsBrief(validated);
  assert.equal(brief.headline, saved[0].nextAction, "the opening line is the first action marked for today");
});

test("the board built from the brief carries only today's cards", (t) => {
  const { store } = fixture(t);
  const context = store.planningContext(date, []);
  const { brief } = store.enqueueMorningBrief(date, { modelAlias: "opus", effort: "high", budgetUsd: 1.5 });
  store.claimNextMorningBrief();
  store.completeDailyPlanning(brief.id, decisionAsBrief(validateDailyDecision(decision(context), context)), "codex");
  const plan = store.ensureDayPlan({ localDate: date, timezone: "America/Los_Angeles", mutationId: "ensure", candidates: [] }).plan;
  assert.deepEqual(plan.items.map((item) => item.taskId), ["plaid", "gary"]);
  assert.ok(plan.items.every((item) => item.decision === "preselected"));
});

test("the opening line skips a leading action that is not for today", (t) => {
  const { store } = fixture(t);
  const context = store.planningContext(date, []);
  const raw = decision(context);
  raw.actions[0].today = false;
  const brief = decisionAsBrief(validateDailyDecision(raw, context));
  assert.equal(brief.headline, saved[1].nextAction);
  raw.actions.forEach((action) => { action.today = false; });
  assert.equal(decisionAsBrief(validateDailyDecision(raw, context)).headline, "Nothing is waiting on your decision this morning.");
});

test("the wire requires today as a boolean, and stored decisions without it read as today", (t) => {
  const { store } = fixture(t);
  const context = store.planningContext(date, []);
  const item = DAILY_PLANNING_SCHEMA.properties.actions.items;
  assert.ok(item.required.includes("today"));
  assert.equal(item.properties.today.type, "boolean");
  assert.match(item.properties.today.description, /later date/);
  assert.match(item.properties.nextAction.description, /card title/);
  assert.throws(() => validateDailyDecision(decision(context, { today: "yes" }), context), /planning_boolean_invalid/);

  const legacy = JSON.parse(JSON.stringify(validateDailyDecision(decision(context), context)));
  for (const action of legacy.actions) delete action.today;
  const read = readStoredDailyDecision(legacy);
  assert.ok(read.actions.every((action) => action.today === true));

  const prompt = dailyPlanningPrompt(context, "");
  assert.match(prompt, /today=true only for actions the operator should act on or decide today/);
  assert.match(prompt, /needs no action at all/);
});
