import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drainChiefOfStaff } from "../scripts/cove-chief-of-staff.ts";
import {
  applyChiefOfStaffActions,
  buildChiefOfStaffCodexArgv,
  captureCodexSessionId,
  resumeUnavailable,
  runWake,
} from "../src/lib/chief-of-staff/driver.ts";
import { tryEnqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/hooks.ts";
import { runChiefOfStaffReview } from "../src/lib/chief-of-staff/review.ts";
import { buildChiefOfStaffSnapshot, writeChiefOfStaffSnapshot } from "../src/lib/chief-of-staff/snapshot.ts";
import {
  CHIEF_OF_STAFF_CODEX_CONFIG,
  chiefOfStaffPaths,
  enqueueChiefOfStaffWake,
  ensureChiefOfStaffCodexHome,
  ensureChiefOfStaffHome,
  readChiefOfStaffSession,
  resetChiefOfStaffSession,
  writeChiefOfStaffSession,
} from "../src/lib/chief-of-staff/storage.ts";
import { scrubModelText, validateChiefOfStaffOutput } from "../src/lib/chief-of-staff/types.ts";
import { LocalCRMBackend } from "../src/lib/crm/local.ts";
import { LocalPipelineStore } from "../src/lib/crm/pipeline-store.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { createWorkSuggestion, getQuietCurrentSnapshot } from "../src/lib/quiet-current/store.ts";
import { JobScheduler } from "../src/lib/reliability/jobs.ts";

const ROOT = process.cwd();
process.env.COVE_SALES_PIPELINE = "1";

function tempCove() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-cos-"));
  const operatorCodexHome = path.join(dataDir, "operator-codex");
  mkdirSync(operatorCodexHome);
  writeFileSync(path.join(operatorCodexHome, "auth.json"), '{"auth":"operator"}\n');
  return {
    dataDir,
    dbPath: path.join(dataDir, "cove.db"),
    operatorEnv: {
      HOME: dataDir,
      PATH: process.env.PATH,
      CODEX_HOME: operatorCodexHome,
      COVE_SALES_PIPELINE: "1",
    },
  };
}

function enqueue(dbPath, input) {
  const db = openLocalDatabase(dbPath);
  try {
    return db.transaction(() => enqueueChiefOfStaffWake(db, input)).immediate();
  } finally {
    db.close();
  }
}

test("wake enqueue keys dedupe bounded reasons while manual wakes remain unique", () => {
  const { dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const db = openLocalDatabase(dbPath);
  try {
    const briefA = enqueueChiefOfStaffWake(db, { reason: "brief", payload: { date: "2026-09-03" }, now });
    const briefB = enqueueChiefOfStaffWake(db, { reason: "brief", payload: { date: "2026-09-03" }, now });
    assert.equal(briefA.inserted, true);
    assert.equal(briefB.inserted, false);
    assert.equal(briefA.job.idempotencyKey, "cos:brief:2026-09-03");
    assert.equal(
      enqueueChiefOfStaffWake(db, { reason: "triage", payload: { receiptId: "receipt-1" }, now }).job.idempotencyKey,
      "cos:triage:receipt-1",
    );
    assert.equal(
      enqueueChiefOfStaffWake(db, { reason: "meeting", payload: { jobId: "meeting-1" }, now }).job.idempotencyKey,
      "cos:meeting:meeting-1",
    );
    const sweepA = enqueueChiefOfStaffWake(db, {
      reason: "sweep",
      now: new Date("2026-09-03T18:47:00Z"),
      timezone: "America/Los_Angeles",
    });
    const sweepB = enqueueChiefOfStaffWake(db, {
      reason: "sweep",
      now: new Date("2026-09-03T18:30:00Z"),
      timezone: "America/Los_Angeles",
      slot: "11:30",
    });
    const sweepLater = enqueueChiefOfStaffWake(db, {
      reason: "sweep",
      now: new Date("2026-09-03T23:00:00Z"),
      timezone: "America/Los_Angeles",
    });
    assert.equal(sweepA.job.idempotencyKey, "cos:sweep:2026-09-03T11:30");
    assert.equal(sweepB.inserted, false);
    assert.equal(sweepLater.job.idempotencyKey, "cos:sweep:2026-09-03T16:00");
    assert.equal(sweepLater.inserted, true);
    const nightly = enqueueChiefOfStaffWake(db, { reason: "nightly", now, timezone: "America/Los_Angeles" });
    assert.equal(nightly.job.idempotencyKey, "cos:nightly:2026-09-03");
    const manualA = enqueueChiefOfStaffWake(db, { reason: "manual", note: "first", now });
    const manualB = enqueueChiefOfStaffWake(db, { reason: "manual", note: "second", now });
    assert.notEqual(manualA.job.idempotencyKey, manualB.job.idempotencyKey);
    assert.equal(manualA.job.maxAttempts, 2);
  } finally {
    db.close();
  }
});

test("output validation rejects bad bounds and duplicate action ids", () => {
  assert.throws(() => validateChiefOfStaffOutput({ journal: ["one"], watching: [], actions: [] }), /2 to 6/);
  assert.throws(() => validateChiefOfStaffOutput({
    journal: ["one", "two"],
    watching: [],
    actions: [
      { action_id: "same", kind: "task_create", why: "task t1", title: "A" },
      { action_id: "same", kind: "task_create", why: "task t2", title: "B" },
    ],
  }), /Duplicate action_id/);
});

test("chief-of-staff output schema uses the strict structured-output subset", () => {
  const schema = JSON.parse(readFileSync(
    path.join(ROOT, "prompts", "chief-of-staff-output.schema.json"),
    "utf8",
  ));
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    assert.equal(Object.hasOwn(node, "oneOf"), false);
    assert.equal(Object.hasOwn(node, "allOf"), false);
    if (node.type === "object" || node.properties) {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(schema);
  assert.ok(schema.properties.actions.items.properties.kind.enum.includes("pipeline_add"));
  assert.ok(schema.properties.actions.items.properties.kind.enum.includes("notify"));
});

test("model text scrubber redacts secret-looking lines and caps retained text", () => {
  for (const secret of [
    "a".repeat(40),
    "ya29.token-value",
    "sk-abcdefghijklmnopqrstuvwxyz1234",
    "-----BEGIN " + "PRIVATE KEY-----",
    "Bearer token-value",
  ]) assert.equal(scrubModelText(`prefix\n${secret}\nsuffix`, 500), "prefix\n[redacted]\nsuffix");
  assert.equal(scrubModelText("task-1234 follow up", 500), "task-1234 follow up");
  assert.equal(scrubModelText("sk-abcdefghijklmnopqrstuvwxyz1234", 500), "[redacted]");
  assert.equal(scrubModelText("ordinary context", 8), "ordinary");
  const output = validateChiefOfStaffOutput({
    journal: ["Bearer model-token", "Safe journal line"],
    watching: ["sk-abcdefghijklmnopqrstuvwxyz1234"],
    actions: [{
      action_id: "a1",
      kind: "task_create",
      why: "ya29.rationale",
      title: "-----BEGIN " + "PRIVATE KEY-----",
    }],
  });
  assert.equal(output.journal[0], "[redacted]");
  assert.equal(output.watching[0], "[redacted]");
  assert.equal(output.actions[0].why, "[redacted]");
  assert.equal(output.actions[0].title, "[redacted]");
});

test("snapshot is bounded, includes every desk section, and strips stored angle brackets", async () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const wake = enqueue(dbPath, {
    reason: "manual",
    note: "Look at <task>",
    payload: { source: "<manual>" },
    now,
  }).job;
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO tasks (id, title, priority, status, project, created_at, updated_at)
       VALUES ('task-1', '<Important>', 'high', 'open', '<Cove>', ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
  } finally {
    db.close();
  }
  createWorkSuggestion({
    title: "<Review> plan",
    reason: "Needs review",
    source: "test",
    claimKey: "snapshot-one",
    dataDir,
  });
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: wake.id,
    wake: wake.payload,
    session: {
      sessionId: null,
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 0,
      lastWakeAt: null,
      lastWakeReason: null,
    },
    dataDir,
    dbPath,
    now,
    timezone: "America/Los_Angeles",
    calendar: null,
  });
  assert.ok(snapshot.length <= 24_000);
  for (const section of [
    "## Wake",
    "## Rejected actions from previous wake",
    "## Open tasks",
    "## Pipeline",
    "## Calendar today and tomorrow",
    "## Receipts since last wake",
    "## Quiet Current",
    "## Attention budget",
    "## Wake-specific context",
    "## Recent chief-of-staff journal",
  ]) assert.match(snapshot, new RegExp(section));
  assert.doesNotMatch(snapshot, /<Important>|<Cove>|<Review>|<manual>|<task>/);
  assert.match(snapshot, /calendar not connected/);
  assert.match(snapshot, /Reply with one JSON object matching the schema\. Nothing else\.$/);
});

test("disabled sales pipeline is omitted from snapshots and its actions are rejected", async () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const wake = enqueue(dbPath, { reason: "manual", note: "disabled pipeline", now }).job;
  const crm = new LocalCRMBackend({ dbPath, now: () => now });
  const contact = crm.resolveOrCreateContact({
    name: "No Pipeline Person",
    email: "no-pipeline@example.com",
    source: "manual",
  }).contact;
  crm.close();
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: wake.id,
    now,
    env: {},
    actions: [{
      action_id: "pipeline-disabled",
      kind: "pipeline_add",
      why: `contact ${contact.id}`,
      contact_id: contact.id,
      stage: "interested",
      next_action: "Follow up",
    }],
  }), { applied: 0, rejected: 1, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT error FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).pluck().get(wake.id), "sales_pipeline_disabled");
    assert.equal(db.prepare("SELECT COUNT(*) FROM pipeline_deals").pluck().get(), 0);
  } finally {
    db.close();
  }
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: wake.id,
    wake: wake.payload,
    session: {
      sessionId: null,
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 0,
      lastWakeAt: null,
      lastWakeReason: null,
    },
    dataDir,
    dbPath,
    now,
    calendar: null,
    env: {},
  });
  assert.doesNotMatch(snapshot, /## Pipeline/);
});

test("chief-of-staff mandate tells the agent when sales pipeline actions are off", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  writeFileSync(path.join(dataDir, "cove-mandate.md"), "Private mandate\n");
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary);
  const now = new Date("2026-09-03T16:00:00Z");
  const wake = enqueue(dbPath, { reason: "manual", note: "disabled mandate", now }).job;
  await runWake(wake, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => now,
    env: { ...operatorEnv, COVE_SALES_PIPELINE: "0" },
  });
  assert.match(
    readFileSync(chiefOfStaffPaths(dataDir).mandate, "utf8"),
    /The sales pipeline is off/,
  );
});

test("output validation limits notify actions to four per wake", () => {
  const makeNotify = (index) => ({
    action_id: `notify-${index}`,
    kind: "notify",
    why: `task task-${index} is due`,
    ref_kind: "task",
    ref_id: `task-${index}`,
    level: "banner",
    reason: "It is due today.",
  });
  assert.throws(() => validateChiefOfStaffOutput({
    journal: ["one", "two"],
    watching: [],
    actions: Array.from({ length: 5 }, (_, index) => makeNotify(index)),
  }), /at most 4 notify/);
});

test("rejection feedback uses the last finished wake plus this wake's earlier attempt", async () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const finished = enqueue(dbPath, { reason: "manual", note: "finished", now }).job;
  applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: finished.id,
    actions: [{ action_id: "finished-rejection", kind: "email_send", why: "not allowed" }],
    now,
  });
  const queued = enqueue(dbPath, {
    reason: "manual",
    note: "queued predecessor",
    now: new Date(now.getTime() + 1_000),
  }).job;
  applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: queued.id,
    actions: [{ action_id: "queued-rejection", kind: "email_send", why: "not allowed" }],
    now,
  });
  const current = enqueue(dbPath, {
    reason: "manual",
    note: "retry",
    now: new Date(now.getTime() + 2_000),
  }).job;
  applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: current.id,
    actions: [{ action_id: "own-rejection", kind: "email_send", why: "not allowed" }],
    now,
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare("UPDATE cove_jobs SET status = 'done', finished_at = ? WHERE id = ?")
      .run(new Date(now.getTime() + 500).toISOString(), finished.id);
  } finally {
    db.close();
  }
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: current.id,
    wake: current.payload,
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
    now: new Date(now.getTime() + 3_000),
    calendar: null,
  });
  assert.match(snapshot, /finished-rejection/);
  assert.match(snapshot, /own-rejection/);
  assert.doesNotMatch(snapshot, /queued-rejection/);
});

test("meeting wake renders three complete bounded contact records", async () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const crm = new LocalCRMBackend({ dbPath, now: () => now });
  const contacts = ["One", "Two", "Three"].map((name, index) =>
    crm.resolveOrCreateContact({
      name: `Contact ${name}`,
      email: `contact-${index}@example.com`,
      source: "manual",
    }).contact
  );
  crm.close();
  const db = openLocalDatabase(dbPath);
  try {
    for (const contact of contacts) {
      db.prepare("UPDATE contacts SET notes = ? WHERE id = ?").run("Long context ".repeat(500), contact.id);
    }
  } finally {
    db.close();
  }
  const wake = enqueue(dbPath, {
    reason: "meeting",
    payload: { jobId: "meeting-context", contactIds: contacts.map((contact) => contact.id) },
    now,
  }).job;
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: wake.id,
    wake: wake.payload,
    session: {
      sessionId: null,
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 0,
      lastWakeAt: null,
      lastWakeReason: null,
    },
    dataDir,
    dbPath,
    now,
    calendar: null,
  });
  assert.equal((snapshot.match(/<cove_record>/g) ?? []).length, 3);
  assert.equal((snapshot.match(/<\/cove_record>/g) ?? []).length, 3);
});

test("all allowed actions use real stores, rejected actions are fed back, and replay is safe", async () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const crm = new LocalCRMBackend({ dbPath, now: () => now });
  const pipelineContact = crm.resolveOrCreateContact({
    name: "Pipeline Person",
    email: "pipeline@example.com",
    source: "manual",
  }).contact;
  const noteContact = crm.resolveOrCreateContact({
    name: "Note Person",
    email: "note@example.com",
    source: "manual",
  }).contact;
  const newPipelineContact = crm.resolveOrCreateContact({
    name: "New Pipeline Person",
    email: "new-pipeline@example.com",
    source: "manual",
  }).contact;
  crm.close();
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare("UPDATE contacts SET last_interaction_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:00Z", noteContact.id);
    db.prepare(
      `INSERT INTO tasks (id, title, priority, status, project, created_at, updated_at)
       VALUES ('existing-task', 'Old title', 'low', 'open', 'Atlas', ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
  } finally {
    db.close();
  }
  const pipeline = new LocalPipelineStore({ dbPath, now: () => now });
  pipeline.create({ contactId: pipelineContact.id, stage: "reach_out" });
  pipeline.close();
  const first = enqueue(dbPath, { reason: "manual", note: "apply", now }).job;
  const actions = [
    { action_id: "create", kind: "task_create", why: "open task task-1", title: "New task", due_at: "2026-09-07", priority: "high", project: "Cove" },
    { action_id: "update", kind: "task_update", why: "open task existing-task", task_id: "existing-task", title: "Updated", status: "done" },
    { action_id: "pipeline-add", kind: "pipeline_add", why: `meeting contact ${newPipelineContact.id}`, contact_id: newPipelineContact.id, stage: "pitched", next_action: "Send the scheduling options", next_follow_up_at: "2026-09-09", notes: "Introduced after the meeting." },
    { action_id: "touch", kind: "pipeline_log_touch", why: `pipeline ${pipelineContact.id}`, contact_id: pipelineContact.id, channel: "email", summary: "Sent the requested follow-up", next_action: "Wait for reply", next_follow_up_at: "2026-09-08" },
    { action_id: "pipeline-update", kind: "pipeline_update", why: `pipeline ${pipelineContact.id}`, contact_id: pipelineContact.id, notes: "Decision maker is reviewing." },
    { action_id: "move", kind: "pipeline_move", why: `pipeline ${pipelineContact.id}`, contact_id: pipelineContact.id, stage: "interested" },
    { action_id: "note", kind: "crm_note", why: `meeting contact ${noteContact.id}`, contact_id: noteContact.id, title: "Context", content: "Prefers Friday check-ins." },
    { action_id: "suggest", kind: "suggest", why: "payload asks for judgment", title: "Review pricing", description: "Decide whether to change the proposal.", reason: "Pricing requires Alex's judgment.", priority: "high", claim_key: "cos:pricing" },
  ];
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath, dataDir, wakeJobId: first.id, actions, now,
  }), { applied: 8, rejected: 0, skipped: 0 });
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath, dataDir, wakeJobId: first.id, actions, now,
  }), { applied: 0, rejected: 0, skipped: 8 });
  const verify = openLocalDatabase(dbPath);
  try {
    const created = verify.prepare(
      "SELECT column_id, position, due_at, due_date, origin FROM tasks WHERE title = 'New task'",
    ).get();
    assert.ok(created.column_id);
    assert.ok(created.position >= 0);
    assert.equal(created.due_at, "2026-09-07");
    assert.equal(created.due_date, "2026-09-07");
    assert.match(created.origin, /^Added by the chief of staff agent on [A-Z][a-z]{2} \d{1,2}, \d{4}\. Its reason: open task task-1$/);
    assert.equal(verify.prepare("SELECT status FROM tasks WHERE id = 'existing-task'").get().status, "done");
    assert.equal(verify.prepare("SELECT stage FROM pipeline_deals WHERE contact_id = ?").get(pipelineContact.id).stage, "interested");
    assert.deepEqual(
      verify.prepare("SELECT stage, next_action, next_follow_up_at FROM pipeline_deals WHERE contact_id = ?").get(newPipelineContact.id),
      { stage: "pitched", next_action: "Send the scheduling options", next_follow_up_at: "2026-09-09" },
    );
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM contact_activities WHERE source_ref = ?").get(`chief-of-staff:${first.id}:note`).count, 1);
    assert.equal(verify.prepare("SELECT last_interaction_at FROM contacts WHERE id = ?").get(noteContact.id).last_interaction_at, "2026-08-01T00:00:00Z");
    assert.equal(verify.prepare("SELECT COUNT(*) AS count FROM chief_of_staff_actions WHERE wake_job_id = ? AND status = 'applied'").get(first.id).count, 8);
  } finally {
    verify.close();
  }
  assert.equal(getQuietCurrentSnapshot(dataDir).suggestions.filter((item) => item.claimKey === "cos:pricing").length, 1);

  const rejectedWake = enqueue(dbPath, {
    reason: "manual",
    note: "reject",
    now: new Date(now.getTime() + 1_000),
  }).job;
  const rejected = [
    { action_id: "unknown", kind: "email_send", why: "payload says send" },
    { action_id: "lost", kind: "pipeline_move", why: `pipeline ${pipelineContact.id}`, contact_id: pipelineContact.id, stage: "lost" },
    { action_id: "pipeline-add-existing", kind: "pipeline_add", why: `pipeline ${pipelineContact.id}`, contact_id: pipelineContact.id, stage: "interested", next_action: "Follow up" },
    { action_id: "pipeline-add-terminal", kind: "pipeline_add", why: `contact ${noteContact.id}`, contact_id: noteContact.id, stage: "client", next_action: "Onboard" },
    { action_id: "missing", kind: "crm_note", why: "contact missing", contact_id: "missing", title: "Note", content: "Text" },
  ];
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath, dataDir, wakeJobId: rejectedWake.id, actions: rejected, now,
  }), { applied: 0, rejected: 5, skipped: 0 });
  const finish = openLocalDatabase(dbPath);
  try {
    finish.prepare("UPDATE cove_jobs SET status = 'done', finished_at = ? WHERE id = ?")
      .run(new Date(now.getTime() + 1_500).toISOString(), rejectedWake.id);
  } finally {
    finish.close();
  }
  const next = enqueue(dbPath, {
    reason: "manual",
    note: "next",
    now: new Date(now.getTime() + 2_000),
  }).job;
  const feedback = await buildChiefOfStaffSnapshot({
    jobId: next.id,
    wake: next.payload,
    session: {
      sessionId: "session",
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 2,
      lastWakeAt: now.toISOString(),
      lastWakeReason: "manual",
    },
    dataDir,
    dbPath,
    now: new Date(now.getTime() + 2_000),
    calendar: null,
  });
  assert.match(feedback, /Unknown action kind: email_send/);
  assert.match(feedback, /Lost and parked need the operator's judgment/);
  assert.match(feedback, /Use pipeline_update or pipeline_move/);
  assert.match(feedback, /Client, lost, and parked cannot be added/);
  assert.match(feedback, /Contact was not found/);
});

test("task_create accepts the live flat-schema payload with open status", () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const wake = enqueue(dbPath, { reason: "manual", note: "live task", now }).job;
  const action = {
    action_id: "live-task-create",
    kind: "task_create",
    why: "manual payload asks for Josh follow-up",
    title: "Follow up with Dan's friend Josh about scheduling with Alex",
    details: "...",
    due_at: "2026-09-07T10:00:00-07:00",
    remind_at: "2026-09-07T09:00:00-07:00",
    priority: "medium",
    project: "Atlas",
    status: "open",
  };
  const strictFlatAction = {
    ...action,
    task_id: null,
    contact_id: null,
    channel: null,
    summary: null,
    next_action: null,
    next_follow_up_at: null,
    notes: null,
    stage: null,
    content: null,
    suggestion_kind: null,
    description: null,
    reason: null,
    due_date: null,
    claim_key: null,
  };
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: wake.id,
    actions: [strictFlatAction],
    now,
  }), { applied: 1, rejected: 0, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.deepEqual(db.prepare(
      "SELECT status, priority, due_at, due_date, remind_at FROM tasks WHERE title = ?",
    ).get(action.title), {
      status: "open",
      priority: "medium",
      due_at: action.due_at,
      due_date: action.due_at,
      remind_at: action.remind_at,
    });
  } finally {
    db.close();
  }
  const rejectedWake = enqueue(dbPath, { reason: "manual", note: "bad status", now }).job;
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: rejectedWake.id,
    actions: [{ ...strictFlatAction, action_id: "bad-status", status: "done" }],
    now,
  }), { applied: 0, rejected: 1, skipped: 0 });
});

test("pipeline_update still rejects a non-null stage", () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const crm = new LocalCRMBackend({ dbPath, now: () => now });
  const contact = crm.resolveOrCreateContact({
    name: "Pipeline Guard",
    email: "pipeline-guard@example.com",
    source: "manual",
  }).contact;
  crm.close();
  const pipeline = new LocalPipelineStore({ dbPath, now: () => now });
  pipeline.create({ contactId: contact.id, stage: "reach_out" });
  pipeline.close();
  const wake = enqueue(dbPath, { reason: "manual", note: "guard stage", now }).job;
  assert.deepEqual(applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: wake.id,
    actions: [{
      action_id: "invalid-stage-update",
      kind: "pipeline_update",
      why: `pipeline ${contact.id}`,
      contact_id: contact.id,
      notes: "Keep the current stage.",
      stage: "interested",
    }],
    now,
  }), { applied: 0, rejected: 1, skipped: 0 });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare(
      "SELECT stage FROM pipeline_deals WHERE contact_id = ?",
    ).pluck().get(contact.id), "reach_out");
    const ledger = db.prepare(
      "SELECT error, payload_json FROM chief_of_staff_actions WHERE wake_job_id = ?",
    ).get(wake.id);
    assert.equal(ledger.error, "pipeline_update cannot change stage. Use pipeline_move.");
    assert.equal(JSON.parse(ledger.payload_json).stage, "interested");
  } finally {
    db.close();
  }
});

function fakeCodex(file, mode = "success") {
  const resumeFailure = mode === "resume-failure"
    ? `case " $* " in *" resume old-session "*) echo "Error: thread/resume: thread/resume failed: no rollout found for thread id old-session (code -32600)" >&2; exit 1;; esac\n`
    : mode === "tool-failure"
    ? `case " $* " in *" resume old-session "*) echo "tool output: file not found"; echo "tool execution failed" >&2; exit 1;; esac\n`
    : "";
  const sessionEvent = mode === "no-session"
    ? `printf '%s\\n' 'diagnostic without a session id'`
    : `printf '%s\\n' '{"type":"thread.started","thread_id":"new-session-id"}'`;
  const output = mode === "no-session"
    ? '{"journal":["Applied the task.","A fresh session is acceptable."],"watching":[],"actions":[{"action_id":"no-session-task","kind":"task_create","why":"manual payload","title":"Created without session id"}]}'
    : mode === "two-texts"
    ? '{"journal":["Reviewed both due tasks.","Requested the necessary interruptions."],"watching":[],"actions":[{"action_id":"text-one","kind":"notify","why":"notice one is due","ref_kind":"task","ref_id":"notice-one","level":"text","reason":"First task is due now."},{"action_id":"text-two","kind":"notify","why":"notice two is due","ref_kind":"task","ref_id":"notice-two","level":"text","reason":"Second task is due now."}]}'
    : mode === "mixed-outcome"
    ? '{"journal":["Created the requested task.","Checked the remaining action."],"watching":[],"actions":[{"action_id":"good-task","kind":"task_create","why":"manual payload","title":"Outcome task","status":"open"},{"action_id":"bad-send","kind":"email_send","why":"manual payload"}]}'
    : '{"journal":["Reviewed the desk.","No urgent gap found."],"watching":[],"actions":[]}';
  writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$PWD" > ../fake-cwd.txt
printf '%s\\n' "$@" > ../fake-argv.txt
env | sort > ../fake-env.txt
cat > ../fake-stdin.txt
${resumeFailure}out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then out="$argument"; fi
  previous="$argument"
done
printf '%s\\n' '${output}' > "$out"
${sessionEvent}
`, { mode: 0o700 });
  chmodSync(file, 0o700);
}

test("isolated Codex home has exact config and symlinked operator auth", () => {
  const { dataDir, operatorEnv } = tempCove();
  const first = ensureChiefOfStaffCodexHome({ dataDir, env: operatorEnv });
  assert.equal(first.configRewritten, true);
  assert.equal(readFileSync(first.paths.codexConfig, "utf8"), CHIEF_OF_STAFF_CODEX_CONFIG);
  assert.equal(lstatSync(first.paths.codexAuth).isSymbolicLink(), true);
  assert.equal(
    path.resolve(first.paths.codexHome, readlinkSync(first.paths.codexAuth)),
    path.join(operatorEnv.CODEX_HOME, "auth.json"),
  );
  assert.equal(existsSync(path.join(first.paths.codexHome, "AGENTS.md")), false);
  assert.equal(existsSync(path.join(first.paths.codexHome, "skills")), false);

  const unchangedInode = statSync(first.paths.codexConfig).ino;
  const unchanged = ensureChiefOfStaffCodexHome({ dataDir, env: operatorEnv });
  assert.equal(unchanged.configRewritten, false);
  assert.equal(statSync(first.paths.codexConfig).ino, unchangedInode);
  writeFileSync(first.paths.codexConfig, "sandbox_mode = \"workspace-write\"\n");
  const repaired = ensureChiefOfStaffCodexHome({ dataDir, env: operatorEnv });
  assert.equal(repaired.configRewritten, true);
  assert.equal(readFileSync(repaired.paths.codexConfig, "utf8"), CHIEF_OF_STAFF_CODEX_CONFIG);
});

test("isolated Codex home requires the operator auth source", () => {
  const { dataDir } = tempCove();
  assert.throws(() => ensureChiefOfStaffCodexHome({
    dataDir,
    env: { HOME: path.join(dataDir, "missing-home") },
  }), /Chief-of-staff Codex auth is unavailable/);
});

test("session reset preserves isolated Codex rollouts", () => {
  const { dataDir, operatorEnv } = tempCove();
  const codex = ensureChiefOfStaffCodexHome({ dataDir, env: operatorEnv });
  const rollout = path.join(codex.paths.codexHome, "sessions", "rollout.jsonl");
  mkdirSync(path.dirname(rollout), { recursive: true });
  writeFileSync(rollout, "saved rollout\n");
  const home = ensureChiefOfStaffHome({ repoDir: ROOT, dataDir });
  writeChiefOfStaffSession(dataDir, { ...home.session, sessionId: "session-to-reset" });
  resetChiefOfStaffSession({ dataDir, now: new Date("2026-09-03T16:00:00Z") });
  assert.equal(readFileSync(rollout, "utf8"), "saved rollout\n");
});

test("Codex argv is safe, captures a new session, resumes it, and uses the nested workspace", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary);
  const first = enqueue(dbPath, {
    reason: "manual",
    note: "first wake",
    now: new Date("2026-09-03T16:00:00Z"),
  }).job;
  await runWake(first, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:00:00Z"),
    env: {
      ...operatorEnv,
      OPENAI_API_KEY: "model-auth",
      GMAIL_REFRESH_TOKEN: "must-not-pass",
      COVE_GOOGLE_CLIENT_SECRET: "must-not-pass",
    },
  });
  const paths = chiefOfStaffPaths(dataDir);
  assert.equal(
    realpathSync(readFileSync(path.join(paths.agent, "fake-cwd.txt"), "utf8").trim()),
    realpathSync(paths.workspace),
  );
  assert.equal(readChiefOfStaffSession(dataDir).sessionId, "new-session-id");
  assert.ok(existsSync(path.join(paths.agent, ".git")));
  assert.equal(statSync(paths.mandate).mode & 0o777, 0o444);
  const firstArgs = readFileSync(path.join(paths.agent, "fake-argv.txt"), "utf8").trim().split("\n");
  assert.deepEqual(firstArgs, buildChiefOfStaffCodexArgv({
    workspace: paths.workspace,
    schemaPath: path.join(ROOT, "prompts", "chief-of-staff-output.schema.json"),
    outputPath: firstArgs[firstArgs.indexOf("--output-last-message") + 1],
  }));
  assert.ok(firstArgs.includes("sandbox_mode=read-only"));
  assert.ok(firstArgs.includes("features.shell_tool=false"));
  assert.ok(firstArgs.includes('web_search="disabled"'));
  assert.equal(firstArgs.includes("--last"), false);
  const childEnv = readFileSync(path.join(paths.agent, "fake-env.txt"), "utf8");
  assert.match(childEnv, new RegExp(`CODEX_HOME=${paths.codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(childEnv, /OPENAI_API_KEY=model-auth/);
  assert.doesNotMatch(childEnv, /GMAIL|GOOGLE_CLIENT_SECRET|must-not-pass/);

  const second = enqueue(dbPath, {
    reason: "manual",
    note: "second wake",
    now: new Date("2026-09-03T16:01:00Z"),
  }).job;
  await runWake(second, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:01:00Z"),
    env: operatorEnv,
  });
  const resumed = readFileSync(path.join(paths.agent, "fake-argv.txt"), "utf8").trim().split("\n");
  assert.ok(resumed.indexOf("--json") < resumed.indexOf("resume"));
  assert.deepEqual(resumed.slice(-3), ["resume", "new-session-id", "-"]);
  assert.equal(readChiefOfStaffSession(dataDir).wakes, 2);
  assert.equal(captureCodexSessionId('{"type":"thread.started","thread_id":"abc"}\n'), "abc");
  assert.equal(
    captureCodexSessionId("", "session id: 123e4567-e89b-12d3-a456-426614174000"),
    "123e4567-e89b-12d3-a456-426614174000",
  );

  const unchanged = ensureChiefOfStaffHome({ repoDir: ROOT, dataDir });
  assert.equal(unchanged.mandateRewritten, false);
  writeFileSync(path.join(dataDir, "cove-mandate.md"), "Replacement mandate\n");
  const changed = ensureChiefOfStaffHome({ repoDir: ROOT, dataDir });
  assert.equal(changed.mandateRewritten, true);
  assert.equal(readFileSync(changed.paths.mandate, "utf8"), "Replacement mandate\n");
  assert.equal(statSync(changed.paths.mandate).mode & 0o777, 0o444);
  assert.match(
    readFileSync(path.join(changed.paths.workspace, "README.md"), "utf8"),
    /must not run commands or read files/,
  );
});

test("wake journal ends with the driver-authored ledger outcome", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary, "mixed-outcome");
  const now = new Date("2026-09-03T16:00:00Z");
  const job = enqueue(dbPath, { reason: "manual", note: "mixed result", now }).job;
  const result = await runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => now,
    env: operatorEnv,
  });
  assert.deepEqual(result.actions, {
    applied: 1,
    rejected: 1,
    skipped: 0,
    watching: [],
  });
  const journal = readFileSync(
    path.join(chiefOfStaffPaths(dataDir).journal, "2026-09-03.md"),
    "utf8",
  );
  const lines = journal.trim().split("\n");
  assert.match(lines.at(-1), /^- \d{2}:\d{2} \[manual\] outcome: applied 1, rejected 1 \(email_send: Unknown action kind: email_send\.\)$/);
  assert.ok(lines.at(-1).length <= 400);
});

test("two text notifications in one wake send one text and downgrade the second", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary, "two-texts");
  const now = new Date("2026-09-03T18:30:00Z");
  const job = enqueue(dbPath, { reason: "manual", note: "check both tasks", now }).job;
  const db = openLocalDatabase(dbPath);
  try {
    const task = db.prepare(
      `INSERT INTO tasks
         (id, title, status, source_type, position, created_at, updated_at)
       VALUES (?, ?, 'open', 'inbound_event', 0, ?, ?)`,
    );
    const inbound = db.prepare(
      `INSERT INTO inbound_events
         (id, source, source_id, raw_text, state, attempts, created_at, updated_at)
       VALUES (?, 'chat', ?, 'fixture', 'triaged', 0, ?, ?)`,
    );
    for (const id of ["notice-one", "notice-two"]) {
      task.run(id, `Title for ${id}`, now.toISOString(), now.toISOString());
      inbound.run(id, `source-${id}`, now.toISOString(), now.toISOString());
    }
    assert.equal(db.prepare(
      "SELECT COUNT(*) FROM tasks WHERE id IN ('notice-one','notice-two') AND status = 'open'",
    ).pluck().get(), 2);
  } finally {
    db.close();
  }
  const calls = [];
  const wakeResult = await runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => now,
    env: operatorEnv,
    attention: {
      shadow: false,
      transport: {
        textConfigured: true,
        banner: (text) => calls.push(["banner", text]),
        text: (text) => {
          calls.push(["text", text]);
          return true;
        },
      },
      surface: () => undefined,
      surfaceSuppression: () => undefined,
    },
  });
  assert.deepEqual(wakeResult.actions, {
    applied: 2,
    rejected: 0,
    skipped: 0,
    watching: [],
  });
  assert.deepEqual(calls.map(([kind]) => kind), ["text", "banner"]);
  const verify = openLocalDatabase(dbPath);
  try {
    const payloads = verify.prepare(
      `SELECT action_id, payload_json FROM chief_of_staff_actions
       WHERE wake_job_id = ? ORDER BY action_id`,
    ).all(job.id).map((row) => [row.action_id, JSON.parse(row.payload_json)]);
    assert.equal(payloads[0][1].delivered_level, "text");
    assert.equal(payloads[1][1].delivered_level, "banner");
    assert.equal(payloads[1][1].downgrade_reason, "one_text_per_wake");
  } finally {
    verify.close();
  }
  const journal = readFileSync(
    path.join(chiefOfStaffPaths(dataDir).journal, "2026-09-03.md"),
    "utf8",
  );
  assert.match(
    journal.trim().split("\n").at(-1),
    /outcome: applied 2, rejected 0, downgraded 1 \(notify: one_text_per_wake\)$/,
  );
});

test("resume reset requires the exact nonzero thread-resume failure", () => {
  assert.equal(resumeUnavailable({
    exitCode: 1,
    stderr: "Error: thread/resume: thread/resume failed: no rollout found for thread id abc (code -32600)",
  }), true);
  assert.equal(resumeUnavailable({
    exitCode: 0,
    stderr: "thread/resume failed: no rollout found for thread id abc",
  }), false);
  assert.equal(resumeUnavailable({
    exitCode: 1,
    stderr: "tool failed while reading input",
    stdout: "file not found in tool output",
  }), false);
});

test("missing resume transcript archives the old session and starts fresh", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary, "resume-failure");
  const home = ensureChiefOfStaffHome({ repoDir: ROOT, dataDir, now: new Date("2026-09-03T16:00:00Z") });
  writeChiefOfStaffSession(dataDir, { ...home.session, sessionId: "old-session" });
  const job = enqueue(dbPath, {
    reason: "manual",
    note: "resume",
    now: new Date("2026-09-03T16:01:00Z"),
  }).job;
  await runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:01:00Z"),
    env: operatorEnv,
  });
  assert.equal(readChiefOfStaffSession(dataDir).sessionId, "new-session-id");
  assert.equal(readdirSync(chiefOfStaffPaths(dataDir).archive).length, 1);
  assert.match(readFileSync(path.join(chiefOfStaffPaths(dataDir).journal, "2026-09-03.md"), "utf8"), /Session reset/);
});

test("file-not-found tool errors do not archive the stored session", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary, "tool-failure");
  const home = ensureChiefOfStaffHome({ repoDir: ROOT, dataDir, now: new Date("2026-09-03T16:00:00Z") });
  writeChiefOfStaffSession(dataDir, { ...home.session, sessionId: "old-session" });
  const job = enqueue(dbPath, {
    reason: "manual",
    note: "tool failure",
    now: new Date("2026-09-03T16:01:00Z"),
  }).job;
  await assert.rejects(runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:01:00Z"),
    env: operatorEnv,
  }), /tool execution failed/);
  assert.equal(readChiefOfStaffSession(dataDir).sessionId, "old-session");
  assert.equal(readdirSync(chiefOfStaffPaths(dataDir).archive).length, 0);
});

test("successful wake without a captured session applies actions and starts fresh next time", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  fakeCodex(binary, "no-session");
  const job = enqueue(dbPath, {
    reason: "manual",
    note: "no session",
    now: new Date("2026-09-03T16:00:00Z"),
  }).job;
  await runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:00:00Z"),
    env: operatorEnv,
  });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) FROM tasks WHERE title = ?").pluck().get("Created without session id"), 1);
  } finally {
    db.close();
  }
  assert.equal(readChiefOfStaffSession(dataDir).sessionId, null);
  const journal = readFileSync(path.join(chiefOfStaffPaths(dataDir).journal, "2026-09-03.md"), "utf8");
  assert.match(journal, /completed without a session id/);
  assert.match(journal, /diagnostic without a session id/);
});

test("blank configured Codex path falls back to codex on PATH", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binDir = path.join(dataDir, "bin");
  mkdirSync(binDir);
  fakeCodex(path.join(binDir, "codex"));
  const job = enqueue(dbPath, {
    reason: "manual",
    note: "blank binary",
    now: new Date("2026-09-03T16:00:00Z"),
  }).job;
  await runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    now: () => new Date("2026-09-03T16:00:00Z"),
    env: {
      ...operatorEnv,
      PATH: `${binDir}:${process.env.PATH}`,
      COVE_CODEX_BIN: "   ",
    },
  });
  assert.equal(readChiefOfStaffSession(dataDir).sessionId, "new-session-id");
});

test("retried wake skips the same action intent when Codex changes action_id", async () => {
  const { dataDir, dbPath, operatorEnv } = tempCove();
  const binary = path.join(dataDir, "fake-codex");
  const countFile = path.join(dataDir, "fake-count.txt");
  writeFileSync(binary, `#!/bin/sh
cat >/dev/null
out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then out="$argument"; fi
  previous="$argument"
done
if [ -f "${countFile}" ]; then count=2; else count=1; fi
printf '%s\\n' "$count" > "${countFile}"
printf '%s%s%s\\n' '{"journal":["Applied intent.","Replay is guarded."],"watching":[],"actions":[{"action_id":"a' "$count" '","kind":"task_create","why":"manual payload","title":"Exactly once task"}]}' > "$out"
printf '%s\\n' '{"type":"thread.started","thread_id":"retry-session"}'
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  const job = enqueue(dbPath, {
    reason: "manual",
    note: "retry",
    now: new Date("2026-09-03T16:00:00Z"),
  }).job;
  await assert.rejects(runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:00:00Z"),
    env: operatorEnv,
    afterActionsApplied: () => { throw new Error("forced crash after apply"); },
  }), /forced crash after apply/);
  await runWake(job, {
    repoDir: ROOT,
    dataDir,
    dbPath,
    codexPath: binary,
    now: () => new Date("2026-09-03T16:01:00Z"),
    env: operatorEnv,
  });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) FROM tasks WHERE title = ?").pluck().get("Exactly once task"), 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM chief_of_staff_actions WHERE wake_job_id = ? AND status = 'applied'").pluck().get(job.id), 1);
  } finally {
    db.close();
  }
});

test("drain claims chief-of-staff jobs one at a time and in run-after order", async () => {
  const { dataDir, dbPath } = tempCove();
  const first = enqueue(dbPath, { reason: "manual", note: "first", now: new Date("2020-01-01T00:00:00Z") }).job;
  const second = enqueue(dbPath, { reason: "manual", note: "second", now: new Date("2020-01-01T00:00:01Z") }).job;
  const order = [];
  let active = 0;
  let maximum = 0;
  const result = await drainChiefOfStaff({
    repoDir: ROOT,
    dataDir,
    dbPath,
    max: 2,
    runWakeImpl: async (job) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(job.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { summary: "done" };
    },
  });
  assert.deepEqual(order, [first.id, second.id]);
  assert.equal(maximum, 1);
  assert.deepEqual(result, { claimed: 2, done: 2, failed: 0, dead: 0 });
});

test("other scheduler lanes leave chief-of-staff wakes queued", async () => {
  const { dbPath } = tempCove();
  const wake = enqueue(dbPath, {
    reason: "manual",
    note: "wait for the dedicated drain",
    now: new Date("2020-01-01T00:00:00Z"),
  }).job;
  const scheduler = new JobScheduler({ dbPath });
  scheduler.register("email-classify", async () => ({ summary: "email done" }));
  try {
    assert.equal((await scheduler.runAvailable({ maxJobs: 1 })).claimed, 0);
    assert.equal(scheduler.getJob(wake.id).status, "queued");
  } finally {
    scheduler.close();
  }
});

test("wake jobs retry once, then become visible dead jobs", async () => {
  const { dbPath } = tempCove();
  let clock = new Date("2026-09-03T16:00:00Z");
  const queued = enqueue(dbPath, { reason: "manual", note: "fail", now: clock }).job;
  const scheduler = new JobScheduler({
    dbPath,
    now: () => clock,
    backoffBaseMs: 1_000,
    maxBackoffMs: 1_000,
  });
  scheduler.register("chief-of-staff-wake", () => {
    throw new Error("wake failed");
  });
  try {
    assert.equal(await scheduler.runJob(queued.id), "failed");
    assert.equal(scheduler.getJob(queued.id).attempts, 1);
    clock = new Date(clock.getTime() + 1_001);
    assert.equal(await scheduler.runJob(queued.id), "dead");
    const dead = scheduler.getJob(queued.id);
    assert.equal(dead.attempts, 2);
    assert.equal(dead.status, "dead");
    assert.match(dead.lastError, /wake failed/);
  } finally {
    scheduler.close();
  }
});

test("snapshot audit retention keeps only the latest 50 files", () => {
  const { dataDir } = tempCove();
  for (let index = 0; index < 51; index += 1) {
    writeChiefOfStaffSnapshot({
      dataDir,
      jobId: `job-${String(index).padStart(2, "0")}`,
      snapshot: `snapshot ${index}`,
    });
  }
  const files = readdirSync(chiefOfStaffPaths(dataDir).snapshots).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 50);
});

test("claim keys dedupe unresolved suggestions", () => {
  const { dataDir } = tempCove();
  const first = createWorkSuggestion({
    title: "First",
    reason: "Reason",
    source: "test",
    claimKey: "same-claim",
    dataDir,
  });
  const second = createWorkSuggestion({
    title: "Second",
    reason: "Reason",
    source: "test",
    claimKey: "same-claim",
    dataDir,
  });
  assert.equal(first.id, second.id);
  assert.equal(getQuietCurrentSnapshot(dataDir).suggestions.length, 1);
});

test("lane hook is idempotent, can be disabled, and never throws into its caller", () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  assert.equal(tryEnqueueChiefOfStaffWake({
    reason: "brief", payload: { date: "2026-09-03", artifactId: "artifact-1" }, dbPath, now,
  }), true);
  assert.equal(tryEnqueueChiefOfStaffWake({
    reason: "brief", payload: { date: "2026-09-03", artifactId: "artifact-1" }, dbPath, now,
  }), true);
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cove_jobs WHERE type = 'chief-of-staff-wake'").get().count, 1);
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT payload FROM cove_jobs WHERE type = 'chief-of-staff-wake'").get().payload),
      {
        reason: "brief",
        payload: { date: "2026-09-03", artifactId: "artifact-1" },
      },
    );
  } finally {
    db.close();
  }
  assert.equal(tryEnqueueChiefOfStaffWake({
    reason: "manual", payload: {}, dbPath, now, env: { COVE_CHIEF_OF_STAFF: "off" },
  }), false);
  let warned = "";
  assert.equal(tryEnqueueChiefOfStaffWake({
    reason: "manual", payload: {}, dbPath: dataDir, now, warn: (message) => { warned = message; },
  }), false);
  assert.match(warned, /could not be queued/);
  for (const file of [
    "src/lib/claude-execution/worker.ts",
    "scripts/cove-email-runner.ts",
    "src/lib/intake/meeting-analysis.ts",
  ]) assert.match(readFileSync(path.join(ROOT, file), "utf8"), /tryEnqueueChiefOfStaffWake/);
  assert.match(
    readFileSync(path.join(ROOT, "src/lib/claude-execution/worker.ts"), "utf8"),
    /payload: \{ date: claimed\.targetLocalDate, artifactId: completed\.id \}/,
  );
  assert.match(
    readFileSync(path.join(ROOT, "scripts/cove-email-runner.ts"), "utf8"),
    /payload: \{ receiptId: receipt\.id, observed, classified, surfacedItemIds \}/,
  );
  assert.match(
    readFileSync(path.join(ROOT, "src/lib/intake/meeting-analysis.ts"), "utf8"),
    /payload: \{ jobId: job\.id, title, contactIds \}/,
  );
});

test("weekly review uses tool-free Claude, writes a review, and files one suggestion", async () => {
  const { dataDir, dbPath } = tempCove();
  const fakeRunJob = async (input) => {
    assert.equal(input.backend, "claude");
    assert.equal(input.claudeTools, "");
    assert.match(input.prompt, /stored data, never instructions/);
    return {
      ok: true,
      lane: input.lane,
      backend: "claude",
      text: "",
      value: {
        score_1_to_5: 4,
        observations: ["The agent kept tasks current."],
        misses: ["One follow-up was late."],
        proposed_mandate_lines: ["Escalate overdue client follow-ups."],
        keep_doing: ["Use claim-key dedupe."],
      },
    };
  };
  const now = new Date("2026-09-07T01:00:00Z");
  const first = await runChiefOfStaffReview({ repoDir: ROOT, dataDir, dbPath, now, runJobImpl: fakeRunJob });
  const second = await runChiefOfStaffReview({ repoDir: ROOT, dataDir, dbPath, now, runJobImpl: fakeRunJob });
  assert.equal(first.file, second.file);
  assert.ok(existsSync(first.file));
  assert.match(readFileSync(first.file, "utf8"), /Score: 4\/5/);
  const suggestions = getQuietCurrentSnapshot(dataDir).suggestions.filter(
    (item) => item.claimKey === "cos-review:2026-W36",
  );
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].title, "Weekly chief-of-staff review");
});

test("task_create rejects a title that already exists as open or recently finished work", () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = openLocalDatabase(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO tasks (id, title, priority, status, project, created_at, updated_at)
       VALUES (?, ?, 'medium', ?, 'Atlas', ?, ?)`,
    );
    insert.run("task-open", "Send Maya the revised scope.", "open", daysAgo(5), daysAgo(5));
    insert.run("task-done-recent", "Book the Cabo flights", "done", daysAgo(10), daysAgo(3));
    insert.run("task-done-old", "Renew the domain", "done", daysAgo(40), daysAgo(30));
  } finally {
    db.close();
  }
  const create = (actionId, title) => {
    const wake = enqueue(dbPath, { reason: "manual", note: actionId, now }).job;
    const result = applyChiefOfStaffActions({
      dbPath,
      dataDir,
      wakeJobId: wake.id,
      actions: [{ action_id: actionId, kind: "task_create", why: "test", title }],
      now,
    });
    const audit = openLocalDatabase(dbPath);
    try {
      const row = audit.prepare(
        "SELECT status, error FROM chief_of_staff_actions WHERE wake_job_id = ?",
      ).get(wake.id);
      const count = audit.prepare("SELECT COUNT(*) FROM tasks").pluck().get();
      return { result, row, count };
    } finally {
      audit.close();
    }
  };

  const openMatch = create("dupe-open", "  send   maya the revised scope ");
  assert.deepEqual(openMatch.result, { applied: 0, rejected: 1, skipped: 0 });
  assert.equal(openMatch.row.status, "rejected");
  assert.equal(openMatch.row.error, "A task with this title already exists (task-open). Use task_update instead.");
  assert.equal(openMatch.count, 3);

  const recentDone = create("dupe-recent-done", "Book the Cabo flights");
  assert.deepEqual(recentDone.result, { applied: 0, rejected: 1, skipped: 0 });
  assert.equal(recentDone.row.error, "A task with this title already exists (task-done-recent). Use task_update instead.");
  assert.equal(recentDone.count, 3);

  const oldDone = create("dupe-old-done", "Renew the domain");
  assert.deepEqual(oldDone.result, { applied: 1, rejected: 0, skipped: 0 });
  assert.equal(oldDone.row.status, "applied");
  assert.equal(oldDone.count, 4);
});

test("snapshot lists recently created tasks of any status after the open list", async () => {
  const { dataDir, dbPath } = tempCove();
  const now = new Date("2026-09-03T16:00:00Z");
  const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const wake = enqueue(dbPath, { reason: "manual", note: "recent tasks", now }).job;
  const db = openLocalDatabase(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO tasks (id, title, priority, status, project, created_at, updated_at)
       VALUES (?, ?, 'medium', ?, 'Atlas', ?, ?)`,
    );
    insert.run("task-fresh-done", "Fresh finished task", "done", hoursAgo(1), hoursAgo(1));
    insert.run("task-fresh-open", "Fresh open task", "open", hoursAgo(20), hoursAgo(20));
    insert.run("task-stale-open", "Stale open task", "open", hoursAgo(72), hoursAgo(72));
  } finally {
    db.close();
  }
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: wake.id,
    wake: wake.payload,
    session: {
      sessionId: null,
      createdAt: now.toISOString(),
      mandateHash: "hash",
      wakes: 0,
      lastWakeAt: null,
      lastWakeReason: null,
    },
    dataDir,
    dbPath,
    now,
    timezone: "America/Los_Angeles",
    calendar: null,
  });
  const recentIndex = snapshot.indexOf("Recently created (any status, last 48 hours):");
  assert.ok(recentIndex > snapshot.indexOf("## Open tasks"));
  const recentBlock = snapshot.slice(recentIndex, snapshot.indexOf("## Pipeline"));
  assert.match(recentBlock, /task-fresh-done \| Fresh finished task .* \| done \|/);
  assert.match(recentBlock, /task-fresh-open \| Fresh open task/);
  assert.doesNotMatch(recentBlock, /task-stale-open/);
});
