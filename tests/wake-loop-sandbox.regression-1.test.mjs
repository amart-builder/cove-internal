/**
 * The mandate's claim about itself, pinned on both providers.
 *
 * prompts/chief-of-staff-mandate.md tells the model "You have no shell, file
 * reads, MCP servers, network, or file writes." That is the strongest thing
 * Cove says about the one agent lane that runs unattended on a schedule
 * against the person's board, so what makes it true should fail a test rather
 * than be re-derived by the next person to read the file.
 *
 * On Codex it is true because of CHIEF_OF_STAFF_CODEX_CONFIG and the argv:
 * read-only sandbox, shell tool off, web search off twice, and no
 * [mcp_servers] table in a home that ensureChiefOfStaffCodexHome refuses to
 * let be the operator's.
 *
 * On Claude it is true because of a default. driver.ts passes no claudeTools,
 * and claudeCommand in model-runner-runtime.mjs falls back to `--tools ""`.
 * Nothing asserted that fallback for this lane. The weekly review has a case
 * pinning its own tool-free call; the wake loop, which runs far more often and
 * unattended, did not. A future change giving claudeCommand a sensible default
 * allowlist would hand this lane file reads and the network with every test
 * still green.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildChiefOfStaffCodexArgv, runWake } from "../src/lib/chief-of-staff/driver.ts";
import {
  CHIEF_OF_STAFF_CODEX_CONFIG,
  enqueueChiefOfStaffWake,
  ensureChiefOfStaffHome,
} from "../src/lib/chief-of-staff/storage.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";

const ROOT = process.cwd();

function tempCove(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-wake-sandbox-"));
  const operatorCodexHome = path.join(dataDir, "operator-codex");
  mkdirSync(operatorCodexHome);
  writeFileSync(path.join(operatorCodexHome, "auth.json"), '{"auth":"operator"}\n');
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return {
    dataDir,
    dbPath: path.join(dataDir, "cove.db"),
    operatorEnv: {
      HOME: dataDir,
      PATH: process.env.PATH,
      CODEX_HOME: operatorCodexHome,
    },
  };
}

test("the wake loop's Claude call carries no tools and no MCP server", async (t) => {
  const { dataDir, dbPath, operatorEnv } = tempCove(t);
  const now = new Date("2026-09-04T16:00:00Z");
  writeFileSync(path.join(dataDir, "agent-settings.json"), JSON.stringify({
    version: 1, provider: "claude", model: "claude-fable-5-1", effort: "low",
    backgroundLimits: { callsPerDay: 4 },
  }));
  const home = ensureChiefOfStaffHome({ repoDir: ROOT, dataDir, now });
  const executable = path.join(dataDir, "claude");
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$@" > ../fake-argv.txt
cat > /dev/null
printf '%s\\n' '{"structured_output":{"journal":["Reviewed the desk.","No urgent gap found."],"watching":[],"actions":[]},"usage":{"input_tokens":100,"output_tokens":30}}'
`, { mode: 0o700 });

  const db = openLocalDatabase(dbPath);
  let wake;
  try {
    wake = db.transaction(() => enqueueChiefOfStaffWake(db, {
      reason: "manual", note: "sandbox test", now,
    })).immediate().job;
  } finally {
    db.close();
  }
  await runWake(wake, {
    repoDir: ROOT, dataDir, dbPath, env: operatorEnv, now: () => now,
    claudePath: executable, codexPath: executable,
  });

  // One argument per line, so an empty --tools value is an empty line.
  const argv = readFileSync(path.join(home.paths.agent, "fake-argv.txt"), "utf8").split("\n");
  const after = (flag) => argv[argv.indexOf(flag) + 1];

  assert.ok(argv.includes("--tools"), "the tool list must be stated, not omitted");
  assert.equal(after("--tools"), "", "the wake loop gets no tools at all");
  assert.equal(after("--permission-mode"), "plan");
  assert.ok(argv.includes("--strict-mcp-config"), "an inherited MCP config would be a network");
  assert.match(after("--mcp-config"), /cove-empty-mcp\.json$/);
  assert.ok(argv.includes("--no-chrome"));
  assert.ok(argv.includes("--disable-slash-commands"));
  // The named tools that would make the mandate's sentence false.
  for (const tool of ["Bash", "Read", "Write", "Edit", "WebSearch", "WebFetch"]) {
    assert.equal(argv.includes(tool), false, `${tool} must not be granted`);
  }
});

test("the Codex argv and config say the same thing", () => {
  const argv = buildChiefOfStaffCodexArgv({
    workspace: "/tmp/workspace",
    schemaPath: "/tmp/schema.json",
    outputPath: "/tmp/out.json",
  });
  const joined = argv.join(" ");
  assert.match(joined, /sandbox_mode=read-only/);
  assert.match(joined, /features\.shell_tool=false/);
  assert.match(joined, /web_search="disabled"/);
  assert.equal(joined.includes("resume"), false, "a fresh call carries no foreign session");

  assert.match(CHIEF_OF_STAFF_CODEX_CONFIG, /sandbox_mode = "read-only"/);
  assert.match(CHIEF_OF_STAFF_CODEX_CONFIG, /shell_tool = false/);
  assert.match(CHIEF_OF_STAFF_CODEX_CONFIG, /web_search = false/);
  assert.match(CHIEF_OF_STAFF_CODEX_CONFIG, /apps = false/);
  assert.match(CHIEF_OF_STAFF_CODEX_CONFIG, /multi_agent = false/);
  // The one that is absent rather than present: Codex reads MCP servers from
  // its home, and this lane passes no explicit empty config the way the
  // groundwork lane does. What closes it is that the config it writes declares
  // none, and it writes that config over any drift on every run.
  assert.equal(/mcp_servers/.test(CHIEF_OF_STAFF_CODEX_CONFIG), false);
});
