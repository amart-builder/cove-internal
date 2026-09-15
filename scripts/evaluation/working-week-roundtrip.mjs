#!/usr/bin/env node
/** Persist saved synthetic model responses through the production state machine.
 * Offline only. No model calls, live database, or mutation of input artifacts. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output' || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error('Use --input ABSOLUTE_RESULTS_DIRECTORY --output NEW_ABSOLUTE_DIRECTORY');
const input = realpathSync(args[1]);
const output = args[3];
mkdirSync(output, { recursive: false, mode: 0o700 });
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cove-week-roundtrip-')));
for (const key of Object.keys(process.env)) if (/^(COVE_|FORGE_)/u.test(key)) delete process.env[key];
Object.assign(process.env, {
  COVE_DATA_DIR: scratch, COVE_DB_PATH: path.join(scratch, 'unused.db'),
  COVE_PROFILE_PATH: path.join(scratch, 'profile.json'), COVE_EXECUTION_CONFIG: path.join(scratch, 'execution.json'),
  COVE_REMINDER_CONFIG_PATH: path.join(scratch, 'reminders.json'),
  COVE_OPERATOR_NAME: 'Morgan', COVE_TIMEZONE: 'America/Los_Angeles', COVE_MODEL_ROUTER: '0', NEXT_PUBLIC_COVE_RUNTIME: 'local',
});
writeFileSync(process.env.COVE_PROFILE_PATH, JSON.stringify({ name: 'Morgan', timezone: 'America/Los_Angeles' }));
writeFileSync(process.env.COVE_EXECUTION_CONFIG, JSON.stringify({ enabled: false }));
writeFileSync(process.env.COVE_REMINDER_CONFIG_PATH, JSON.stringify({ channel: 'none' }));
let blockedSideEffectAttempts = 0;
const forbid = () => { blockedSideEffectAttempts++; throw new Error('Roundtrip forbids network and subprocess execution'); };
net.Socket.prototype.connect = forbid; http.request = forbid; http.get = forbid; https.request = forbid; https.get = forbid; globalThis.fetch = forbid;
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = forbid;
syncBuiltinESMExports();
const { openLocalDatabase } = await import('../../src/lib/local/database.ts');
const { createDayPlanStore } = await import('../../src/lib/day-plan/store.ts');
const { validateDailyDecision, decisionAsBrief } = await import('../../src/lib/chief-of-staff/daily-planning.ts');
const files = readdirSync(input).filter(name => /^[a-z0-9-]+\.(codex|claude)\.[1-5]\.result\.json$/u.test(name)).sort();
if (!files.length) throw new Error('No finished model results found');
const report = { input, fixture: 'synthetic saved model responses', safety: { scratch, blockedSideEffectAttempts: 0 }, results: [] };
for (const [index, filename] of files.entries()) {
  const response = JSON.parse(readFileSync(path.join(input, filename), 'utf8'));
  if (!/^[a-z0-9-]+$/u.test(response.caseId)) throw new Error('Unsafe case ID');
  const fixture = JSON.parse(readFileSync(path.join(input, `${response.caseId}.input.json`), 'utf8'));
  const scenario = fixture.source;
  const now = new Date(scenario.now);
  const file = path.join(scratch, `${index}.db`);
  const db = openLocalDatabase(file);
  const store = createDayPlanStore({ dbPath: file, now: () => now });
  const result = { id: response.id, originalValidation: response.validation };
  try {
    for (const task of scenario.tasks) db.prepare("INSERT INTO tasks(id,title,description,status,priority,created_at,updated_at,due_at) VALUES(?,?,?,'open','medium',?,?,?)").run(task.id, task.title, task.description, scenario.now, scenario.now, task.dueAt ?? null);
    const events = (scenario.events ?? []).map(event => ({ status: 'confirmed', description: '', location: '', htmlLink: '', meetingUrl: '', attendees: [], calendarId: 'work', ...event }));
    const context = store.planningContext(scenario.now.slice(0, 10), events);
    assert.deepEqual(context.references, fixture.context.references, 'Fixture source identity changed during replay');
    const before = db.prepare('SELECT id,title,status,due_at FROM tasks ORDER BY id').all();
    let decision;
    try { decision = validateDailyDecision(response.wire, fixture.context, { requireNarrative: true, sourcePrompt: fixture.sourcePrompt }); }
    catch (error) {
      result.status = 'rejected-before-persistence'; result.rejection = error.message;
      assert.deepEqual(db.prepare('SELECT id,title,status,due_at FROM tasks ORDER BY id').all(), before);
      assert.equal(db.prepare('SELECT count(*) FROM day_plan_briefs').pluck().get(), 0);
      continue;
    }
    const brief = store.enqueueMorningBrief(scenario.now.slice(0, 10), { modelAlias: 'saved-fixture', effort: 'low', budgetUsd: 0 }).brief;
    assert.equal(store.claimNextMorningBrief().id, brief.id);
    store.completeDailyPlanning(brief.id, decisionAsBrief(decision), response.provider);
    const plan = store.ensureDayPlan({ localDate: scenario.now.slice(0, 10), timezone: 'America/Los_Angeles', mutationId: `roundtrip:${index}`, candidates: [] }).plan;
    assert.ok(plan);
    const bundle = store.planningReadBundle();
    assert.deepEqual(bundle.brief.narrativeParagraphs, decision.narrativeParagraphs);
    assert.deepEqual(db.prepare('SELECT id,title,status,due_at FROM tasks ORDER BY id').all(), before, 'Unaccepted model output changed canonical tasks');
    assert.equal(plan.items.some(item => item.decision === 'accepted'), false);
    result.status = 'persisted-and-projected';
    result.tasksBefore = before.length; result.tasksAfter = before.length;
    result.planItems = plan.items.length; result.paragraphsPreserved = bundle.brief.narrativeParagraphs.length;
    result.pendingQuestions = db.prepare('SELECT count(*) FROM cove_planning_questions').pluck().get();
  } catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 1; }
  finally { store.close(); db.close(); report.results.push(result); }
}
report.safety.blockedSideEffectAttempts = blockedSideEffectAttempts;
if (blockedSideEffectAttempts) process.exitCode = 1;
report.summary = {
  inspected: report.results.length,
  persistedAndProjected: report.results.filter(r => r.status === 'persisted-and-projected').length,
  rejectedBeforePersistence: report.results.filter(r => r.status === 'rejected-before-persistence').length,
  failed: report.results.filter(r => r.status === 'failed').length,
};
writeFileSync(path.join(output, 'roundtrip-results.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report.summary)}\n`);
