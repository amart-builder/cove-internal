import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyChiefOfStaffActions } from "../src/lib/chief-of-staff/driver.ts";
import { buildChiefOfStaffSnapshot } from "../src/lib/chief-of-staff/snapshot.ts";
import { enqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/storage.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { getQuietCurrentSnapshot } from "../src/lib/quiet-current/store.ts";

function fixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-cos-notify-"));
  const dbPath = path.join(dataDir, "cove.db");
  const db = openLocalDatabase(dbPath);
  db.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, dbPath };
}

function enqueue(dbPath, now, note = "attention test") {
  const db = openLocalDatabase(dbPath);
  try {
    return db.transaction(() => enqueueChiefOfStaffWake(db, {
      reason: "manual",
      note,
      now,
    })).immediate().job;
  } finally {
    db.close();
  }
}

function insertTask(dbPath, input) {
  const now = input.now.toISOString();
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO tasks
         (id, title, status, source_type, position, created_at, updated_at,
          notified_at, nudged_at)
       VALUES (?, ?, ?, 'inbound_event', 0, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.title,
      input.status ?? "open",
      now,
      now,
      input.notifiedAt ?? null,
      input.nudgedAt ?? null,
    );
    db.prepare(
      `INSERT INTO inbound_events
         (id, source, source_id, raw_text, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'fixture', 'triaged', 0, ?, ?)`,
    ).run(input.id, input.source ?? "chat", `source-${input.id}`, now, now);
  } finally {
    db.close();
  }
}

function notifyAction(input) {
  return {
    action_id: input.actionId ?? `notify-${input.refId}`,
    kind: "notify",
    why: input.why ?? `${input.refKind} ${input.refId} needs attention now`,
    ref_kind: input.refKind,
    ref_id: input.refId,
    level: input.level ?? "banner",
    reason: input.reason ?? "It needs attention today.",
  };
}

function insertAttentionRows(dbPath, rows) {
  const db = openLocalDatabase(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO cove_attention_ledger
         (id, kind, ref_kind, ref_id, level, reason, delivered_at,
          suppressed_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.kind ?? "chief_of_staff",
        row.refKind ?? "task",
        row.refId,
        row.level,
        row.reason ?? "Fixture attention decision.",
        row.deliveredAt ?? null,
        row.suppressedReason ?? null,
        row.createdAt,
      );
    }
  } finally {
    db.close();
  }
}

test("notify delivers sanitized task text and finalizes the shared attention ledger", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now);
  insertTask(dbPath, {
    id: "email-task",
    title: "Reply to josh@example.com at https://example.com/private",
    source: "email",
    now,
  });
  const calls = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({ refKind: "task", refId: "email-task" })],
    now,
    attention: {
      shadow: false,
      transport: {
        textConfigured: false,
        banner: (text) => calls.push(["banner", text]),
        text: (text) => calls.push(["text", text]),
      },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 1, rejected: 0, skipped: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "banner");
  assert.doesNotMatch(calls[0][1], /josh@example\.com|https?:\/\/|example\.com/i);
  assert.match(calls[0][1], /^from email:/);

  const db = openLocalDatabase(dbPath);
  try {
    const attention = db.prepare(
      `SELECT id, kind, ref_kind, ref_id, level, delivered_at, suppressed_reason
       FROM cove_attention_ledger WHERE ref_id = 'email-task'`,
    ).get();
    assert.equal(attention.kind, "chief_of_staff");
    assert.equal(attention.ref_kind, "task");
    assert.equal(attention.level, "banner");
    assert.equal(attention.delivered_at, now.toISOString());
    assert.equal(attention.suppressed_reason, null);
    const action = JSON.parse(db.prepare(
      "SELECT payload_json FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).pluck().get(job.id));
    assert.equal(action.attention_ledger_id, attention.id);
  } finally {
    db.close();
  }
});

test("notify ignores an unrelated title and records it in the audit payload", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now);
  insertTask(dbPath, {
    id: "josh-follow-up",
    title: "Follow up with Josh",
    source: "chat",
    now,
  });
  const calls = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [{
      ...notifyAction({ refKind: "task", refId: "josh-follow-up" }),
      title: "Harmless flat-schema title",
    }],
    now,
    attention: {
      shadow: false,
      transport: {
        textConfigured: false,
        banner: (text) => calls.push(text),
        text: () => undefined,
      },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 1, rejected: 0, skipped: 0 });
  assert.equal(calls.length, 1);
  const db = openLocalDatabase(dbPath);
  try {
    const payload = JSON.parse(db.prepare(
      "SELECT payload_json FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).pluck().get(job.id));
    assert.deepEqual(payload.ignored_fields, ["title"]);
    assert.equal(Object.hasOwn(payload, "title"), false);
  } finally {
    db.close();
  }
});

test("notify resolves commitments and open deals by contact id", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now);
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO commitments
         (id, kind, title, source_kind, source_ref, status, confidence,
          confirmed, created_at, updated_at)
       VALUES ('promise-1', 'promise', ?, 'detector', 'gmail:message-1',
               'open', 'high', 1, ?, ?)`,
    ).run("Email dana@example.com via https://example.com", now.toISOString(), now.toISOString());
    db.prepare(
      `INSERT INTO contacts (id, name, created_at, updated_at)
       VALUES ('contact-1', 'Dana Rivera', ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
    db.prepare(
      `INSERT INTO pipeline_deals
         (id, contact_id, stage, next_action, source, stage_changed_at,
          created_at, updated_at)
       VALUES ('deal-1', 'contact-1', 'pitched', ?, 'manual', ?, ?, ?)`,
    ).run(
      "Call +1 310 555 1212 at https://example.com",
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    );
  } finally {
    db.close();
  }
  const calls = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [
      notifyAction({ refKind: "commitment", refId: "promise-1" }),
      notifyAction({ actionId: "notify-deal", refKind: "deal", refId: "contact-1" }),
    ],
    now,
    attention: {
      shadow: false,
      transport: {
        textConfigured: false,
        banner: (text) => calls.push(text),
        text: () => undefined,
      },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 2, rejected: 0, skipped: 0 });
  assert.match(calls[0], /^from email:/);
  assert.doesNotMatch(calls[0], /dana@|https?:\/\//i);
  assert.match(calls[1], /^Follow up with Dana Rivera:/);
  assert.doesNotMatch(calls[1], /310|https?:\/\//i);

  const closedDb = openLocalDatabase(dbPath);
  try {
    closedDb.prepare("UPDATE pipeline_deals SET stage = 'client' WHERE contact_id = 'contact-1'").run();
  } finally {
    closedDb.close();
  }
  const nextJob = enqueue(dbPath, new Date(now.getTime() + 1_000), "closed deal");
  const closed = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: nextJob.id,
    actions: [notifyAction({ actionId: "closed-deal", refKind: "deal", refId: "contact-1" })],
    now: new Date(now.getTime() + 1_000),
    attention: {
      shadow: false,
      transport: { textConfigured: false, banner: () => undefined, text: () => undefined },
    },
  });
  assert.deepEqual(closed, { applied: 0, rejected: 1, skipped: 0 });
});

test("shadow notify records a shadow row, sends nothing, and files Quiet Current", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  writeFileSync(path.join(dataDir, "attention-sweep.json"), '{"shadow":true}\n');
  const job = enqueue(dbPath, now);
  insertTask(dbPath, { id: "shadow-task", title: "Review proposal", now });
  const calls = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({
      refKind: "task",
      refId: "shadow-task",
      level: "text",
      reason: "A decision is due before the meeting.",
    })],
    now,
    attention: {
      transport: {
        textConfigured: true,
        banner: (...args) => calls.push(["banner", ...args]),
        text: (...args) => calls.push(["text", ...args]),
      },
    },
  });
  assert.deepEqual(result, { applied: 1, rejected: 0, skipped: 0 });
  assert.deepEqual(calls, []);
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT level FROM cove_attention_ledger WHERE ref_id = 'shadow-task'",
    ).pluck().get(), "shadow");
  } finally {
    db.close();
  }
  const suggestion = getQuietCurrentSnapshot(dataDir).suggestions.find((item) =>
    item.title.startsWith("Would have interrupted:")
  );
  assert.ok(suggestion);
  assert.equal(suggestion.source, "Cove chief of staff shadow");
});

test("notify strips angle brackets from its reason before Quiet Current", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now);
  insertTask(dbPath, { id: "clean-reason", title: "Review proposal", now });
  const surfaces = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({
      refKind: "task",
      refId: "clean-reason",
      reason: "<Decision> is needed <today>.",
    })],
    now,
    attention: {
      shadow: true,
      transport: { textConfigured: false, banner: () => undefined, text: () => undefined },
      surface: (input) => surfaces.push(input),
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 1, rejected: 0, skipped: 0 });
  assert.equal(surfaces[0].reason, "Decision is needed today.");
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT reason FROM cove_attention_ledger WHERE ref_id = 'clean-reason'",
    ).pluck().get(), "Decision is needed today.");
  } finally {
    db.close();
  }
});

test("a board-only fallback is rejected and reported to the next wake", async (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now, "transport fallback");
  insertTask(dbPath, { id: "board-only", title: "Review the board", now });
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({ refKind: "task", refId: "board-only" })],
    now,
    attention: {
      shadow: false,
      transport: {
        textConfigured: false,
        banner: () => {
          throw new Error("native banner unavailable");
        },
        text: () => undefined,
      },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 0, rejected: 1, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT level FROM cove_attention_ledger WHERE ref_id = 'board-only'",
    ).pluck().get(), "board");
    const action = db.prepare(
      `SELECT error, payload_json FROM chief_of_staff_actions
       WHERE wake_job_id = ?`,
    ).get(job.id);
    assert.equal(action.error, "delivered_board_only:native banner unavailable");
    assert.equal(JSON.parse(action.payload_json).delivered_level, "board");
    db.prepare("UPDATE cove_jobs SET status = 'done', finished_at = ? WHERE id = ?")
      .run(now.toISOString(), job.id);
  } finally {
    db.close();
  }
  const next = enqueue(dbPath, new Date(now.getTime() + 60_000), "read fallback");
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: next.id,
    wake: next.payload,
    session: {
      sessionId: "session",
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 1,
      lastWakeAt: now.toISOString(),
      lastWakeReason: "manual",
    },
    dataDir,
    dbPath,
    now: new Date(now.getTime() + 60_000),
    calendar: null,
  });
  assert.match(snapshot, /notify\): delivered_board_only:native banner unavailable/);
});

test("a seventh banner is suppressed and its rejection reaches the next snapshot", async (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now, "spend the banner budget");
  insertTask(dbPath, { id: "seventh-banner", title: "Final banner candidate", now });
  insertAttentionRows(dbPath, [
    {
      id: "floor-text",
      kind: "floor_nudge",
      refId: "floor-task",
      level: "text",
      deliveredAt: now.toISOString(),
      createdAt: now.toISOString(),
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `banner-${index}`,
      refId: `earlier-${index}`,
      level: "banner",
      deliveredAt: now.toISOString(),
      createdAt: now.toISOString(),
    })),
  ]);
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({ refKind: "task", refId: "seventh-banner" })],
    now,
    attention: {
      shadow: false,
      transport: { textConfigured: false, banner: () => undefined, text: () => undefined },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 0, rejected: 1, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT error FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).pluck().get(job.id), "daily_banner_cap");
    db.prepare("UPDATE cove_jobs SET status = 'done', finished_at = ? WHERE id = ?")
      .run(now.toISOString(), job.id);
  } finally {
    db.close();
  }
  const next = enqueue(dbPath, new Date(now.getTime() + 60_000), "next wake");
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: next.id,
    wake: next.payload,
    session: {
      sessionId: "session",
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 1,
      lastWakeAt: now.toISOString(),
      lastWakeReason: "manual",
    },
    dataDir,
    dbPath,
    now: new Date(now.getTime() + 60_000),
    calendar: null,
  });
  assert.match(snapshot, /notify\): daily_banner_cap/);
});

test("the same ref is rejected on the shared 24 hour cooldown", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  insertTask(dbPath, { id: "cooldown-task", title: "Do not repeat", now });
  const attention = {
    shadow: false,
    transport: { textConfigured: false, banner: () => undefined, text: () => undefined },
    surface: () => undefined,
    surfaceSuppression: () => undefined,
  };
  const first = enqueue(dbPath, now, "first notification");
  assert.equal(applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: first.id,
    actions: [notifyAction({ refKind: "task", refId: "cooldown-task" })],
    now,
    attention,
  }).applied, 1);
  const secondNow = new Date(now.getTime() + 60 * 60 * 1_000);
  const second = enqueue(dbPath, secondNow, "repeat notification");
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: second.id,
    actions: [notifyAction({
      actionId: "repeat",
      refKind: "task",
      refId: "cooldown-task",
      reason: "It is still due.",
    })],
    now: secondNow,
    attention,
  });
  assert.deepEqual(result, { applied: 0, rejected: 1, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.match(db.prepare(
      "SELECT error FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).pluck().get(second.id), /^cooldown_until:/);
  } finally {
    db.close();
  }
});

test("a closed task notify is rejected before allocating attention", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now);
  insertTask(dbPath, { id: "closed-task", title: "Already done", status: "done", now });
  const calls = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({ refKind: "task", refId: "closed-task" })],
    now,
    attention: {
      shadow: false,
      transport: {
        textConfigured: true,
        banner: (...args) => calls.push(args),
        text: (...args) => calls.push(args),
      },
    },
  });
  assert.deepEqual(result, { applied: 0, rejected: 1, skipped: 0 });
  assert.deepEqual(calls, []);
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT error FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).pluck().get(job.id), "no longer open");
    assert.equal(db.prepare(
      "SELECT COUNT(*) FROM cove_attention_ledger WHERE ref_id = 'closed-task'",
    ).pluck().get(), 0);
  } finally {
    db.close();
  }
});

test("a third model text is suppressed and falls back to a banner", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  const job = enqueue(dbPath, now);
  insertTask(dbPath, { id: "third-text", title: "Needs attention", now });
  insertAttentionRows(dbPath, Array.from({ length: 2 }, (_, index) => ({
    id: `text-${index}`,
    refId: `text-task-${index}`,
    level: "text",
    deliveredAt: now.toISOString(),
    createdAt: now.toISOString(),
  })));
  const calls = [];
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [notifyAction({ refKind: "task", refId: "third-text", level: "text" })],
    now,
    attention: {
      shadow: false,
      transport: {
        textConfigured: true,
        banner: (...args) => calls.push(["banner", ...args]),
        text: (...args) => calls.push(["text", ...args]),
      },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(result, { applied: 1, rejected: 0, skipped: 0 });
  assert.deepEqual(calls.map(([kind]) => kind), ["banner"]);
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      `SELECT COUNT(*) FROM cove_attention_ledger
       WHERE ref_id = 'third-text' AND level = 'suppressed'
         AND suppressed_reason = 'reserved_floor_text_slot'`,
    ).pluck().get(), 1);
    assert.equal(db.prepare(
      "SELECT COUNT(*) FROM cove_attention_ledger WHERE ref_id = 'third-text' AND level = 'banner'",
    ).pluck().get(), 1);
  } finally {
    db.close();
  }
});

test("snapshot attention budget reports usage, cooldown, deterministic nudges, and shadowing", async (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  writeFileSync(path.join(dataDir, "attention-sweep.json"), '{"shadow":true}\n');
  insertTask(dbPath, {
    id: "reminded-task",
    title: "Review <today>",
    now,
    notifiedAt: new Date(now.getTime() - 60_000).toISOString(),
  });
  insertAttentionRows(dbPath, [
    {
      id: "delivered-banner",
      refId: "reminded-task",
      level: "banner",
      deliveredAt: new Date(now.getTime() - 120_000).toISOString(),
      createdAt: new Date(now.getTime() - 120_000).toISOString(),
    },
    {
      id: "shadow-observation",
      refId: "shadow-ref",
      level: "shadow",
      createdAt: new Date(now.getTime() - 60_000).toISOString(),
    },
  ]);
  const wake = enqueue(dbPath, now, "inspect attention");
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: wake.id,
    wake: wake.payload,
    session: {
      sessionId: "session",
      createdAt: new Date(now.getTime() - 60 * 60 * 1_000).toISOString(),
      mandateHash: "hash",
      wakes: 2,
      lastWakeAt: new Date(now.getTime() - 10 * 60 * 1_000).toISOString(),
      lastWakeReason: "manual",
    },
    dataDir,
    dbPath,
    now,
    calendar: null,
  });
  assert.match(snapshot, /## Attention budget/);
  assert.match(snapshot, /texts=0\/3, banners=1\/6, model_texts=0\/2, floor_texts=0\/1/);
  assert.match(snapshot, /Chief-of-staff notify lane: shadow/);
  assert.match(snapshot, /cooldown chief_of_staff \| task:reminded-task \| banner/);
  assert.match(snapshot, /task reminded-task \| Review today \| reminder/);
  assert.match(snapshot, /Suppressed or shadowed today: 1/);
  assert.doesNotMatch(snapshot, /Review <today>/);
});

test("attention budget preserves suppressions ahead of bounded reminder detail", async (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  for (let index = 0; index < 8; index += 1) {
    insertTask(dbPath, {
      id: `reminder-${index}`,
      title: `Reminder ${index} ${"x".repeat(49)}`,
      now,
      notifiedAt: new Date(now.getTime() - (index + 1) * 1_000).toISOString(),
    });
  }
  insertAttentionRows(dbPath, Array.from({ length: 3 }, (_, index) => ({
    id: `suppressed-${index}`,
    refId: `suppressed-ref-${index}`,
    level: "suppressed",
    suppressedReason: "daily_banner_cap",
    createdAt: new Date(now.getTime() - (index + 1) * 1_000).toISOString(),
  })));
  const wake = enqueue(dbPath, now, "bounded attention section");
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: wake.id,
    wake: wake.payload,
    session: {
      sessionId: "session",
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 1,
      lastWakeAt: new Date(now.getTime() - 60_000).toISOString(),
      lastWakeReason: "manual",
    },
    dataDir,
    dbPath,
    now,
    calendar: null,
  });
  const section = snapshot.split("## Attention budget\n")[1]
    .split("\n\n## Wake-specific context")[0];
  assert.match(section, /Suppressed or shadowed today: 3/);
  for (let index = 0; index < 3; index += 1) {
    assert.match(section, new RegExp(`suppressed-ref-${index}`));
  }
  for (let index = 0; index < 8; index += 1) {
    assert.match(section, new RegExp(`task reminder-${index}`));
  }
  assert.doesNotMatch(section, /\[section truncated\]/);
});

test("notify falls back to the action's why when reason is left null", (t) => {
  const { dataDir, dbPath } = fixture(t);
  const now = new Date("2026-09-03T18:30:00.000Z");
  writeFileSync(path.join(dataDir, "attention-sweep.json"), '{"shadow":true}\n');
  const job = enqueue(dbPath, now);
  insertTask(dbPath, { id: "why-task", title: "Follow up with Josh", now });
  const action = notifyAction({
    refKind: "task",
    refId: "why-task",
    why: "Alex asked for one banner about the Josh follow-up.",
  });
  action.reason = null;
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [action],
    now,
    attention: { transport: { textConfigured: false, banner: () => {}, text: () => {} } },
  });
  assert.deepEqual(result, { applied: 1, rejected: 0, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT reason FROM cove_attention_ledger WHERE ref_id = 'why-task'",
    ).pluck().get(), "Alex asked for one banner about the Josh follow-up.");
  } finally {
    db.close();
  }
});
