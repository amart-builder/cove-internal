import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultLocalDatabasePath, localDatabasePath, openLocalDatabase } from "../src/lib/local/database.ts";
import { loadCoveRuntimePaths } from "../scripts/lib/cove-runtime-paths.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");

test("every default database path is the one COVE_DATA_DIR controls", (t) => {
  // CONFIGURATION.md documents COVE_DB_PATH as defaulting to <data>/cove.db,
  // where <data> is COVE_DATA_DIR. Four stores used to default to
  // process.cwd()/data/cove.db instead, so setting COVE_DATA_DIR on its own --
  // which the table invites -- put tasks, contacts and email in one database
  // while the day plan, briefs, Buddy turns and task sessions went to another.
  // Two databases, no error, and a Morning Brief that cannot see the tasks.
  const previous = process.env.COVE_DATA_DIR;
  const previousDb = process.env.COVE_DB_PATH;
  const relocated = mkdtempSync(path.join(os.tmpdir(), "cove-relocated-data-"));
  t.after(() => {
    if (previous === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previous;
    if (previousDb === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDb;
    rmSync(relocated, { recursive: true, force: true });
  });
  delete process.env.COVE_DB_PATH;
  process.env.COVE_DATA_DIR = relocated;
  assert.equal(defaultLocalDatabasePath(), path.join(relocated, "cove.db"));
  assert.equal(localDatabasePath(), path.join(relocated, "cove.db"));

  // And the stores have to reach it through that one function rather than
  // rebuilding the path from the working directory.
  const libRoot = path.join(sourceRoot, "src", "lib");
  const offenders = readdirSync(libRoot, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(ts|tsx|mjs)$/.test(entry))
    .filter((entry) => /process\.cwd\(\)\s*,\s*"data"\s*,\s*"cove\.db"/
      .test(readFileSync(path.join(libRoot, entry), "utf8")));
  assert.deepEqual(offenders, [], `these resolve a database without COVE_DATA_DIR: ${offenders.join(", ")}`);

  // The private JSON beside the database has to move with it. The execution
  // registry was reading `<cwd>/data` while the profile and the workspace
  // config both honoured COVE_DATA_DIR, so a relocated install found no
  // workspaces and said nothing about why.
  const configOffenders = readdirSync(libRoot, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(ts|tsx|mjs)$/.test(entry))
    .filter((entry) => {
      const source = readFileSync(path.join(libRoot, entry), "utf8");
      return /coveConfigPath\(\s*path\.join\(\s*process\.cwd\(\)/.test(source);
    });
  assert.deepEqual(
    configOffenders,
    [],
    `these resolve a private config file without COVE_DATA_DIR: ${configOffenders.join(", ")}`,
  );
});

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cove-install-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  mkdirSync(path.join(root, "home"));
  symlinkSync(path.join(sourceRoot, "node_modules"), path.join(root, "node_modules"));
  symlinkSync(path.join(sourceRoot, "src"), path.join(root, "src"));
  for (const name of [
    "cove-backup.sh", "cove-restore-backup.sh", "cove-verify-sqlite.mjs", "cove-jobs.ts",
    "lib/load-local-env.mjs", "lib/cove-runtime-paths.mjs",
    "lib/cove-install-runtime.mjs", "lib/cove-serving.sh",
  ]) copyFileSync(path.join(sourceRoot, "scripts", name), path.join(root, "scripts", name));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:COVE_|FORGE_|NEXT_PUBLIC_COVE_|NEXT_PUBLIC_FORGE_)/.test(key)));
  Object.assign(env, {
    HOME: path.join(root, "home"),
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    COVE_NODE_PATH: process.execPath,
    // Scratch databases under a scratch HOME, so the restore script's "is any
    // Cove service loaded" gate is about somebody else's installation here.
    COVE_RESTORE_ALLOW_RUNNING: "1",
  });
  return { root, env };
}

function taskDatabase(file, title) {
  const db = openLocalDatabase(file);
  db.prepare("INSERT INTO task_columns (id,name,position,is_default,created_at,updated_at) VALUES ('col','Today',0,1,'now','now')").run();
  db.prepare("INSERT INTO tasks (id,column_id,title,status,tags,project,position,source_type) VALUES ('task','col',?,'open','[]','Cove',0,'manual')").run(title);
  db.close();
}

function titleAt(file) {
  const db = openLocalDatabase(file);
  try { return db.prepare("SELECT title FROM tasks WHERE id='task'").pluck().get(); }
  finally { db.close(); }
}

for (const { configKind, relative } of ["DB_PATH", "DATA_DIR"].flatMap(configKind =>
  [false, true].map(relative => ({ configKind, relative })))) {
  test(`backup and restore use ${relative ? "relative " : ""}${configKind} saved only in .env.local${relative ? " from a foreign cwd" : ""}`, (t) => {
    const { root, env } = fixture(t);
    const privateDir = path.join(root, "private data");
    const selected = path.join(privateDir, "cove.db");
    const decoy = path.join(root, "data/cove.db");
    const backups = path.join(root, "recovery snapshots");
    taskDatabase(selected, "Selected original");
    taskDatabase(decoy, "Unrelated default");
    const configPath = value => relative ? path.relative(root, value) : value;
    writeFileSync(path.join(root, ".env.local"),
      `COVE_${configKind}="${configPath(configKind === "DB_PATH" ? selected : privateDir)}"\nCOVE_BACKUP_DIR="${configPath(backups)}"\n`);
    const cwd = relative ? path.join(root, "home") : root;

    const backup = spawnSync("/bin/bash", [path.join(root, "scripts/cove-backup.sh")], {
      cwd, env, encoding: "utf8",
    });
    assert.equal(backup.status, 0, `${backup.stdout}\n${backup.stderr}`);
    const snapshots = readdirSync(backups).filter(name => name.endsWith(".db"));
    assert.equal(snapshots.length, 1);
    const snapshot = path.join(backups, snapshots[0]);
    assert.equal(titleAt(snapshot), "Selected original");
    assert.equal(titleAt(decoy), "Unrelated default");
    const changed = openLocalDatabase(selected);
    changed.prepare("UPDATE tasks SET title='Changed after snapshot' WHERE id='task'").run();
    changed.close();

    const restore = spawnSync("/bin/bash", [path.join(root, "scripts/cove-restore-backup.sh"), "--yes", snapshot], {
      cwd, env, encoding: "utf8",
    });
    assert.equal(restore.status, 0, `${restore.stdout}\n${restore.stderr}`);
    assert.equal(titleAt(selected), "Selected original");
    assert.equal(titleAt(decoy), "Unrelated default");
    const preserved = readdirSync(path.join(backups, "recovery")).find(name => name.endsWith(".db"));
    assert.ok(preserved, "restore preserves the actual replaced database");
    assert.equal(titleAt(path.join(backups, "recovery", preserved)), "Changed after snapshot");
  });
}

test("missing configured database fails backup without creating or backing up the default database", (t) => {
  const { root, env } = fixture(t);
  writeFileSync(path.join(root, ".env.local"), `COVE_DB_PATH=${path.join(root, "missing/cove.db")}\n`);
  const result = spawnSync("/bin/bash", [path.join(root, "scripts/cove-backup.sh")], {
    cwd: root, env, encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /no backup was created/);
  assert.equal(existsSync(path.join(root, "data/cove.db")), false);
});

test("runtime path resolution preserves explicit settings and canonical/legacy database precedence", (t) => {
  const { root } = fixture(t);
  const privateDir = path.join(root, "private");
  mkdirSync(privateDir);
  writeFileSync(path.join(root, ".env.local"), `COVE_DATA_DIR=${privateDir}\n`);
  const legacy = path.join(privateDir, "forge.db");
  const canonical = path.join(privateDir, "cove.db");
  writeFileSync(legacy, "legacy fixture");
  assert.equal(loadCoveRuntimePaths(root, {}).dbPath, legacy);
  writeFileSync(canonical, "canonical fixture");
  assert.equal(loadCoveRuntimePaths(root, {}).dbPath, canonical);
  const explicit = path.join(root, "override.db");
  assert.equal(loadCoveRuntimePaths(root, { COVE_DB_PATH: explicit }).dbPath, explicit);
  // Check parity with the app without modifying the caller's environment.
  // package.json has no "type": "module", so tsx hands a .ts module to a bare
  // --input-type=module eval as CommonJS: a static named import of a real
  // export fails with "does not provide an export named". Go through a dynamic
  // import and accept either shape rather than asserting the interop.
  const check = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const m = await import(${JSON.stringify(path.join(sourceRoot, "src/lib/local/database.ts"))});`
    + ` const resolve = m.defaultLocalDatabasePath ?? m.default?.defaultLocalDatabasePath;`
    + ` process.stdout.write(resolve(${JSON.stringify(root)}));`,
  ], { cwd: sourceRoot, env: { PATH: process.env.PATH, COVE_DATA_DIR: privateDir }, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, canonical);
});

test("installer readiness fails when the new worker heartbeat is missing", (t) => {
  const { root, env } = fixture(t);
  const installer = readFileSync(path.join(sourceRoot, "scripts/install-cove-local.sh"), "utf8");
  const start = installer.indexOf("# Confirm the server actually came up.");
  assert.ok(start > 0);
  const backupStub = path.join(root, "backup-stub");
  writeFileSync(backupStub, '#!/bin/sh\nprintf "called" > "$COVE_TEST_BACKUP"\n');
  chmodSync(backupStub, 0o700);
  const runner = path.join(root, "readiness.sh");
  writeFileSync(runner, `#!/bin/bash
set -euo pipefail
curl() {
  # The readiness loop now asks /api/health whether the thing answering is
  # actually Cove, so the stub has to answer as Cove would.
  case "$*" in
    *"/api/health"*) printf '{"snapshot":null,"readiness":{"checkedAt":"2026-09-21T00:00:00.000Z"}}' ;;
    *) printf '200' ;;
  esac
}
stat() { printf '%s' "$COVE_TEST_HEARTBEAT"; }
sleep() { :; }
LANE_DATA_DIR="$COVE_TEST_ROOT"
COVE_BRIEF_WEB_BASE="http://127.0.0.1:4317"
WORKER_START_EPOCH=100
LOG_DIR="$COVE_TEST_ROOT"
REPO_DIR="$COVE_TEST_ROOT"
COVE_BACKUP_DIR="$COVE_TEST_ROOT/backups"
TSX_BIN="$COVE_TEST_ROOT/backup-stub"
UID_NUM=999
INSTALL_MEETING_LANE=1
INSTALL_PROGRESS_LANE=1
INSTALL_VOICE_REVIEW_LANE=1
INSTALL_CHIEF_OF_STAFF_LANE=1
${installer.slice(start)}`);
  const backupReceipt = path.join(root, "backup-called");
  const missing = spawnSync("/bin/bash", [runner], { encoding: "utf8", env: {
    ...env, COVE_TEST_ROOT: root, COVE_TEST_HEARTBEAT: "0", COVE_TEST_BACKUP: backupReceipt,
  } });
  assert.equal(missing.status, 1, `${missing.stdout}\n${missing.stderr}`);
  assert.match(missing.stderr, /setup is incomplete/);
  assert.doesNotMatch(missing.stdout, /Cove is running at/);
  assert.equal(existsSync(backupReceipt), false);

  const healthy = spawnSync("/bin/bash", [runner], { encoding: "utf8", env: {
    ...env, COVE_TEST_ROOT: root, COVE_TEST_HEARTBEAT: "101", COVE_TEST_BACKUP: backupReceipt,
  } });
  assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`);
  assert.equal(readFileSync(backupReceipt, "utf8"), "called");
  assert.match(healthy.stdout, /Claude worker status: ok/);
  // The closing summary is the lane inventory AGENTS.md has you read back to
  // the person, so it has to name the chief-of-staff lanes when they are on
  // and never the retired attention-sweep agent this script deletes.
  assert.match(healthy.stdout, /Chief of staff: sweeps at 11:30 and 16:00/);
  assert.doesNotMatch(healthy.stdout, /Attention sweep:/);
});

test("installer schedules email from the resolved private data root", (t) => {
  const { root, env } = fixture(t);
  const privateDir = path.join(root, "private");
  mkdirSync(privateDir);
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(privateDir, "cove-workspace.json"), JSON.stringify({ triage_times: ["06:30", "16:45"] }));
  writeFileSync(path.join(root, "data/cove-workspace.json"), JSON.stringify({ triage_times: ["09:00"] }));
  const installer = readFileSync(path.join(sourceRoot, "scripts/install-cove-local.sh"), "utf8");
  const start = installer.indexOf('EMAIL_CONFIG=');
  const end = installer.indexOf('# (Re)load all agents', start);
  assert.ok(start > 0 && end > start);
  const runtimeBlock = /xml_escape\(\) \{[\s\S]*?\n\nmkdir -p/.exec(installer)?.[0].replace(/\n\nmkdir -p$/, "");
  assert.ok(runtimeBlock, "execute the actual installer runtime environment renderer");
  const runner = path.join(root, "email-render.sh");
  writeFileSync(runner, `#!/bin/bash
set -euo pipefail
REPO_DIR="$COVE_TEST_ROOT"
LANE_DATA_DIR="$COVE_TEST_ROOT/private"
TRIAGE_PLIST="$COVE_TEST_ROOT/triage.plist"
LOG_DIR="$COVE_TEST_ROOT"
NODE_BIN="$(dirname "$COVE_NODE_PATH")"
JOB_RUNNER=claude
CODEX_PLIST_ENTRY=""
NOTIFICATION_PLIST_ENTRY=""
COVE_DATA_DIR="$LANE_DATA_DIR"
COVE_DB_PATH="$LANE_DATA_DIR/cove.db"
COVE_BRIEF_WEB_BASE="http://127.0.0.1:4317"
${runtimeBlock}
${installer.slice(start, end)}`);
  const result = spawnSync("/bin/bash", [runner], {
    env: { ...env, COVE_TEST_ROOT: root }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const plist = readFileSync(path.join(root, "triage.plist"), "utf8");
  assert.match(plist, /<integer>6<\/integer><key>Minute<\/key><integer>30<\/integer>/);
  assert.match(plist, /<integer>16<\/integer><key>Minute<\/key><integer>45<\/integer>/);
  assert.doesNotMatch(plist, /<key>Hour<\/key><integer>9<\/integer>/);
});
