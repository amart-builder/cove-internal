/** Local, model-free follow-through. Claims survive restarts; uncertain delivery
 * stays visible instead of being called success or blindly sent a second time. */
import { createHash } from 'node:crypto';
import { allocateAttention, finalizeAttentionDelivery } from './ledger.mjs';
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
const POLICY_HOLD = 'Reminder held by the attention allowance or a prior alert. Review this item in Cove.';
// Routine backlog holds are normal attention policy. A held imminent deadline,
// missed meeting or actual delivery failure still needs to be visible.
const NEEDS_ATTENTION = `(status IN ('uncertain','failed','missed') OR
 (status='pending' AND error IS NOT NULL AND
 (error <> '${POLICY_HOLD}' OR attempts > 0 OR stage IN ('meeting','advance','preparation'))))`;
function preparationSourceOpen(db, ref, now) {
  if (ref.kind === "task") return Boolean(db.prepare("SELECT 1 FROM tasks WHERE id=? AND status='open' AND archived_at IS NULL AND remind_native=1 AND (notification_policy IS NULL OR notification_policy <> 'none')").get(ref.id));
  if (ref.kind !== "suggestion") return false;
  const stores = db.prepare("SELECT state_json FROM cove_quiet_current").all();
  const suggestion = stores.flatMap(s => JSON.parse(s.state_json).suggestions ?? []).find(s => s.id === ref.id);
  return Boolean(suggestion && ["proposed", "refined", "deferred"].includes(suggestion.state) && Date.parse(suggestion.expiresAt) > +now);
}
function state(db, key) { const row = db.prepare('SELECT value, updated_at FROM cove_follow_through_state WHERE key = ?').get(key); return row ? { ...JSON.parse(row.value), updatedAt: row.updated_at } : null; }
function put(db, key, value, now) { db.prepare('INSERT INTO cove_follow_through_state VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(value), now.toISOString()); }
function localParts(now, timezone) {
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' }).formatToParts(now).map((p) => [p.type,p.value]));
 return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function previousDate(date) { return new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0,10); }
function noticeId(kind, id, due, stage) { return createHash('sha256').update(JSON.stringify([kind,id,due,stage])).digest('hex'); }
function safeTitle(value) { return (
    cleanAttentionText(sanitizeAttentionContent(String(value))).slice(0,140) || 'Open Cove to review'
  ); }


export function followThroughStatus(db, now = new Date()) {
 const heartbeat = state(db,'heartbeat'); const calendar = state(db,'calendar');
 const cutoff = new Date(now-86400000).toISOString();
 const unresolved = Number(db.prepare(`SELECT COUNT(*) FROM cove_follow_through_notices WHERE ${NEEDS_ATTENTION}`).pluck().get());
 const held = Number(db.prepare(`SELECT COUNT(*) FROM cove_follow_through_notices WHERE updated_at > ? AND status='pending' AND error=? AND NOT ${NEEDS_ATTENTION}`).pluck().get(cutoff,POLICY_HOLD));
 return { protection: unresolved ? 'attention_required' : 'current', unresolved, lastCheckedAt: heartbeat?.updatedAt ?? null, healthy: Boolean(heartbeat && now - new Date(heartbeat.updatedAt) < 5*MINUTE),
  held,
  calendar: { status: calendar?.status ?? 'not_checked', checkedAt: calendar?.updatedAt ?? null, fresh: Boolean(calendar?.status === 'ready' && now - new Date(calendar.updatedAt) < 10*MINUTE) },
  notices: db.prepare(`SELECT id, title, ref_kind AS refKind, ref_id AS refId, stage, due_at AS dueAt, status, snoozed_until AS snoozedUntil, error,
   ${NEEDS_ATTENTION} AS needsAttention
   FROM cove_follow_through_notices WHERE ${NEEDS_ATTENTION}
   OR id IN (SELECT id FROM cove_follow_through_notices WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20)
   ORDER BY needsAttention DESC, updated_at DESC`).all(new Date(now-7*86400000).toISOString()) };
}
export function snoozeFollowThrough(db, id, now = new Date()) {
 // Snoozing dismisses this advance warning for one hour; completion and meeting
 // cancellation are re-read before any later delivery.
 return (
    db.prepare("UPDATE cove_follow_through_notices SET status='pending', snoozed_until=?, updated_at=? WHERE id=? AND status IN ('pending','delivered','uncertain','failed')").run(new Date(+now+60*MINUTE).toISOString(),now.toISOString(),id).changes === 1
  );
}

export function acknowledgeFollowThrough(db,id,now=new Date()) {
 return (
    db.prepare("UPDATE cove_follow_through_notices SET status='acknowledged',error=NULL,updated_at=? WHERE id=? AND status <> 'sending'").run(now.toISOString(),id).changes===1
  );
}

export async function runFollowThrough({ db, now = new Date(), timezone, calendar, notify }) {
 const nowIso = now.toISOString(); const local = localParts(now,timezone);
 // Historical notices lack their original timezone. Never reclassify a
 // genuine miss using today's timezone; quiet-hour eligibility is checked
 // before creating new candidates below.
 db.prepare("UPDATE cove_follow_through_notices SET status='uncertain', error='Delivery was interrupted. Review this item in Cove.' WHERE status='sending' AND updated_at < ?").run(new Date(now-5*MINUTE).toISOString());
 const poll = db.transaction(() => {
  const current = state(db,'calendar');
  if (current && now-new Date(current.updatedAt) < 5*MINUTE) return false;
  put(db,'calendar',{ status:'checking', events:current?.events ?? [], timezone:current?.timezone ?? timezone },now); return true;
 }).immediate();
 if (poll) {
  try {
   const source = await calendar();
   if (!source) put(db,'calendar',{status:'not_connected',events:[]},now);
   else {
    const events = await source.listEvents({ timeMin:nowIso,timeMax:new Date(+now+ 7 * 86400000).toISOString(),timeZone:timezone,maxResults:250 });
        // Refresh only planning records already linked to this calendar. Missing
        // events in a bounded list remain unknown, never implicitly cancelled.
        if (
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name='cove_calendar_occurrences'",
            )
            .get()
        ) {
          for (const event of events) {
            const rows = db
              .prepare(
                "SELECT * FROM cove_calendar_occurrences WHERE provider=? AND calendar_id=? AND event_id=?",
              )
              .all(
                event.provider ?? "google",
                event.calendarId ?? "primary",
                event.id,
              );
            for (const previous of rows) {
              const content = JSON.stringify(event);
              db.prepare(
                "UPDATE cove_calendar_occurrences SET title=?,start_at=?,end_at=?,status=?,source_json=?,updated_at=CASE WHEN source_json<>? THEN ? ELSE updated_at END,observed_at=? WHERE id=?",
              ).run(
                event.summary || previous.title,
                event.start || previous.start_at,
                event.end || previous.end_at,
                event.status,
                content,
                content,
                nowIso,
                nowIso,
                previous.id,
              );
            }
          }
        }
        // Exclude cancelled, declined and all-day events. Never retain descriptions
        // or attendee identities merely to schedule a meeting banner.
        put(db,'calendar',{status:'ready',timezone,events:events.filter(
                (e) => e.status !== 'cancelled' && !e.attendees?.some(
                    (a) =>a.self && a.responseStatus==='declined') && e.start?.includes('T')).slice(0,250).map((e) =>({id:e.id,start:e.start,title:safeTitle(e.summary)}))},now);
   }
  } catch (error) {
    const prior = state(db,'calendar');
    const disconnected = error?.code === 'not_configured';
    put(db,'calendar',{status:disconnected ? 'not_connected' : 'unavailable',events:disconnected ? [] : prior?.events ?? [],timezone},now);
  }
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
 // Accepted promises and waiting-on commitments also need deterministic
 // coverage; they need not first be copied into the task board.
 for(const commitment of db.prepare("SELECT id,title,due_at FROM commitments WHERE status='open' AND confirmed=1 AND kind<>'idea' AND due_at IS NOT NULL").all()) {
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(commitment.due_at);const due=Date.parse(commitment.due_at);if(!Number.isFinite(due))continue;
  let stage;
  if(dateOnly?local.date===previousDate(commitment.due_at)&&local.hour>=15:+now>=due-60*MINUTE&&+now<due)stage='advance';
  if(dateOnly?local.date>commitment.due_at:+now>=due)stage=`overdue:${local.date}`;
  if(stage)candidates.push({kind:'commitment',ref:commitment.id,due:commitment.due_at,stage,title:safeTitle(commitment.title)});
 }
 const cached=state(db,'calendar');
 if (cached?.status==='ready' && now-new Date(cached.updatedAt)<10*MINUTE) for (const event of cached.events) {
  const until=Date.parse(event.start)-now;
  if (event.id && until>0 && until<=15*MINUTE) candidates.push({kind:'meeting',ref:event.id,due:event.start,stage:'meeting',title:event.title});
 }
  // A recorded preparation check survives model outage. It reports the last
  // known state and respects the same attention policy as calendar reminders.
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='cove_calendar_occurrences'",
      )
      .get()
  ) {
    for (const row of db
      .prepare(
        `SELECT r.ref_kind,r.ref_id,r.next_action,r.state,r.next_check_at,e.event_id,e.status AS event_status,e.start_at,e.observed_at
   FROM cove_responsibilities r JOIN cove_calendar_occurrences e ON r.parent_kind='calendar' AND r.parent_id=e.id
   WHERE r.state<>'resolved' AND r.next_check_at<=? AND e.status<>'cancelled' ORDER BY r.next_check_at LIMIT 100`,
      )
      .all(nowIso)) {
      if (!preparationSourceOpen(db, {kind:row.ref_kind,id:row.ref_id}, now)) continue;
      const fresh = Date.parse(row.observed_at) > +now - 10 * MINUTE;
      candidates.push({
        kind: "meeting",
        ref: row.event_id,
        due: row.next_check_at,
        stage: "preparation",
        title: safeTitle(row.next_action),
        preparationRef: { kind: row.ref_kind, id: row.ref_id },
        message: `Preparation check: ${safeTitle(row.next_action)}. Last known state: ${row.state}.${fresh ? "" : " Cove could not verify the current calendar state."} ${Date.parse(row.start_at) <= +now ? "The recorded preparation window has passed; review the next useful step." : "Review what is ready before the call."}`,
      });
    }
  }
  // Prioritize meetings and approaching deadlines before the overdue backlog.
  const priority = (candidate) => candidate.kind === 'meeting' ? 0 : candidate.stage === 'advance' ? 1 : 2;
 candidates.sort((a,b)=>priority(a)-priority(b) || Date.parse(a.due)-Date.parse(b.due));
 for (const candidate of candidates) {
  const id=noticeId(candidate.kind,candidate.ref,candidate.due,candidate.stage);
  if (local.hour<8 || local.hour>=18) continue;
  db.prepare("INSERT OR IGNORE INTO cove_follow_through_notices(id,ref_kind,ref_id,title,stage,due_at,status,updated_at) VALUES(?,?,?,?,?,?,'pending',?)").run(id,candidate.kind,candidate.ref,candidate.title,candidate.stage,candidate.due,nowIso);
  const claim=db.transaction(()=>{
   const row=db.prepare('SELECT * FROM cove_follow_through_notices WHERE id=?').get(id);
   if (!row || row.status!=='pending' || (row.snoozed_until && Date.parse(row.snoozed_until)>+now) || row.attempts>=3 || (row.attempts && now-new Date(row.updated_at)<5*MINUTE)) return null;
   if (candidate.kind==='task' && !db.prepare("SELECT 1 FROM tasks WHERE id=? AND status='open' AND archived_at IS NULL AND due_at=? AND remind_native=1 AND (? <> 'advance' OR remind_at IS NULL OR remind_at = '') AND (notification_policy IS NULL OR notification_policy IN ('both', ?)) AND (engaged_at IS NULL OR julianday(engaged_at) <= julianday(?))").get(candidate.ref,candidate.due,candidate.stage,candidate.stage==='advance'?'predeadline':'due',new Date(now-60*MINUTE).toISOString())) return null;
   if(candidate.preparationRef && !preparationSourceOpen(db,candidate.preparationRef,now)) return null;
   if(candidate.preparationRef &&
          !db
            .prepare(
              "SELECT 1 FROM cove_responsibilities r JOIN cove_calendar_occurrences e ON r.parent_id=e.id AND r.parent_kind='calendar' WHERE r.ref_kind=? AND r.ref_id=? AND r.state<>'resolved' AND r.next_check_at=? AND e.status<>'cancelled'",
            )
            .get(
              candidate.preparationRef.kind,
              candidate.preparationRef.id,
              candidate.due,
            )) return null;
   if(candidate.kind==='commitment'&&!db.prepare("SELECT 1 FROM commitments WHERE id=? AND status='open' AND confirmed=1 AND kind<>'idea' AND due_at=?").get(candidate.ref,candidate.due))return null;
   if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='cove_responsibilities' AND type='table'").get() && db.prepare("SELECT 1 FROM cove_responsibilities WHERE ref_kind=? AND ref_id=? AND acknowledged_at>?").get(candidate.kind,candidate.ref,new Date(+now-60*MINUTE).toISOString())) return null;
   const allocation=allocateAttention(db,{kind:'chief_of_staff',refKind:candidate.kind,refId:row.snoozed_until ? `${candidate.ref}:snooze:${row.snoozed_until}` : candidate.kind==='meeting'?`${candidate.ref}:${candidate.due}`:candidate.ref,requestedLevel:'banner',deadlineReminder:candidate.stage==='advance',reason:'Scheduled follow-through',now});
   if (!allocation.row || allocation.finalLevel!=='banner') {
    db.prepare("UPDATE cove_follow_through_notices SET error=CASE WHEN attempts=0 THEN ? ELSE error END WHERE id=?").run(POLICY_HOLD,id);
    return null;
   }
   db.prepare("UPDATE cove_follow_through_notices SET status='sending', attempts=attempts+1, updated_at=? WHERE id=?").run(nowIso,id);
   return allocation.row.id;
  }).immediate();
  if (!claim) continue;
  // Explain the trigger from known schedule data, without another model call.
  const minutes = Math.ceil((Date.parse(candidate.due)-now)/MINUTE);
  const dueSoon = /^\d{4}-\d{2}-\d{2}$/.test(candidate.due)
   ? 'Due tomorrow' : `Due in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const message=candidate.message ??
      (candidate.kind==='meeting'
   ? `Your meeting starts in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}: ${candidate.title}. Take a moment to prep.`
   : candidate.stage==='advance'
    ? `${dueSoon}: ${candidate.title}. Make time for the next step.`
    : `Past due and still open in Cove: ${candidate.title}. Check what needs to happen next.`);
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
   db.prepare("UPDATE cove_follow_through_notices SET status=?,error=?,updated_at=? WHERE id=?").run(certainFailure ? db.prepare('SELECT attempts FROM cove_follow_through_notices WHERE id=?').get(id).attempts>=3?'failed':'pending'
          : 'uncertain', certainFailure?'Native notification failed before delivery':'Delivery could not be confirmed. Review this item in Cove.',nowIso,id);
   if (certainFailure) finalizeAttentionDelivery(db,{id:claim,level:'suppressed',suppressedReason:'delivery_failed',now});
  }
 }
 // Obsolete pending notices are historical evidence, not actionable UI work.
 const active = new Set(candidates.map((c) =>noticeId(c.kind,c.ref,c.due,c.stage)));
 for (const row of db.prepare("SELECT id,ref_kind,due_at FROM cove_follow_through_notices WHERE status='pending'").all()) if (!active.has(row.id)) {
  // Unavailable calendar data does not prove a meeting was cancelled. Retain
  // its pending reminder until fresh evidence or the recorded start time.
  if (row.ref_kind==='meeting' && Date.parse(row.due_at)>+now && cached?.status!=='ready') continue;
  const missed=row.ref_kind==='meeting' && Date.parse(row.due_at)<=+now;
  db.prepare("UPDATE cove_follow_through_notices SET status=?,error=?,updated_at=? WHERE id=?").run(missed?'missed':'expired',missed?'Meeting reminder was not delivered before its start.':null,nowIso,row.id);
 }
 put(db,'heartbeat',{status:'ready'},now);
 return followThroughStatus(db,now);
}
