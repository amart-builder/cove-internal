import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createDayPlanStore } from "../src/lib/day-plan/store.ts";
import {
  fetchOpenProjectTasks,
  groupRecentPings,
  hasNewProjectEvidence,
  mergeProgressHeartbeat,
  parseProgressOutput,
  projectFromCwd,
  readPingFiles,
  resolvePingProject,
  runProgressReconcile,
  shouldProcessProject,
  validateProgress,
} from "../scripts/forge-progress-reconcile.mjs";
import {
  consumeProgressSuggestionRelays,
  readProgressDigestRelays,
  writeProgressDigestRelay,
  writeProgressSuggestionRelay,
} from "../src/lib/progress/relay.ts";
import {
  createWorkSuggestion,
  getQuietCurrentSnapshot,
  setQuietCurrentNowForTests,
  setQuietCurrentStorePathForTests,
} from "../src/lib/quiet-current/store.ts";

const NOW = new Date("2026-07-27T21:30:00.000Z");

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `forge-progress-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ping(project, minute, host = "mbp") {
  return {
    ts: `2026-07-27T21:${String(minute).padStart(2, "0")}:00.000Z`,
    event: "Stop",
    session_id: `${host}-${project}-${minute}`,
    cwd: `/Users/${host}/Atlas/Projects/${project}/src/lib`,
    git_branch: "main",
    git_head: `head-${minute}`,
  };
}

test("cwd project mapping tolerates both machines, nesting, and non-project paths", () => {
  assert.equal(
    projectFromCwd("/Users/alexanderjmartin/Atlas/Projects/catalyst/src/app"),
    "catalyst",
  );
  assert.equal(
    projectFromCwd(
      "/Users/alexandermartin/Desktop/Atlas/Projects/astack/forge/scripts",
    ),
    "forge",
  );
  assert.equal(projectFromCwd("/Users/alexandermartin/Desktop/Atlas/brain"), "Atlas");
  assert.equal(projectFromCwd("/tmp"), "Atlas");
});

test("cwd mapping selects the deepest bounded git repo and rejects hostile segments", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "Projects", "astack", "forge", ".git"), {
    recursive: true,
  });
  assert.deepEqual(
    resolvePingProject(
      "/Users/alexandermartin/Desktop/Atlas/Projects/astack/forge/src",
      { atlasRoot: root },
    ),
    {
      project: "forge",
      projectDir: path.join(root, "Projects", "astack", "forge"),
    },
  );
  assert.equal(
    projectFromCwd(
      "/Users/alex/Atlas/Projects/../secrets",
      { atlasRoot: root },
    ),
    "Atlas",
  );
  assert.equal(
    projectFromCwd(
      "/Users/alex/Atlas/Projects//secrets",
      { atlasRoot: root },
    ),
    "Atlas",
  );
  assert.equal(
    projectFromCwd(
      "/Users/alex/Atlas/Projects/.hidden/repo",
      { atlasRoot: root },
    ),
    "Atlas",
  );
});

test("structured Claude output unwraps the CLI envelope", () => {
  assert.deepEqual(
    parseProgressOutput(JSON.stringify({
      structured_output: {
        project_summary: "Progress made.",
        tasks: [],
      },
    })),
    {
      project_summary: "Progress made.",
      tasks: [],
    },
  );
});

test("progress validation rejects oversized and non-verbatim evidence quotes", () => {
  const tasks = [{ id: "task-1" }];
  const base = {
    project_summary: "Progress made.",
    tasks: [{
      task_id: "task-1",
      progress: "likely_done",
      evidence_quote: "abc Ship",
      note: "Likely complete.",
      scope_changed: false,
    }],
  };
  assert.equal(validateProgress(base, tasks, "abc Ship").tasks[0].task_id, "task-1");
  assert.throws(
    () => validateProgress({
      ...base,
      tasks: [{ ...base.tasks[0], evidence_quote: "x".repeat(301) }],
    }, tasks, "x".repeat(301)),
    /invalid task result/,
  );
  assert.throws(
    () => validateProgress(base, tasks, "different evidence"),
    /not supplied/,
  );
});

test("ping reader ignores conflicts and old files while counting malformed lines", (t) => {
  const dir = fixture(t);
  writeFileSync(
    path.join(dir, "mbp-2026-07-27.jsonl"),
    `${JSON.stringify(ping("forge", 10))}\nnot-json\n`,
  );
  writeFileSync(
    path.join(dir, "mbp.sync-conflict-1-2026-07-27.jsonl"),
    `${JSON.stringify(ping("conflict", 11))}\n`,
  );
  writeFileSync(
    path.join(dir, "mbp-2026-07-01.jsonl"),
    `${JSON.stringify(ping("old", 12))}\n`,
  );
  const result = readPingFiles(dir, { now: NOW });
  assert.equal(result.pings.length, 1);
  assert.equal(result.pings[0].session_id, "mbp-forge-10");
  assert.equal(result.malformed, 1);
});

test("Supabase task fetch maps and bounds only the fields the model needs", async () => {
  let requested;
  const tasks = await fetchOpenProjectTasks("forge", {
    supabase: {
      url: "https://example.supabase.co",
      key: "secret",
      table: "forge_tasks",
    },
    fetchImpl: async (url) => {
      requested = String(url);
      return new Response(JSON.stringify([{
        id: "task-1",
        title: "T".repeat(350),
        description: "D".repeat(2500),
        project: "forge",
        status: "open",
        due_at: NOW.toISOString(),
        priority: "high",
        tags: ["one", 2, "two"],
        column_id: "today",
      }]));
    },
  });
  assert.match(requested, /forge_tasks/);
  assert.match(requested, /project=eq(?:%2E|\.)forge/);
  assert.equal(tasks[0].title.length, 300);
  assert.equal(tasks[0].description.length, 2000);
  assert.deepEqual(tasks[0].tags, ["one", "two"]);
});

test("new evidence requires a new ping timestamp or changed git head", () => {
  const group = {
    pings: [ping("forge", 10), ping("forge", 20)],
  };
  const prior = {
    evidence: {
      ping_events: group.pings.map((value) => ({ ts: value.ts })),
      git_head: "same-head",
    },
  };
  assert.equal(hasNewProjectEvidence(group, "same-head", prior), false);
  assert.equal(hasNewProjectEvidence(group, "new-head", prior), true);
  assert.equal(
    hasNewProjectEvidence(
      { pings: [...group.pings, ping("forge", 25)] },
      "same-head",
      prior,
    ),
    true,
  );
});

test("noise floor keeps two-ping projects and one-ping projects due today", () => {
  const groups = groupRecentPings([
    ping("catalyst", 10),
    ping("catalyst", 20),
    ping("forge", 15),
  ], NOW);
  assert.equal(
    shouldProcessProject(
      groups.get("catalyst"),
      [],
      "2026-07-27",
      "America/Los_Angeles",
    ),
    true,
  );
  assert.equal(
    shouldProcessProject(
      groups.get("forge"),
      [{ due_at: "2026-07-28T03:30:00.000Z" }],
      "2026-07-27",
      "America/Los_Angeles",
    ),
    true,
  );
  assert.equal(
    shouldProcessProject(
      groups.get("forge"),
      [{ due_at: "2026-07-29T03:30:00.000Z" }],
      "2026-07-27",
      "America/Los_Angeles",
    ),
    false,
  );
});

test("session digest schema migrates in place and persists structured evidence", (t) => {
  const dir = fixture(t);
  const dbPath = path.join(dir, "day-plan.db");
  const legacy = new Database(dbPath);
  legacy.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
  legacy.prepare("INSERT INTO unrelated (id) VALUES (?)").run("keep");
  legacy.close();

  const store = createDayPlanStore({
    dbPath,
    now: () => NOW,
  });
  store.recordSessionDigest({
    id: "digest-1",
    runAt: NOW.toISOString(),
    project: "catalyst",
    summary: "Moved the launch flow forward.",
    perTask: [{
      task_id: "task-1",
      progress: "some",
      evidence_quote: "Finish launch route",
      note: "Implemented the first route.",
      scope_changed: false,
    }],
    evidence: { git_log: ["abc Finish launch route"] },
  });
  store.close();

  const reopened = createDayPlanStore({ dbPath });
  t.after(() => reopened.close());
  const [digest] = reopened.listSessionDigests({
    since: "2026-07-27T00:00:00.000Z",
    until: "2026-07-28T00:00:00.000Z",
  });
  assert.equal(digest.project, "catalyst");
  assert.equal(digest.perTask[0].task_id, "task-1");
  assert.deepEqual(digest.evidence.git_log, ["abc Finish launch route"]);
  const verify = new Database(dbPath, { readonly: true });
  assert.deepEqual(verify.prepare("SELECT * FROM unrelated").get(), { id: "keep" });
  verify.close();
});

test("session digest retention keeps the latest 20 rows per project", (t) => {
  const dir = fixture(t);
  const store = createDayPlanStore({ dbPath: path.join(dir, "retention.db") });
  t.after(() => store.close());
  for (let index = 0; index < 25; index += 1) {
    store.recordSessionDigest({
      id: `digest-${index}`,
      runAt: new Date(NOW.getTime() + index * 1_000).toISOString(),
      project: "forge",
      summary: `Run ${index}`,
      perTask: [],
      evidence: { index },
    });
  }
  const rows = store.listSessionDigests({ project: "forge", limit: 100 });
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, "digest-24");
  assert.equal(rows.at(-1).id, "digest-5");
});

test("digest relay is write-once and readable by a machine without the Mini store", (t) => {
  const dir = fixture(t);
  const digest = {
    id: "progress-0123456789abcdef0123456789abcdef",
    runAt: NOW.toISOString(),
    project: "forge",
    summary: "Forge moved forward.",
    perTask: [],
    evidence: { fingerprint: "fingerprint-1" },
  };
  assert.equal(writeProgressDigestRelay({ digest, dataDir: dir }), true);
  assert.equal(writeProgressDigestRelay({ digest, dataDir: dir }), false);
  assert.equal(readProgressDigestRelays({ dataDir: dir })[0].summary, digest.summary);
});

test("relay consumer lands observed progress locally and dedupes equivalent claims across sources", (t) => {
  const dir = fixture(t);
  const quietFile = path.join(dir, "quiet-current.json");
  setQuietCurrentStorePathForTests(quietFile);
  setQuietCurrentNowForTests(NOW);
  t.after(() => {
    setQuietCurrentNowForTests(undefined);
    setQuietCurrentStorePathForTests(undefined);
  });
  writeProgressSuggestionRelay({
    dataDir: dir,
    suggestion: {
      digestId: "progress-digest-1",
      taskId: "task-1",
      taskTitle: "Ship the reconciler",
      note: "Implementation appears complete.",
      evidenceQuote: "abc Ship reconciler",
      claim: "likely_done",
      createdAt: NOW.toISOString(),
    },
  });
  const consumerOptions = {
    dataDir: dir,
    now: NOW,
    getSnapshot: getQuietCurrentSnapshot,
    createSuggestion: createWorkSuggestion,
  };
  const first = consumeProgressSuggestionRelays(consumerOptions);
  assert.equal(first.created, 1);
  const [landed] = getQuietCurrentSnapshot().suggestions;
  assert.equal(landed.kind, "observed_progress");
  assert.equal(landed.targetTaskId, "task-1");

  createWorkSuggestion({
    kind: "observed_progress",
    title: "Review progress: Reshape scope",
    reason: "scope changed in commit abc",
    source: "another-detector",
    targetTaskId: "task-2",
  });
  writeProgressSuggestionRelay({
    dataDir: dir,
    suggestion: {
      digestId: "progress-digest-2",
      taskId: "task-2",
      taskTitle: "Reshape scope",
      note: "Scope changed.",
      evidenceQuote: "scope changed in commit abc",
      claim: "scope_changed",
      createdAt: NOW.toISOString(),
    },
  });
  const second = consumeProgressSuggestionRelays(consumerOptions);
  assert.equal(second.deduped, 1);
  assert.equal(getQuietCurrentSnapshot().suggestions.length, 2);

  createWorkSuggestion({
    kind: "observed_progress",
    title: "Review progress: Same task",
    reason: "an earlier, different claim",
    source: "another-detector",
    targetTaskId: "task-3",
  });
  writeProgressSuggestionRelay({
    dataDir: dir,
    suggestion: {
      digestId: "progress-digest-3",
      taskId: "task-3",
      taskTitle: "Same task",
      note: "A distinct claim should remain visible.",
      evidenceQuote: "the new scope landed in commit def",
      claim: "scope_changed",
      createdAt: NOW.toISOString(),
    },
  });
  const third = consumeProgressSuggestionRelays(consumerOptions);
  assert.equal(third.created, 1);
  assert.equal(getQuietCurrentSnapshot().suggestions.length, 4);
});

test("heartbeat merge preserves other watcher keys", (t) => {
  const dir = fixture(t);
  const file = path.join(dir, "intake", "heartbeats.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    meeting_watch: { last_run_at: "2026-07-27T20:00:00.000Z" },
  }));
  mergeProgressHeartbeat(file, {
    last_run_at: NOW.toISOString(),
    projects_active: 2,
    errors: 0,
  });
  const heartbeat = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(
    heartbeat.meeting_watch.last_run_at,
    "2026-07-27T20:00:00.000Z",
  );
  assert.equal(heartbeat.progress_reconcile.projects_active, 2);
});

test("dry-run performs analysis but writes no store, pencil, state, or heartbeat", async (t) => {
  const dir = fixture(t);
  let analyzed = 0;
  const result = await runProgressReconcile({
    dryRun: true,
    dataDir: dir,
    statePath: path.join(dir, "state.json"),
    heartbeatPath: path.join(dir, "heartbeats.json"),
    dbPath: path.join(dir, "day-plan.db"),
    now: () => NOW,
    readPings: () => [ping("catalyst", 10), ping("catalyst", 20)],
    fetchTasks: async () => [{ id: "task-1", title: "Ship" }],
    gitEvidence: async () => ({ lines: ["abc Ship"], head: "head-1" }),
    readCurrentState: () => "## Current State\nShipping.",
    analyzeProject: async () => {
      analyzed += 1;
      return {
        project_summary: "Shipping moved forward.",
        tasks: [{
          task_id: "task-1",
          progress: "some",
          evidence_quote: "abc Ship",
          note: "A commit exists.",
          scope_changed: false,
        }],
      };
    },
    store: {
      recordSessionDigest: () => {
        throw new Error("dry-run touched store");
      },
    },
    writeDigestRelay: () => {
      throw new Error("dry-run wrote digest relay");
    },
    writeSuggestionRelay: () => {
      throw new Error("dry-run wrote suggestion relay");
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(analyzed, 1);
  assert.equal(result.summary.digests_written, 0);
  assert.equal(existsSync(path.join(dir, "state.json")), false);
  assert.equal(existsSync(path.join(dir, "heartbeats.json")), false);
  assert.equal(existsSync(path.join(dir, "day-plan.db")), false);
});

test("one project failure does not freeze another project's cursor", async (t) => {
  const dir = fixture(t);
  const digests = [];
  const heartbeatPath = path.join(dir, "intake", "heartbeats.json");
  const statePath = path.join(dir, "state.json");
  const result = await runProgressReconcile({
    dataDir: dir,
    statePath,
    heartbeatPath,
    now: () => NOW,
    readPings: () => [
      ping("alpha", 10),
      ping("alpha", 11),
      ping("beta", 12),
      ping("beta", 13),
    ],
    fetchTasks: async (project) => [{
      id: `task-${project}`,
      title: `Ship ${project}`,
    }],
    gitEvidence: async () => ({
      lines: ["abc Ship beta"],
      head: "head-beta",
    }),
    readCurrentState: () => "",
    analyzeProject: async ({ project }) => {
      if (project === "alpha") throw new Error("simulated Claude failure");
      return {
        project_summary: "Beta moved.",
        tasks: [],
      };
    },
    store: {
      recordSessionDigest: (digest) => digests.push(digest),
      listSessionDigests: () => [],
      close: () => undefined,
    },
    writeDigestRelay: () => true,
    writeSuggestionRelay: () => ({ written: true }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.errors, 1);
  assert.deepEqual(digests.map((digest) => digest.project), ["beta"]);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.projects.alpha, undefined);
  assert.equal(
    state.projects.beta.last_successful_run_at,
    NOW.toISOString(),
  );
  assert.equal(
    JSON.parse(readFileSync(heartbeatPath, "utf8")).progress_reconcile.errors,
    1,
  );
});

test("unchanged evidence skips Claude and the full task fetch", async (t) => {
  const dir = fixture(t);
  const pings = [ping("forge", 10), ping("forge", 20)];
  let taskFetches = 0;
  let analyses = 0;
  const result = await runProgressReconcile({
    dryRun: true,
    dataDir: dir,
    now: () => NOW,
    readPings: () => pings,
    gitEvidence: async () => ({ lines: [], head: "same-head" }),
    getLatestDigest: async () => ({
      evidence: {
        ping_events: pings.map((value) => ({ ts: value.ts })),
        git_head: "same-head",
      },
    }),
    fetchTasks: async () => {
      taskFetches += 1;
      return [];
    },
    analyzeProject: async () => {
      analyses += 1;
      return { project_summary: "", tasks: [] };
    },
  });
  assert.equal(result.summary.skipped_no_new_evidence, 1);
  assert.equal(taskFetches, 0);
  assert.equal(analyses, 0);
});

test("noise-floor rejection happens before the full task fetch", async (t) => {
  const dir = fixture(t);
  let fullFetches = 0;
  const result = await runProgressReconcile({
    dryRun: true,
    dataDir: dir,
    now: () => NOW,
    readPings: () => [ping("forge", 10)],
    hasDueToday: async () => false,
    fetchTasks: async () => {
      fullFetches += 1;
      return [];
    },
  });
  assert.equal(result.summary.projects_skipped, 1);
  assert.equal(result.summary.projects[0].skipped, "noise_floor");
  assert.equal(fullFetches, 0);
});

test("Mini installer renders and registers meeting and progress templates", () => {
  const installer = readFileSync(
    path.join(process.cwd(), "scripts", "install-forge-local.sh"),
    "utf8",
  );
  assert.match(installer, /scripts\/launchd\/com\.forge\.meeting-watch\.plist/);
  assert.match(installer, /scripts\/launchd\/com\.forge\.progress\.plist/);
  assert.match(installer, /FORGE_PROGRESS_RELAY_CONSUMER/);
  assert.match(installer, /launchctl bootstrap "gui\/\$UID_NUM" "\$MINI_MEETING_PLIST"/);
  assert.match(installer, /launchctl bootstrap "gui\/\$UID_NUM" "\$MINI_PROGRESS_PLIST"/);
});
