import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allocateAttention,
  attentionCooldown,
  dailyAttentionUsage,
  finalizeAttentionDelivery,
} from "../src/lib/attention/ledger.mjs";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-attention-ledger-"));
  const db = new Database(path.join(dir, "cove.db"));
  runLocalMigrations(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test("global caps span judgment kinds and preserve the floor text slot", (t) => {
  const db = fixture(t);
  const now = new Date("2026-08-06T10:00:00-07:00");
  const allocate = (kind, refId, requestedLevel = "text") => allocateAttention(db, {
    kind,
    refKind: kind === "urgent_email" ? "email" : "task",
    refId,
    requestedLevel,
    reason: "Test attention decision.",
    now,
  });

  assert.equal(allocate("sweep_nudge", "sweep-1").finalLevel, "text");
  assert.equal(allocate("urgent_email", "email-1").finalLevel, "text");
  const reserved = allocate("sweep_nudge", "sweep-2");
  assert.equal(reserved.finalLevel, "banner");
  assert.equal(reserved.suppressionRows[0].suppressedReason, "reserved_floor_text_slot");
  assert.equal(allocate("floor_nudge", "floor-1").finalLevel, "text");

  allocate("urgent_email", "email-2", "banner");
  allocate("sweep_nudge", "sweep-3", "banner");
  const exhausted = allocate("urgent_email", "email-3", "banner");
  assert.equal(exhausted.row, null);
  assert.equal(exhausted.suppressionRows.at(-1).suppressedReason, "daily_banner_cap");
  assert.equal(allocate("urgent_email", "email-3", "banner").suppressionRows.length, 0);
  assert.deepEqual(dailyAttentionUsage(db, now), {
    texts: 3,
    banners: 6,
    modelTexts: 2,
    floorTexts: 1,
  });
  assert.ok(db.prepare(
    "SELECT 1 FROM cove_attention_ledger WHERE level = 'suppressed' AND suppressed_reason = 'daily_banner_cap'",
  ).get());
  assert.equal(db.prepare(
    "SELECT COUNT(*) FROM cove_attention_ledger WHERE ref_id = 'email-3' AND level = 'suppressed'",
  ).pluck().get(), 1);
});

test("transport finalization downgrades reservations and releases failed budget", (t) => {
  const db = fixture(t);
  const now = new Date("2026-08-06T10:00:00-07:00");
  const boardOnly = allocateAttention(db, {
    kind: "urgent_email",
    refKind: "email",
    refId: "board-fallback",
    requestedLevel: "text",
    reason: "Transport fallback fixture.",
    now,
  });
  finalizeAttentionDelivery(db, {
    id: boardOnly.row.id,
    level: "board",
    now,
  });
  assert.deepEqual(dailyAttentionUsage(db, now), {
    texts: 0,
    banners: 0,
    modelTexts: 0,
    floorTexts: 0,
  });

  const failed = allocateAttention(db, {
    kind: "sweep_nudge",
    refKind: "task",
    refId: "failed-everywhere",
    requestedLevel: "text",
    reason: "All transports fail.",
    now,
  });
  finalizeAttentionDelivery(db, {
    id: failed.row.id,
    level: "suppressed",
    suppressedReason: "delivery_failed",
    now,
  });
  assert.deepEqual(dailyAttentionUsage(db, now), {
    texts: 0,
    banners: 0,
    modelTexts: 0,
    floorTexts: 0,
  });
  assert.deepEqual(db.prepare(
    "SELECT level, delivered_at, suppressed_reason FROM cove_attention_ledger WHERE id = ?",
  ).get(failed.row.id), {
    level: "suppressed",
    delivered_at: null,
    suppressed_reason: "delivery_failed",
  });
});

test("same-ref cooldown backs off from 24 hours to 48 hours to weekly", (t) => {
  const db = fixture(t);
  const base = new Date("2026-08-01T12:00:00-07:00");
  const at = (hours) => new Date(base.getTime() + hours * 60 * 60 * 1_000);
  const nudge = (now) => allocateAttention(db, {
    kind: "floor_nudge",
    refKind: "task",
    refId: "chronic-task",
    requestedLevel: "board",
    reason: "Still overdue.",
    now,
  });

  assert.equal(nudge(at(0)).finalLevel, "board");
  assert.equal(nudge(at(23)).finalLevel, "suppressed");
  assert.equal(nudge(at(24)).finalLevel, "board");
  assert.equal(nudge(at(71)).finalLevel, "suppressed");
  assert.equal(nudge(at(72)).finalLevel, "board");
  assert.equal(nudge(at(72 + 24 * 6)).finalLevel, "suppressed");
  assert.equal(nudge(at(72 + 24 * 7)).finalLevel, "board");
  assert.equal(attentionCooldown(db, {
    refKind: "task",
    refId: "chronic-task",
    now: at(72 + 24 * 7),
  }).priorNudges, 4);
});

test("a shadow row never suppresses a real nudge for the same item", (t) => {
  const db = fixture(t);
  // The sweep logs task-1 in shadow at 11:30; the live floor must still nudge
  // it at noon. A shadow row interrupted nobody, so it cannot spend a cooldown.
  allocateAttention(db, {
    kind: "sweep_nudge",
    refKind: "task",
    refId: "task-1",
    requestedLevel: "text",
    reason: "Shadow observation.",
    shadow: true,
    now: new Date("2026-08-06T11:30:00-07:00"),
  });
  const floor = allocateAttention(db, {
    kind: "floor_nudge",
    refKind: "task",
    refId: "task-1",
    requestedLevel: "banner",
    maximumLevel: "banner",
    reason: "Due today, not done: Ship the newsletter.",
    now: new Date("2026-08-06T12:00:00-07:00"),
  });
  assert.equal(floor.finalLevel, "banner");
  assert.equal(floor.suppressionRows.length, 0);

  // A second shadow observation of the same item still backs off.
  const repeat = allocateAttention(db, {
    kind: "sweep_nudge",
    refKind: "task",
    refId: "task-1",
    requestedLevel: "banner",
    reason: "Shadow observation again.",
    shadow: true,
    now: new Date("2026-08-06T16:00:00-07:00"),
  });
  assert.equal(repeat.finalLevel, "suppressed");
});

test("the floor spends at most one text a day no matter how many items come due", (t) => {
  const db = fixture(t);
  const allocateFloor = (refId, hours) => allocateAttention(db, {
    kind: "floor_nudge",
    refKind: "task",
    refId,
    requestedLevel: "text",
    reason: "Due today, not done.",
    now: new Date(`2026-08-06T${hours}:00:00-07:00`),
  });
  assert.equal(allocateFloor("__floor_daily__:2026-08-06", "12").finalLevel, "text");
  const second = allocateFloor("__floor_daily__:2026-08-06-retry", "13");
  assert.equal(second.finalLevel, "banner");
  assert.equal(second.suppressionRows[0].suppressedReason, "daily_floor_text_cap");
  assert.equal(dailyAttentionUsage(db, new Date("2026-08-06T14:00:00-07:00")).floorTexts, 1);
});

test("model lanes stop one short so the floor text survives a busy morning", (t) => {
  const db = fixture(t);
  const morning = new Date("2026-08-06T09:00:00-07:00");
  const attempts = [];
  for (let index = 0; index < 6; index += 1) {
    attempts.push(allocateAttention(db, {
      kind: "sweep_nudge",
      refKind: "task",
      refId: `morning-${index}`,
      requestedLevel: "banner",
      reason: "Morning ranking.",
      now: morning,
    }).finalLevel);
  }
  // Five get through; the sixth is held back to protect the reserved slot.
  assert.deepEqual(attempts, [
    "banner", "banner", "banner", "banner", "banner", "suppressed",
  ]);
  const floor = allocateAttention(db, {
    kind: "floor_nudge",
    refKind: "task",
    refId: "__floor_daily__:2026-08-06",
    requestedLevel: "text",
    maximumLevel: "text",
    reason: "Due today, not done: 2 of your own items.",
    now: new Date("2026-08-06T12:00:00-07:00"),
  });
  assert.equal(floor.finalLevel, "text");
});
