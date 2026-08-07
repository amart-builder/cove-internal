import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  callAttentionSweepClaude,
  readAttentionSnapshot,
  runAttentionSweep,
} from "../scripts/cove-attention-sweep.mjs";
import { validateAttentionSweepOutput } from "../src/lib/attention/sweep-protocol.mjs";
import {
  setQuietCurrentStorePathForTests,
} from "../src/lib/quiet-current/store.ts";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-attention-sweep-"));
  const dbPath = path.join(dir, "cove.db");
  const quietPath = path.join(dir, "quiet-current.json");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  setQuietCurrentStorePathForTests(quietPath);
  t.after(() => {
    db.close();
    setQuietCurrentStorePathForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

function insertTask(db, id = "task-1") {
  db.prepare(
    `INSERT INTO tasks
       (id, title, description, priority, status, source_type, position,
        project, created_at, updated_at)
     VALUES (?, 'Client deadline', 'Needs a decision today', 'high', 'open',
             'inbound_event', 0, 'Cove', ?, ?)`,
  ).run(id, "2026-08-06T08:00:00.000Z", "2026-08-06T08:00:00.000Z");
  db.prepare(
    `INSERT INTO inbound_events
       (id, source, source_id, raw_text, state, attempts, created_at, updated_at)
     VALUES (?, 'chat', ?, 'direct request', 'triaged', 0, ?, ?)`,
  ).run(id, `source-${id}`, "2026-08-06T08:00:00.000Z", "2026-08-06T08:00:00.000Z");
}

test("the frozen validator bounds refs and levels to the supplied snapshot", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../fixtures/attention-sweep.snapshot.json", import.meta.url),
    "utf8",
  ));
  const valid = validateAttentionSweepOutput({
    nudges: [{
      ref_kind: "task",
      ref_id: "task-client-deadline",
      reason: "The client deadline is today.",
      level: "banner",
    }],
  }, fixture.snapshot);
  assert.ok(valid.nudges.length >= fixture.expected.minimumNudges);
  assert.ok(valid.nudges.length <= fixture.expected.maximumNudges);
  assert.ok(fixture.expected.allowedRefs.includes(
    `${valid.nudges[0].refKind}:${valid.nudges[0].refId}`,
  ));
  assert.throws(() => validateAttentionSweepOutput({
    nudges: [{
      ref_kind: "task",
      ref_id: "not-in-snapshot",
      reason: "Invented reference.",
      level: "banner",
    }],
  }, fixture.snapshot), /outside_snapshot/);
  assert.throws(() => validateAttentionSweepOutput({
    nudges: [{
      ref_kind: "task",
      ref_id: "task-client-deadline",
      reason: "Wrong channel.",
      level: "push",
    }],
  }, fixture.snapshot), /level_invalid/);
});

test("the installer schedules only 11:30 and 16:00 and retires the wake canary", () => {
  const installer = readFileSync(
    new URL("../scripts/install-cove-local.sh", import.meta.url),
    "utf8",
  );
  const start = installer.indexOf("<string>com.cove.attention-sweep</string>");
  const end = installer.indexOf("</plist>", start);
  const block = installer.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(block, /<integer>11<\/integer><key>Minute<\/key><integer>30<\/integer>/);
  assert.match(block, /<integer>16<\/integer><key>Minute<\/key><integer>0<\/integer>/);
  assert.doesNotMatch(block, /<key>Hour<\/key><integer>7<\/integer>/);
  assert.match(installer, /launchctl bootout "gui\/\$UID_NUM\/com\.cove\.wake-canary"/);
  assert.match(installer, /rm -f "\$LA_DIR\/com\.cove\.wake-canary\.plist"/);
  assert.doesNotMatch(installer, /bootstrap[^\n]*com\.cove\.wake-canary/);
  assert.doesNotMatch(installer, /cat >[^\n]*com\.cove\.wake-canary/);
  assert.equal(existsSync(new URL("../scripts/cove-wake-canary.sh", import.meta.url)), false);
});

test("the sweep Claude seam is tool-free, empty-MCP, bounded, and minimally env-scoped", async () => {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    let stdin = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => {
      stdin += chunk;
    });
    calls.push({ executable, args, options, stdin: () => stdin });
    child.stdin.once("finish", () => {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ nudges: [] }));
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
    });
    return child;
  };
  const priorSecret = process.env.COVE_TEST_SECRET;
  process.env.COVE_TEST_SECRET = "must-not-cross";
  try {
    const result = await callAttentionSweepClaude({
      tasks: [],
      commitments: [],
      now: "2026-08-06T18:30:00.000Z",
    }, {
      repoDir: process.cwd(),
      claudePath: "/test/claude",
      spawnImpl,
      timeoutMs: 60_000,
    });
    assert.deepEqual(result, { nudges: [] });
  } finally {
    if (priorSecret === undefined) delete process.env.COVE_TEST_SECRET;
    else process.env.COVE_TEST_SECRET = priorSecret;
  }
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.executable, "/test/claude");
  assert.deepEqual(call.args.slice(0, 8), [
    "-p",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
  ]);
  assert.ok(call.args.includes("cove-empty-mcp.json") ||
    call.args.some((value) => value.endsWith("/scripts/cove-empty-mcp.json")));
  assert.equal(call.args[call.args.indexOf("--max-budget-usd") + 1], "2.00");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.COVE_TEST_SECRET, undefined);
  assert.match(call.stdin(), /<untrusted_board_snapshot>/);
});

test("shadow mode writes the ledger and Quiet Current without transport", async (t) => {
  const { dir, dbPath, db } = fixture(t);
  insertTask(db);
  const calls = [];
  const surfaces = [];
  const result = await runAttentionSweep({
    dbPath,
    dataDir: dir,
    now: new Date("2026-08-06T11:30:00-07:00"),
    shadow: true,
    claudeCall: async () => ({
      nudges: [{
        ref_kind: "task",
        ref_id: "task-1",
        reason: "A client is waiting today.",
        level: "text",
      }],
    }),
    transport: {
      textConfigured: true,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => calls.push(["text", ...args]),
    },
    surface: (input) => surfaces.push(input),
    surfaceSuppression: () => undefined,
  });
  assert.equal(result.status, "shadow");
  assert.deepEqual(calls, []);
  assert.equal(db.prepare(
    "SELECT level FROM cove_attention_ledger WHERE ref_id = 'task-1'",
  ).pluck().get(), "shadow");
  assert.match(surfaces[0].title, /^Would have interrupted:/);
});

test("a task completed after the snapshot is dropped before delivery", async (t) => {
  const { dir, dbPath, db } = fixture(t);
  insertTask(db, "complete-me");
  const calls = [];
  const result = await runAttentionSweep({
    dbPath,
    dataDir: dir,
    now: new Date("2026-08-06T16:00:00-07:00"),
    shadow: false,
    claudeCall: async () => {
      const concurrent = new Database(dbPath);
      concurrent.prepare("UPDATE tasks SET status = 'done' WHERE id = 'complete-me'").run();
      concurrent.close();
      return {
        nudges: [{
          ref_kind: "task",
          ref_id: "complete-me",
          reason: "It looked urgent in the snapshot.",
          level: "banner",
        }],
      };
    },
    transport: {
      textConfigured: false,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => calls.push(["text", ...args]),
    },
  });
  assert.equal(result.dropped, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(db.prepare(
    "SELECT level, suppressed_reason FROM cove_attention_ledger WHERE ref_id = 'complete-me'",
  ).get(), {
    level: "suppressed",
    suppressed_reason: "completed_since_snapshot",
  });
});

test("failed sweep transports downgrade the reservation to board", async (t) => {
  const { dir, dbPath, db } = fixture(t);
  insertTask(db, "fallback-to-board");
  const surfaces = [];
  const result = await runAttentionSweep({
    dbPath,
    dataDir: dir,
    now: new Date("2026-08-06T16:00:00-07:00"),
    shadow: false,
    claudeCall: async () => ({
      nudges: [{
        ref_kind: "task",
        ref_id: "fallback-to-board",
        reason: "A client is waiting today.",
        level: "text",
      }],
    }),
    transport: {
      textConfigured: true,
      banner: () => {
        throw new Error("banner unavailable");
      },
      text: () => {
        throw new Error("text unavailable");
      },
    },
    surface: (input) => surfaces.push(input),
    surfaceSuppression: () => undefined,
  });
  assert.equal(result.nudges, 1);
  assert.equal(surfaces.length, 1);
  assert.equal(db.prepare(
    "SELECT level FROM cove_attention_ledger WHERE ref_id = 'fallback-to-board'",
  ).pluck().get(), "board");
});

test("only the third consecutive failed sweep fires one banner", async (t) => {
  const { dir, dbPath } = fixture(t);
  const calls = [];
  let claudeCalls = 0;
  const options = {
    dbPath,
    dataDir: dir,
    shadow: false,
    now: new Date("2026-08-06T16:00:00-07:00"),
    claudeCall: async () => {
      claudeCalls += 1;
      throw new Error("Claude unavailable");
    },
    transport: {
      textConfigured: false,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => calls.push(["text", ...args]),
    },
  };
  assert.equal((await runAttentionSweep(options)).consecutiveFailures, 1);
  assert.equal((await runAttentionSweep(options)).consecutiveFailures, 2);
  assert.equal((await runAttentionSweep(options)).consecutiveFailures, 3);
  assert.equal(claudeCalls, 6);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /failed three times/);
});

test("shadow mode reaches no transport, not even to report its own failure", async (t) => {
  const { dir, dbPath } = fixture(t);
  const calls = [];
  const options = {
    dbPath,
    dataDir: dir,
    shadow: true,
    now: new Date("2026-08-06T16:00:00-07:00"),
    claudeCall: async () => {
      throw new Error("Claude unavailable");
    },
    transport: {
      textConfigured: true,
      banner: (...args) => calls.push(["banner", ...args]),
      text: (...args) => calls.push(["text", ...args]),
    },
  };
  assert.equal((await runAttentionSweep(options)).consecutiveFailures, 1);
  assert.equal((await runAttentionSweep(options)).consecutiveFailures, 2);
  assert.equal((await runAttentionSweep(options)).consecutiveFailures, 3);
  assert.deepEqual(calls, []);
});

test("a huge board still serializes as valid JSON inside the prompt budget", (t) => {
  const { dbPath } = fixture(t);
  const db = new Database(dbPath);
  const stamp = "2026-08-06T09:00:00.000Z";
  const insert = db.prepare(
    `INSERT INTO tasks
       (id, title, description, status, position, source_type, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, 'manual', ?, ?)`,
  );
  const wall = "x".repeat(40_000);
  for (let index = 0; index < 400; index += 1) {
    insert.run(`bulk-${index}`, `Task ${index} ${wall}`, wall, index, stamp, stamp);
  }
  const snapshot = readAttentionSnapshot(db, new Date("2026-08-06T16:00:00-07:00"));
  db.close();
  const serialized = JSON.stringify(snapshot);
  assert.ok(serialized.length <= 180_000, `snapshot was ${serialized.length} chars`);
  // Valid JSON, not a string cut in half: the model must be able to parse it.
  assert.doesNotThrow(() => JSON.parse(serialized));
  assert.ok(snapshot.tasks.length > 0);
  assert.ok(snapshot.tasks.every((task) => task.title.length <= 500));
});
