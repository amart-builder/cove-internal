import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { handleLocalRest } from '../src/lib/local/db.ts';
import { createTaskApi, taskVersion } from '../src/lib/apple-reminders/bridge.mjs';
import { queuePhoneReminder, phoneReminderSnapshot } from '../src/lib/apple-reminders/queue.mjs';
import { reminderTick } from '../scripts/cove-apple-reminders.mjs';

test('reminder API writes use real SQLite filters, field guards, booleans and timezone validation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cove-reminder-api-'));
  process.env.COVE_DB_PATH = path.join(directory, 'cove.db');
  const requests = [];
  const api = createTaskApi('http://127.0.0.1:3200', async (url, options) => {
    const parsed = new URL(url); requests.push({ parsed, options });
    if (parsed.pathname === '/api/day-plan') return Response.json({ csrfToken: 'fixture-only-csrf-1234567890' });
    const result = handleLocalRest(parsed.pathname.split('/').at(-1), options.method, parsed.searchParams, options.body);
    return Response.json(result.body, { status: result.status });
  });
  const created = handleLocalRest('tasks', 'POST', new URLSearchParams(), { id: 'reminder-task', title: 'Send proposal', status: 'open', column_id: 'col-todo', priority: 'medium', remind_native: true, remind_text: false });
  assert.equal(created.status, 201);
  const before = await api.task('reminder-task');
  const saved = await api.patch(before, { remind_at: '2026-09-10T15:00:00-07:00', remind_native: false, remind_text: false, notification_policy: 'none' });
  assert.equal(saved.remind_native, false); assert.equal(saved.remind_at, '2026-09-10T15:00:00-07:00');
  assert.equal(requests.find(r => r.options.method === 'PATCH').parsed.searchParams.get('remind_native'), 'eq.1');
  await assert.rejects(api.patch(before, { remind_native: false }), /changed/);
});

test('background queue retries temporary API failures and exposes terminal budget failures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cove-reminder-queue-'));
  const stateDir = path.join(directory, 'state');
  const config = { enabled: true, allowAgentJudgment: true, stateDir, calendarId: 'cove-list', timezone: 'America/Los_Angeles' };
  await writeFile(path.join(directory, 'apple-reminders.json'), JSON.stringify(config));
  const task = { id: 'task-1', title: 'Follow up', status: 'open', updated_at: 'now' };
  const queued = queuePhoneReminder({ dataDir: directory, task, action: { level: 'notification', remind_at: '2099-09-10T15:00:00-07:00', reason: 'Agreed followup', next_action: 'Check the reply' }, intentKey: 'a' });
  let taskReads = 0;
  const dependencies = { native: async () => ({ reminders: [] }), api: { task: async () => { taskReads++; throw new Error('Cove returned HTTP 503'); } } };
  await reminderTick(directory, dependencies);
  const queueFile = path.join(stateDir, 'queue', `${queued.mutationId}.json`);
  let entry = JSON.parse(await readFile(queueFile, 'utf8'));
  assert.equal(entry.phase, 'queued'); assert.equal(taskReads, 1);
  entry.retryAt = '2000-01-01T00:00:00Z'; await writeFile(queueFile, JSON.stringify(entry));
  dependencies.api.task = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await reminderTick(directory, dependencies);
  entry = JSON.parse(await readFile(queueFile, 'utf8')); assert.equal(entry.phase, 'queued');
  entry.retryAt = '2000-01-01T00:00:00Z'; await writeFile(queueFile, JSON.stringify(entry));
  dependencies.api.task = async () => task;
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, links: {}, decisions: ['x','y'].map(taskId => ({ taskId, origin: 'agent', day: '2099-09-10' })) }));
  await reminderTick(directory, dependencies);
  entry = JSON.parse(await readFile(queueFile, 'utf8')); assert.equal(entry.phase, 'needs_attention');
  assert.match(phoneReminderSnapshot(directory).join('\n'), /budget is reserved/);
  assert.equal(entry.request.expectedVersion, taskVersion(task));
});
