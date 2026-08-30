import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { renderLanePlist } from "../scripts/lib/render-lane-plist.mjs";
import { loadLocalEnv } from "../scripts/lib/load-local-env.mjs";
import { POST } from "../src/app/api/cove-rest/[table]/route.ts";
import { getQuietCurrentCsrfToken } from "../src/lib/quiet-current/store.ts";

const ROOT = process.cwd();

test("meeting and progress plists render the absolute Node executable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-plist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const name of [
    "com.cove.meeting-watch.plist",
    "com.cove.meeting-drain.plist",
    "com.cove.progress.plist",
  ]) {
    const destination = path.join(dir, name);
    const rendered = renderLanePlist({
      source: path.join(ROOT, "scripts", "launchd", name),
      destination,
      repoDir: "/Users/client/Cove",
      homeDir: "/Users/client",
      atlasRoot: "/Users/client/Atlas",
      dataDir: "/Users/client/Cove/data",
      nodePath: "/opt/homebrew/Cellar/node/24.1.0/bin/node",
    });
    assert.match(rendered, /<string>\/opt\/homebrew\/Cellar\/node\/24\.1\.0\/bin\/node<\/string>/);
    assert.doesNotMatch(
      rendered,
      /__COVE_(?:NODE_REAL|JOB_RUNNER|CODEX_BIN)__|<string>\/usr\/bin\/env<\/string>/,
    );
    assert.doesNotMatch(rendered, /--env-file/);
    assert.match(rendered, /<key>COVE_JOB_RUNNER<\/key>\s*<string>codex-sol-high<\/string>/);
    assert.doesNotMatch(rendered, /(?:BRIEF|DUMP)_WRITER/);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal(await readFile(destination, "utf8"), rendered);
  }

  const spacedDir = path.join(dir, "renderer with spaces");
  mkdirSync(spacedDir);
  const renderer = path.join(spacedDir, "render-lane-plist.mjs");
  const rendererLink = path.join(dir, "renderer link.mjs");
  const destination = path.join(dir, "cli-rendered.plist");
  copyFileSync(path.join(ROOT, "scripts", "lib", "render-lane-plist.mjs"), renderer);
  symlinkSync(renderer, rendererLink);
  execFileSync(process.execPath, [
    rendererLink,
    path.join(ROOT, "scripts", "launchd", "com.cove.progress.plist"),
    destination,
    "/Users/client/Cove",
    "/Users/client",
    "/Users/client/Atlas",
    "/Users/client/Cove/data",
    "/opt/homebrew/bin/node",
  ]);
  assert.match(await readFile(destination, "utf8"), /<string>\/opt\/homebrew\/bin\/node<\/string>/);
});

test("meeting watcher plist renders the exact weekday working-hours grid", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-meeting-calendar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = path.join(dir, "com.cove.meeting-watch.plist");
  renderLanePlist({
    source: path.join(ROOT, "scripts", "launchd", "com.cove.meeting-watch.plist"),
    destination,
    repoDir: "/Users/client/Cove",
    homeDir: "/Users/client",
    atlasRoot: "/Users/client/Atlas",
    dataDir: "/Users/client/Cove/data",
    nodePath: "/opt/homebrew/bin/node",
  });
  const plist = JSON.parse(execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", destination],
    { encoding: "utf8" },
  ));
  const expected = [];
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    for (let hour = 8; hour <= 17; hour += 1) {
      for (const minute of [0, 15, 30, 45]) {
        expected.push({ Weekday: weekday, Hour: hour, Minute: minute });
      }
    }
    expected.push({ Weekday: weekday, Hour: 18, Minute: 0 });
  }
  assert.equal(plist.RunAtLoad, true);
  assert.equal("StartInterval" in plist, false);
  assert.deepEqual(plist.StartCalendarInterval, expected);
});

test("meeting drain plist is an always-on 15-minute local sweep", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-meeting-drain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = path.join(dir, "com.cove.meeting-drain.plist");
  renderLanePlist({
    source: path.join(ROOT, "scripts", "launchd", "com.cove.meeting-drain.plist"),
    destination,
    repoDir: "/Users/client/Cove",
    homeDir: "/Users/client",
    atlasRoot: "/Users/client/Atlas",
    dataDir: "/Users/client/Cove/data",
    nodePath: "/opt/homebrew/bin/node",
  });
  const plist = JSON.parse(execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", destination],
    { encoding: "utf8" },
  ));
  assert.equal(plist.Label, "com.cove.meeting-drain");
  assert.deepEqual(plist.ProgramArguments.slice(-1), ["--drain-only"]);
  assert.equal(plist.StartInterval, 900);
  assert.equal(plist.RunAtLoad, true);
  assert.equal(plist.KeepAlive, false);
  assert.equal("StartCalendarInterval" in plist, false);
});

test("local env loading parses simple and quoted values without overriding the shell", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-local-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, ".env.local"), [
    "# local configuration",
    "PLAIN=value",
    "DOUBLE_QUOTED=\"two words\"",
    "SINGLE_QUOTED='three words'",
    "EXISTING=file-value",
    "",
  ].join("\n"));
  const env = { EXISTING: "shell-value" };
  assert.equal(loadLocalEnv(dir, env), env);
  assert.deepEqual(env, {
    EXISTING: "shell-value",
    PLAIN: "value",
    DOUBLE_QUOTED: "two words",
    SINGLE_QUOTED: "three words",
  });
});

test("installer creates the optional env file safely and treats a slow worker as a warning", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  assert.match(installer, /install -m 600 \/dev\/null "\$REPO_DIR\/\.env\.local"/);
  assert.match(installer, /WORKER_HEARTBEAT_EPOCH/);
  assert.match(installer, /for _ in \$\(seq 1 30\)/);
  assert.match(installer, /Warning: Cove web started/);
  assert.match(installer, /Claude worker status: ok/);
  assert.match(installer, /Claude worker status: not started/);
  assert.doesNotMatch(installer, /Claude worker did not become healthy[\s\S]{0,200}exit 1/);
});

test("task and contact skills authenticate every documented generic mutation", () => {
  const task = readFileSync(path.join(ROOT, "skills", "cove-task", "SKILL.md"), "utf8");
  const contact = readFileSync(path.join(ROOT, "skills", "cove-contact", "SKILL.md"), "utf8");
  assert.match(task, /csrfToken/);
  assert.match(task, /X-Cove-CSRF: <token from the day-plan GET>/);
  assert.match(contact, /api\/cove-rest\/companies[\s\S]{0,300}X-Cove-CSRF/);
});

test("the real Cove REST mutation route enforces the documented CSRF header", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-skill-csrf-"));
  const previous = {
    dbPath: process.env.COVE_DB_PATH,
    accessMode: process.env.COVE_DAY_PLAN_ACCESS_MODE,
    runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME,
    legacyRuntime: process.env.NEXT_PUBLIC_FORGE_RUNTIME,
  };
  process.env.COVE_DB_PATH = path.join(dir, "cove.db");
  delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
  delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
  delete process.env.NEXT_PUBLIC_FORGE_RUNTIME;
  t.after(async () => {
    globalThis.__coveDb?.close();
    delete globalThis.__coveDb;
    if (previous.dbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previous.dbPath;
    if (previous.accessMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previous.accessMode;
    if (previous.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previous.runtime;
    if (previous.legacyRuntime === undefined) delete process.env.NEXT_PUBLIC_FORGE_RUNTIME;
    else process.env.NEXT_PUBLIC_FORGE_RUNTIME = previous.legacyRuntime;
    await rm(dir, { recursive: true, force: true });
  });

  const context = { params: Promise.resolve({ table: "tasks" }) };
  const request = (token) => new NextRequest(
    "http://localhost:3200/api/cove-rest/tasks",
    {
      method: "POST",
      headers: {
        host: "localhost:3200",
        origin: "http://localhost:3200",
        "content-type": "application/json",
        ...(token ? { "x-cove-csrf": token } : {}),
      },
      body: JSON.stringify({
        id: "skill-contract-task",
        title: "Verify the CSRF contract",
      }),
    },
  );

  const missing = await POST(request(), context);
  assert.equal(missing.status, 403);
  const token = getQuietCurrentCsrfToken();
  assert.equal(
    (await readFile(path.join(dir, "quiet-current.json.token"), "utf8")).trim(),
    token,
  );
  const allowed = await POST(request(token), context);
  assert.equal(allowed.status, 201);
});

test("the distributed meeting example is disabled and the live config stays ignored", () => {
  const example = JSON.parse(
    readFileSync(path.join(ROOT, "data", "cove-meetings.example.json"), "utf8"),
  );
  const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.equal(example.enabled, false);
  assert.deepEqual(example.active_tools, []);
  assert.equal(example.window, "newer_than:4d");
  assert.doesNotMatch(ignore, /!\/data\/cove-meetings\.json(?:\n|$)/);
  assert.match(ignore, /!\/data\/cove-meetings\.example\.json/);
});
