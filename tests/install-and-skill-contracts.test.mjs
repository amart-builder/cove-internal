import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { renderLanePlist } from "../scripts/lib/render-lane-plist.mjs";
import { loadLocalEnv } from "../scripts/lib/load-local-env.mjs";
import { POST } from "../src/app/api/cove-rest/[table]/route.ts";
import { getQuietCurrentCsrfToken } from "../src/lib/quiet-current/store.ts";

const ROOT = process.cwd();
const execFileAsync = promisify(execFile);

test("meeting and progress plists render the absolute Node executable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-plist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const name of [
    "com.cove.meeting-watch.plist",
    "com.cove.meeting-drain.plist",
    "com.cove.progress.plist",
    "com.cove.voice-review.plist",
    "com.cove.chief-of-staff-drain.plist",
    "com.cove.chief-of-staff-sweep.plist",
    "com.cove.chief-of-staff-nightly.plist",
    "com.cove.chief-of-staff-review.plist",
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
      notificationApp: "/Users/client/Applications/Cove Notifications.app/Contents/MacOS/CoveNotifier",
    });
    assert.match(rendered, /<string>\/opt\/homebrew\/Cellar\/node\/24\.1\.0\/bin\/node<\/string>/);
    assert.doesNotMatch(
      rendered,
      /__COVE_(?:NODE_REAL|JOB_RUNNER|CODEX_BIN|NOTIFICATION_APP)__|<string>\/usr\/bin\/env<\/string>/,
    );
    assert.doesNotMatch(rendered, /--env-file/);
    if (name.startsWith("com.cove.chief-of-staff-")) {
      assert.doesNotMatch(rendered, /<key>COVE_JOB_RUNNER<\/key>/);
    } else {
      assert.match(rendered, /<key>COVE_JOB_RUNNER<\/key>\s*<string>codex-sol-high<\/string>/);
    }
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

test("voice review plist runs Sundays at 18:00 without login catch-up", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-voice-review-calendar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = path.join(dir, "com.cove.voice-review.plist");
  renderLanePlist({
    source: path.join(ROOT, "scripts", "launchd", "com.cove.voice-review.plist"),
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
  assert.equal(plist.Label, "com.cove.voice-review");
  assert.deepEqual(plist.ProgramArguments, [
    "/opt/homebrew/bin/node",
    "/Users/client/Cove/scripts/cove-voice-review.mjs",
  ]);
  assert.deepEqual(plist.StartCalendarInterval, {
    Weekday: 0,
    Hour: 18,
    Minute: 0,
  });
  assert.equal(plist.RunAtLoad, false);
  assert.equal(plist.KeepAlive, false);
  assert.equal("StartInterval" in plist, false);
});

test("chief-of-staff plists render drain, sweep, nightly, and weekly review schedules", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-cos-plists-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const rendered = {};
  for (const name of ["drain", "sweep", "nightly", "review"]) {
    const destination = path.join(dir, `com.cove.chief-of-staff-${name}.plist`);
    renderLanePlist({
      source: path.join(ROOT, "scripts", "launchd", `com.cove.chief-of-staff-${name}.plist`),
      destination,
      repoDir: "/Users/client/Cove",
      homeDir: "/Users/client",
      atlasRoot: "/Users/client/Atlas",
      dataDir: "/Users/client/Cove/data",
      nodePath: "/opt/homebrew/bin/node",
      codexPath: "/Users/client/.local/bin/codex",
      notificationApp: "/Users/client/Applications/Cove Notifications.app/Contents/MacOS/CoveNotifier",
    });
    rendered[name] = JSON.parse(execFileSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", destination],
      { encoding: "utf8" },
    ));
  }
  assert.equal(rendered.drain.StartInterval, 300);
  assert.deepEqual(rendered.drain.ProgramArguments.slice(-3), ["drain", "--max", "3"]);
  assert.equal(
    rendered.drain.EnvironmentVariables.COVE_NOTIFICATION_APP,
    "/Users/client/Applications/Cove Notifications.app/Contents/MacOS/CoveNotifier",
  );
  assert.equal(rendered.drain.EnvironmentVariables.COVE_NOTIFY, "1");
  assert.deepEqual(rendered.sweep.StartCalendarInterval, [
    { Hour: 11, Minute: 30 },
    { Hour: 16, Minute: 0 },
  ]);
  assert.deepEqual(rendered.sweep.ProgramArguments.slice(-7), [
    "enqueue", "--reason", "sweep", "--slot", "11:30", "--slot", "16:00",
  ]);
  assert.deepEqual(rendered.nightly.StartCalendarInterval, { Hour: 21, Minute: 30 });
  assert.deepEqual(rendered.nightly.ProgramArguments.slice(-3), ["enqueue", "--reason", "nightly"]);
  assert.deepEqual(rendered.review.StartCalendarInterval, { Weekday: 0, Hour: 18, Minute: 0 });
  assert.deepEqual(rendered.review.ProgramArguments.slice(-1), ["review"]);
  for (const plist of Object.values(rendered)) {
    assert.equal(plist.KeepAlive, false);
    assert.match(plist.EnvironmentVariables.COVE_CODEX_BIN, /codex$/);
  }
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

test("installer local env lookup works in an empty process environment", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-installer-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lookup = (name) => execFileSync("/usr/bin/env", [
    "-i",
    process.execPath,
    "--input-type=module",
    "-e",
    `import { pathToFileURL } from "node:url";
     const { loadLocalEnv } = await import(pathToFileURL(process.argv[1]).href);
     const loaded = loadLocalEnv(process.argv[2], { ...process.env });
     process.stdout.write(loaded[process.argv[3]] ?? "");`,
    path.join(ROOT, "scripts", "lib", "load-local-env.mjs"),
    dir,
    name,
  ], { encoding: "utf8" });

  await writeFile(path.join(dir, ".env.local"), "COVE_CHIEF_OF_STAFF=1\n");
  assert.equal(lookup("COVE_CHIEF_OF_STAFF"), "1");
  await writeFile(path.join(dir, ".env.local"), "# opt-in absent\n");
  assert.equal(lookup("COVE_CHIEF_OF_STAFF"), "");
});

test("installer creates the optional env file safely and requires a healthy worker", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  assert.match(installer, /install -m 600 \/dev\/null "\$REPO_DIR\/\.env\.local"/);
  assert.match(installer, /WORKER_HEARTBEAT_EPOCH/);
  assert.match(installer, /for _ in \$\(seq 1 30\)/);
  assert.match(installer, /Cove setup is incomplete: the worker has not written a fresh heartbeat/);
  assert.match(installer, /Claude worker status: ok/);
  assert.doesNotMatch(installer, /Claude worker status: not started/);
  assert.match(installer, /com\.cove\.chief-of-staff-drain\.plist/);
  assert.match(installer, /com\.cove\.chief-of-staff-sweep\.plist/);
  assert.match(installer, /com\.cove\.chief-of-staff-nightly\.plist/);
  assert.match(installer, /com\.cove\.chief-of-staff-review\.plist/);
  assert.match(installer, /CHIEF_OF_STAFF_OPT_IN="\$\(local_env_value COVE_CHIEF_OF_STAFF\)"/);
  assert.match(installer, /\[ "\$CHIEF_OF_STAFF_OPT_IN" = "1" \][\s\S]{0,180}\[ -s "\$LANE_DATA_DIR\/cove-mandate\.md" \]/);
  assert.match(installer, /Chief of staff: off \(set COVE_CHIEF_OF_STAFF=1, verify the selected agent, and add data\/cove-mandate\.md to enable\)/);
  const disabledLaneBlock = installer.match(
    /if \[ "\$INSTALL_CHIEF_OF_STAFF_LANE" != "1" \]; then([\s\S]*?)\nfi/,
  )?.[1] ?? "";
  for (const lane of ["drain", "sweep", "nightly", "review"]) {
    assert.match(
      disabledLaneBlock,
      new RegExp(`launchctl bootout "gui/\\$UID_NUM/com\\.cove\\.chief-of-staff-${lane}" 2>/dev/null \\|\\| true`),
    );
  }
  assert.match(disabledLaneBlock, /rm -f "\$CHIEF_OF_STAFF_DRAIN_PLIST"/);
  assert.match(installer, /launchctl bootout "gui\/\$UID_NUM\/com\.cove\.attention-sweep"/);
  assert.match(installer, /rm -f "\$LA_DIR\/com\.cove\.attention-sweep\.plist"/);
  assert.doesNotMatch(installer, /launchctl bootstrap[^\n]*ATTENTION_SWEEP/);
  assert.doesNotMatch(installer, /launchctl enable[^\n]*com\.cove\.attention-sweep/);
});

test("a first install without a saved agent is told to choose one, not to install Codex", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  // With no data/agent-settings.json the runner falls back to the legacy Codex
  // default, so a Claude-only Mac fails this check. Pointing that person at
  // COVE_CODEX_BIN sends them to install a CLI they may have deliberately not
  // chosen; the actual missing step is Step 0's verified selection.
  const block = installer.match(
    /if \[ "\$JOB_RUNNER" = "codex-sol-high" \][\s\S]*?\nfi/,
  )?.[0] ?? "";
  assert.match(block, /if \[ -z "\$AGENT_PROVIDER" \]; then/);
  assert.match(block, /cove-agent-settings\.mjs configure --provider claude/);
  assert.match(block, /COVE_CODEX_BIN/);
});

function installerPlistBlock(installer, label) {
  const start = installer.indexOf(`<string>${label}</string>`);
  assert.ok(start > 0, `${label} is not written by the installer`);
  const next = installer.indexOf("<key>Label</key>", start);
  return installer.slice(start, next === -1 ? installer.length : next);
}

test("the web app's LaunchAgent carries the resolved Claude executable", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");

  // Buddy, replan, spawn-session and /login all run inside the web app process
  // and resolve the CLI as COVE_CLAUDE_BIN or the literal $HOME/.local/bin/claude.
  // Neither spelling consults PATH, so a Claude installed anywhere else leaves
  // the worker (whose plist does carry the path) able to run Claude while Buddy
  // fails with "Buddy was interrupted." -- the one surface a stuck person is
  // told to ask for help.
  const local = installerPlistBlock(installer, "com.cove.local");
  assert.match(
    local,
    /\$CLAUDE_PLIST_ENTRY/,
    "com.cove.local must receive the installer's resolved Claude path",
  );
  assert.match(
    installer,
    /<key>COVE_CLAUDE_BIN<\/key>\\n    <string>%s<\/string>/,
    "the Claude plist entry has to be built from the resolved binary",
  );

  // Every service that can start Claude gets the same treatment.
  for (const label of ["com.cove.claude-worker", "com.cove.morning-brief"]) {
    assert.match(
      installerPlistBlock(installer, label),
      /COVE_CLAUDE_BIN/,
      `${label} must receive the resolved Claude path`,
    );
  }
});

test("stopping Cove covers every service the installer can load", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  const stop = readFileSync(path.join(ROOT, "scripts", "cove-stop.sh"), "utf8");
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");

  // "Stop Cove" has to mean every lane. A label the installer can load but the
  // stop script does not know about keeps running -- including the chief-of-staff
  // lanes, which call a model and can notify -- after someone was told Cove was
  // off. Read the labels out of the installer so a new lane cannot be added
  // without also being stoppable.
  const installed = new Set(
    (installer.match(/com\.cove\.[a-z0-9-]+(?:\.[a-z0-9-]+)*/g) ?? [])
      .map((label) => label.replace(/\.plist$/, "")),
  );
  assert.ok(installed.size >= 10, "expected the installer to name its LaunchAgent labels");
  const missing = [...installed].filter((label) => !stop.includes(`\n${label}\n`)).sort();
  assert.deepEqual(missing, [], `scripts/cove-stop.sh is missing: ${missing.join(", ")}`);

  // bootout alone lasts until the next login, so the stop path has to offer the
  // one that survives a restart and say which is which.
  assert.match(stop, /launchctl disable "gui\/\$UID_NUM\/\$label"/);
  assert.match(stop, /--disable/);
  assert.match(readme, /scripts\/cove-stop\.sh/);
});

test("nothing in a local-first install phones home to Next.js", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  const verify = readFileSync(path.join(ROOT, "scripts", "cove-verify.mjs"), "utf8");

  // `next build` and `next start` both report anonymous telemetry unless this
  // is set. Cove's documentation names the places data leaves the Mac, and
  // Vercel is not one of them, so the two commands a person actually runs --
  // the release gate and the web app agent -- have to turn it off.
  assert.match(
    installerPlistBlock(installer, "com.cove.local"),
    /<key>NEXT_TELEMETRY_DISABLED<\/key>\s*<string>1<\/string>/,
    "the web app agent must disable Next telemetry",
  );
  assert.match(verify, /NEXT_TELEMETRY_DISABLED: "1"/);
});

test("stopping Cove reports and disables what is actually on the Mac", async (t) => {
  // A stub launchctl standing in for the real one, so the stop script can be
  // run rather than only read. Everything with a plist is loaded except
  // voice-review, which stands for a lane someone stopped by hand.
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const agents = path.join(home, "Library", "LaunchAgents");
  const bin = path.join(dir, "bin");
  mkdirSync(agents, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const present = [
    "com.cove.local",
    "com.cove.jobs",
    "com.cove.claude-worker",
    "com.cove.chief-of-staff-nightly",
    "com.cove.voice-review",
  ];
  for (const label of present) {
    await writeFile(path.join(agents, `${label}.plist`), "<plist/>\n");
  }
  const actions = path.join(dir, "actions.log");
  await writeFile(
    path.join(bin, "launchctl"),
    [
      "#!/usr/bin/env bash",
      `AGENTS=${JSON.stringify(agents)}`,
      `LOG=${JSON.stringify(actions)}`,
      'case "$1" in',
      "  list)",
      '    for f in "$AGENTS"/*.plist; do',
      '      b=$(basename "$f" .plist)',
      '      [ "$b" = "com.cove.voice-review" ] && continue',
      `      printf '1\\t0\\t%s\\n' "$b"`,
      "    done",
      "    ;;",
      "  print)",
      '    lbl="${2##*/}"',
      '    [ "$lbl" = "com.cove.voice-review" ] && exit 1',
      '    [ -e "$AGENTS/$lbl.plist" ] && exit 0',
      "    exit 1",
      "    ;;",
      '  bootout|disable) printf "%s %s\\n" "$1" "${2##*/}" >> "$LOG" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
  };

  const status = execFileSync("bash", [path.join(ROOT, "scripts/cove-stop.sh"), "--status"], {
    encoding: "utf8",
    env,
  });
  // Only what exists on this Mac. The known-label list carries every label the
  // installer has ever written, and printing the retired and pre-rename ones
  // buried the lanes that are actually running.
  for (const label of present) assert.match(status, new RegExp(label.replace(/\./g, "\\.")));
  assert.doesNotMatch(status, /com\.forge\./);
  assert.doesNotMatch(status, /com\.cove\.wake-canary/);
  assert.match(status, /com\.cove\.voice-review\s+not loaded\s+starts at login/);

  execFileSync("bash", [path.join(ROOT, "scripts/cove-stop.sh"), "--disable"], {
    encoding: "utf8",
    env,
  });
  const log = await readFile(actions, "utf8");
  // A lane that is stopped but still has its plist comes back at the next
  // login, so --disable has to cover it even though there was nothing to boot
  // out. Four loaded, five disabled.
  assert.equal(log.match(/^bootout /gm)?.length, 4, log);
  assert.equal(log.match(/^disable /gm)?.length, 5, log);
  assert.match(log, /^disable com\.cove\.voice-review$/m);
});

test("task and contact skills authenticate every documented generic mutation", () => {
  const task = readFileSync(path.join(ROOT, "skills", "cove-task", "SKILL.md"), "utf8");
  const contact = readFileSync(path.join(ROOT, "skills", "cove-contact", "SKILL.md"), "utf8");
  assert.match(task, /csrfToken/);
  assert.match(task, /X-Cove-CSRF: <token from the day-plan GET>/);
  assert.match(task, /"origin": "<who asked, where, and when, then their exact words in quotes>"/);
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


// The installer's readiness probe decides whether an install is reported as
// successful. It used to accept any 200 on /tasks, so another program holding
// port 3200 meant `next start` exited EADDRINUSE, launchd restarted it every
// ten seconds forever, and the installer printed "Cove is running at ...".
// Extract the real loop and drive it against two servers to prove the
// difference is now detected.
async function runReadinessProbe(respond) {
  const server = http.createServer(respond);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const installer = readFileSync(path.join(ROOT, "scripts/install-cove-local.sh"), "utf8");
  const start = installer.indexOf('echo "Starting Cove..."');
  const end = installer.indexOf('if [ -n "$UP" ]; then');
  assert.ok(start > 0 && end > start, "install-cove-local.sh no longer has a readiness loop to extract");
  const loop = installer.slice(start, end);
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-probe-"));
  try {
    const harness = path.join(dir, "probe.sh");
    // `sleep` is stubbed so a probe that never succeeds costs no wall clock.
    await writeFile(harness, [
      "set -uo pipefail",
      "sleep() { :; }",
      `COVE_BRIEF_WEB_BASE=${base}`,
      loop,
      'printf "UP=%s FOREIGN=%s\\n" "$UP" "$FOREIGN_SERVER"',
    ].join("\n"));
    // Async on purpose: the stub server above shares this process's event
    // loop, so a synchronous child would block it and curl would never be
    // answered.
    const { stdout } = await execFileAsync("bash", [harness], { encoding: "utf8" });
    return stdout.trim().split("\n").pop();
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a program squatting on Cove's port is not mistaken for a working install", async () => {
  const result = await runReadinessProbe((request, response) => {
    if (request.url.startsWith("/api/health")) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<h1>not cove</h1>");
  });
  assert.equal(result, "UP= FOREIGN=yes");
});

test("Cove answering its own health endpoint is what counts as started", async () => {
  const result = await runReadinessProbe((request, response) => {
    if (request.url.startsWith("/api/health")) {
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ snapshot: null, readiness: { checkedAt: "2026-09-21T00:00:00.000Z" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<h1>cove</h1>");
  });
  assert.equal(result, "UP=yes FOREIGN=");
});

test("the installer says what to do when another program holds the port", () => {
  const installer = readFileSync(path.join(ROOT, "scripts/install-cove-local.sh"), "utf8");
  assert.match(installer, /Something other than Cove is already using port \$WEB_PORT/);
  assert.match(installer, /lsof -nP -iTCP:\$WEB_PORT -sTCP:LISTEN/);
  assert.match(installer, /COVE_BRIEF_WEB_BASE=http:\/\/127\.0\.0\.1:3201/);
  assert.match(installer, /grep -q 'EADDRINUSE'/);
});


// `launchctl disable` outlives the plist and survives a restart, so a label
// disabled once stays refused until something enables it. com.cove.local.backup,
// com.cove.reminders and com.cove.email-triage were bootstrapped and never
// enabled, so stopping Cove for good and re-running the installer brought the
// website and the worker back while the daily backup, the reminders lane and
// email triage stayed off, silently.
test("every agent the installer can load is also enabled, before it is loaded", async () => {
  const installer = readFileSync(path.join(ROOT, "scripts/install-cove-local.sh"), "utf8");

  // Two sources, because the agents come from two places: plists written
  // inline by the installer, and the lane templates rendered through
  // scripts/lib/render-lane-plist.mjs.
  const labelFrom = text =>
    [...text.matchAll(/<key>Label<\/key>\s*\n?\s*<string>(com\.cove\.[^<]+)<\/string>/g)]
      .map(match => match[1]);
  const labels = new Set(labelFrom(installer));
  for (const file of readdirSync(path.join(ROOT, "scripts/launchd"))) {
    if (!file.endsWith(".plist")) continue;
    for (const label of labelFrom(readFileSync(path.join(ROOT, "scripts/launchd", file), "utf8"))) {
      labels.add(label);
    }
  }
  assert.ok(labels.size >= 14, `expected the installer to write plists, saw ${labels.size}`);

  const loop = installer.match(/for cove_label in \\\n([\s\S]*?)\ndone\n/);
  assert.ok(loop, "install-cove-local.sh no longer enables its agents in one loop");
  const enabled = new Set(
    loop[1].split("\n")
      .map(line => line.trim().replace(/\s*\\$/, "").trim())
      .filter(line => line.startsWith("com.cove.")),
  );
  for (const label of labels) {
    assert.ok(enabled.has(label), `${label} is loaded by the installer but never enabled`);
  }

  // Order matters: launchd refuses to load a disabled service, so an enable
  // that runs after the bootstrap is too late to help the run it is in.
  assert.ok(
    installer.indexOf("for cove_label in") < installer.indexOf('launchctl bootstrap "gui/$UID_NUM"'),
    "the enable loop must run before the first bootstrap",
  );

  // And run the real loop against a stub launchctl, so this is not only a read.
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-enable-"));
  try {
    const calls = path.join(dir, "calls");
    await writeFile(path.join(dir, "launchctl"),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "${calls}"\n`);
    await chmod(path.join(dir, "launchctl"), 0o755);
    const harness = path.join(dir, "enable.sh");
    await writeFile(harness, ["set -uo pipefail", "UID_NUM=501", loop[0]].join("\n"));
    await execFileAsync("bash", [harness], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const seen = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(seen.length, enabled.size);
    for (const label of labels) {
      assert.ok(seen.includes(`enable gui/501/${label}`), `no enable call for ${label}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The block is extracted and run rather than pattern-matched, so this fails if
// the guard stops narrowing the file for any reason, not just if a line moves.
async function runEnvLocalGuard(prepare) {
  const installer = readFileSync(path.join(ROOT, "scripts/install-cove-local.sh"), "utf8");
  const start = installer.indexOf('if [ ! -e "$REPO_DIR/.env.local" ]; then');
  const end = installer.indexOf("local_env_value() {");
  assert.ok(start > 0 && end > start, "install-cove-local.sh no longer has an .env.local block to extract");
  const block = installer.slice(start, end);
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-envlocal-"));
  try {
    await prepare(dir);
    const harness = path.join(dir, "guard.sh");
    await writeFile(harness, ["set -euo pipefail", `REPO_DIR=${JSON.stringify(dir)}`, block].join("\n"));
    await execFileAsync("bash", [harness], { encoding: "utf8" });
    return (statSync(path.join(dir, ".env.local")).mode & 0o777).toString(8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the installer creates .env.local private", async () => {
  assert.equal(await runEnvLocalGuard(async () => {}), "600");
});

test("the installer narrows an .env.local someone wrote by hand first", async () => {
  // SECURITY_AND_INTEGRATIONS.md promises a mode-0600 .env.local and tells
  // people to put a Granola API key in it. The setup playbook also has you
  // write COVE_CHIEF_OF_STAFF or COVE_BRIEF_WEB_BASE into it before the
  // install, which creates it with the author's umask — normally 0644.
  const mode = await runEnvLocalGuard(async (dir) => {
    await writeFile(path.join(dir, ".env.local"), "COVE_CHIEF_OF_STAFF=0\n", { mode: 0o644 });
    chmodSync(path.join(dir, ".env.local"), 0o644);
  });
  assert.equal(mode, "600");
});

test("the installer leaves an already-private .env.local and its contents alone", async () => {
  let contents;
  const mode = await runEnvLocalGuard(async (dir) => {
    await writeFile(path.join(dir, ".env.local"), "COVE_BRIEF_WEB_BASE=http://127.0.0.1:3201\n", { mode: 0o600 });
    contents = readFileSync(path.join(dir, ".env.local"), "utf8");
  });
  assert.equal(mode, "600");
  assert.equal(contents, "COVE_BRIEF_WEB_BASE=http://127.0.0.1:3201\n");
});
