import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function reminderPath(dataDir, taskId) {
  const key = createHash('sha256').update(taskId).digest('hex');
  return path.join(dataDir, 'reminders', `repeat-${key}.json`);
}
export function scheduleNotificationReminder(dataDir, taskId, now = new Date()) {
  const file = reminderPath(dataDir, taskId);
  const remindAt = new Date(+now + 60 * 60_000).toISOString();
  mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({taskId, remindAt}), {mode:0o600, flag:'wx'});
  renameSync(temp, file);
  return remindAt;
}
/** User-requested repeats are native-only and never alter a task's deadline.
 * Claim before delivery; uncertain crash recovery is reported, never resent. */
export function drainNotificationReminders({db, dataDir, notify, onFailure, now = new Date()}) {
  const dir = path.join(dataDir, 'reminders');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter(name => /^repeat-[a-f0-9]{64}\.json\.claimed$/.test(name))) {
    const claim = path.join(dir,name);
    if (+now - statSync(claim).mtimeMs < 5*60_000) continue;
    let taskId=name;
    try { taskId=JSON.parse(readFileSync(claim,'utf8')).taskId ?? name; } catch { /* Preserve unreadable crash evidence. */ }
    onFailure({id:taskId,title:'Requested reminder',error:'Cove could not confirm this reminder after an interrupted delivery. Review the task and request another reminder if needed.'});
    if (existsSync(claim)) renameSync(claim, `${claim}.${randomUUID()}.uncertain`);
  }
  for (const name of readdirSync(dir).filter(name => /^repeat-[a-f0-9]{64}\.json$/.test(name))) {
    const file = path.join(dir, name);
    let entry;
    try { entry = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { onFailure({id:name,title:'Requested reminder',error:String(error)}); continue; }
    if (typeof entry.taskId !== 'string' || !entry.taskId) { onFailure({id:name,title:'Requested reminder',error:'Missing task reference.'}); continue; }
    if (!Number.isFinite(Date.parse(entry.remindAt)) || Date.parse(entry.remindAt) > +now) continue;
    const claim = `${file}.claimed`;
    // A previous uncertain send must not be overwritten by another claim.
    if (existsSync(claim)) continue;
    try { renameSync(file, claim); utimesSync(claim, now, now); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      const task = db.prepare("SELECT id,title,source_type FROM tasks WHERE id=? AND status='open' AND archived_at IS NULL").get(entry.taskId);
      if (task) notify(task);
      unlinkSync(claim);
    } catch (error) {
      onFailure({id:entry.taskId, title:'Requested reminder', error:String(error)});
      // Preserve uncertainty for diagnosis without retrying the send.
      if (existsSync(claim)) renameSync(claim, `${claim}.${randomUUID()}.uncertain`);
    }
  }
}
