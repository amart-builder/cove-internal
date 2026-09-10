import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReminderBridge, taskVersion, localTimestamp } from '../src/lib/apple-reminders/bridge.mjs';

async function fixture(t, overrides = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cove-apple-reminders-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let serial = 1;
  const tasks = new Map(); const reminders = new Map(); const calls = [];
  const task = (id = 'task-1') => ({ id, title: 'Send the proposal', description: 'Recipient has the pricing. Confirm the scope before sending.', status: 'open', column_id: 'todo',
    due_at: '2026-09-10T15:00:00-07:00', due_date: '2026-09-10', remind_at: null, remind_native: true, remind_text: false,
    notification_policy: 'both', updated_at: '2026-09-10T15:00:00Z', priority: 'medium' });
  tasks.set('task-1', task());
  const api = {
    async task(id) { assert(tasks.has(id)); return structuredClone(tasks.get(id)); },
    async patch(before, changes) {
      assert.equal(taskVersion(before), taskVersion(tasks.get(before.id)), 'Optimistic task conflict');
      const saved = { ...before, ...changes, updated_at: `revision-${++serial}` }; tasks.set(before.id, saved); return structuredClone(saved);
    },
    async column(done) { return done ? 'done' : 'todo'; },
  };
  const native = async input => {
    calls.push(structuredClone(input));
    if (input.command === 'status') return { authorized: true, urgentAlarmSupported: false };
    if (input.command === 'list') return { reminders: structuredClone([...reminders.values()]) };
    assert.equal(input.command, 'save');
    if (input.id) {
      assert.equal(reminders.get(input.id)?.revision, input.revision, 'Optimistic Apple conflict');
    } else {
      const existing = [...reminders.values()].find(r => r.taskId === input.taskId);
      if (existing) return { saved: false, recovered: true, reminder: structuredClone(existing) };
    }
    const reminder = { taskId: input.taskId, id: input.id ?? `apple-${++serial}`, calendarId: 'cove-list', title: input.title, notes: input.notes,
      completed: input.completed, dueAt: input.dueAt, allDay: false, priority: input.priority, url: input.url,
      alarms: [{ absolute: input.dueAt, relative: 0 }], timezone: input.timezone, revision: `apple-rev-${++serial}` };
    reminders.set(reminder.id, reminder);
    return { saved: true, reminder: structuredClone(reminder) };
  };
  const config = { enabled: true, allowAgentJudgment: true, stateDir, calendarId: 'cove-list', timezone: 'America/Los_Angeles', conversationUrl: 'https://claude.ai/code/session_cove', maxAutomaticPerDay: 2 };
  const deps = { api, native, now: () => new Date('2026-09-10T16:00:00Z'), ...overrides };
  const bridge = createReminderBridge(config, deps);
  const input = (id = 'task-1', extra = {}) => ({ taskId: id, expectedVersion: taskVersion(tasks.get(id)), mutationId: `remind-${id}-intent-1`, origin: 'explicit', delivery: 'notification',
    notifyAt: '2026-09-10T15:00:00-07:00', reason: 'The recipient is expecting the proposal today.', nextStep: 'Confirm the scope and review the draft.', ...extra });
  return { bridge, config, deps, tasks, reminders, calls, input, task, api, native, stateDir };
}

test('a real reminder intent carries context and suppresses duplicate Cove due alerts', async t => {
  const f = await fixture(t);
  const result = await f.bridge.set(f.input());
  assert.equal(result.saved, true); assert.equal(result.urgentAlarmConfirmed, false);
  const reminder = [...f.reminders.values()][0];
  assert.match(reminder.notes, /Why now:.*recipient/); assert.match(reminder.notes, /Next step:.*scope/);
  assert.match(reminder.notes, /Recipient has the pricing/); assert.equal(reminder.url, f.config.conversationUrl+'#cove-task=task-1'); assert.doesNotMatch(reminder.notes, /Cove task:|task-1/);
  assert.equal(f.tasks.get('task-1').remind_native, false);
  assert.equal(f.tasks.get('task-1').notification_policy, 'none');
  assert.equal(f.tasks.get('task-1').remind_at, '2026-09-10T15:00:00-07:00');
});

test('stable receipt replay cannot duplicate an Apple reminder or accept changed arguments', async t => {
  const f = await fixture(t); const input = f.input();
  await f.bridge.set(input);
  const result = await f.bridge.set(input);
  assert.equal(result.replayed, true); assert.equal(f.reminders.size, 1);
  await assert.rejects(f.bridge.set({ ...input, reason: 'A different request' }), /different reminder request/);
});

test('stale task context fails before any native save', async t => {
  const f = await fixture(t); const input = f.input(); f.tasks.get('task-1').title = 'Changed';
  await assert.rejects(f.bridge.set(input), /task changed/);
  assert.equal(f.calls.filter(r => r.command === 'save').length, 0);
});

test('completing from Apple synchronizes the Cove task while preserving its context', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.completed = true; r.revision = 'user-completed';
  const result = await f.bridge.sync();
  assert.equal(result.results[0].state, 'active');
  assert.equal(f.tasks.get('task-1').status, 'done'); assert.equal(f.tasks.get('task-1').column_id, 'done');
  assert.match(f.tasks.get('task-1').description, /Confirm the scope/);
});

test('Cove completion and reopening synchronize to Apple without dropping user notes', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.notes += '\nMy extra phone note.'; r.revision = 'user-note';
  f.tasks.get('task-1').status = 'done'; await f.bridge.sync();
  assert.equal(f.reminders.get(r.id).completed, true);
  assert.match(f.reminders.get(r.id).notes, /My extra phone note/);
  f.tasks.get('task-1').status = 'open'; await f.bridge.sync();
  assert.equal(f.reminders.get(r.id).completed, false);
});

test('rescheduling from either side keeps an anchored deadline and reminder in step', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const id = [...f.reminders.keys()][0];
  f.tasks.get('task-1').due_at = '2026-09-10T16:00:00-07:00';
  await f.bridge.sync(); assert.equal(f.reminders.get(id).dueAt, '2026-09-10T23:00:00Z');
  f.reminders.get(id).dueAt = '2026-09-11T00:00:00Z'; f.reminders.get(id).alarms = [{ absolute: '2026-09-11T00:00:00Z', relative: 0 }]; f.reminders.get(id).revision = 'phone-retimed';
  await f.bridge.sync(); assert.equal(f.tasks.get('task-1').due_at, '2026-09-10T17:00:00-07:00');
});

test('a reminder scheduled before a deadline does not change that deadline on phone rescheduling', async t => {
  const f = await fixture(t); await f.bridge.set(f.input('task-1', { notifyAt: '2026-09-10T14:00:00-07:00' }));
  const r = [...f.reminders.values()][0]; r.dueAt = '2026-09-10T21:30:00Z'; r.alarms = [{ absolute: r.dueAt, relative: 0 }]; r.revision = 'phone-retimed';
  await f.bridge.sync();
  assert.equal(f.tasks.get('task-1').due_at, '2026-09-10T15:00:00-07:00');
  assert.equal(f.tasks.get('task-1').remind_at, '2026-09-10T14:30:00-07:00');
});

test('concurrent conflicting changes are surfaced without overwriting either side', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.title = 'Phone edit'; r.revision = 'user-change';
  f.tasks.get('task-1').title = 'Desktop edit';
  const result = await f.bridge.sync();
  assert.equal(result.results[0].state, 'conflict');
  assert.equal(f.tasks.get('task-1').title, 'Desktop edit'); assert.equal(f.reminders.get(r.id).title, 'Phone edit');
});

test('a deleted or moved native reminder is never silently recreated', async t => {
  const f = await fixture(t); await f.bridge.set(f.input()); f.reminders.clear();
  const result = await f.bridge.sync();
  assert.equal(result.results[0].state, 'conflict'); assert.equal(f.reminders.size, 0);
});

test('cancellation stops the native reminder but keeps the Cove task open', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  await f.bridge.set(f.input('task-1', { mutationId: 'cancel-task-1-intent', delivery: 'none' }));
  await f.bridge.sync();
  assert.equal([...f.reminders.values()][0].completed, true); assert.equal(f.tasks.get('task-1').status, 'open');
});

test('explicit requests remain available after the automatic suggestion budget fills', async t => {
  const f = await fixture(t);
  for (const id of ['task-2', 'task-3', 'task-4']) f.tasks.set(id, f.task(id));
  await f.bridge.set(f.input('task-1', { origin: 'agent' })); await f.bridge.set(f.input('task-2', { origin: 'agent' }));
  await assert.rejects(f.bridge.set(f.input('task-3', { origin: 'agent' })), /budget/);
  await f.bridge.set(f.input('task-4')); assert.equal(f.reminders.size, 3);
});

test('routine automatic alerts respect quiet hours but explicit requests retain exact time', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.set(f.input('task-1', { origin: 'agent', notifyAt: '2026-09-10T23:00:00-07:00' })), /daytime/);
  await f.bridge.set(f.input('task-1', { notifyAt: '2026-09-10T23:00:00-07:00' }));
  assert.equal([...f.reminders.values()][0].dueAt, '2026-09-11T06:00:00Z');
});

test('an ordinary notification is never reported as a confirmed urgent alarm', async t => {
  const f = await fixture(t); const result = await f.bridge.set(f.input('task-1', { delivery: 'alarm' }));
  assert.equal(result.scheduledNotification, true); assert.equal(result.urgentAlarmConfirmed, false);
  assert.equal(result.reminder.state, 'alarm_pending'); assert.match(result.warning, /no alarm is confirmed/);
});

test('an interrupted native creation recovers by task identity without creating a duplicate', async t => {
  const f = await fixture(t); let failAfterSave = true;
  const bridge = createReminderBridge(f.config, { ...f.deps, native: async input => {
    const result = await f.native(input);
    if (input.command === 'save' && failAfterSave) { failAfterSave = false; throw new Error('Simulated interrupted receipt'); }
    return result;
  } });
  const input = f.input();
  await assert.rejects(bridge.set(input), /interrupted/); assert.equal(f.reminders.size, 1);
  const resumed = createReminderBridge(f.config, f.deps);
  const result = await resumed.sync(); assert.equal(result.results[0].state, 'active'); assert.equal(f.reminders.size, 1);
  assert.equal((await resumed.set(input)).replayed, true);
  const state = JSON.parse(await readFile(path.join(f.stateDir, 'state.json'), 'utf8'));
  assert.equal(state.links['task-1'].nativeId, [...f.reminders.keys()][0]);
});

test('operator timezone offsets follow daylight-saving changes', () => {
  assert.equal(localTimestamp('2026-11-01T08:30:00Z', 'America/Los_Angeles'), '2026-11-01T01:30:00-07:00');
  assert.equal(localTimestamp('2026-11-01T09:30:00Z', 'America/Los_Angeles'), '2026-11-01T01:30:00-08:00');
});

test('a transient read failure retries and later task completion reaches Apple', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  let failRead = true;
  const bridge = createReminderBridge(f.config, { ...f.deps, api: { ...f.api, task: async id => {
    if (failRead) throw new Error('HTTP 503'); return f.api.task(id);
  } } });
  assert.equal((await bridge.sync()).results[0].state, 'retry_pending');
  failRead = false; f.tasks.get('task-1').status = 'done';
  assert.equal((await bridge.sync()).results[0].state, 'active');
  assert.equal([...f.reminders.values()][0].completed, true);
});

test('a committed task patch with a lost response recovers its receipt and automatic budget', async t => {
  const f = await fixture(t); let loseResponse = true;
  const bridge = createReminderBridge(f.config, { ...f.deps, api: { ...f.api, patch: async (before, changes) => {
    const result = await f.api.patch(before, changes);
    if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
    return result;
  } } });
  const input = f.input('task-1', { origin: 'agent' });
  await assert.rejects(bridge.set(input), /Response lost/);
  const resumed = createReminderBridge(f.config, f.deps);
  assert.equal((await resumed.sync()).results[0].state, 'active');
  assert.equal((await resumed.set(input)).replayed, true);
  const state = JSON.parse(await readFile(path.join(f.stateDir, 'state.json'), 'utf8'));
  assert.equal(state.decisions.length, 1); assert.equal(state.decisions[0].origin, 'agent');
  assert.equal(f.reminders.size, 1);
});

test('editing Cove reminder time updates Apple independently of the task deadline', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  f.tasks.get('task-1').remind_at = '2026-09-10T16:00:00-07:00';
  assert.equal((await f.bridge.sync()).results[0].state, 'active');
  assert.equal([...f.reminders.values()][0].dueAt, '2026-09-10T23:00:00Z');
  assert.equal(f.tasks.get('task-1').due_at, '2026-09-10T15:00:00-07:00');
});

test('an anchored deadline change updates both Apple and Cove reminder time', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  f.tasks.get('task-1').due_at = '2026-09-10T16:00:00-07:00';
  await f.bridge.sync();
  assert.equal(f.tasks.get('task-1').remind_at, '2026-09-10T16:00:00-07:00');
});

test('ordinary synchronization preserves an Apple priority change', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.priority = 5; r.revision = 'manual-priority';
  f.tasks.get('task-1').title = 'Updated title'; await f.bridge.sync();
  assert.equal(f.reminders.get(r.id).priority, 5);
});

test('agent judgment cannot cancel an explicit reminder or act when disabled', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  await assert.rejects(f.bridge.set(f.input('task-1', { mutationId: 'agent-cancel-intent', origin: 'agent', delivery: 'none' })), /explicit user reminder/);
  const disabled = createReminderBridge({ ...f.config, allowAgentJudgment: false }, f.deps);
  await assert.rejects(disabled.set(f.input('task-1', { mutationId: 'agent-cancel-disabled', origin: 'agent', delivery: 'none' })), /not enabled/);
  assert.equal([...f.reminders.values()][0].completed, false);
});

test('updated reminder context preserves notes appended on the phone', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.notes += '\nUser detail to retain.'; r.revision = 'phone-note-added';
  const context = await f.bridge.context('task-1');
  assert.equal(context.nativeReminder.revision, r.revision);
  await assert.rejects(f.bridge.set(f.input('task-1', { mutationId: 'edit-context-intent', reason: 'New reason' })), /Apple reminder changed/);
  await f.bridge.set(f.input('task-1', { mutationId: 'edit-context-intent', reason: 'New reason', expectedReminderRevision: r.revision }));
  assert.match(f.reminders.get(r.id).notes, /Why now: New reason/);
  assert.match(f.reminders.get(r.id).notes, /User detail to retain/);
});

test('an interrupted cancellation completes its receipt during recovery', async t => {
  const f = await fixture(t); await f.bridge.set(f.input()); let fail = true;
  const bridge = createReminderBridge(f.config, { ...f.deps, native: async input => {
    const result = await f.native(input);
    if (input.command === 'save' && fail) { fail = false; throw new Error('Lost cancel response'); }
    return result;
  } });
  const intent = f.input('task-1', { mutationId: 'cancel-recovery-intent', delivery: 'none' });
  await assert.rejects(bridge.set(intent), /Lost cancel/);
  await bridge.sync(); assert.equal((await bridge.set(intent)).replayed, true);
  assert.equal(f.tasks.get('task-1').status, 'open');
});

test('a manually removed notification alarm is surfaced without silently restoring it', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  [...f.reminders.values()][0].alarms = [];
  const result = await f.bridge.sync();
  assert.equal(result.results[0].state, 'conflict'); assert.match(result.results[0].error, /no notification alarm/);
});

test('native SQLite flags and API boolean flags yield the same task version', () => {
  const raw = { id: 'test', remind_native: 1, remind_text: 0 };
  assert.equal(taskVersion(raw), taskVersion({ ...raw, remind_native: true, remind_text: false }));
});

test('sync repairs missing success receipts for active and cancelled links', async t => {
  const f = await fixture(t); const input = f.input(); await f.bridge.set(input);
  async function loseResult(intent) {
    const file = path.join(f.stateDir, `op-${intent.mutationId}.json`);
    const receipt = JSON.parse(await readFile(file, 'utf8')); delete receipt.result;
    await writeFile(file, JSON.stringify(receipt));
  }
  await loseResult(input); await f.bridge.sync(); assert.equal((await f.bridge.set(input)).replayed, true);
  const cancel = f.input('task-1', { delivery: 'none', mutationId: 'cancel-receipt-gap' });
  await f.bridge.set(cancel); await loseResult(cancel); await f.bridge.sync(); assert.equal((await f.bridge.set(cancel)).replayed, true);
});

test('repeated explicit scheduling restores a removed alarm instead of reporting unchanged success', async t => {
  const f = await fixture(t); await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.alarms = []; r.revision = 'removed-alarm';
  const result = await f.bridge.set(f.input('task-1', { mutationId: 'restore-phone-alarm', expectedReminderRevision: r.revision }));
  assert.equal(result.scheduledNotification, true); assert.notEqual(result.unchanged, true);
  assert.equal(f.calls.filter(row => row.command === 'save').at(-1).ensureAlarm, true);
});

test('shortening generated context removes old text while preserving appended user notes', async t => {
  const f = await fixture(t); f.tasks.get('task-1').description = 'Keep this. Remove this outdated detail.';
  await f.bridge.set(f.input());
  const r = [...f.reminders.values()][0]; r.notes += '\nUser-added detail.'; r.revision = 'phone-added-detail';
  f.tasks.get('task-1').description = 'Keep this.';
  await f.bridge.set(f.input('task-1', { mutationId: 'shorten-task-context', expectedReminderRevision: r.revision }));
  assert.doesNotMatch(f.reminders.get(r.id).notes, /outdated detail/);
  assert.match(f.reminders.get(r.id).notes, /User-added detail/);
});


test('lost cancellation response cannot overwrite a newer open Apple edit', async t => {
  const f = await fixture(t); await f.bridge.set(f.input()); let lose = true;
  const bridge = createReminderBridge(f.config, { ...f.deps, native: async input => {
    const result = await f.native(input);
    if (input.command === 'save' && lose) { lose = false; throw new Error('Lost cancel response'); }
    return result;
  } });
  await assert.rejects(bridge.set(f.input('task-1', { mutationId: 'cancel-newer-edit', delivery: 'none' })), /Lost cancel/);
  const r = [...f.reminders.values()][0]; r.completed = false; r.revision = 'phone-reopened'; r.notes += '\nNew note';
  const saves = f.calls.filter(row => row.command === 'save').length;
  const result = await bridge.sync();
  assert.equal(result.results[0].state, 'conflict');
  assert.equal(f.reminders.get(r.id).completed, false);
  assert.equal(f.calls.filter(row => row.command === 'save').length, saves);
  assert.match(f.reminders.get(r.id).notes, /New note/);
});

test('interrupted cancellation retries only an unchanged pre-cancellation record', async t => {
  const f = await fixture(t); await f.bridge.set(f.input()); let fail = true;
  const bridge = createReminderBridge(f.config, { ...f.deps, native: async input => {
    if (input.command === 'save' && fail) { fail = false; throw new Error('Save not started'); }
    return f.native(input);
  } });
  const intent = f.input('task-1', { mutationId: 'cancel-before-write', delivery: 'none' });
  await assert.rejects(bridge.set(intent), /Save not started/);
  assert.equal((await bridge.sync()).results[0].state, 'cancelled');
  assert.equal((await bridge.set(intent)).replayed, true);
});

for (const interruption of ['before', 'after']) {
  test(`cancelling creation interrupted ${interruption} native save cannot resurrect a reminder`, async t => {
    const f = await fixture(t);
    let interrupt = true;
    const bridge = createReminderBridge(f.config, {...f.deps, native: async input => {
      if (input.command === 'save' && interrupt) {
        interrupt = false;
        if (interruption === 'after') await f.native(input);
        throw new Error('Interrupted native creation');
      }
      return f.native(input);
    }});
    await assert.rejects(bridge.set(f.input()), /Interrupted/);
    const state = JSON.parse(await readFile(path.join(f.stateDir, 'state.json'), 'utf8'));
    assert.equal(state.links['task-1'].phase, 'pending_native');
    assert.equal(state.links['task-1'].nativeId, null);
    const context = await bridge.context('task-1');
    const cancel = f.input('task-1', {delivery:'none', mutationId:'cancel-pending-create',
      expectedReminderRevision:context.nativeReminder?.revision});
    assert.equal((await bridge.set(cancel)).cancelled, true);
    const resumed = createReminderBridge(f.config, f.deps);
    await resumed.sync(); await resumed.sync();
    assert.equal((await resumed.context('task-1')).reminders[0].state, 'cancelled');
    assert.equal(f.tasks.get('task-1').status, 'open');
    assert.equal([...f.reminders.values()].filter(row => !row.completed).length, 0);
    assert.equal(f.reminders.size, interruption === 'after' ? 1 : 0);
    assert.equal((await resumed.set(cancel)).cancelled, true);
  });
}
