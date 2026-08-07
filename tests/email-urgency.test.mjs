import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleUrgentEmail } from "../src/lib/attention/email-urgency.ts";
import { safeSenderDomain } from "../src/lib/attention/safety.mjs";
import { validateEmailClassification } from "../src/lib/email/classifier.ts";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-email-urgency-"));
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  const now = "2026-08-06T18:00:00.000Z";
  db.prepare(
    `INSERT INTO email_items
       (id, message_id, thread_id, status, workflow_state, thread_version,
        latest_inbound_message_id, created_at, updated_at)
     VALUES ('email-item-1', 'message-1', 'thread-1', 'pending', 'open', 1,
             'message-1', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO cove_email_messages
       (message_id, thread_id, email_item_id, direction, state, attempts,
        observed_at, processed_at, updated_at)
     VALUES ('message-1', 'thread-1', 'email-item-1', 'inbound', 'processed', 1,
             ?, ?, ?)`,
  ).run(now, now, now);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

function baseClassification(overrides = {}) {
  return {
    bucket: "action",
    summary: "A client needs an answer.",
    recommended_action: "Review it.",
    draft_body: null,
    commitments: [],
    record_correspondence: true,
    ...overrides,
  };
}

test("missing or invalid urgency fields default false without changing classification", () => {
  assert.equal(validateEmailClassification(baseClassification()).urgent, false);
  assert.equal(validateEmailClassification(baseClassification({
    urgent: "yes",
    urgency_reason: "Same-day request.",
  })).urgent, false);
  assert.equal(validateEmailClassification(baseClassification({
    urgent: true,
    urgency_reason: null,
  })).urgent, false);
  const urgent = validateEmailClassification(baseClassification({
    urgent: true,
    urgency_reason: "The meeting moved to this afternoon.",
  }));
  assert.equal(urgent.urgent, true);
  assert.equal(urgent.bucket, "action");
});

test("sender domains are punycode-normalized or safely rejected", () => {
  assert.equal(safeSenderDomain("Person <person@раypal.com>"), "xn--ypal-43d9g.com");
  assert.equal(safeSenderDomain("broken header"), "an unknown sender");
  assert.equal(safeSenderDomain("two@example.com@evil.com"), "an unknown sender");
});

test("shadow urgency writes once and never calls transport", (t) => {
  const { dir, dbPath, db } = fixture(t);
  const calls = [];
  const surfaceCalls = [];
  const result = handleUrgentEmail({
    dbPath,
    dataDir: dir,
    messageId: "message-1",
    emailItemId: "email-item-1",
    fromHeader: "Client <client@example.com>",
    urgent: true,
    urgencyReason: "The client needs a same-day answer.",
    shadow: true,
    now: new Date("2026-08-06T11:00:00-07:00"),
  }, {
    transport: {
      textConfigured: true,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => calls.push(["text", ...args]),
    },
    surface: (input) => surfaceCalls.push(input),
    surfaceSuppression: () => undefined,
  });
  assert.equal(result.status, "shadow");
  assert.deepEqual(calls, []);
  assert.equal(surfaceCalls.length, 1);
  assert.equal(db.prepare(
    "SELECT level FROM cove_attention_ledger WHERE ref_id = 'message-1'",
  ).pluck().get(), "shadow");
  // A second shadow pass must not re-log the same message.
  const shadowRepeat = handleUrgentEmail({
    dbPath,
    dataDir: dir,
    messageId: "message-1",
    emailItemId: "email-item-1",
    fromHeader: "Client <client@example.com>",
    urgent: true,
    urgencyReason: "Still urgent.",
    shadow: true,
  }, {
    transport: {
      textConfigured: true,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => calls.push(["text", ...args]),
    },
    surface: () => undefined,
    surfaceSuppression: () => undefined,
  });
  assert.equal(shadowRepeat.status, "deduped");
  assert.deepEqual(calls, []);

  // Once urgency goes live, the shadow row must not silence the real alert.
  const live = handleUrgentEmail({
    dbPath,
    dataDir: dir,
    messageId: "message-1",
    emailItemId: "email-item-1",
    fromHeader: "Client <client@example.com>",
    urgent: true,
    urgencyReason: "Still urgent.",
    shadow: false,
  }, {
    transport: {
      textConfigured: true,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => {
        calls.push(["text", ...args]);
        return true;
      },
    },
    surface: () => undefined,
    surfaceSuppression: () => undefined,
  });
  assert.notEqual(live.status, "deduped");
  assert.ok(calls.some(([channel]) => channel === "text" || channel === "banner"));
});

test("live urgency sends one safe domain-only text and deduplicates by message id", (t) => {
  const { dbPath } = fixture(t);
  const calls = [];
  const dependencies = {
    transport: {
      textConfigured: true,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => {
        calls.push(["text", ...args]);
        return true;
      },
    },
    surface: () => undefined,
    surfaceSuppression: () => undefined,
  };
  const input = {
    dbPath,
    messageId: "message-1",
    emailItemId: "email-item-1",
    fromHeader: "Client <client@раypal.com>",
    urgent: true,
    urgencyReason: "The meeting moved to today. Contact client@secret.com.",
    shadow: false,
    now: new Date("2026-08-06T13:00:00-07:00"),
  };
  assert.equal(handleUrgentEmail(input, dependencies).status, "live");
  assert.equal(handleUrgentEmail(input, dependencies).status, "deduped");
  assert.equal(calls.filter(([kind]) => kind === "text").length, 1);
  const text = calls.find(([kind]) => kind === "text")[1];
  assert.match(text, /xn--ypal-43d9g\.com/);
  assert.doesNotMatch(text, /Client|secret|meeting moved/);
  const banner = calls.find(([kind]) => kind === "banner")[1];
  assert.doesNotMatch(banner, /client@secret\.com/);
  assert.match(banner, /^from email:/);
});

test("failed urgency transports downgrade to board without spending text or banner budget", (t) => {
  const { dbPath, db } = fixture(t);
  const surfaceCalls = [];
  const result = handleUrgentEmail({
    dbPath,
    messageId: "message-1",
    emailItemId: "email-item-1",
    fromHeader: "Client <client@example.com>",
    urgent: true,
    urgencyReason: "The client needs a same-day answer.",
    shadow: false,
    now: new Date("2026-08-06T13:00:00-07:00"),
  }, {
    transport: {
      textConfigured: true,
      banner: () => {
        throw new Error("banner unavailable");
      },
      text: () => {
        throw new Error("text unavailable");
      },
    },
    surface: (input) => surfaceCalls.push(input),
    surfaceSuppression: () => undefined,
  });
  assert.equal(result.status, "live");
  assert.equal(surfaceCalls.length, 1);
  assert.deepEqual(db.prepare(
    "SELECT level, delivered_at FROM cove_attention_ledger WHERE ref_id = 'message-1'",
  ).get(), {
    level: "board",
    delivered_at: "2026-08-06T20:00:00.000Z",
  });
});

test("an urgency delivery that fails everywhere stays retryable", (t) => {
  const { dbPath, db } = fixture(t);
  const dependencies = {
    transport: {
      textConfigured: true,
      banner: () => {
        throw new Error("banner unavailable");
      },
      text: () => {
        throw new Error("text unavailable");
      },
    },
    surface: () => {
      throw new Error("board unavailable");
    },
    surfaceSuppression: () => undefined,
  };
  const input = {
    dbPath,
    messageId: "message-1",
    emailItemId: "email-item-1",
    fromHeader: "Client <client@example.com>",
    urgent: true,
    urgencyReason: "The client needs a same-day answer.",
    shadow: false,
    now: new Date("2026-08-06T13:00:00-07:00"),
  };
  assert.equal(handleUrgentEmail(input, dependencies).status, "suppressed");
  assert.equal(handleUrgentEmail(input, dependencies).status, "suppressed");
  assert.equal(db.prepare(
    `SELECT COUNT(*) FROM cove_attention_ledger
      WHERE ref_id = 'message-1' AND level = 'suppressed'
        AND suppressed_reason = 'delivery_failed'`,
  ).pluck().get(), 2);
});
