/**
 * Shared allocation ledger for every Cove attention lane.
 *
 * Daily caps, cooldowns, shadow observations, and the reserved deterministic
 * floor slot are enforced here so independent scripts cannot overspend the same
 * notification budget. Shadow rows are evidence only and never suppress a live
 * alert.
 */
import { randomUUID } from "node:crypto";

export const ATTENTION_LIMITS = Object.freeze({
  textsPerDay: 3,
  bannersPerDay: 6,
  modelTextsPerDay: 2,
  floorTextsPerDay: 1,
});

const DELIVERED_LEVELS = ["text", "banner", "board"];
const SHADOW_AWARE_LEVELS = [...DELIVERED_LEVELS, "shadow"];
const LEVEL_RANK = Object.freeze({ board: 0, banner: 1, text: 2 });

function localDayBounds(now) {
  // Attention quotas currently reset on the Mac's local day, unlike product
  // scheduling, which uses the operator profile's IANA timezone. Supported
  // single-Mac installs normally align those zones; keep this distinction
  // explicit if remote-host operation returns.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function insertRow(db, input) {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO cove_attention_ledger
       (id, kind, ref_kind, ref_id, level, reason, delivered_at,
        suppressed_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.refKind,
    input.refId,
    input.level,
    String(input.reason || "Cove attention decision.").slice(0, 2_000),
    input.deliveredAt ?? null,
    input.suppressedReason ?? null,
    input.createdAt,
  );
  return {
    id,
    kind: input.kind,
    refKind: input.refKind,
    refId: input.refId,
    level: input.level,
    reason: input.reason,
    deliveredAt: input.deliveredAt ?? null,
    suppressedReason: input.suppressedReason ?? null,
    createdAt: input.createdAt,
  };
}

function insertSuppressionOnce(db, input) {
  const since = new Date(Date.parse(input.createdAt) - 24 * 60 * 60 * 1_000)
    .toISOString();
  const existing = db.prepare(
    `SELECT 1 FROM cove_attention_ledger
      WHERE kind = ? AND ref_kind = ? AND ref_id = ?
        AND level = 'suppressed' AND suppressed_reason = ?
        AND created_at >= ?
      LIMIT 1`,
  ).get(
    input.kind,
    input.refKind,
    input.refId,
    input.suppressedReason,
    since,
  );
  return existing ? null : insertRow(db, input);
}

function appendSuppression(rows, db, input) {
  const row = insertSuppressionOnce(db, input);
  if (row) rows.push(row);
}

export function attentionCooldown(db, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now);
  // A shadow row never interrupted anyone, so it must never hold off a real
  // nudge. A shadow request still counts earlier shadow rows, so the sweep does
  // not log the same ref twice in one window.
  const levels = input.shadow === true ? SHADOW_AWARE_LEVELS : DELIVERED_LEVELS;
  const rows = db.prepare(
    `SELECT level, COALESCE(delivered_at, created_at) AS occurred_at
       FROM cove_attention_ledger
      WHERE ref_kind = ? AND ref_id = ?
        AND level IN (${levels.map(() => "?").join(",")})
      ORDER BY COALESCE(delivered_at, created_at) DESC, created_at DESC`,
  ).all(input.refKind, input.refId, ...levels);
  if (rows.length === 0) {
    return { allowed: true, priorNudges: 0, nextAllowedAt: null };
  }
  const delayMs = rows.length === 1
    ? 24 * 60 * 60 * 1_000
    : rows.length === 2
      ? 48 * 60 * 60 * 1_000
      : 7 * 24 * 60 * 60 * 1_000;
  const nextAllowedAt = new Date(Date.parse(rows[0].occurred_at) + delayMs);
  return {
    allowed: nextAllowedAt.getTime() <= now.getTime(),
    priorNudges: rows.length,
    nextAllowedAt: nextAllowedAt.toISOString(),
  };
}

export function dailyAttentionUsage(db, now = new Date()) {
  const { start, end } = localDayBounds(now);
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN level = 'text' THEN 1 ELSE 0 END) AS texts,
       SUM(CASE WHEN level IN ('text','banner') THEN 1 ELSE 0 END) AS banners,
       SUM(CASE WHEN level = 'text' AND kind <> 'floor_nudge' THEN 1 ELSE 0 END)
         AS model_texts,
       SUM(CASE WHEN level = 'text' AND kind = 'floor_nudge' THEN 1 ELSE 0 END)
         AS floor_texts
     FROM cove_attention_ledger
     WHERE delivered_at >= ? AND delivered_at < ?`,
  ).get(start, end);
  return {
    texts: Number(row?.texts ?? 0),
    banners: Number(row?.banners ?? 0),
    modelTexts: Number(row?.model_texts ?? 0),
    floorTexts: Number(row?.floor_texts ?? 0),
  };
}

// Texts also consume banner capacity. Preserve two of the six slots for
// approaching deadlines, meetings or urgent email, plus one floor slot until the floor has run.
function bannerCapFor(kind, floorDelivered, refKind, deadlineReminder = false) {
  // Keep the final slot for meetings/urgent mail. An approaching deadline can
  // use the penultimate slot even after routine reminders and the floor.
  // This reserves capacity; it does not increase the person's interruption cap.
  if (refKind === "meeting" || kind === "urgent_email") return ATTENTION_LIMITS.bannersPerDay;
  if (kind === "chief_of_staff" && deadlineReminder && ["task", "commitment"].includes(refKind)) return ATTENTION_LIMITS.bannersPerDay - (floorDelivered ? 1 : 2);
  if (kind === "floor_nudge" && !floorDelivered) return ATTENTION_LIMITS.bannersPerDay - 1;
  if (kind === "floor_nudge" || floorDelivered) {
    return ATTENTION_LIMITS.bannersPerDay - 2;
  }
  return ATTENTION_LIMITS.bannersPerDay - 3;
}

// Reserve known meeting reminders before optional work spends today's slots.
// This reads the last observed calendar even during a refresh/outage: unknown
// availability is not evidence that a previously known meeting was cancelled.
function upcomingMeetingSlots(db, now) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cove_follow_through_state' AND type='table'").get()) return 0;
  const row = db.prepare("SELECT value FROM cove_follow_through_state WHERE key='calendar'").get();
  let calendar;
  try { calendar = JSON.parse(row?.value ?? '{}'); } catch { return 0; }
  if (calendar.status === 'not_connected' || !Array.isArray(calendar.events)) return 0;
  const { start, end } = localDayBounds(now);
  const completed = new Set();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='cove_follow_through_notices' AND type='table'").get()) {
    for (const notice of db.prepare("SELECT ref_id,due_at FROM cove_follow_through_notices WHERE ref_kind='meeting' AND stage='meeting' AND status IN ('sending','delivered','uncertain','acknowledged','missed','failed') AND julianday(due_at)>=julianday(?) AND julianday(due_at)<julianday(?)").all(start,end)) {
      completed.add(`${notice.ref_id}:${Date.parse(notice.due_at)}`);
    }
  }
  const reserved = new Set();
  let clock;
  try { clock = new Intl.DateTimeFormat('en-US', { timeZone: calendar.timezone, hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  for (const event of calendar.events) {
    if (!event?.id || typeof event.start !== 'string' || !event.start.includes('T') || event.status === 'cancelled' || event.attendees?.some(a => a.self && a.responseStatus === 'declined')) continue;
    const at = Date.parse(event.start);
    const key = `${event.id}:${at}`;
    if (!Number.isFinite(at) || at <= +now || at < Date.parse(start) || at >= Date.parse(end) || completed.has(key)) continue;
    // Reserve when the 15-minute reminder window intersects delivery hours.
    // An 18:05 meeting can alert at 17:50; an 08:00 meeting has no eligible
    // pre-start minute after quiet hours end.
    const parts = Object.fromEntries(clock.formatToParts(new Date(at)).map(part => [part.type, part.value]));
    const startMinute = Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60;
    if (startMinute <= 8 * 60 || startMinute >= 18 * 60 + 15) continue;
    reserved.add(key);
  }
  return Math.min(ATTENTION_LIMITS.bannersPerDay, reserved.size);
}

function boundedLevel(requestedLevel, maximumLevel) {
  if (!(requestedLevel in LEVEL_RANK) || !(maximumLevel in LEVEL_RANK)) {
    throw new Error("attention_level_invalid");
  }
  return LEVEL_RANK[requestedLevel] <= LEVEL_RANK[maximumLevel]
    ? requestedLevel
    : maximumLevel;
}

export function allocateAttention(db, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("attention_now_invalid");
  const createdAt = now.toISOString();
  return db.transaction(() => {
    const suppressionRows = [];
    const cooldown = attentionCooldown(db, {
      refKind: input.refKind,
      refId: input.refId,
      shadow: input.shadow === true,
      now,
    });
    const acknowledged = db.prepare("SELECT 1 FROM sqlite_master WHERE name='cove_responsibilities' AND type='table'").get() && db.prepare("SELECT 1 FROM cove_responsibilities WHERE ref_kind=? AND ref_id=? AND acknowledged_at>?").get(input.refKind,input.refId,new Date(+now-3600000).toISOString());
    if (acknowledged) {
      appendSuppression(suppressionRows,db,{kind:input.kind,refKind:input.refKind,refId:input.refId,level:'suppressed',reason:input.reason,suppressedReason:'acknowledged_for_one_hour',createdAt});
      return {row:null,suppressionRows,cooldown,finalLevel:'suppressed'};
    }
    if (!cooldown.allowed) {
      appendSuppression(suppressionRows, db, {
        kind: input.kind,
        refKind: input.refKind,
        refId: input.refId,
        level: "suppressed",
        reason: input.reason,
        suppressedReason: `cooldown_until:${cooldown.nextAllowedAt}`,
        createdAt,
      });
      return { row: null, suppressionRows, cooldown, finalLevel: "suppressed" };
    }

    if (input.shadow === true) {
      const row = insertRow(db, {
        kind: input.kind,
        refKind: input.refKind,
        refId: input.refId,
        level: "shadow",
        reason: input.reason,
        createdAt,
      });
      return { row, suppressionRows, cooldown, finalLevel: "shadow" };
    }

    let finalLevel = boundedLevel(
      input.requestedLevel,
      input.maximumLevel ?? input.requestedLevel,
    );
    let usage = dailyAttentionUsage(db, now);
    const { start, end } = localDayBounds(now);
    // A fallback native banner also satisfies the floor reservation. Keep that
    // slot available if an advance warning is delivered earlier in the day.
    const floorDelivered = Boolean(db.prepare(
      "SELECT 1 FROM cove_attention_ledger WHERE kind='floor_nudge' AND level IN ('text','banner') AND delivered_at >= ? AND delivered_at < ? LIMIT 1",
    ).get(start, end));

    const reservedMeetings = input.refKind === "meeting" || input.kind === "urgent_email"
      ? 0 : upcomingMeetingSlots(db, now);
    const bannerCap = Math.min(
      bannerCapFor(input.kind, floorDelivered, input.refKind, input.deadlineReminder === true),
      ATTENTION_LIMITS.bannersPerDay - reservedMeetings,
    );
    const bannerSuppression = reservedMeetings > 0 && usage.banners >= ATTENTION_LIMITS.bannersPerDay - reservedMeetings
      ? "reserved_upcoming_meetings" : "daily_banner_cap";

    if (finalLevel === "text") {
      const modelTextBlocked = input.kind !== "floor_nudge" &&
        usage.modelTexts >= ATTENTION_LIMITS.modelTextsPerDay;
      // The floor batches its day into one text, so it can never spend more
      // than its reserved slot no matter how many items come due.
      const floorTextBlocked = input.kind === "floor_nudge" &&
        usage.floorTexts >= ATTENTION_LIMITS.floorTextsPerDay;
      const bannerBlocked = usage.banners >= bannerCap;
      if (
        usage.texts >= ATTENTION_LIMITS.textsPerDay ||
        bannerBlocked ||
        modelTextBlocked ||
        floorTextBlocked
      ) {
        const suppressedReason = bannerBlocked
          ? bannerSuppression
          : modelTextBlocked
            ? "reserved_floor_text_slot"
            : floorTextBlocked
              ? "daily_floor_text_cap"
              : usage.texts >= ATTENTION_LIMITS.textsPerDay
                ? "daily_text_cap"
                : "attention_cap";
        appendSuppression(suppressionRows, db, {
          kind: input.kind,
          refKind: input.refKind,
          refId: input.refId,
          level: "suppressed",
          reason: input.reason,
          suppressedReason,
          createdAt,
        });
        if (bannerBlocked) {
          return { row: null, suppressionRows, cooldown, finalLevel: "suppressed" };
        }
        finalLevel = "banner";
        usage = dailyAttentionUsage(db, now);
      }
    }

    if (finalLevel === "banner" && usage.banners >= bannerCap) {
      appendSuppression(suppressionRows, db, {
        kind: input.kind,
        refKind: input.refKind,
        refId: input.refId,
        level: "suppressed",
        reason: input.reason,
        suppressedReason: bannerSuppression,
        createdAt,
      });
      return { row: null, suppressionRows, cooldown, finalLevel: "suppressed" };
    }

    const row = insertRow(db, {
      kind: input.kind,
      refKind: input.refKind,
      refId: input.refId,
      level: finalLevel,
      reason: input.reason,
      deliveredAt: createdAt,
      createdAt,
    });
    return { row, suppressionRows, cooldown, finalLevel };
  }).immediate();
}

export function finalizeAttentionDelivery(db, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("attention_now_invalid");
  const level = input.level;
  if (!["text", "banner", "board", "shadow", "suppressed"].includes(level)) {
    throw new Error("attention_level_invalid");
  }
  if (level === "suppressed" && !String(input.suppressedReason ?? "").trim()) {
    throw new Error("attention_suppressed_reason_required");
  }
  const result = db.prepare(
    `UPDATE cove_attention_ledger
        SET level = ?, delivered_at = ?, suppressed_reason = ?
      WHERE id = ?`,
  ).run(
    level,
    ["text", "banner", "board"].includes(level) ? now.toISOString() : null,
    level === "suppressed" ? String(input.suppressedReason).slice(0, 500) : null,
    input.id,
  );
  if (result.changes !== 1) throw new Error("attention_ledger_row_missing");
}

export function recordSweepRun(db, input) {
  const now = input.now instanceof Date ? input.now : new Date(input.now ?? Date.now());
  const createdAt = now.toISOString();
  const row = insertRow(db, {
    kind: "sweep_nudge",
    refKind: "task",
    refId: "__sweep_run__",
    level: input.failed ? "suppressed" : "shadow",
    reason: input.failed ? String(input.reason || "Attention sweep failed.") : "sweep_run_success",
    suppressedReason: input.failed ? "sweep_failure" : null,
    createdAt,
  });
  const recent = db.prepare(
    `SELECT level, reason, suppressed_reason
       FROM cove_attention_ledger
      WHERE kind = 'sweep_nudge' AND ref_id = '__sweep_run__'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 20`,
  ).all();
  let consecutiveFailures = 0;
  for (const entry of recent) {
    if (entry.suppressed_reason !== "sweep_failure") break;
    consecutiveFailures += 1;
  }
  return { row, consecutiveFailures };
}

export function hasAttentionLedger(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'cove_attention_ledger'",
  ).get());
}
