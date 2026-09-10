import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getQuietCurrentSnapshot } from "../src/lib/quiet-current/store.ts";
import { allocateAttention } from "../src/lib/attention/ledger.mjs";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-attention-floor-"));
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls.log");
  const texts = path.join(dir, "texts.log");
  const dbPath = path.join(dir, "cove.db");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_CALLS\"\n");
  writeFileSync(path.join(bin, "ssh"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_TEXTS\"\n");
  chmodSync(path.join(bin, "osascript"), 0o700);
  chmodSync(path.join(bin, "ssh"), 0o700);
  const config = path.join(dir, "reminders.json");
  writeFileSync(config, JSON.stringify({
    channel: "imessage",
    imessage_to: "+13105550123",
    remote_host: "operator@100.64.0.9",
  }));
  const db = new Database(dbPath);
  runLocalMigrations(db);
  t.after(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bin, calls, texts, config, dbPath, db };
}

function insertTask(db, input) {
  db.prepare(
    `INSERT INTO tasks
       (id, title, status, due_at, source_type, remind_native, remind_text,
        position, project, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'Cove', ?, ?)`,
  ).run(
    input.id,
    input.title,
    input.status ?? "open",
    "2099-08-06",
    input.sourceType ?? "inbound_event",
    "2099-08-01T00:00:00.000Z",
    "2099-08-01T00:00:00.000Z",
  );
  if (input.inboundSource) {
    db.prepare(
      `INSERT INTO inbound_events
         (id, source, source_id, raw_text, state, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'source text', 'triaged', 0, ?, ?)`,
    ).run(
      input.id,
      input.inboundSource,
      `source-${input.id}`,
      "2099-08-01T00:00:00.000Z",
      "2099-08-01T00:00:00.000Z",
    );
  }
}

test("the noon floor excludes production meeting tasks from its direct count", (t) => {
  const { dir, bin, calls, texts, config, dbPath, db } = fixture(t);
  insertTask(db, { id: "direct-task", title: "Review launch", inboundSource: "chat" });
  insertTask(db, {
    id: "meeting-task",
    title: "Call https://secret.example.com alice@example.com +13105551212",
    inboundSource: "meeting",
  });
  insertTask(db, { id: "done-task", title: "Already done", inboundSource: "chat", status: "done" });
  assert.equal(
    db.prepare("SELECT source_type FROM tasks WHERE id = 'meeting-task'").pluck().get(),
    "inbound_event",
  );
  db.prepare(
    `INSERT INTO commitments
       (id, kind, title, counterparty, source_kind, due_at, confidence,
        confirmed, status, created_at, updated_at)
     VALUES ('commitment-1', 'promise', 'Send the promised recap', 'Jordan',
             'manual', '2099-08-05', 'high', 1, 'open', ?, ?)`,
  ).run("2099-08-01T00:00:00.000Z", "2099-08-01T00:00:00.000Z");
  db.close();

  const run = () => spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/cove-reminders.mjs",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_DATA_DIR: dir,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_ATTENTION_NOW: "2099-08-06T12:00:00-07:00",
      COVE_TEST_CALLS: calls,
      COVE_TEST_TEXTS: texts,
    },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const banners = readFileSync(calls, "utf8");
  assert.match(banners, /Due today and still open in Cove: Review launch/);
  assert.match(banners, /from meeting:/);
  assert.doesNotMatch(banners, /secret\.example|alice@example|13105551212/);
  assert.doesNotMatch(banners, /Already done/);
  // The meeting task is source_type=inbound_event with source=meeting, so only
  // the direct task and the manual commitment contribute to this count.
  const sent = readFileSync(texts, "utf8");
  assert.equal(sent.match(/Cove: 2 things need a look\. Open the board\./g)?.length, 1);
  assert.equal(sent.match(/Open the board\./g)?.length, 1);

  const check = new Database(dbPath, { readonly: true });
  const rows = check.prepare(
    `SELECT ref_kind, ref_id, level FROM cove_attention_ledger
     WHERE level IN ('text','banner') ORDER BY ref_id`,
  ).all();
  assert.deepEqual(rows, [
    { ref_kind: "task", ref_id: "__floor_daily__:2099-08-06", level: "text" },
    { ref_kind: "commitment", ref_id: "commitment-1", level: "banner" },
    { ref_kind: "task", ref_id: "direct-task", level: "banner" },
    { ref_kind: "task", ref_id: "meeting-task", level: "banner" },
  ]);
  check.close();

  const before = `${banners}\n${sent}`;
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(`${readFileSync(calls, "utf8")}\n${readFileSync(texts, "utf8")}`, before);
});

test("floor cap exhaustion writes suppression rows and one Quiet Current line", (t) => {
  const { dir, bin, calls, texts, config, dbPath, db } = fixture(t);
  const now = new Date("2099-08-06T12:00:00-07:00");
  for (let index = 0; index < 6; index += 1) {
    allocateAttention(db, {
      kind: index % 2 === 0 ? "sweep_nudge" : "urgent_email",
      refKind: index % 2 === 0 ? "task" : "email",
      refId: `budget-${index}`,
      requestedLevel: "banner",
      reason: "Budget fixture.",
      now,
    });
  }
  insertTask(db, { id: "capped-floor", title: "Capped floor item", inboundSource: "chat" });
  db.close();
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/cove-reminders.mjs",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_DATA_DIR: dir,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_ATTENTION_NOW: now.toISOString(),
      COVE_TEST_CALLS: calls,
      COVE_TEST_TEXTS: texts,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const check = new Database(dbPath, { readonly: true });
  assert.ok(check.prepare(
    `SELECT 1 FROM cove_attention_ledger
     WHERE ref_id = 'capped-floor' AND level = 'suppressed'
       AND suppressed_reason = 'daily_banner_cap'`,
  ).get());
  check.close();
  const quiet = getQuietCurrentSnapshot(dir);
  assert.equal(quiet.suggestions.length, 1);
  assert.equal(quiet.suggestions[0].title, "Nudges were suppressed");
});

test("a broken text channel produces one fallback banner, not one every tick", (t) => {
  const { dir, bin, calls, texts, config, dbPath, db } = fixture(t);
  // The relay is unreachable, so every text attempt throws.
  writeFileSync(path.join(bin, "ssh"), "#!/bin/sh\nexit 255\n");
  chmodSync(path.join(bin, "ssh"), 0o700);
  insertTask(db, { id: "direct-task", title: "Ship the newsletter", inboundSource: "chat" });
  db.close();

  const run = (minute) => spawnSync(process.execPath, [
    "--import",
    "tsx",
    "scripts/cove-reminders.mjs",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_DATA_DIR: dir,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_ATTENTION_NOW: `2099-08-06T12:${minute}:00-07:00`,
      COVE_TEST_CALLS: calls,
      COVE_TEST_TEXTS: texts,
    },
  });
  assert.equal(run("00").status, 0);
  assert.equal(run("01").status, 0);
  assert.equal(run("02").status, 0);

  const banners = readFileSync(calls, "utf8");
  // The fallback banner is a real interruption, so it must start a cooldown
  // instead of firing again on the next sixty-second tick.
  assert.equal(banners.match(/I couldn't deliver your text reminder:/g)?.length, 1);
  const check = new Database(dbPath, { readonly: true });
  assert.equal(check.prepare(
    `SELECT level FROM cove_attention_ledger
      WHERE ref_id LIKE '__floor_daily__%'`,
  ).pluck().get(), "banner");
  check.close();
});

test('an uncertain text with a failed fallback retains its claim and never blindly resends',t=>{
 const {dir,bin,calls,texts,config,dbPath,db}=fixture(t);
 writeFileSync(path.join(bin,'ssh'),'#!/bin/sh\nprintf "attempt\\n" >> "$COVE_TEST_TEXTS"\nprintf "ETIMEDOUT\\n" >&2\nexit 255\n');
 writeFileSync(path.join(bin,'osascript'),'#!/bin/sh\nexit 1\n');
 insertTask(db,{id:'direct-task',title:'Review the launch',inboundSource:'chat'});db.close();
 const run=minute=>spawnSync(process.execPath,['--import','tsx','scripts/cove-reminders.mjs'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,COVE_DB_PATH:dbPath,COVE_DATA_DIR:dir,COVE_REMINDER_CONFIG_PATH:config,COVE_ATTENTION_NOW:`2099-08-06T12:${minute}:00-07:00`,COVE_TEST_CALLS:calls,COVE_TEST_TEXTS:texts}});
 for(const minute of ['00','01','02'])assert.equal(run(minute).status,0);
 assert.equal(readFileSync(texts,'utf8'),'attempt\n');
 const check=new Database(dbPath,{readonly:true});
 assert.deepEqual(check.prepare("SELECT level,suppressed_reason FROM cove_attention_ledger WHERE ref_id LIKE '__floor_daily__%' AND level='text'").get(),{level:'text',suppressed_reason:'delivery_uncertain'});
 assert.equal(check.prepare("SELECT count(*) FROM cove_failure_inbox WHERE source='reminder-delivery' AND dismissed_at IS NULL").pluck().get(),1);check.close();
});
