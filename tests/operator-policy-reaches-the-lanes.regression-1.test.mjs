import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedOperatorPolicy, TEMPLATE_RELATIVE } from "../scripts/lib/seed-operator-policy.mjs";
import { readOperatorPolicy } from "../src/lib/operator-policy.ts";

const ROOT = process.cwd();

function dataDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a fresh install has an operator policy the lanes can read", (t) => {
  const dir = dataDir(t);
  assert.equal(readOperatorPolicy({ dataDir: dir }), null, "nothing is there before the install");

  const result = seedOperatorPolicy({ dataDir: dir, repoDir: ROOT });

  assert.equal(result.created, true);
  const policy = readOperatorPolicy({ dataDir: dir });
  assert.ok(policy, "the lanes must find a policy after an install, not null");
  // The one sentence that exists nowhere else in the repository. Six lanes put
  // this text at the top of their prompt; if it is not here it reaches no model.
  assert.match(policy, /check existing open tasks and pending suggestions/);
  assert.equal(policy, readFileSync(path.join(ROOT, TEMPLATE_RELATIVE), "utf8").trim());
});

test("an operator's own policy is never overwritten", (t) => {
  const own = "# Mine\n\nNever text me before 9.\n";

  const current = dataDir(t);
  writeFileSync(path.join(current, "cove-policy.md"), own);
  assert.equal(seedOperatorPolicy({ dataDir: current, repoDir: ROOT }).created, false);
  assert.equal(readOperatorPolicy({ dataDir: current }), own.trim());

  // An install made before the cove-/forge- rename reads the legacy name, so
  // seeding beside it would leave the operator's own policy unread.
  const legacy = dataDir(t);
  writeFileSync(path.join(legacy, "forge-policy.md"), own);
  assert.equal(seedOperatorPolicy({ dataDir: legacy, repoDir: ROOT }).created, false);
  assert.equal(readOperatorPolicy({ dataDir: legacy }), own.trim());
});

test("the seeded policy is written as privately as the files beside it", (t) => {
  const dir = dataDir(t);
  const { path: written } = seedOperatorPolicy({ dataDir: dir, repoDir: ROOT });
  assert.equal(statSync(written).mode & 0o777, 0o600);
});

test("a tree with no template stops the install rather than shipping without a policy", (t) => {
  const dir = dataDir(t);
  const emptyRepo = dataDir(t);

  assert.throws(() => seedOperatorPolicy({ dataDir: dir, repoDir: emptyRepo }), /ENOENT/);
  assert.equal(readOperatorPolicy({ dataDir: dir }), null);
});

test("the installer seeds the policy before it loads a single lane", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  // Unindented, so it is not inside any conditional: every install gets one.
  const call = /^"\$NODE_REAL" "\$REPO_DIR\/scripts\/lib\/seed-operator-policy\.mjs" "\$COVE_DATA_DIR" "\$REPO_DIR"$/m;
  assert.match(installer, call, "every install seeds the policy, using its own resolved paths");

  // A lane that starts before the file exists reads no policy on its first run,
  // and --mini bootstraps four of them well before the skills are laid down.
  const seeded = installer.search(call);
  const firstLane = installer.indexOf("launchctl bootstrap");
  assert.ok(firstLane > 0 && seeded < firstLane, "the policy has to be on disk before any lane is loaded");

  // The prerequisite phase only checks; it must stay free of writes, and the
  // data-directory block is pinned elsewhere as permissions and nothing else.
  assert.ok(seeded > installer.indexOf('CODEX_PLIST_ENTRY=""'), "seeding is not a preflight check");
  assert.ok(seeded > installer.indexOf("BUDDY_APP_URL="), "seeding is not part of narrowing the data directory");
});

test("the template ships to the people who install Cove", () => {
  const exporter = readFileSync(path.join(ROOT, "scripts", "export-cove-client.mjs"), "utf8");
  assert.match(exporter, /"prompts\/"/, "the seed reads the template at install time, so it has to be exported");
});
