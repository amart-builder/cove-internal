import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, stat, rmdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const OP = /^[A-Za-z0-9_-]{8,100}$/;
const TASK_FIELDS = 'id,title,description,status,column_id,due_at,due_date,remind_at,remind_native,remind_text,notification_policy,updated_at,priority';
const iso = value => new Date(value).toISOString().replace('.000Z', 'Z');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equalTime = (a, b) => a === b || (a && b && Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b));
class ConflictError extends Error {}
function check(condition, message) { if (!condition) throw new Error(message); }
function conflict(condition, message) { if (!condition) throw new ConflictError(message); }
function text(value, label, max = 2000) {
  check(typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'), `Invalid ${label}.`);
  return value.trim();
}
function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), 'A phone reminder needs an exact date, time and timezone offset.');
  return iso(value);
}
function taskVersion(task) {
  return hash(Object.fromEntries(TASK_FIELDS.split(',').map(key => [key, ['remind_native', 'remind_text'].includes(key) && task[key] != null ? Boolean(task[key]) : (task[key] ?? null)])));
}
function taskView(task) { return { title: task.title, completed: task.status !== 'open', dueAt: task.due_at ?? null, remindAt: task.remind_at ?? null }; }
function hasDueAlarm(reminder, notifyAt = reminder.dueAt) { return Array.isArray(reminder.alarms) && reminder.alarms.some(alarm => equalTime(alarm.absolute, notifyAt) || (!alarm.absolute && alarm.relative === 0)); }
function nativeView(reminder) { return { title: reminder.title, completed: reminder.completed, dueAt: reminder.dueAt }; }
function sameValue(key, a, b) { return key === 'dueAt' || key === 'remindAt' ? equalTime(a, b) : a === b; }
function localTimestamp(time, timezone) {
  const date = new Date(time);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(date).map(p => [p.type, p.value]));
  const offset = parts.timeZoneName.replace('GMT', '') || 'Z';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
function localDay(time, timezone) { return localTimestamp(time, timezone).slice(0, 10); }

export async function nativeCommand(helperPath, input, { timeoutMs = 25_000 } = {}) {
  check(path.isAbsolute(helperPath) && helperPath.endsWith('.app/Contents/MacOS/CoveReminders'), 'Use the installed Cove Reminders app.');
  const appPath = path.dirname(path.dirname(path.dirname(helperPath)));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cove-reminders-command-'));
  const inputPath = path.join(directory, 'input.json'); const outputPath = path.join(directory, 'output.json');
  try {
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    await writeFile(outputPath, '', { mode: 0o600 });
    // LaunchServices supplies the app's own privacy identity, including from launchd.
    // Direct child execution incorrectly inherits its caller's Reminders permission.
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/open', ['-n', '-g', '-W', '--stdin', inputPath, '--stdout', outputPath, '--stderr', '/dev/null', appPath], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Apple Reminders timed out. Read the linked reminder before retrying.')); }, timeoutMs);
      child.once('error', () => { clearTimeout(timer); reject(new Error('The Cove Reminders helper could not start.')); });
      child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('The Cove Reminders helper could not start.')); });
    });
    check((await stat(outputPath)).size <= 8_000_000, 'Apple Reminders response exceeded the safe size.');
    let value;
    try { value = JSON.parse(await readFile(outputPath, 'utf8')); }
    catch { throw new Error('Apple Reminders returned an invalid result. Check the saved state before retrying.'); }
    check(value.ok === true, typeof value.error === 'string' ? value.error.slice(0, 400) : 'Apple Reminders rejected the request.');
    return value.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createTaskApi(appUrl, fetchImpl = fetch) {
  const base = new URL(appUrl);
  check(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && !base.username && !base.password, 'Cove must use an explicit loopback URL.');
  let csrf;
  async function request(route, method = 'GET', body) {
    if (method !== 'GET' && !csrf) csrf = (await request('/api/day-plan')).csrfToken;
    if (method !== 'GET') check(typeof csrf === 'string' && csrf.length >= 16, 'Cove request permission is unavailable.');
    const response = await fetchImpl(`${base.origin}${route}`, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Cove-CSRF': csrf },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(response.status === 409 ? 'The Cove task changed. Read it again before updating.' : `Cove returned HTTP ${response.status}. Check the saved state before retrying.`);
    return response.json();
  }
  async function task(id) {
    check(ID.test(id), 'Invalid task ID.');
    const query = new URLSearchParams({ id: `eq.${id}`, select: TASK_FIELDS, limit: '1' });
    let rows = await request(`/api/cove-rest/tasks?${query}`);
    if (!rows.length) { query.set('status', 'eq.archived'); rows = await request(`/api/cove-rest/tasks?${query}`); }
    check(rows.length === 1, 'The linked Cove task is unavailable.');
    return rows[0];
  }
  async function patch(before, changes) {
    const query = new URLSearchParams({ id: `eq.${before.id}`, updated_at: `eq.${before.updated_at}`, status: `eq.${before.status}` });
    const body = { ...changes, _expected: { title: before.title, description: before.description, priority: before.priority, columnId: before.column_id } };
    for (const field of ['due_at', 'remind_at', 'remind_native', 'remind_text', 'notification_policy']) {
      if (Object.hasOwn(changes, field)) query.set(field, before[field] == null ? 'is.null' : `eq.${typeof before[field] === 'boolean' ? Number(before[field]) : before[field]}`);
    }
    const rows = await request(`/api/cove-rest/tasks?${query}`, 'PATCH', body);
    check(Array.isArray(rows) && rows.length === 1, 'The Cove task changed while the reminder was being saved.');
    return task(before.id);
  }
  async function column(completed) {
    const rows = await request('/api/cove-rest/task_columns?select=id,name');
    const expected = completed ? ['Done', 'Completed'] : ['Not Started', 'To Do'];
    const row = rows.find(row => expected.includes(row.name));
    check(row, 'Cove is missing the required task list.'); return row.id;
  }
  return { task, patch, column };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Cove reminder state is unreadable. No automatic reset was attempted.'); }
}
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export function createReminderBridge(config, dependencies = {}) {
  check(config?.enabled === true, 'Apple Reminders is not connected to Cove.');
  check(path.isAbsolute(config.stateDir) && typeof config.calendarId === 'string' && config.calendarId, 'Apple Reminders setup is incomplete.');
  const timezone = config.timezone ?? 'America/Los_Angeles';
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  const native = dependencies.native ?? (input => nativeCommand(config.helperPath, input));
  const api = dependencies.api ?? createTaskApi(config.appUrl);
  const now = dependencies.now ?? (() => new Date());
  const stateFile = path.join(config.stateDir, 'state.json');
  const lockDir = path.join(config.stateDir, 'lock');
  const initial = () => ({ version: 1, links: {}, decisions: [], lastSyncAt: null });
  const nativeInput = input => ({ ...input, calendarId: config.calendarId });
  let current;
  async function locked(work) {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    try { await mkdir(lockDir, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(path.join(lockDir, 'owner.json'), null);
      let alive = true;
      if (owner?.pid) { try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; } }
      if (!owner && Date.now() - (await stat(lockDir)).mtimeMs > 30_000) alive = false;
      check(!alive, 'Cove reminder synchronization is busy. Retry after it finishes.');
      await rename(lockDir, `${lockDir}.stale-${randomUUID()}`);
      await mkdir(lockDir, { mode: 0o700 });
    }
    await atomic(path.join(lockDir, 'owner.json'), { pid: process.pid });
    try {
      current = await readJson(stateFile, initial());
      check(current.version === 1 && current.links && Array.isArray(current.decisions), 'Unsupported reminder state.');
      return await work();
    } finally {
      current = undefined;
      await unlink(path.join(lockDir, 'owner.json'));
      await rmdir(lockDir);
    }
  }
  const saveState = () => atomic(stateFile, current);
  function publicLink(link) {
    return { taskId: link.taskId, reminderId: link.nativeId ?? null, title: link.title, delivery: link.delivery,
      notifyAt: link.notifyAt, state: link.phase, reason: link.reason, nextStep: link.nextStep,
      origin: link.origin, lastError: link.lastError ?? null, updatedAt: link.updatedAt };
  }
  function note(task, input) {
    return `Next step: ${input.nextStep}\n\nWhy now: ${input.reason}\n\nTask context:\n${String(task.description ?? '').slice(0, 2200)}`;
  }
  function updatedNotes(link, reminder) {
    if (!reminder) return link.notes;
    if (link.previousNotes && reminder.notes.startsWith(link.previousNotes)) return link.notes + reminder.notes.slice(link.previousNotes.length);
    if (reminder.notes.startsWith(link.notes)) return reminder.notes;
    const end = reminder.notes.indexOf('[End Cove context]');
    if (end >= 0) return link.notes + reminder.notes.slice(end + '[End Cove context]'.length);
    return reminder.notes;
  }
  async function nativeSave(link, reminder, task, { completed = task.status !== 'open', notifyAt = link.notifyAt, refreshContext = false } = {}) {
    const conversationLink = new URL(config.conversationUrl); conversationLink.hash = `cove-task=${task.id}`;
    const result = await native(nativeInput({ command: 'save', taskId: task.id, ...(reminder ? { id: reminder.id, revision: reminder.revision } : {}),
      title: task.title, notes: refreshContext ? updatedNotes(link, reminder) : (reminder?.notes ?? link.notes), dueAt: notifyAt, timezone,
      completed, ensureAlarm: refreshContext && link.origin === 'explicit', priority: reminder?.priority ?? (link.delivery === 'alarm' ? 1 : 0), url: conversationLink.href }));
    check(result.reminder, 'The Apple reminder save did not return a record.');
    conflict(completed || hasDueAlarm(result.reminder, notifyAt), 'The saved Apple reminder has no notification alarm at the requested time. No phone alert is confirmed.');
    return result.reminder;
  }
  async function set(input) {
    check(ID.test(input.taskId), 'Invalid task ID.');
    check(OP.test(input.mutationId), 'Use a stable mutation ID of 8 to 100 letters, numbers, hyphens or underscores.');
    check(['notification', 'alarm', 'none'].includes(input.delivery), 'Invalid reminder delivery mode.');
    check(['explicit', 'agent'].includes(input.origin), 'Reminder origin must be explicit or agent.');
    const reason = text(input.reason, 'reason', 500);
    const nextStep = text(input.nextStep, 'next step', 700);
    const notifyAt = input.delivery === 'none' ? null : date(input.notifyAt);
    const fingerprint = hash({ ...input, reason, nextStep, notifyAt });
    return locked(async () => {
      const receiptFile = path.join(config.stateDir, `op-${input.mutationId}.json`);
      const prior = await readJson(receiptFile, null);
      if (prior) {
        check(prior.fingerprint === fingerprint, 'This mutation ID already belongs to a different reminder request.');
        if (prior.result) return { ...prior.result, replayed: true, current: current.links[input.taskId] ? publicLink(current.links[input.taskId]) : null };
        throw new Error('The earlier reminder request has an uncertain outcome. Read reminder status and synchronize before retrying.');
      }
      const task = await api.task(input.taskId);
      check(task.status === 'open' || input.delivery === 'none', 'Only open tasks can get a new reminder.');
      check(input.expectedVersion === taskVersion(task), 'The task changed. Read its current reminder context before scheduling.');
      const existing = current.links[input.taskId];
      if (input.origin === 'agent') {
        check(config.allowAgentJudgment === true, 'Automatic phone reminders are not enabled.');
        check(existing?.origin !== 'explicit', 'An automatic judgment cannot change or cancel an explicit user reminder.');
      }
      const reminders = (await native(nativeInput({ command: 'list' }))).reminders;
      const reminder = existing?.nativeId ? reminders.find(row => row.id === existing.nativeId) : undefined;
      if (existing?.nativeId && !reminder) throw new Error('The linked Apple reminder was removed or moved. No duplicate was created.');
      if (reminder && reminder.revision !== existing.nativeBase?.revision) {
        check(input.expectedReminderRevision === reminder.revision, 'The Apple reminder changed. Read its current reminder context and provide expectedReminderRevision before editing.');
      }
      if (input.delivery !== 'none') {
        check(Date.parse(notifyAt) > +now(), 'Choose a future reminder time.');
        const sameIntent = existing && ['active', 'alarm_pending'].includes(existing.phase) && equalTime(existing.notifyAt, notifyAt) && existing.delivery === input.delivery && existing.reason === reason && existing.nextStep === nextStep && existing.origin === input.origin && existing.notes === note(task, { reason, nextStep }) && reminder?.completed === false && reminder?.title === task.title && equalTime(reminder?.dueAt, notifyAt) && hasDueAlarm(reminder, notifyAt);
        if (sameIntent) return { saved: existing.phase === 'active', unchanged: true, reminder: publicLink(existing) };
        if (input.origin === 'agent') {
          check(config.allowAgentJudgment === true, 'Automatic phone reminders are not enabled.');
          const day = localDay(notifyAt, timezone);
          const automatic = current.decisions.filter(item => item.origin === 'agent' && item.day === day && item.taskId !== task.id);
          check(automatic.length < (config.maxAutomaticPerDay ?? 2), 'The automatic phone reminder budget is reserved. Keep this in the brief or surface a decision instead of adding another alert.');
          const hour = Number(localTimestamp(notifyAt, timezone).slice(11, 13));
          if (input.delivery !== 'alarm') check(hour >= (config.quietHoursEnd ?? 8) && hour < (config.quietHoursStart ?? 21), 'Routine automatic phone notifications wait until daytime.');
          const recent = current.decisions.some(item => item.taskId === task.id && Date.parse(item.recordedAt) > +now() - 6 * 60 * 60_000);
          check(!recent, 'This task already received a phone reminder decision recently. Update the task or brief instead of repeating the interruption.');
        }
      }
      await atomic(receiptFile, { fingerprint, state: 'pending', taskId: task.id, requestedAt: now().toISOString() });
      if (input.delivery === 'none') {
        if (existing && reminder) {
          existing.phase = 'pending_cancel'; existing.cancelOperationId = input.mutationId;
          existing.cancelNativeBase = reminder; existing.cancelTaskBase = task; await saveState();
          const cancelled = await nativeSave(existing, reminder, task, { completed: true });
          existing.nativeBase = cancelled; existing.phase = 'cancelled'; existing.updatedAt = now().toISOString();
          await saveState();
        }
        const result = { saved: true, cancelled: true, taskId: task.id };
        await atomic(receiptFile, { fingerprint, result }); return result;
      }
      const link = { taskId: task.id, title: task.title, delivery: input.delivery, notifyAt, reason, nextStep,
        previousNotes: existing?.notes, origin: input.origin, followDue: equalTime(task.due_at, notifyAt), notes: note(task, { reason, nextStep }),
        nativeId: reminder?.id ?? null, nativeBase: reminder ?? null, taskBase: task,
        priorNative: existing?.priorNative ?? task.remind_native, priorText: existing?.priorText ?? task.remind_text,
        priorPolicy: existing?.priorPolicy ?? task.notification_policy,
        phase: 'pending_native', updatedAt: now().toISOString(), operationId: input.mutationId };
      current.links[task.id] = link; await saveState();
      const saved = await nativeSave(link, reminder, task, { refreshContext: true });
      link.nativeId = saved.id; link.nativeBase = saved; link.phase = 'pending_task'; await saveState();
      link.intendedPatch = { remind_at: localTimestamp(notifyAt, timezone), remind_native: false, remind_text: false, notification_policy: 'none' };
      await saveState();
      const patched = await api.patch(task, link.intendedPatch);
      link.taskBase = patched;
      link.phase = input.delivery === 'alarm' ? 'alarm_pending' : 'active';
      if (input.delivery === 'alarm') link.lastError = 'Ordinary notification scheduled. The Urgent alarm switch still needs native verification; no alarm is confirmed.';
      return finalize(link, receiptFile, fingerprint);
    });
  }

  async function finalize(link, receiptFile, fingerprint) {
    if (!current.decisions.some(row => row.operationId === link.operationId)) {
      current.decisions.push({ operationId: link.operationId, taskId: link.taskId, origin: link.origin,
        day: localDay(link.notifyAt, timezone), recordedAt: now().toISOString(), delivery: link.delivery });
    }
    link.updatedAt = now().toISOString(); await saveState();
    const result = { saved: true, scheduledNotification: true, urgentAlarmConfirmed: false, reminder: publicLink(link), warning: link.lastError ?? null };
    await atomic(receiptFile, { fingerprint, result }); return result;
  }
  async function syncOne(link, reminders) {
    // State and receipt are separate atomic files. Repair a crash between them.
    if (link.phase === 'cancelled' && link.cancelOperationId) {
      const file = path.join(config.stateDir, `op-${link.cancelOperationId}.json`);
      const operation = await readJson(file, null);
      if (operation?.fingerprint && !operation.result) await atomic(file, { fingerprint: operation.fingerprint, result: { saved: true, cancelled: true, taskId: link.taskId } });
    }
    if (['active', 'alarm_pending'].includes(link.phase) && link.operationId) {
      const file = path.join(config.stateDir, `op-${link.operationId}.json`);
      const operation = await readJson(file, null);
      if (operation?.fingerprint && !operation.result) await finalize(link, file, operation.fingerprint);
    }
    if (['cancelled', 'conflict', 'missing'].includes(link.phase)) return;
    let task = await api.task(link.taskId);
    let reminder = link.nativeId ? reminders.find(row => row.id === link.nativeId) : reminders.find(row => row.taskId === link.taskId || row.notes.startsWith(`Cove task: ${link.taskId}\n`));
    if (!reminder && link.phase === 'pending_native') {
      conflict(taskVersion(task) === taskVersion(link.taskBase) && task.status === 'open' && Date.parse(link.notifyAt) > +now(),
        'The task or time changed before an interrupted Apple creation. Review required.');
      reminder = await nativeSave(link, null, task);
    }
    conflict(reminder, 'The linked Apple reminder is missing or moved. No replacement was created.');
    link.nativeId = reminder.id;
    if (link.phase === 'pending_native' || link.phase === 'pending_task') {
      const patch = link.intendedPatch ?? { remind_at: localTimestamp(link.notifyAt, timezone), remind_native: false, remind_text: false, notification_policy: 'none' };
      const intended = { ...link.taskBase, ...patch };
      const matchesIntended = taskVersion({ ...task, updated_at: intended.updated_at }) === taskVersion(intended);
      const matchesOriginal = taskVersion(task) === taskVersion(link.taskBase);
      conflict(matchesOriginal || matchesIntended, 'The task changed during an interrupted reminder save. Review required.');
      conflict(hasDueAlarm(reminder, link.notifyAt), 'The pending Apple reminder has no notification alarm at the requested time. Review required.');
      conflict(reminder.title === link.title && equalTime(reminder.dueAt, link.notifyAt) && reminder.completed === false,
        'The recovered Apple reminder differs from the pending request. Review required.');
      if (!matchesIntended) task = await api.patch(task, patch);
      link.nativeBase = reminder; link.taskBase = task; link.phase = link.delivery === 'alarm' ? 'alarm_pending' : 'active';
      link.lastError = link.delivery === 'alarm' ? 'Ordinary notification scheduled. Urgent alarm verification remains pending.' : null;
      const file = path.join(config.stateDir, `op-${link.operationId}.json`);
      const operation = await readJson(file, null);
      conflict(operation?.fingerprint, 'The original reminder receipt is missing. Review required.');
      await finalize(link, file, operation.fingerprint);
      return;
    }
    if (link.phase === 'pending_cancel') {
      // A lost response is not permission to overwrite a later Apple edit.
      // Already-completed items need only a receipt, not another native write.
      if (!reminder.completed) {
        conflict(reminder.revision === (link.cancelNativeBase ?? link.nativeBase)?.revision &&
          taskVersion(task) === taskVersion(link.cancelTaskBase ?? link.taskBase),
        'The linked reminder or task changed during an interrupted cancellation. Review required.');
        reminder = await nativeSave(link, reminder, task, { completed: true });
      }
      link.nativeBase = reminder; link.phase = 'cancelled'; await saveState();
      const file = path.join(config.stateDir, `op-${link.cancelOperationId}.json`);
      const operation = await readJson(file, null);
      if (operation?.fingerprint) await atomic(file, { fingerprint: operation.fingerprint, result: { saved: true, cancelled: true, taskId: task.id } });
      return;
    }
    conflict(reminder.completed || hasDueAlarm(reminder), 'The Apple reminder has no notification alarm. Restore its alert in Reminders before continuing.');
    const taskBefore = taskView(link.taskBase); const taskNow = taskView(task);
    const nativeBefore = nativeView(link.nativeBase); const nativeNow = nativeView(reminder);
    const changedTask = ['title', 'completed', 'dueAt', 'remindAt'].filter(key => !sameValue(key, taskBefore[key], taskNow[key]));
    const changedNative = ['title', 'completed', 'dueAt'].filter(key => !sameValue(key, nativeBefore[key], nativeNow[key]));
    const conflicts = changedTask.filter(key => changedNative.includes(key) && (key !== 'dueAt' || link.followDue) && !sameValue(key, taskNow[key], nativeNow[key]));
    if (changedTask.includes('remindAt') && changedNative.includes('dueAt') && !equalTime(task.remind_at, reminder.dueAt)) conflicts.push('reminder time');
    conflict(!conflicts.length, `Cove and Apple both changed ${conflicts.join(', ')}. Neither edit was overwritten; review the linked reminder.`);
    if (task.status === 'archived') {
      if (!reminder.completed) reminder = await nativeSave(link, reminder, task, { completed: true });
      link.phase = 'cancelled'; link.taskBase = task; link.nativeBase = reminder; return;
    }
    const patch = {};
    if (changedNative.includes('title')) patch.title = reminder.title;
    if (changedNative.includes('completed')) {
      patch.status = reminder.completed ? 'done' : 'open';
      patch.column_id = await api.column(reminder.completed);
    }
    if (changedNative.includes('dueAt')) {
      conflict(reminder.dueAt && !reminder.allDay, 'The Apple reminder lost its exact alert time. Choose a time before synchronizing.');
      link.notifyAt = iso(reminder.dueAt);
      patch.remind_at = localTimestamp(reminder.dueAt, timezone);
      if (link.followDue) { patch.due_at = patch.remind_at; patch.due_date = patch.remind_at.slice(0, 10); patch.notified_at = null; }
    }
    const taskMovedTime = changedTask.includes('remindAt') || (changedTask.includes('dueAt') && link.followDue);
    if (taskMovedTime && !changedNative.includes('dueAt')) {
      const value = changedTask.includes('remindAt') ? task.remind_at : task.due_at;
      conflict(value && /T/.test(value), 'The Cove task no longer has an exact reminder time. Review required.');
      link.notifyAt = date(value);
      if (!changedTask.includes('remindAt')) patch.remind_at = localTimestamp(value, timezone);
      else if (!equalTime(task.due_at, value)) link.followDue = false;
    }
    if (Object.keys(patch).length) task = await api.patch(task, patch);
    const needsNative = task.title !== reminder.title || (task.status !== 'open') !== reminder.completed || (taskMovedTime && !equalTime(link.notifyAt, reminder.dueAt));
    if (needsNative) reminder = await nativeSave(link, reminder, task);
    link.taskBase = task; link.nativeBase = reminder; link.title = task.title; link.updatedAt = now().toISOString();
    if (link.phase !== 'alarm_pending') link.lastError = null;
  }
  async function sync() {
    return locked(async () => {
      const reminders = (await native(nativeInput({ command: 'list' }))).reminders;
      const results = [];
      for (const link of Object.values(current.links)) {
        try { await syncOne(link, reminders); results.push({ taskId: link.taskId, state: link.phase }); }
        catch (error) { link.lastError = String(error.message).slice(0, 500); if (error instanceof ConflictError) link.phase = 'conflict'; results.push({ taskId: link.taskId, state: error instanceof ConflictError ? 'conflict' : 'retry_pending', error: link.lastError }); }
        await saveState();
      }
      current.lastSyncAt = now().toISOString(); await saveState();
      return { syncedAt: current.lastSyncAt, results };
    });
  }
  async function context(taskId) {
    const status = await native({ command: 'status' });
    const state = await readJson(stateFile, initial());
    let task; let nativeReminder;
    if (taskId && status.authorized && state.links[taskId]?.nativeId) {
      const rows = (await native(nativeInput({ command: 'list' }))).reminders;
      nativeReminder = rows.find(row => row.id === state.links[taskId].nativeId) ?? null;
    }
    if (taskId) { const row = await api.task(taskId); task = { id: row.id, title: row.title, status: row.status, dueAt: row.due_at, description: row.description, version: taskVersion(row) }; }
    return { connected: status.authorized === true, timezone, notificationSupported: true, urgentAlarmSupported: status.urgentAlarmSupported === true,
      urgentAlarmReason: status.urgentAlarmReason, lastSyncAt: state.lastSyncAt,
      automaticBudgetPerDay: config.maxAutomaticPerDay ?? 2, task, nativeReminder,
      reminders: Object.values(state.links).filter(row => !taskId || row.taskId === taskId).map(publicLink),
      guidance: 'Apple Reminders schedules delivery on the user’s devices after iCloud sync. A saved notification is not proof of a displayed phone alert or Urgent alarm. Explicit requested reminders are not subject to the automatic suggestion budget.' };
  }
  return { set, sync, context };
}

export async function loadReminderConfig(dataDir) {
  return readJson(path.join(dataDir, 'apple-reminders.json'), null);
}
export { taskVersion, localTimestamp };
