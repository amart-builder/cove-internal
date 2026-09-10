#!/usr/bin/env node
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReminderBridge, loadReminderConfig } from '../src/lib/apple-reminders/bridge.mjs';

export async function reminderTick(dataDir, dependencies = {}) {
  const config = await loadReminderConfig(dataDir);
  if (!config?.enabled) return { enabled: false };
  const bridge = createReminderBridge(config, dependencies);
  const results = [];
  // Recover uncertain saves before replaying their stable queue intent.
  await bridge.sync();
  const directory = path.join(config.stateDir, 'queue');
  const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of files.filter(name => /^chief-[a-f0-9]{40}\.json$/.test(name)).sort()) {
    const file = path.join(directory, name);
    const entry = JSON.parse(await readFile(file, 'utf8'));
    if (entry.phase !== 'queued' || Date.parse(entry.retryAt ?? '') > Date.now()) continue;
    try {
      entry.result = await bridge.set(entry.request);
      entry.phase = entry.result.reminder?.state === 'alarm_pending' ? 'needs_attention' : 'saved';
    } catch (error) {
      entry.error = String(error.message).slice(0, 500);
      entry.attempts = (entry.attempts ?? 0) + 1;
      const temporary = /busy|timed out|timeout|invalid result|could not start|operation failed|invalid result|HTTP (5\d\d|408|429)|uncertain outcome|fetch failed|ECONN/i.test(entry.error);
      entry.phase = temporary && entry.attempts < 5 ? 'queued' : 'needs_attention';
      if (entry.phase === 'queued') entry.retryAt = new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** (entry.attempts - 1))).toISOString();
    }
    entry.processedAt = new Date().toISOString();
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(entry, null, 2), { mode: 0o600 }); await rename(temporary, file);
    results.push({ mutationId: entry.request.mutationId, phase: entry.phase, error: entry.error });
  }
  const synchronization = await bridge.sync();
  return { enabled: true, processed: results, ...synchronization };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDirIndex = process.argv.indexOf('--data-dir');
  const dataDir = dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : undefined;
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Use --data-dir with the explicit Cove data directory.');
  const result = await reminderTick(dataDir);
  console.log(JSON.stringify(result));
  if (result.processed?.some(row => row.phase === 'needs_attention') || result.results?.some(row => row.state === 'conflict')) process.exitCode = 1;
}
