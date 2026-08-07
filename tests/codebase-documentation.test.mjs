import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("the public entry points lead coding agents to the canonical codebase guide", () => {
  const readme = read("README.md");
  const agents = read("AGENTS.md");
  const agentContract = read("AGENT_CONTRACT.md");
  const exporter = read("scripts/export-cove-client.mjs");

  assert.match(readme, /\[CODEBASE_GUIDE\.md\]\(CODEBASE_GUIDE\.md\)/);
  assert.match(agents, /Read `CODEBASE_GUIDE\.md` first/);
  assert.match(agentContract, /read `CODEBASE_GUIDE\.md`/i);
  assert.match(exporter, /"CODEBASE_GUIDE\.md"/);
});

test("the codebase guide accounts for every server domain directory", () => {
  const guide = read("CODEBASE_GUIDE.md");
  const domains = readdirSync(path.join(repoRoot, "src", "lib"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const domain of domains) {
    assert.match(
      guide,
      new RegExp(`src/lib/${domain.replaceAll("-", "\\-")}/`),
      `CODEBASE_GUIDE.md does not account for src/lib/${domain}/`,
    );
  }
});

test("every private docs artifact is classified by the documentation index", () => {
  if (!existsSync(path.join(repoRoot, "docs"))) return;

  const index = read("docs/README.md");
  const documents = [];
  function collect(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) collect(path.join(directory, entry.name), relative);
      else if (relative !== "README.md") documents.push(relative);
    }
  }
  collect(path.join(repoRoot, "docs"));
  documents.sort();

  for (const document of documents) {
    assert.match(
      index,
      new RegExp(document.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `docs/${document} is not classified in docs/README.md`,
    );
  }
});

test("every API route is named in the codebase guide", () => {
  const guide = read("CODEBASE_GUIDE.md");
  const apiRoot = path.join(repoRoot, "src", "app", "api");
  const routes = [];

  function collectRoutes(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collectRoutes(absolute);
      else if (entry.name === "route.ts") {
        routes.push(`/api/${path.relative(apiRoot, directory).split(path.sep).join("/")}`);
      }
    }
  }
  collectRoutes(apiRoot);

  for (const route of routes.sort()) {
    assert.match(
      guide,
      new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `CODEBASE_GUIDE.md does not account for ${route}`,
    );
  }
});

test("every rendered LaunchAgent label is named in the codebase guide", () => {
  const guide = read("CODEBASE_GUIDE.md");
  const installerSources = [
    read("scripts/install-cove-local.sh"),
    ...readdirSync(path.join(repoRoot, "scripts", "launchd"))
      .filter((name) => name.endsWith(".plist"))
      .map((name) => read(path.join("scripts", "launchd", name))),
  ].join("\n");
  const labels = [...installerSources.matchAll(/<string>(com\.cove\.[^<]+)<\/string>/g)]
    .map((match) => match[1])
    .filter((label, index, all) => all.indexOf(label) === index)
    .sort();

  for (const label of labels) {
    assert.match(guide, new RegExp(label.replaceAll(".", "\\.")), `${label} is undocumented`);
  }
});

test("high-risk modules explain their authority and failure boundaries", () => {
  const moduleMarkers = new Map([
    ["src/lib/day-plan/store.ts", "Durable state machine"],
    ["src/lib/day-plan/brief-sources.ts", "exact evidence envelope"],
    ["src/lib/claude-execution/worker.ts", "durable background model queues"],
    ["src/lib/local/database.ts", "Canonical SQLite connection factory"],
    ["src/lib/local/migrations.ts", "append-only schema history"],
    ["src/lib/request-security.ts", "not user authentication"],
    ["src/lib/task-sessions/manager.ts", "user-visible Claude Code sessions"],
    ["src/lib/workspace/google/gateway.ts", "Fixed-capability Google Workspace gateway"],
    ["src/lib/email/automation.ts", "Gmail observations and Cove email state"],
    ["src/lib/email/state-machine.ts", "one Gmail thread"],
    ["src/lib/email/gmail-outbox.ts", "durable Gmail operation outbox"],
    ["src/lib/intake/run.ts", "Source-to-task intake coordinator"],
    ["src/lib/intake/meeting-pipeline.ts", "meeting-note pipeline"],
    ["src/lib/intake/task-writer.ts", "write boundary"],
    ["src/lib/tasks/recurrence.ts", "Deterministic recurring-task calendar"],
    ["src/lib/quiet-current/store.ts", "pencil layer"],
    ["src/lib/buddy/store.ts", "conversation and receipt state"],
    ["src/lib/buddy/replan.ts", "mid-day replan preview"],
    ["src/lib/crm/local.ts", "local CRM backend"],
    ["src/lib/reliability/jobs.ts", "Durable scheduler"],
    ["src/lib/reliability/receipts.ts", "effects Cove actually observed"],
    ["src/lib/reliability/failures.ts", "Visible failure inbox"],
    ["src/lib/health/readiness.ts", "Factual readiness"],
    ["src/lib/data/tasks.ts", "Browser-safe task API adapter"],
    ["src/lib/attention/ledger.mjs", "attention lane"],
    ["src/lib/day-plan/brief.ts", "artifact contract"],
    ["src/lib/day-plan/brief-relay.ts", "historical split-host"],
    ["src/lib/day-plan/presentation.ts", "Pure presentation rules"],
    ["src/components/tasks/TodayView.tsx", "Browser coordinator"],
    ["src/components/tasks/useDayRitual.ts", "Network and polling adapter"],
    ["scripts/install-cove-local.sh", "installer is a renderer and reconciler"],
    ["scripts/export-cove-client.mjs", "explicit allowlist"],
    ["scripts/cove-progress-reconcile.mjs", "read-only evidence"],
    ["scripts/cove-verify.mjs", "Release gate"],
  ]);

  for (const [file, marker] of moduleMarkers) {
    assert.match(read(file), new RegExp(marker, "i"), `${file} needs its module contract`);
  }
});
