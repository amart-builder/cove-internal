#!/usr/bin/env node
/** Offline longitudinal evaluation. Never accepts a database path or invokes a
 * provider. Run with Node 24 --import tsx and --output-dir NEW_DIRECTORY.
 * Synthetic fixtures exercise production storage and policy, not AI judgment. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output-dir' || !path.isAbsolute(args[1])) {
  throw new Error('Usage: node --import tsx working-week-state.mjs --output-dir NEW_ABSOLUTE_DIRECTORY');
}
// Exclusive mkdir refuses existing directories (including symlinks), before any
// product import. A database is always created in our own fresh OS temp folder.
const outputDir = args[1];
mkdirSync(outputDir, { recursive: false });
const runDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cove-week-state-')));
const dbPath = path.join(runDir, 'synthetic.db');
for (const key of Object.keys(process.env)) {
  if (/^(COVE_|FORGE_)/u.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  COVE_DATA_DIR: runDir, COVE_DB_PATH: dbPath,
  COVE_PROFILE_PATH: path.join(runDir, 'profile.json'),
  COVE_EXECUTION_CONFIG: path.join(runDir, 'execution.json'),
  COVE_REMINDER_CONFIG_PATH: path.join(runDir, 'reminder.json'),
  COVE_TIMEZONE: 'America/Los_Angeles', COVE_OPERATOR_NAME: 'Synthetic Operator',
  COVE_MODEL_ROUTER: '0', NEXT_PUBLIC_COVE_RUNTIME: 'local',
});
writeFileSync(process.env.COVE_PROFILE_PATH, JSON.stringify({ name: 'Synthetic Operator', timezone: 'America/Los_Angeles' }));
writeFileSync(process.env.COVE_EXECUTION_CONFIG, JSON.stringify({ enabled: false }));
writeFileSync(process.env.COVE_REMINDER_CONFIG_PATH, JSON.stringify({ channel: 'none' }));
// Enforce the offline contract even if an imported domain accidentally starts
// calling a provider or a native transport in a future implementation.
let blockedSideEffectAttempts = 0;
const isolatedVerifierSpawn = childProcess.spawnSync.bind(childProcess);
const sqliteModule = createRequire(import.meta.url).resolve('better-sqlite3');
const forbidSideEffect = () => { blockedSideEffectAttempts++; throw new Error('Working-week evaluation forbids network and subprocess side effects'); };
net.Socket.prototype.connect = forbidSideEffect;
http.request = forbidSideEffect; http.get = forbidSideEffect;
https.request = forbidSideEffect; https.get = forbidSideEffect;
globalThis.fetch = forbidSideEffect;
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = forbidSideEffect;
syncBuiltinESMExports();
const { openLocalDatabase } = await import('../../src/lib/local/database.ts');
const { createDayPlanStore, DayPlanVersionConflict } = await import('../../src/lib/day-plan/store.ts');
const { buildDayPlanCandidates } = await import('../../src/lib/day-plan/candidates.ts');
const { runFollowThrough, followThroughStatus, snoozeFollowThrough, acknowledgeFollowThrough } = await import('../../src/lib/attention/follow-through.mjs');
const { rememberCalendarOccurrences, validateDailyDecision, decisionAsBrief } = await import('../../src/lib/chief-of-staff/daily-planning.ts');
const { morningBriefFromArtifact } = await import('../../src/lib/day-plan/brief.ts');
let clock = new Date('2026-09-14T15:00:00Z');
let db = openLocalDatabase(dbPath);
let store = createDayPlanStore({ dbPath, now: () => new Date(clock), focusCount: 3 });
const timezone = 'America/Los_Angeles';
const evidence = {
  schemaVersion: 1, evaluation: 'working-week-state', fixture: 'wholly synthetic',
  safety: { dbPath, outputDir, databaseSuppliedByUser: false, networkCalls: 0, realNotificationCalls: 0, modelCalls: 0 },
  checks: [], days: [], notifications: [], processRestarts: [], limitations: [
    'Domain-level simulation, not browser or native OS acceptance.',
    'Brief prose is a fixed fixture; this does not measure model judgment.',
    'Calendar retrieval and notification delivery are injected fakes.',
    'Clock is injected into the exercised domains; not a global scheduler simulation.',
  ],
};
let phase = 'setup';
function check(name, fn) {
  try { fn(); evidence.checks.push({ phase, name, status: 'passed' }); }
  catch (error) { evidence.checks.push({ phase, name, status: 'failed', error: error.message }); throw error; }
}
function restart() {
  const expected = {
    tasks: db.prepare('SELECT id,title,status,due_at FROM tasks ORDER BY id').all(),
    plans: db.prepare('SELECT * FROM day_plans ORDER BY id').all(),
    snapshots: db.prepare('SELECT * FROM day_snapshots ORDER BY id').all(),
  };
  store.close(); db.close();
  // This sole subprocess is a fixed read-only SQLite verifier. Its path is
  // generated above, never supplied by a caller. Provider/native subprocesses
  // remain blocked. A fresh OS process cannot reuse our in-memory plan cache.
  const verification = isolatedVerifierSpawn(process.execPath, ['-e', `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], {readonly:true,fileMustExist:true});
    process.stdout.write(JSON.stringify({
      tasks:db.prepare('SELECT id,title,status,due_at FROM tasks ORDER BY id').all(),
      plans:db.prepare('SELECT * FROM day_plans ORDER BY id').all(),
      snapshots:db.prepare('SELECT * FROM day_snapshots ORDER BY id').all()
    })); db.close();
  `, sqliteModule, dbPath], { encoding: 'utf8', timeout: 10000, env: process.env });
  assert.equal(verification.status, 0, verification.stderr);
  assert.deepEqual(JSON.parse(verification.stdout), expected);
  evidence.processRestarts.push({ phase, status: 'passed', verifiedTasks: expected.tasks.length, verifiedPlans: expected.plans.length, verifiedSnapshots: expected.snapshots.length });
  db = openLocalDatabase(dbPath);
  store = createDayPlanStore({ dbPath, now: () => new Date(clock), focusCount: 3 });
}
let serial = 0;
function mutate(plan, action, extra = {}) {
  return store.mutateDayPlan({ planId: plan.id, expectedVersion: plan.version,
    mutationId: `week:${++serial}:${action}`, action, ...extra });
}
function tasks() {
  return db.prepare('SELECT id,title,description,status,priority,position,updated_at AS updatedAt FROM tasks WHERE archived_at IS NULL ORDER BY position').all();
}
const titles = [
  ['capacity', 'Decide delivery capacity before offering five proposals'],
  ['invoice', 'Review vendor invoice. Payment has not been authorized.'],
  ['proposal-a', 'Prepare proposal for client A'], ['proposal-b', 'Prepare proposal for client B'],
  ['proposal-c', 'Prepare proposal for client C'], ['proposal-d', 'Prepare proposal for client D'],
  ['proposal-e', 'Prepare proposal for client E'], ['ramp', 'Build the three-person ramp plan'],
  ['decisions', 'Prepare the client decision sheet'], ['reply', 'Respond to the setup assistant'],
];
db.exec("INSERT OR IGNORE INTO task_columns(id,name,position) VALUES('week-today','Must happen today',10),('week-done','Done',30)");
const insert = db.prepare("INSERT INTO tasks(id,title,description,status,priority,position,column_id,created_at,updated_at) VALUES(?,?,?,'open','high',?,'week-today',?,?)");
for (const [position, [id, title]] of titles.entries()) insert.run(id, title, 'Synthetic owner request. Scope and price remain undecided.', position, clock.toISOString(), clock.toISOString());
db.prepare("UPDATE tasks SET due_at='2026-09-21',description='Invoice remains unpaid. Review is not payment authorization.' WHERE id='invoice'").run();
const initialIds = titles.map(([id]) => id).sort();
const completedIds = [];
try {
  check('fresh database contains only the ten synthetic commitments', () => assert.deepEqual(tasks().map(t => t.id).sort(), initialIds));
  for (let day = 0; day < 5; day++) {
    const date = `2026-09-${14 + day}`;
    phase = date;
    clock = new Date(`${date}T15:00:00Z`);
    const previous = day ? store.listRecentSnapshots(1)[0] : null;
    const previousNote = previous ? store.getPlan(previous.dayPlanId).nextDayNote : null;
    const candidates = buildDayPlanCandidates({ localDate: date, timezone, tasks: tasks().filter(t => t.status === 'open').map(t => ({ ...t, column: 'today', refreshedAt: clock.toISOString() })) }, 3);
    let plan = store.ensureDayPlan({ localDate: date, timezone, mutationId: `ensure:${date}`, candidates }).plan;
    const paragraphs = [
      `Synthetic brief for ${date}: capacity must be decided before committing delivery dates.`,
      'All five proposal commitments remain recorded. The owner chooses what fits today.',
      previous ? `Yesterday: ${previousNote}` : 'No previous closeout exists.',
    ];
    const artifact = store.enqueueMorningBrief(date, { modelAlias: 'fixture', effort: 'high', budgetUsd: 0 }).brief;
    store.claimNextMorningBrief();
    store.completeMorningBrief(artifact.id, JSON.stringify({ headline: 'A feasible working day', narrativeParagraphs: paragraphs, lensNarrative: paragraphs.join('\n\n'), existingTaskCandidates: [], watchItems: [], boardActions: [] }));
    store.forceAttachMorningBrief(date, artifact.id);
    plan = store.getPlan(plan.id);
    plan = mutate(plan, 'arrival_open').plan;
    plan = mutate(plan, 'start_day').plan;
    check('daily focus contains three selected commitments and no completed work', () => {
      assert.equal(plan.items.filter(i => i.decision === 'accepted').length, 3);
      assert.equal(plan.items.some(i => completedIds.includes(i.taskId)), false);
    });
    if (previous) check('previous closeout preserves a concrete next step for this morning', () => {
      assert.equal(previousNote, `Continue the next proposal on ${date}.`);
      assert.ok(previous.body.unresolvedItems.some(i => i.nextStep === 'Confirm scope before setting the price.'));
      assert.ok(previous.body.unresolvedItems.some(i => i.taskId === 'invoice'));
      assert.equal(db.prepare("SELECT due_at FROM tasks WHERE id='invoice'").pluck().get(), '2026-09-21');
      assert.equal(tasks().find(t => t.id === 'invoice').status, 'open');
    });
    const selected = plan.items.find(i => i.decision === 'accepted' && i.taskId !== 'invoice');
    if (day === 0) {
      const undoItem = plan.items.find(i => i.taskId === 'invoice');
      const beforeIds = plan.items.map(i => i.taskId);
      plan = mutate(plan, 'item_complete', { itemId: undoItem.id }).plan;
      check('completion changes canonical task status immediately', () => assert.equal(tasks().find(t => t.id === undoItem.taskId).status, 'done'));
      restart(); plan = store.getPlan(plan.id);
      plan = mutate(plan, 'item_reopen', { itemId: undoItem.id }).plan;
      restart(); plan = store.getPlan(plan.id);
      check('Undo survives restart and restores canonical status and original focus position', () => {
        assert.equal(tasks().find(t => t.id === undoItem.taskId).status, 'open');
        assert.equal(db.prepare("SELECT due_at FROM tasks WHERE id='invoice'").pluck().get(), '2026-09-21');
        assert.deepEqual(plan.items.map(i => i.taskId), beforeIds);
      });
      plan = mutate(plan, 'arrival_reopen').plan;
      const stale = structuredClone(plan);
      plan = mutate(plan, 'item_edit', { itemId: selected.id, title: 'Decide a realistic weekly capacity first', outcome: 'Explicit capacity decision' }).plan;
      check('an older screen cannot overwrite the owner’s newer decision', () => {
        assert.throws(() => mutate(stale, 'item_later', { itemId: selected.id }), DayPlanVersionConflict);
        assert.equal(store.getPlan(plan.id).items.find(i => i.id === selected.id).title, 'Decide a realistic weekly capacity first');
      });
      plan = mutate(plan, 'start_day').plan;
    }
    if (day === 1) {
      const event = { id: 'client-call', summary: 'Synthetic client call', status: 'confirmed', start: `${date}T18:00:00Z`, end: `${date}T19:00:00Z`, attendees: [] };
      rememberCalendarOccurrences(db, [event], clock);
      clock = new Date(`${date}T15:10:00Z`);
      const moved = { ...event, start: `${date}T20:00:00Z`, end: `${date}T21:00:00Z` };
      const observation = { calendarId: 'primary', timeMin: `${date}T07:00:00Z`, timeMax: '2026-09-22T07:00:00Z', timeZone: timezone, observedAt: clock.toISOString(), complete: true };
      const context = JSON.parse(store.planningContext(date, [moved], observation).text);
      check('fresh rescheduling replaces the old meeting time in planning context', () => {
        assert.equal(context.coverage.calendarSchedule.status, 'complete');
        assert.match(JSON.stringify(context), /20:00:00/);
        assert.doesNotMatch(JSON.stringify(context), /18:00:00/);
        assert.equal(db.prepare("SELECT count(*) FROM cove_calendar_occurrences WHERE event_id='client-call'").pluck().get(), 1);
      });
      const partial = JSON.parse(store.planningContext(date, [], { ...observation, complete: false }).text);
      check('a partial calendar check does not claim complete schedule knowledge', () => assert.equal(partial.coverage.calendarSchedule.status, 'partial'));
      const sourceVersion = tasks().find(t => t.id === selected.taskId).updatedAt;
      const staleWorker = store.enqueueMorningBrief(date, { modelAlias: 'fixture', effort: 'high', budgetUsd: 0 }).brief;
      store.claimNextMorningBrief();
      store.completeMorningBrief(staleWorker.id, JSON.stringify({ headline: 'A feasible working day', narrativeParagraphs: paragraphs, lensNarrative: paragraphs.join('\n\n'), existingTaskCandidates: [], watchItems: [], boardActions: [{ op: 'retitle', taskId: selected.taskId, title: 'Outdated worker title', why: 'Synthetic recommendation based on old snapshot', evidenceRefs: [], expectedTaskUpdatedAt: sourceVersion }] }));
      store.stageMorningBriefBoardActions(staleWorker.id);
      clock = new Date(`${date}T15:11:00Z`);
      db.prepare('UPDATE tasks SET title=?,updated_at=? WHERE id=?').run('Owner clarified scope after the worker started', clock.toISOString(), selected.taskId);
      const activation = store.activateBriefBoardActions(date, clock);
      check('a delayed worker cannot overwrite a newer canonical human edit', () => {
        assert.equal(activation.activated, false); assert.equal(activation.applied, 0);
        assert.equal(db.prepare('SELECT state FROM day_plan_brief_actions WHERE artifact_id=?').pluck().get(staleWorker.id), 'skipped_late');
        assert.equal(tasks().find(t => t.id === selected.taskId).title, 'Owner clarified scope after the worker started');
      });
      const beforeLateDecision = store.planningReadBundle();
      const decisionContext = store.planningContext(date);
      const decision = validateDailyDecision({
        narrativeParagraphs: ['A new midday recommendation must not replace the morning brief.'],
        actions: [{ source: decisionContext.references.find(ref => ref.kind === 'task' && ref.id === selected.taskId), proposal: null, nextAction: 'Reconsider this afternoon’s order.', rationale: 'Synthetic late worker result.', assumptions: [], owner: 'me', state: 'ready', plannedFor: null, nextCheckAt: `${date}T16:00:00Z` }],
        watches: [], questions: [],
      }, decisionContext, { requireNarrative: true });
      clock = new Date(`${date}T15:12:00Z`);
      const lateArtifact = store.enqueueMorningBrief(date, { modelAlias: 'fixture', effort: 'high', budgetUsd: 0 }).brief;
      store.claimNextMorningBrief();
      store.completeDailyPlanning(lateArtifact.id, decisionAsBrief(decision), 'codex');
      const afterLateDecision = store.planningReadBundle();
      // User contract: once Start Day is pressed, a new worker recommendation
      // must not become a new brief or an unsolicited midday review queue.
      evidence.lateDecision = {
        priorBriefId: beforeLateDecision.model.currentPlan.briefId,
        resultingBriefId: afterLateDecision.model.currentPlan.briefId,
        pendingProposalId: afterLateDecision.brief.proposalId ?? null,
        resultingNarrative: afterLateDecision.brief.narrativeParagraphs,
      };
      check('late daily planning preserves the started day’s brief and accepted order with no review proposal', () => {
        assert.deepEqual(afterLateDecision.model.currentPlan.items.map(item => ({ id: item.id, decision: item.decision, position: item.position })), beforeLateDecision.model.currentPlan.items.map(item => ({ id: item.id, decision: item.decision, position: item.position })));
        assert.equal(afterLateDecision.model.currentPlan.briefId, beforeLateDecision.model.currentPlan.briefId);
        assert.deepEqual(afterLateDecision.brief.narrativeParagraphs, beforeLateDecision.brief.narrativeParagraphs);
        assert.equal(afterLateDecision.brief.proposalId, undefined);
        assert.equal((afterLateDecision.brief.proposedActions ?? []).length, 0);
      });
    }
    if (day === 2) {
      clock = new Date(`${date}T22:00:00Z`);
      db.prepare('UPDATE tasks SET due_at=?,remind_native=1 WHERE id=?').run('2026-09-17', selected.taskId);
      let attempts = 0;
      const tick = async () => runFollowThrough({ db, now: clock, timezone, calendar: async () => null, notify: async message => {
        attempts++; evidence.notifications.push({ time: clock.toISOString(), ...message, result: 'uncertain fake transport' }); throw new Error('Synthetic handoff timeout');
      } });
      await tick(); restart(); clock = new Date(`${date}T22:06:00Z`); await tick();
      const notice = followThroughStatus(db, clock).notices.find(n => n.refId === selected.taskId);
      check('uncertain delivery remains actionable after restart without duplicate sending', () => {
        assert.equal(attempts, 1); assert.equal(notice.status, 'uncertain'); assert.equal(notice.needsAttention, 1);
      });
      acknowledgeFollowThrough(db, notice.id, clock);
      check('explicit acknowledgement clears the transport issue', () => assert.equal(followThroughStatus(db, clock).unresolved, 0));
    }
    if (day === 3) {
      clock = new Date(`${date}T22:00:00Z`);
      db.prepare('UPDATE tasks SET due_at=?,remind_native=1 WHERE id=?').run('2026-09-18', selected.taskId);
      const deliveries = [];
      const tick = () => runFollowThrough({ db, now: clock, timezone, calendar: async () => null, notify: async message => { deliveries.push(message); evidence.notifications.push({ time: clock.toISOString(), ...message, result: 'fake success' }); } });
      await tick();
      const notice = followThroughStatus(db, clock).notices.find(n => n.refId === selected.taskId && n.stage === 'advance');
      assert.ok(notice);
      snoozeFollowThrough(db, notice.id, clock);
      plan = mutate(plan, 'item_complete', { itemId: selected.id }).plan;
      restart(); clock = new Date(`${date}T23:01:00Z`); await tick();
      check('completion during a snooze prevents the reminder returning after sleep/restart', () => {
        assert.equal(deliveries.filter(n => n.taskId === selected.taskId).length, 1);
        assert.equal(followThroughStatus(db, clock).notices.find(n => n.id === notice.id).status, 'expired');
      });
    }
    if (day === 4) {
      const start = `${date}T16:15:00Z`;
      const events = [{ id: 'week-final-call', summary: 'Friday synthetic handoff', start, end: `${date}T17:00:00Z`, status: 'confirmed', attendees: [] }];
      const deliveries = [];
      const tick = () => runFollowThrough({ db, now: clock, timezone, calendar: async () => ({ listEvents: async () => events }), notify: async message => { deliveries.push(message); evidence.notifications.push({ time: clock.toISOString(), ...message, result: 'fake success' }); } });
      const backlog = tasks().filter(t => t.status === 'open' && t.id !== selected.taskId && t.id !== 'invoice');
      for (const task of backlog) db.prepare("UPDATE tasks SET due_at='2026-09-01',remind_native=1 WHERE id=?").run(task.id);
      clock = new Date(`${date}T15:00:00Z`); await tick();
      check('routine backlog stays bounded before an upcoming known meeting', () => assert.ok(deliveries.length <= 3));
      clock = new Date(`${date}T16:00:00Z`);
      await tick(); restart(); clock = new Date(`${date}T16:01:00Z`); await tick();
      check('a known meeting is announced once across a worker restart', () => {
        assert.equal(deliveries.filter(n => n.message.includes('Friday synthetic handoff')).length, 1);
        assert.match(deliveries.find(n => n.message.includes('Friday synthetic handoff')).message, /15 minutes/);
      });
    }
    // Finish one selected commitment each day, leave one with explicit progress
    // and one carried. Every next morning reads the previous durable closeout.
    plan = store.getPlan(plan.id);
    check('the active read model retains the full narrative after the day’s interactions', () => assert.deepEqual(store.planningReadBundle().brief.narrativeParagraphs, paragraphs));
    if (plan.items.find(i => i.id === selected.id).decision !== 'completed') plan = mutate(plan, 'item_complete', { itemId: selected.id }).plan;
    completedIds.push(selected.taskId);
    clock = new Date(`${date}T23:30:00Z`);
    plan = mutate(plan, 'settlement_start').plan;
    const remaining = plan.items.filter(i => i.decision === 'accepted');
    plan = mutate(plan, 'settlement_decide', { itemId: remaining[0].id, disposition: 'progress', progressNote: 'Collected scope notes.', nextStep: 'Confirm scope before setting the price.' }).plan;
    plan = mutate(plan, 'settlement_decide', { itemId: remaining[1].id, disposition: 'carry' }).plan;
    const commit = { planId: plan.id, expectedVersion: plan.version, mutationId: `close:${date}`, action: 'settlement_commit', completedHumanTaskIds: [selected.taskId], nextDayNote: `Continue the next proposal on 2026-09-${15 + day}.` };
    const closed = store.mutateDayPlan(commit);
    restart();
    const replay = store.mutateDayPlan(commit);
    check('retrying closeout after restart creates exactly one factual snapshot', () => {
      assert.equal(replay.replayed, true); assert.equal(replay.snapshot.id, closed.snapshot.id);
      assert.equal(db.prepare('SELECT count(*) FROM day_snapshots WHERE day_plan_id=?').pluck().get(plan.id), 1);
      assert.deepEqual(closed.snapshot.body.completedHumanTaskIds, [selected.taskId]);
      assert.equal(store.getReadModel().currentPlan, undefined);
    });
    check('full saved brief survives edits, completion, closeout and database reopen', () => {
      const artifactRow = store.getMorningBrief(artifact.id);
      assert.ok(artifactRow);
      assert.deepEqual(morningBriefFromArtifact(artifactRow).narrativeParagraphs, paragraphs);
    });
    evidence.days.push({ date, planId: plan.id, completed: selected.taskId, carried: remaining.map(i => i.taskId), snapshotId: closed.snapshot.id, remainingOpen: tasks().filter(t => t.status === 'open').length });
  }
  phase = 'week-end';
  check('all ten commitments are retained, exactly five completed and five still open', () => {
    assert.deepEqual(tasks().map(t => t.id).sort(), initialIds);
    assert.deepEqual(tasks().filter(t => t.status === 'done').map(t => t.id).sort(), completedIds.sort());
    assert.equal(tasks().filter(t => t.status === 'open').length, 5);
    assert.equal(db.prepare('SELECT count(*) FROM day_snapshots').pluck().get(), 5);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  });
  check('the undone invoice remains open with its original due date and unpaid evidence', () => {
    assert.equal(tasks().find(t => t.id === 'invoice').status, 'open');
    assert.equal(db.prepare("SELECT due_at FROM tasks WHERE id='invoice'").pluck().get(), '2026-09-21');
    assert.equal(tasks().find(t => t.id === 'invoice').description, 'Invoice remains unpaid. Review is not payment authorization.');
  });
  check('no network, model subprocess or real notification transport was attempted', () => assert.equal(blockedSideEffectAttempts, 0));
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = { phase, message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  store.close(); if (db.open) db.close();
  evidence.safety.blockedSideEffectAttempts = blockedSideEffectAttempts;
  evidence.summary = { completedDays: evidence.days.length, passedChecks: evidence.checks.filter(c => c.status === 'passed').length, failedChecks: evidence.checks.filter(c => c.status === 'failed').length, fakeNotificationAttempts: evidence.notifications.length };
  writeFileSync(path.join(outputDir, 'state-results.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: evidence.status, ...evidence.summary, evidencePath: path.join(outputDir, 'state-results.json') })}\n`);
}
