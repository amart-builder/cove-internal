import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";
import { getQuietCurrentCsrfToken } from "../src/lib/quiet-current/store.ts";
import {
  clearStoredJevCredential,
  jevCredentialPath,
  jevCredentialStatus,
  normaliseJevCredential,
  resolveJevCredential,
  saveJevCredential,
  withJevCredential,
} from "../src/lib/jev/credential.ts";
import { readJevLastAttempts, recordJevAttempt } from "../src/lib/jev/ledger.ts";
import { credentialMessage, laneStatusMessage } from "../src/lib/jev/presentation.ts";
import { readJevSettings, writeJevSettings } from "../src/lib/jev/settings.ts";
import {
  GET,
  PATCH,
  modeAfterPatch,
  parseJevSettingsPatch,
} from "../src/app/api/jev-settings/implementation.ts";

// Obviously not a key. Nothing in this repository ever carries a real one.
const KEY = "apikey_settings_screen_test_only";
const OTHER_KEY = "apikey_settings_screen_second_key";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-jev-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function install(t) {
  const dir = fixture(t);
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.close();
  const before = {
    dataDir: process.env.COVE_DATA_DIR,
    dbPath: process.env.COVE_DB_PATH,
    runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME,
    key: process.env.COVE_TYPESAFE_API_KEY,
  };
  process.env.COVE_DATA_DIR = dir;
  process.env.COVE_DB_PATH = dbPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  delete process.env.COVE_TYPESAFE_API_KEY;
  t.after(() => {
    for (const [name, value] of [
      ["COVE_DATA_DIR", before.dataDir],
      ["COVE_DB_PATH", before.dbPath],
      ["NEXT_PUBLIC_COVE_RUNTIME", before.runtime],
      ["COVE_TYPESAFE_API_KEY", before.key],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return { dir, dbPath };
}

const headers = {
  host: "localhost:3200",
  origin: "http://localhost:3200",
  "content-type": "application/json",
};

function read() {
  return GET(new NextRequest("http://localhost:3200/api/jev-settings", { headers }));
}

function write(body, extra = {}) {
  return PATCH(new NextRequest("http://localhost:3200/api/jev-settings", {
    method: "PATCH",
    headers: { ...headers, "x-cove-csrf": getQuietCurrentCsrfToken(), ...extra },
    body: JSON.stringify(body),
  }));
}

test("a pasted key is stored on this Mac, readable by nobody else, and never read back", (t) => {
  const dir = fixture(t);
  assert.deepEqual(jevCredentialStatus({ dataDir: dir, env: {} }), {
    configured: false,
    source: "none",
  });

  const saved = saveJevCredential({ dataDir: dir, credential: `  ${KEY}\n`, now: new Date(0) });
  assert.equal(saved.source, "stored");
  assert.equal(saved.hint, KEY.slice(-4));
  assert.equal(saved.savedAt, new Date(0).toISOString());
  assert.equal(resolveJevCredential({ dataDir: dir, env: {} }), KEY);

  const file = jevCredentialPath(dir);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).credential, KEY);

  const status = jevCredentialStatus({ dataDir: dir, env: {} });
  assert.equal(status.configured, true);
  assert.equal(status.hint, KEY.slice(-4));
  assert.ok(!JSON.stringify(status).includes(KEY), "status must not carry the key");

  assert.equal(clearStoredJevCredential(dir), true);
  assert.equal(existsSync(file), false);
  assert.equal(resolveJevCredential({ dataDir: dir, env: {} }), undefined);
});

test("an environment key still wins, and a stored key reaches a lane that only reads the environment", (t) => {
  const dir = fixture(t);
  saveJevCredential({ dataDir: dir, credential: KEY });

  const environment = { COVE_TYPESAFE_API_KEY: OTHER_KEY };
  assert.equal(resolveJevCredential({ dataDir: dir, env: environment }), OTHER_KEY);
  assert.equal(jevCredentialStatus({ dataDir: dir, env: environment }).source, "environment");
  assert.equal(withJevCredential(environment, dir), environment);

  const hydrated = withJevCredential({}, dir);
  assert.equal(hydrated.COVE_TYPESAFE_API_KEY, KEY);
  assert.equal(process.env.COVE_TYPESAFE_API_KEY, undefined);

  // An install with no stored key is handed its own environment back unchanged.
  const empty = fixture(t);
  const bare = {};
  assert.equal(withJevCredential(bare, empty), bare);
});

test("a key that would fail at TypeSafe as a 401 is refused where there is someone to tell", () => {
  assert.throws(() => normaliseJevCredential(""), /Paste the TypeSafe key first/);
  assert.throws(() => normaliseJevCredential("short"), /does not look like/);
  assert.throws(() => normaliseJevCredential(42), /as text/);
  assert.throws(() => normaliseJevCredential(`${KEY} ${KEY}`), /spaces or unusual/);
  assert.equal(normaliseJevCredential(` ${KEY} `), KEY);
});

test("the screen reads the settings, the key's source, and what each lane last did", (t) => {
  const { dir, dbPath } = install(t);
  writeJevSettings({ dataDir: dir, mode: "shadow", features: { emailTriage: true } });
  const db = new Database(dbPath);
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "jev_unauthorized",
    status: 401,
    reservedInputTokens: 900,
    latencyMs: 12,
    occurredAt: "2026-09-20T10:00:00.000Z",
  });
  db.close();

  return read().then(async (response) => {
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.mode, "shadow");
    assert.equal(state.credential.configured, false);
    const triage = state.lanes.find((lane) => lane.feature === "emailTriage");
    assert.equal(triage.enabled, true);
    // Switched on, but there is no key, so it is not running and says so.
    assert.equal(triage.running, false);
    assert.equal(triage.lastAttempt.outcome, "jev_unauthorized");
    assert.equal(
      laneStatusMessage(triage, { mode: state.mode, credentialConfigured: false }),
      "Switched on, but there is no key yet, so nothing runs.",
    );
    assert.deepEqual(
      state.lanes.map((lane) => lane.feature),
      ["emailTriage", "commitmentAudit", "meetingAudit", "waitingResolution"],
    );
    assert.equal(state.lanes.find((lane) => lane.feature === "meetingAudit").lastAttempt, undefined);
  });
});

test("switching a lane on from the screen starts shadow mode, as the terminal command does", (t) => {
  const { dir } = install(t);
  assert.equal(readJevSettings({ dataDir: dir, env: {} }).mode, "off");

  return write({ features: { waitingResolution: true } }).then(async (response) => {
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.mode, "shadow");
    const stored = readJevSettings({ dataDir: dir, env: {} });
    assert.equal(stored.mode, "shadow");
    assert.equal(stored.features.waitingResolution, true);
    assert.equal(stored.features.emailTriage, false);

    // Stopping everything is one switch and leaves the lane's own switch alone,
    // so resuming does not mean remembering what was on.
    const stopped = await (await write({ mode: "off" })).json();
    assert.equal(stopped.mode, "off");
    assert.equal(readJevSettings({ dataDir: dir, env: {} }).features.waitingResolution, true);
  });
});

test("saving the key from the screen is what makes a switched-on lane actually run", (t) => {
  const { dir } = install(t);
  return write({ features: { emailTriage: true } }).then(async () => {
    const saved = await (await write({ credential: KEY })).json();
    assert.equal(saved.credential.configured, true);
    assert.equal(saved.credential.source, "stored");
    assert.equal(saved.credential.hint, KEY.slice(-4));
    assert.ok(!JSON.stringify(saved).includes(KEY), "the route must not echo the key");
    assert.equal(saved.lanes.find((lane) => lane.feature === "emailTriage").running, true);
    assert.equal(resolveJevCredential({ dataDir: dir, env: {} }), KEY);
    assert.equal(
      credentialMessage(saved.credential),
      `A key ending ${KEY.slice(-4)} is saved on this Mac.`,
    );

    const removed = await (await write({ credential: null })).json();
    assert.equal(removed.credential.configured, false);
    assert.equal(removed.lanes.find((lane) => lane.feature === "emailTriage").enabled, true);
    assert.equal(removed.lanes.find((lane) => lane.feature === "emailTriage").running, false);
  });
});

test("the settings route is local-only, CSRF-protected, and refuses what it cannot read", async (t) => {
  const { dir } = install(t);
  assert.equal((await write({ mode: "off" }, { "x-cove-csrf": "" })).status, 403);
  assert.equal(
    (await write({ mode: "off" }, { origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await write({ features: { notALane: true } })).status, 400);
  assert.equal((await write({ mode: "assist" })).status, 400);
  assert.equal((await write({ credential: "too-short" })).status, 400);
  assert.equal((await write({ nonsense: true })).status, 400);
  // Nothing above reached the store.
  assert.equal(resolveJevCredential({ dataDir: dir, env: {} }), undefined);
  assert.equal(readJevSettings({ dataDir: dir, env: {} }).mode, "off");

  process.env.NEXT_PUBLIC_COVE_RUNTIME = "convex";
  assert.equal((await read()).status, 404);
});

test("a patch is read strictly, and turning a lane on never leaves the mode behind", () => {
  assert.deepEqual(parseJevSettingsPatch({ mode: "shadow" }), { mode: "shadow" });
  assert.deepEqual(
    parseJevSettingsPatch({ features: { meetingAudit: false } }),
    { features: { meetingAudit: false } },
  );
  assert.throws(() => parseJevSettingsPatch({ features: {} }), /Name a lane/);
  assert.throws(() => parseJevSettingsPatch({ features: { emailTriage: "yes" } }), /on or off/);
  assert.throws(() => parseJevSettingsPatch({ credential: 7 }), /as text/);
  assert.throws(() => parseJevSettingsPatch([]), /could not read/);
  assert.throws(() => parseJevSettingsPatch({}), /Nothing to change/);

  assert.equal(modeAfterPatch("off", { features: { emailTriage: true } }), "shadow");
  assert.equal(modeAfterPatch("off", { features: { emailTriage: false } }), undefined);
  assert.equal(modeAfterPatch("shadow", { features: { emailTriage: true } }), undefined);
  assert.equal(modeAfterPatch("shadow", { mode: "off" }), "off");
});

test("the ledger hands the screen one last attempt per lane and nothing for a lane that never ran", (t) => {
  const dir = fixture(t);
  const db = new Database(path.join(dir, "cove.db"));
  runLocalMigrations(db);
  for (const [outcome, occurredAt] of [
    ["jev_timeout", "2026-09-20T09:00:00.000Z"],
    ["ok", "2026-09-20T09:05:00.000Z"],
  ]) {
    recordJevAttempt({
      db,
      feature: "meetingAudit",
      outcome,
      reservedInputTokens: 500,
      latencyMs: 5,
      occurredAt,
    });
  }
  const latest = readJevLastAttempts({ db });
  db.close();
  assert.equal(latest.meetingAudit.outcome, "ok");
  assert.equal(latest.meetingAudit.occurredAt, "2026-09-20T09:05:00.000Z");
  assert.equal(latest.emailTriage, undefined);
});

test("every reason a lane is not running is said in the operator's words", () => {
  const lane = { feature: "emailTriage", enabled: true, running: false };
  assert.equal(
    laneStatusMessage({ ...lane, enabled: false }, { mode: "shadow", credentialConfigured: true }),
    "Off.",
  );
  assert.equal(
    laneStatusMessage(lane, { mode: "off", credentialConfigured: true }),
    "Switched on, but Jev is stopped, so nothing runs.",
  );
  assert.match(
    laneStatusMessage(
      { ...lane, breaker: { state: "open", until: "2026-09-20T11:00:00.000Z" } },
      { mode: "shadow", credentialConfigured: true },
    ),
    /^Paused after repeated failures\. It tries again at /,
  );
  assert.equal(
    laneStatusMessage(lane, { mode: "shadow", credentialConfigured: true }),
    "Recording. Nothing has come through it yet.",
  );
  assert.match(
    laneStatusMessage(
      { ...lane, lastAttempt: { outcome: "jev_unauthorized", occurredAt: "2026-09-20T10:00:00.000Z" } },
      { mode: "shadow", credentialConfigured: true },
    ),
    /TypeSafe rejected the key at .*\. Paste it again below\.$/,
  );
  assert.equal(
    credentialMessage({ configured: false, source: "none" }),
    "No key yet. Nothing calls TypeSafe without one.",
  );
  assert.match(
    credentialMessage({ configured: true, source: "environment", hint: "1234" }),
    /\.env\.local file, and that one wins/,
  );
});
