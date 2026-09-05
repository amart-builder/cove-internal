/** Local, model-free follow-through. Claims survive restarts; uncertain delivery
 * stays visible instead of being called success or blindly sent a second time. */
import { createHash } from 'node:crypto';
import { allocateAttention, dailyAttentionUsage, finalizeAttentionDelivery } from './ledger.mjs';
import { cleanAttentionText, sanitizeAttentionContent } from './safety.mjs';

export const FOLLOW_THROUGH_SCHEMA = `
CREATE TABLE IF NOT EXISTS cove_follow_through_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cove_follow_through_notices (
 id TEXT PRIMARY KEY, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, title TEXT NOT NULL,
 stage TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 snoozed_until TEXT, error TEXT
);`;
const MINUTE = 60_000;
function state(db, key) { const row = db.prepare('SELECT value, updated_at FROM cove_follow_through_state WHERE key = ?').get(key); return row ? { ...JSON.parse(row.value), updatedAt: row.updated_at } : null; }
function put(db, key, value, now) { db.prepare('INSERT INTO cove_follow_through_state VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), now.toISOString()); }
function localParts(now, timezone) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' }).formatToParts(now).map(p => [p.type,p.value]));
 return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function previousDate(date) { return new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0,10); }
function noticeId(kind, id, due, stage) { return createHash('sha256').update(JSON.stringify([kind,id,due,stage])).digest('hex'); }
function safeTitle(value) { return cleanAttentionText(sanitizeAttentionContent(String(value))).slice(0,140) || 'Open Cove to review'; }

export function followThroughStatus(db, now = new Date()) {
 const heartbeat = state(db,'heartbeat'); const calendar = state(db,'calendar');
 return { lastCheckedAt: heartbeat?.updatedAt ?? null, healthy: Boolean(heartbeat && now - new Date(heartbeat.updatedAt) < 5*MINUTE),
  calendar: { status: calendar?.status ?? 'not_checked', checkedAt: calendar?.updatedAt ?? null, fresh: Boolean(calendar?.status === 'ready' && now - new Date(calendar.updatedAt) < 10*MINUTE) },
  notices: db.prepare("SELECT id, title, ref_kind AS refKind, ref_id AS refId, stage, due_at AS dueAt, status, snoozed_until AS snoozedUntil FROM cove_follow_through_notices WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20").all(new Date(now-7*86400000).toISOString()) };
}
export function snoozeFollowThrough(db, id, now = new Date()) {
 // Snoozing dismisses this advance warning for one hour; completion and meeting
 // cancellation are re-read before any later delivery.
 return db.prepare("UPDATE cove_follow_through_notices SET status='pending', snoozed_until=?, updated_at=? WHERE id=? AND status <> 'sending'").run(new Date(+now+60*MINUTE).toISOString(),now.toISOString(),id).changes === 1;
}

export async function runFollowThrough({ db, now = new Date(), timezone, calendar, notify }) {
 const nowIso = now.toISOString(); const local = localParts(now,timezone);
 db.prepare("UPDATE cove_follow_through_notices SET status='uncertain', error='Delivery was interrupted. Review this item in Cove.' WHERE status='sending' AND updated_at < ?").run(new Date(now-5*MINUTE).toISOString());
 const poll = db.transaction(() => {
  const current = state(db,'calendar');
  if (current && now-new Date(current.updatedAt) < 5*MINUTE) return false;
  put(db,'calendar',{ status:'checking', events:[] },now); return true;
 }).immediate();
 if (poll) {
  try {
   const source = await calendar();
   if (!source) put(db,'calendar',{status:'not_connected',events:[]},now);
   else {
    const events = await source.listEvents({ timeMin:nowIso,timeMax:new Date(+now+30*MINUTE).toISOString(),timeZone:timezone,maxResults:250 });
    // Exclude cancelled, declined and all-day events. Never retain descriptions
    // or attendee identities merely to schedule a meeting banner.
    put(db,'calendar',{status:'ready',events:events.filter(e => e.status !== 'cancelled' && !e.attendees?.some(a=>a.self && a.responseStatus==='declined') && e.start?.includes('T')).slice(0,250).map(e=>({id:e.id,start:e.start,title:safeTitle(e.summary)}))},now);
   }
  } catch (error) { put(db,'calendar',{status:error?.code === 'not_configured' ? 'not_connected' : 'unavailable',events:[]},now); }
 }
 const candidates=[];
 const tasks = db.prepare("SELECT id,title,due_at,notification_policy,engaged_at,remind_native,remind_at FROM tasks WHERE status='open' AND archived_at IS NULL AND due_at IS NOT NULL AND remind_native=1 AND (notification_policy IS NULL OR notification_policy <> 'none')").all();
 for (const task of tasks) {
  if (task.engaged_at && now-new Date(task.engaged_at)<60*MINUTE) continue;
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(task.due_at); const due=Date.parse(task.due_at);
  if (!Number.isFinite(due)) continue;
  let stage;
  // Date-only means a day, never a made-up 9am deadline. Offer prep at 3pm on
  // the preceding local day; explicit remind_at keeps its existing owner.
  if (task.notification_policy !== 'due' && !task.remind_at && (dateOnly ? local.date===previousDate(task.due_at) && local.hour>=15 : +now>=due-60*MINUTE && +now<due)) stage='advance';
  if (task.notification_policy !== 'predeadline' && (dateOnly ? local.date>task.due_at : +now>=due+86400000)) stage=`overdue:${local.date}`;
  if (stage) candidates.push({kind:'task',ref:task.id,due:task.due_at,stage,title:safeTitle(task.title)});
 }
 const cached=state(db,'calendar');
 if (cached?.status==='ready' && now-new Date(cached.updatedAt)<10*MINUTE) for (const event of cached.events) {
  const until=Date.parse(event.start)-now;
  if (event.id && until>0 && until<=15*MINUTE) candidates.push({kind:'meeting',ref:event.id,due:event.start,stage:'meeting',title:event.title});
 }
 // Meetings first; never flood a busy day with a banner for every task.
 candidates.sort((a,b)=>(a.kind==='meeting'?0:1)-(b.kind==='meeting'?0:1) || a.due.localeCompare(b.due));
 for (const candidate of candidates) {
  const id=noticeId(candidate.kind,candidate.ref,candidate.due,candidate.stage);
  db.prepare("INSERT OR IGNORE INTO cove_follow_through_notices(id,ref_kind,ref_id,title,stage,due_at,status,updated_at) VALUES(?,?,?,?,?,?,'pending',?)").run(id,candidate.kind,candidate.ref,candidate.title,candidate.stage,candidate.due,nowIso);
  if (local.hour<8 || local.hour>=18) continue;
  const claim=db.transaction(()=>{
   const row=db.prepare('SELECT * FROM cove_follow_through_notices WHERE id=?').get(id);
   if (!row || row.status!=='pending' || (row.snoozed_until && Date.parse(row.snoozed_until)>+now) || row.attempts>=3 || (row.attempts && now-new Date(row.updated_at)<5*MINUTE)) return null;
   if (dailyAttentionUsage(db,now).banners>=5) return null;
   if (candidate.kind==='task' && !db.prepare("SELECT 1 FROM tasks WHERE id=? AND status='open' AND archived_at IS NULL AND due_at=? AND remind_native=1 AND (? <> 'advance' OR remind_at IS NULL OR remind_at = '') AND (notification_policy IS NULL OR notification_policy IN ('both', ?)) AND (engaged_at IS NULL OR julianday(engaged_at) <= julianday(?))").get(candidate.ref,candidate.due,candidate.stage,candidate.stage==='advance'?'predeadline':'due',new Date(now-60*MINUTE).toISOString())) return null;
   const allocation=allocateAttention(db,{kind:'chief_of_staff',refKind:candidate.kind,refId:row.snoozed_until ? `${candidate.ref}:snooze:${row.snoozed_until}` : candidate.kind==='meeting'?`${candidate.ref}:${candidate.due}`:candidate.ref,requestedLevel:'banner',reason:'Scheduled follow-through',now});
   if (!allocation.row || allocation.finalLevel!=='banner') return null;
   db.prepare("UPDATE cove_follow_through_notices SET status='sending', attempts=attempts+1, updated_at=? WHERE id=?").run(nowIso,id);
   return allocation.row.id;
  }).immediate();
  if (!claim) continue;
  const message=candidate.kind==='meeting' ? `Meeting in ${Math.ceil((Date.parse(candidate.due)-now)/MINUTE)} minutes: ${candidate.title}. Ready to prep?` : candidate.stage==='advance' ? `Coming due: ${candidate.title}. Make time for the next step.` : `Still open past its deadline: ${candidate.title}. Review the next step.`;
  let handedOff = false;
  try {
   await notify({id,message,taskId:candidate.kind==='task'?candidate.ref:undefined});
   handedOff = true;
   db.prepare("UPDATE cove_follow_through_notices SET status='delivered', error=NULL, updated_at=? WHERE id=?").run(nowIso,id);
   finalizeAttentionDelivery(db,{id:claim,level:'banner',now});
  } catch (error) {
   // Only an explicit pre-handoff failure is safely retryable. A timeout, crash
   // or failed success receipt may mean macOS already received the banner.
   const certainFailure = !handedOff && error?.deliveryNotAttempted === true;
   db.prepare("UPDATE cove_follow_through_notices SET status=?,error=?,updated_at=? WHERE id=?").run(certainFailure ? (db.prepare('SELECT attempts FROM cove_follow_through_notices WHERE id=?').get(id).attempts>=3?'failed':'pending') : 'uncertain', certainFailure?'Native notification failed before delivery':'Delivery could not be confirmed. Review this item in Cove.',nowIso,id);
   if (certainFailure) finalizeAttentionDelivery(db,{id:claim,level:'suppressed',suppressedReason:'delivery_failed',now});
  }
 }
 // Obsolete pending notices are historical evidence, not actionable UI work.
 const active = new Set(candidates.map(c=>noticeId(c.kind,c.ref,c.due,c.stage)));
 for (const row of db.prepare("SELECT id FROM cove_follow_through_notices WHERE status='pending'").all()) if (!active.has(row.id)) db.prepare("UPDATE cove_follow_through_notices SET status='expired' WHERE id=?").run(row.id);
 put(db,'heartbeat',{status:'ready'},now);
 return followThroughStatus(db,now);
}
