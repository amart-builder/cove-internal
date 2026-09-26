/**
 * For a capture Cove raised on its own, `now` delivers less than `scheduled`.
 *
 * prompts/triage.md question 4 offered the model three surfaces in descending
 * order of reach: "`now` (text + notification) | `scheduled` (`surface_at`
 * time) | `board` (due date + morning brief is enough)". For an email or
 * meeting capture that ordering is inverted at the top.
 *
 * enforceSurfacePolicy (src/lib/intake/run.ts) turns a non-direct `surface:
 * "now"` into a board card with a Mac banner and nothing else -- deliberately,
 * so a stranger's words are never pushed to the phone at the moment they
 * arrive. But `scheduled` from the same source still reaches the phone:
 * fireScheduledReminders sends CONTENT_FREE_REMINDER, "Cove reminder: open the
 * board", which says nothing about the capture and so is safe to send.
 *
 * So a model that correctly reads an email as urgent, and picks the surface
 * the prompt describes as the loudest, gets the quietest delivery Cove has.
 * The same item marked one step down the list would have reached the person.
 *
 * The behaviour is right; the prompt was wrong about it. These tests pin both
 * halves of the asymmetry and pin that the prompt now states it, so nobody
 * restores the tidy-looking three-step ordering without reading this.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";
import { runCoveIntake } from "../src/lib/intake/run.ts";
import { readTriageProtocol } from "../src/lib/triage/protocol.ts";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");

const TIMEZONE = "America/Los_Angeles";
// 12:30 in Los Angeles, inside the 08:00-20:00 delivery window.
const REMINDER_NOW = "2026-09-22T19:30:00Z";
const CAPTURED_AT = new Date("2026-09-22T18:00:00.000Z");

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-surface-asymmetry-"));
  const dataDir = path.join(dir, "data");
  mkdirSync(path.join(dataDir, "brief"), { recursive: true });
  writeFileSync(path.join(dataDir, "brief", "goals.md"), "# Goals\nGrow Edge AI.");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const calls = path.join(dir, "calls.log");
  // The only outbound channel in this fixture is iMessage, which goes through
  // osascript. Stubbing it is how the phone leg becomes observable.
  writeFileSync(
    path.join(bin, "osascript"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_CALLS\"\n",
  );
  chmodSync(path.join(bin, "osascript"), 0o700);
  // The triage runner resolves its provider binary on PATH before it spawns
  // anything, and falls back to a raw-text card when it cannot find one. The
  // spawn itself is stubbed below, so this only has to exist and answer the
  // capability probe.
  const codex = path.join(bin, "codex");
  writeFileSync(
    codex,
    "#!/bin/sh\nif [ \"$1\" = \"mcp\" ]; then echo '{\"name\":\"1password\"}'; exit 0; fi\nexit 99\n",
  );
  chmodSync(codex, 0o700);
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.close();
  const reminderConfig = path.join(dir, "cove-reminders.json");
  writeFileSync(
    reminderConfig,
    JSON.stringify({ channel: "imessage", imessage_to: "+15550100" }),
  );

  const prior = {
    path: process.env.PATH,
    db: process.env.COVE_DB_PATH,
    runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME,
    timezone: process.env.COVE_TIMEZONE,
  };
  const priorDb = globalThis.__coveDb;
  delete globalThis.__coveDb;
  process.env.PATH = `${bin}${path.delimiter}${prior.path ?? ""}`;
  process.env.COVE_DB_PATH = dbPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  process.env.COVE_TIMEZONE = TIMEZONE;
  t.after(() => {
    if (prior.path === undefined) delete process.env.PATH;
    else process.env.PATH = prior.path;
    globalThis.__coveDb?.close();
    if (priorDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = priorDb;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
    if (prior.timezone === undefined) delete process.env.COVE_TIMEZONE;
    else process.env.COVE_TIMEZONE = prior.timezone;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dataDir, bin, calls, dbPath, reminderConfig };
}

function triageSpawn(payload) {
  return (executable, args) => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.once("finish", () => {
      queueMicrotask(() => {
        const output = JSON.stringify(payload);
        const outputIndex = args.indexOf("--output-last-message");
        if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], output);
        else child.stdout.write(output);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
    });
    return child;
  };
}

function coveFetch(posts) {
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/api/cove-rest/task_columns")) {
      return new Response(JSON.stringify([
        { id: "not-started", name: "Not Started", position: 0 },
        { id: "today", name: "Must happen today", position: 10 },
      ]));
    }
    if (value.includes("/api/cove-rest/tasks?")) return new Response("[]");
    if (value.endsWith("/api/day-plan")) return new Response('{"csrfToken":"csrf"}');
    if (value.endsWith("/api/cove-rest/tasks") && init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
}

function triage(overrides) {
  return {
    title: "Approve the wire before close of business",
    description: "The supplier is blocked until this clears.",
    project: "Atlas",
    priority: "high",
    due_at: "2026-09-22T16:00:00-07:00",
    autonomy: "none",
    groundwork_notes: null,
    urgency_reason: "The supplier is blocked today.",
    offer: "Want the invoice pulled up?",
    existing_task_id: null,
    ...overrides,
  };
}

async function capture(files, surfaceOverrides, source = "email") {
  const posts = [];
  const texts = [];
  const result = await runCoveIntake({
    text: "Please approve the wire before close of business.",
    source,
    sourceId: `asymmetry-${surfaceOverrides.surface}-${source}`,
  }, {
    dataDir: files.dataDir,
    repoDir: process.cwd(),
    fetchImpl: coveFetch(posts),
    webBaseUrl: "http://asymmetry.test",
    codexPath: "codex",
    spawnImpl: triageSpawn(triage(surfaceOverrides)),
    now: () => CAPTURED_AT,
    notifyNow: async (title) => texts.push(title),
    write: () => undefined,
  });
  return { result, posts, texts };
}

function reminderFiles(files) {
  const dir = path.join(files.dataDir, "reminders");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function runReminders(files) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/cove-reminders.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${files.bin}:${process.env.PATH}`,
        COVE_DB_PATH: files.dbPath,
        COVE_DATA_DIR: files.dataDir,
        COVE_REMINDER_CONFIG_PATH: files.reminderConfig,
        COVE_TEST_CALLS: files.calls,
        COVE_NOTIFICATION_APP: "/nonexistent",
        COVE_ATTENTION_NOW: REMINDER_NOW,
        COVE_TIMEZONE: TIMEZONE,
        TZ: TIMEZONE,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return existsSync(files.calls) ? readFileSync(files.calls, "utf8") : "";
}

test("an email capture marked `now` is downgraded and leaves nothing to deliver", async (t) => {
  const files = fixture(t);
  const { posts, texts } = await capture(files, { surface: "now", surface_at: null });

  assert.equal(texts.length, 0, "no text at the moment of capture");
  assert.deepEqual(reminderFiles(files), [], "and no entry for the runner to fire later");
  assert.equal(posts.length, 1);
  assert.match(
    posts[0].description,
    /Immediate text suppressed for email input\./,
    "the downgrade is recorded on the card",
  );
  // The Mac banner this path does still raise is the subject of
  // tests/intake-urgent-banner-provenance.regression-1.test.mjs; it cannot be
  // observed here because notifyNativeOnly returns early off darwin.
});

test("the same email capture marked `scheduled` does reach the phone", async (t) => {
  const files = fixture(t);
  const { texts } = await capture(files, {
    surface: "scheduled",
    surface_at: "2026-09-22T12:00:00-07:00",
  });

  assert.equal(texts.length, 0, "nothing at capture time either -- it waits");
  assert.deepEqual(
    reminderFiles(files).map((name) => name.startsWith("scheduled-")),
    [true],
    "an entry is left for the runner",
  );

  // Two legs come out of the runner: a Mac banner and an iMessage. Only the
  // second is the phone, and only the second is the point here.
  const phone = runReminders(files)
    .split("\n")
    .filter((line) => line.includes("to buddy"));
  assert.equal(phone.length, 1, "the phone is reached");
  assert.match(phone[0], /Cove reminder: open the board/);
  assert.doesNotMatch(
    phone[0],
    /wire/i,
    "with none of the capture's words, which is why this is safe to send",
  );
});

test("a capture the operator wrote keeps `now` as the loudest surface", async (t) => {
  const files = fixture(t);
  const { posts, texts } = await capture(
    files,
    { surface: "now", surface_at: null },
    "chat",
  );

  assert.deepEqual(texts, ["Approve the wire before close of business"]);
  assert.doesNotMatch(posts[0].description, /suppressed/);
});

test("the triage prompt tells the model what `now` actually does for a non-direct capture", () => {
  const protocol = readTriageProtocol();

  assert.match(
    protocol,
    /`now`[^\n]*text/,
    "question 4 still describes what `now` sends",
  );
  // The claim the prompt has to carry: for a source the operator did not write
  // from, `now` sends no text, and `scheduled` is the surface that reaches the
  // phone. Without it the model is told the opposite of what the code does.
  assert.match(protocol, /\bemail\b/, "the prompt names the sources this applies to");
  assert.match(
    protocol,
    /nothing reaches the phone/,
    "and states plainly that a non-direct `now` does not text",
  );
  assert.match(
    protocol,
    /content-free nudge/,
    "and names what `scheduled` sends instead, so the model knows the trade",
  );
});
