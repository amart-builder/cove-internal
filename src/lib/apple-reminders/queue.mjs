import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { taskVersion } from './bridge.mjs';

export function readPhoneReminderConfig(dataDir) {
  const file = path.join(dataDir, 'apple-reminders.json');
  if (!existsSync(file)) return null;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  return config?.enabled === true ? config : null;
}

export function queuePhoneReminder({ dataDir, task, action, intentKey }) {
  const config = readPhoneReminderConfig(dataDir);
  if (!config?.allowAgentJudgment) throw new Error('Automatic Apple Reminders are not enabled.');
  if (!['notification', 'alarm', 'none'].includes(action.level)) throw new Error('Phone reminder level must be notification, alarm, or none.');
  if (task.status !== 'open') throw new Error('Phone reminders require an open task.');
  for (const [key, maximum] of [['reason', 500], ['next_action', 700]]) {
    if (typeof action[key] !== 'string' || !action[key].trim() || action[key].length > maximum) throw new Error(`${key} is required for a useful phone reminder.`);
  }
  if (action.level !== 'none' && (typeof action.remind_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(action.remind_at) || !Number.isFinite(Date.parse(action.remind_at)))) throw new Error('An exact remind_at with timezone is required.');
  const mutationId = `chief-${createHash('sha256').update(intentKey).digest('hex').slice(0, 40)}`;
  const directory = path.join(config.stateDir, 'queue');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${mutationId}.json`);
  const request = { taskId: task.id, expectedVersion: taskVersion(task), mutationId, origin: 'agent', delivery: action.level,
    notifyAt: action.remind_at, reason: action.reason, nextStep: action.next_action };
  // The per-wake action ledger and stable filename make queueing replay-safe.
  if (!existsSync(file)) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ request, phase: 'queued' }, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
  }
  return { queued: true, delivered: false, mutationId };
}

export function phoneReminderSnapshot(dataDir) {
  const config = readPhoneReminderConfig(dataDir);
  if (!config) return ['Apple Reminders: not connected. Do not queue phone_reminder actions.'];
  const file = path.join(config.stateDir, 'state.json');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { links: {} };
  const rows = Object.values(state.links).filter(row => row.phase !== 'cancelled');
  const queueDir = path.join(config.stateDir, 'queue');
  const failures = existsSync(queueDir) ? readdirSync(queueDir).filter(name => /^chief-[a-f0-9]{40}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(path.join(queueDir, name), 'utf8')))
    .filter(entry => entry.phase === 'needs_attention')
    .sort((a, b) => String(b.processedAt).localeCompare(String(a.processedAt))).slice(0, 5) : [];
  return [
    `Apple Reminders: enabled; automatic judgment=${config.allowAgentJudgment === true}; ordinary notifications supported; Urgent alarm automation=${config.urgentAlarmSupported === true ? 'verified' : 'not verified; never claim a confirmed alarm'}.`,
    `Last synchronization: ${state.lastSyncAt ?? 'not yet verified'}. Automatic phone budget: ${config.maxAutomaticPerDay ?? 2} per target day. Explicit user requests are exempt.`,
    ...failures.map(entry => `Phone reminder needs attention: ${entry.request.taskId} | ${entry.error ?? entry.result?.warning ?? 'Urgent alarm not verified'}`),
    `Linked reminders: ${rows.length}; showing ${Math.min(rows.length, 12)}.`,
    ...rows.slice(0, 12).map(row => `${row.taskId} | ${row.title} | ${row.notifyAt} | ${row.delivery} | ${row.phase} | ${row.lastError ?? row.reason}`),
  ];
}
