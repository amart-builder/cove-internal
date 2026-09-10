import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createCoveClient, createMcpHandler, localAppUrl, serve } from '../scripts/cove-mobile-mcp.mjs';

const token = 'fixture-credential-never-output-0987654321';
const lists = [
  { id: 'col-todo', name: 'Not Started', position: 0 },
  { id: 'col-today', name: 'Must happen today', position: 10 },
  { id: 'col-progress', name: 'In Flight / Waiting', position: 20 },
  { id: 'col-done', name: 'Done', position: 30 },
];
const baseTask = () => ({ id: 'task-a', title: 'Review proposal', description: 'Existing note', priority: 'high', due_at: '2026-09-11', column_id: 'col-today', status: 'open', project: 'Atlas', position: 0, updated_at: '2026-09-10T15:00:00.000Z', tags: [], origin: 'User request' });
async function fixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cove-mobile-test-'));
  const tasks = new Map([['task-a', baseTask()]]); const requests = []; let beforeWrite; let failWrite = false;
  const state = { csrfToken: token, currentPlan: { id: 'plan', localDate: '2026-09-10', timezone: 'America/Los_Angeles', state: 'active', version: 2, items: [{ id: 'item-a', taskId: 'task-a', title: 'Old title', decision: 'accepted', owner: 'me' }] }, morningBrief: { id: 'brief', targetLocalDate: '2026-09-10', generatedAt: '2026-09-10T14:00:00Z', headline: 'Review first', narrativeParagraphs: ['Review the proposal.'], csrfToken: token, writer: { privatePath: '/private/secret' } } };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url); const q = parsed.searchParams; requests.push({ url, ...options });
    if (parsed.pathname === '/api/day-plan') return Response.json(state);
    if (parsed.pathname.endsWith('/task_columns')) return Response.json(lists);
    assert.equal(parsed.pathname, '/api/cove-rest/tasks');
    if (options.method === 'PATCH' || options.method === 'POST') {
      assert.equal(options.headers['X-Cove-CSRF'], token);
      if (beforeWrite) await beforeWrite();
      if (failWrite) throw new Error('Network died with ' + token);
      const body = JSON.parse(options.body);
      if (options.method === 'POST') {
        if (tasks.has(body.id)) return new Response('duplicate', { status: 500 });
        const row = { ...body, updated_at: '2026-09-10T16:30:00.000Z' }; tasks.set(row.id, row); return Response.json([row], { status: 201 });
      }
      const row = tasks.get(q.get('id')?.slice(3));
      if (!row || row.updated_at !== q.get('updated_at')?.slice(3) || row.status !== q.get('status')?.slice(3)) return Response.json([]);
      if (q.has('due_at') && (q.get('due_at') === 'is.null' ? row.due_at !== null : row.due_at !== q.get('due_at').slice(3))) return Response.json([]);
      const { _expected, ...patch } = body;
      for (const [key, value] of Object.entries(_expected ?? {})) {
        if (row[key === 'columnId' ? 'column_id' : key] !== value) return Response.json('conflict', { status: 409 });
      }
      const result = { ...row, ...patch, updated_at: '2026-09-10T16:30:00.000Z' }; tasks.set(row.id, result); return Response.json([result]);
    }
    let found = [...tasks.values()].filter(t => t.status !== 'archived');
    if (q.has('id')) found = found.filter(t => t.id === q.get('id').slice(3));
    if (q.get('status')?.startsWith('eq.')) found = found.filter(t => t.status === q.get('status').slice(3));
    if (q.has('title')) found = found.filter(t => t.title.toLowerCase().includes(q.get('title').slice(7, -1).toLowerCase()));
    found.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
    found = found.slice(Number(q.get('offset') ?? 0), Number(q.get('offset') ?? 0) + Number(q.get('limit') ?? 1000));
    const keys = q.get('select')?.split(',');
    return Response.json(found.map(t => keys ? Object.fromEntries(keys.filter(k => t[k] !== undefined).map(k => [k, t[k]])) : t));
  };
  const options = { appUrl: 'http://127.0.0.1:3200', stateDir, fetchImpl, now: () => new Date('2026-09-10T16:30:00.000Z') };
  const client = createCoveClient(options);
  return { client, options, stateDir, tasks, requests, state, setBeforeWrite: fn => { beforeWrite = fn; }, failWrite: () => { failWrite = true; } };
}
const countWrites = f => f.requests.filter(r => ['PATCH', 'POST'].includes(r.method)).length;
async function updateArgs(f, changes, mutation_id = 'test-update-01') {
  const { task } = await f.client.call('cove_tasks', { id: 'task-a' });
  return { id: task.id, revision: task.revision, changes, user_request: 'I completed the proposal review.', mutation_id };
}

test('refuses remote URLs, credentials, routes and missing configuration', () => {
  for (const value of [undefined, 'https://127.0.0.1:3200', 'http://example.com', 'http://user:pass@127.0.0.1:3200', 'http://127.0.0.1:3200/path', 'http://127.0.0.1:3200?token=x']) assert.throws(() => localAppUrl(value));
  assert.equal(localAppUrl('http://127.0.0.1:3200'), 'http://127.0.0.1:3200');
});
test('today uses live status and never returns the request credential or private writer metadata', async () => {
  const f = await fixture(); f.tasks.get('task-a').status = 'done';
  const result = await f.client.call('cove_today');
  assert.equal(result.plan.items[0].liveTask.status, 'done');
  assert.equal(result.plan.items[0].taskStateVerified, true);
  assert.equal(result.brief.isToday, true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-credential|privatePath|csrfToken/);
  assert.equal(countWrites(f), 0);
});
test('stale brief and missing live task remain explicit', async () => {
  const f = await fixture(); f.state.currentPlan.localDate = '2026-09-09'; f.state.morningBrief.targetLocalDate = '2026-09-09'; f.tasks.delete('task-a');
  const result = await f.client.call('cove_today');
  assert.equal(result.plan.isToday, false); assert.equal(result.brief.isToday, false);
  assert.equal(result.plan.items[0].liveTask, null); assert.equal(result.plan.items[0].taskStateVerified, false);
});
test('lists paginate and give an exact task revision', async () => {
  const f = await fixture(); f.tasks.set('task-b', { ...baseTask(), id: 'task-b' });
  const result = await f.client.call('cove_tasks', { limit: 1 });
  assert.equal(result.tasks.length, 1); assert.equal(result.hasMore, true); assert.equal(result.nextOffset, 1);
  assert.match(result.tasks[0].revision, /^[a-f0-9]{64}$/);
  assert.equal((await f.client.call('cove_tasks', { offset: 1, limit: 1 })).hasMore, false);
});
test('completion changes both status and list, preserves deadline, and has a durable receipt', async () => {
  const f = await fixture(); const args = await updateArgs(f, { state: 'done' });
  const result = await f.client.call('cove_update_task', args);
  assert.equal(result.saved, true); assert.equal(result.task.status, 'done'); assert.equal(result.task.column_id, 'col-done');
  assert.equal(f.tasks.get('task-a').due_at, '2026-09-11');
  const log = JSON.parse(await readFile(path.join(f.stateDir, args.mutation_id + '.json'), 'utf8'));
  assert.equal(log.status, 'saved'); assert.equal(log.before.status, 'open');
  assert.doesNotMatch(JSON.stringify(log), /fixture-credential/);
});
test('progress appends without replacing existing notes', async () => {
  const f = await fixture(); const args = await updateArgs(f, { state: 'waiting', note: 'Waiting for a reply.' });
  await f.client.call('cove_update_task', args);
  assert.match(f.tasks.get('task-a').description, /^Existing note\n\n\[2026-09-10T16:30:00.000Z\] Waiting for a reply\.$/);
  assert.equal(f.tasks.get('task-a').status, 'open'); assert.equal(f.tasks.get('task-a').column_id, 'col-progress');
});
test('stale task revision cannot overwrite a desktop edit', async () => {
  const f = await fixture(); const args = await updateArgs(f, { title: 'Phone title' });
  f.tasks.get('task-a').title = 'Desktop title';
  await assert.rejects(f.client.call('cove_update_task', args), /changed since your read/);
  assert.equal(countWrites(f), 0); assert.equal(f.tasks.get('task-a').title, 'Desktop title');
});
test('concurrent edit after preflight cannot be reported as saved', async () => {
  const f = await fixture(); const args = await updateArgs(f, { state: 'done' });
  f.setBeforeWrite(() => { f.tasks.get('task-a').updated_at = '2026-09-10T16:29:00Z'; });
  await assert.rejects(f.client.call('cove_update_task', args), /No single task update/);
  assert.equal(f.tasks.get('task-a').status, 'open');
});
test('same timestamp field conflict is rejected by the transaction guard', async () => {
  const f = await fixture(); const args = await updateArgs(f, { note: 'Phone note' });
  f.setBeforeWrite(() => { f.tasks.get('task-a').description = 'New desktop note'; });
  await assert.rejects(f.client.call('cove_update_task', args), /task changed/);
  assert.equal(f.tasks.get('task-a').description, 'New desktop note');
});
test('retry after success reuses receipt across a fresh connector process', async () => {
  const f = await fixture(); const args = await updateArgs(f, { note: 'One note.' });
  await f.client.call('cove_update_task', args);
  const resumed = createCoveClient(f.options);
  const result = await resumed.call('cove_update_task', args);
  assert.equal(result.replayed, true); assert.equal(countWrites(f), 1);
  assert.equal(f.tasks.get('task-a').description.split('One note.').length, 2);
});
test('uncertain write blocks automatic replay and never exposes network error content', async () => {
  const f = await fixture(); const args = await updateArgs(f, { state: 'done' }); f.failWrite();
  await assert.rejects(f.client.call('cove_update_task', args), /outcome is uncertain/);
  await assert.rejects(createCoveClient(f.options).call('cove_update_task', args), /no confirmed receipt/);
  assert.equal(countWrites(f), 1);
});
test('task creation is replay safe and keeps an undated request undated', async () => {
  const f = await fixture(); const args = { title: 'Call Sam', mutation_id: 'test-create-01', user_request: 'Add call Sam to my list.' };
  const first = await f.client.call('cove_create_task', args);
  assert.equal(first.task.due_at, null); assert.equal(first.task.status, 'open');
  const second = await createCoveClient(f.options).call('cove_create_task', args);
  assert.equal(second.replayed, true); assert.equal(first.task.id, second.task.id); assert.equal(countWrites(f), 1);
});
test('mutation ID cannot be reused for a different intent', async () => {
  const f = await fixture(); const args = { title: 'Call Sam', mutation_id: 'test-create-01', user_request: 'Add call Sam.' };
  await f.client.call('cove_create_task', args);
  await assert.rejects(f.client.call('cove_create_task', { ...args, title: 'Call Pat' }), /different arguments/);
});
test('date-only remains date-only; invalid calendar dates and offsetless times fail', async () => {
  const f = await fixture();
  const args = await updateArgs(f, { due_at: '2026-09-12' });
  await f.client.call('cove_update_task', args);
  assert.equal(f.tasks.get('task-a').due_at, '2026-09-12'); assert.equal(f.tasks.get('task-a').notified_at, null);
  for (const due_at of ['2026-02-30', '2026-09-12T17:00:00', 'tomorrow']) {
    await assert.rejects(f.client.call('cove_create_task', { title: 'Call Pat', mutation_id: 'test-date-01', user_request: 'Add call Pat.', due_at }));
  }
});
test('arbitrary table access, deletes, tool names and argument injection are refused', async () => {
  const f = await fixture();
  for (const [name, args] of [['cove_delete_task', {}], ['cove_tasks', { table: 'email_items' }], ['cove_tasks', { id: '../secret' }], ['cove_update_task', { ...(await updateArgs(f, { state: 'done' })), changes: { status: 'archived' } }]]) await assert.rejects(f.client.call(name, args));
  assert.equal(countWrites(f), 0);
});
test('MCP notifications and uninitialized requests cannot mutate tasks', async () => {
  let called = 0; const handler = createMcpHandler({ call: async () => { called++; } });
  assert.equal(await handler({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'cove_create_task' } }), undefined);
  assert.equal((await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cove_create_task' } })).error.code, -32000);
  assert.equal(called, 0);
});
test('stdio handles chunked framing, malformed JSON, and standard MCP discovery', async () => {
  const f = await fixture(); let output = '';
  const input = Readable.from(['{"jsonrpc":"2.0","id":1,"method":"ini', 'tialize"}\nnot-json\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n']);
  await serve({ input, output: new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } }), client: f.client });
  const responses = output.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(responses[0].result.serverInfo.name, 'cove-mobile'); assert.equal(responses[1].error.code, -32700);
  assert.equal(responses[2].result.tools.length, 6);
});
test('oversized framing is refused without invoking a tool', async () => {
  let called = false;
  await assert.rejects(serve({ input: Readable.from(['x'.repeat(66000)]), output: new Writable({ write(c, e, cb) { cb(); } }), client: { call: async () => { called = true; } } }), /limit/);
  assert.equal(called, false);
});


test('reordered JSON keys still replay the same intent without another write', async () => {
  const f = await fixture(); const args = await updateArgs(f, { state: 'waiting', note: 'Waiting for reply.' });
  await f.client.call('cove_update_task', args);
  const reversed = Object.fromEntries(Object.entries(args).reverse());
  reversed.changes = Object.fromEntries(Object.entries(args.changes).reverse());
  assert.equal((await createCoveClient(f.options).call('cove_update_task', reversed)).replayed, true);
  assert.equal(countWrites(f), 1);
});
test('unexpected diagnostics are hidden from MCP consumers', async () => {
  const handler = createMcpHandler({ call: async () => { throw new Error('EACCES /private/secret fixture-credential'); } });
  await handler({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  const result = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cove_today', arguments: {} } });
  assert.equal(result.result.isError, true); assert.doesNotMatch(JSON.stringify(result), /secret|credential|EACCES/);
});

test('same timestamp deadline edits cannot overwrite a newer deadline', async () => {
  const f = await fixture(); const args = await updateArgs(f, { due_at: '2026-09-12' });
  f.setBeforeWrite(() => { f.tasks.get('task-a').due_at = '2026-09-15'; });
  await assert.rejects(f.client.call('cove_update_task', args), /No single task update/);
  assert.equal(f.tasks.get('task-a').due_at, '2026-09-15');
});
test('an undated task uses an atomic null guard when assigning a deadline', async () => {
  const f = await fixture(); f.tasks.get('task-a').due_at = null;
  const args = await updateArgs(f, { due_at: '2026-09-12' });
  const result = await f.client.call('cove_update_task', args);
  assert.equal(result.saved, true);
  assert.equal(new URL(f.requests.find(r=>r.method==='PATCH').url).searchParams.get('due_at'), 'is.null');
});

test('phone connector forwards fresh reminder revisions and retains alarm uncertainty', async () => {
  const f = await fixture(); let input;
  const client = createCoveClient({ ...f.options, reminders: {
    context: async taskId => ({ task: { id: taskId, version: 'fresh' }, nativeReminder: { revision: 'apple-current' } }),
    set: async value => { input = value; return { saved: true, urgentAlarmConfirmed: false, warning: 'Urgent switch requires verification' }; },
  } });
  assert.equal((await client.call('cove_reminders', { task_id: 'task-a' })).nativeReminder.revision, 'apple-current');
  const result = await client.call('cove_set_reminder', { task_id: 'task-a', expected_version: 'fresh', expected_reminder_revision: 'apple-current', mutation_id: 'phone-alarm-intent',
    origin: 'explicit', delivery: 'alarm', notify_at: '2026-09-10T15:00:00-07:00', reason: 'Move the car', next_step: 'Park on the unrestricted side' });
  assert.equal(input.expectedReminderRevision, 'apple-current'); assert.equal(result.urgentAlarmConfirmed, false);
});

test('unconnected Reminders cannot claim a phone reminder was scheduled', async () => {
  const f = await fixture();
  assert.equal((await f.client.call('cove_reminders', {})).connected, false);
  await assert.rejects(f.client.call('cove_set_reminder', {}), /not connected/);
});
