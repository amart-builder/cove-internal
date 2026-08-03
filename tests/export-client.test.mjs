import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const EXPORT_SCRIPT = new URL(
  "../scripts/export-cove-client.mjs",
  import.meta.url,
);

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function runExport(repo, output, args = []) {
  return spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "export-cove-client.mjs"), "--output", output, ...args],
    { encoding: "utf8" },
  );
}

test("client export is clean by default and explicit about dirty exports", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-client-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "tests"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# Cove\n");
  writeFileSync(path.join(repo, "SETUP.md"), "# Setup\n");
  writeFileSync(path.join(repo, "LICENSE"), "Test license\n");
  writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({
    name: "cove-test",
    version: "1.0.0",
  }, null, 2)}\n`);
  writeFileSync(path.join(repo, "AGENTS.md"), "# Client agent instructions\n");
  writeFileSync(
    path.join(repo, "CLAUDE.md"),
    "@AGENTS.md\n\nOperator-only model and machine guidance.\n",
  );
  const allowedFixture = "ghp_" + "12345678901234567890";
  writeFileSync(
    path.join(repo, "tests", "progress-reconcile.test.mjs"),
    `const fixtures = ["${allowedFixture}", "${allowedFixture}"];\n`,
  );
  copyFileSync(EXPORT_SCRIPT, path.join(repo, "scripts", "export-cove-client.mjs"));
  git(repo, ["init", "-q"]);
  git(repo, [
    "add",
    "AGENTS.md",
    "CLAUDE.md",
    "LICENSE",
    "README.md",
    "SETUP.md",
    "package.json",
    "scripts/export-cove-client.mjs",
    "tests/progress-reconcile.test.mjs",
  ]);
  git(repo, [
    "-c",
    "user.name=Cove Test",
    "-c",
    "user.email=cove-test@example.com",
    "commit",
    "-qm",
    "Initial fixture",
  ]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const cleanOutput = path.join(dir, "clean-export");
  const clean = runExport(repo, cleanOutput);
  assert.equal(clean.status, 0, clean.stderr);
  const cleanManifest = JSON.parse(readFileSync(
    path.join(cleanOutput, "COVE_CLIENT_MANIFEST.json"),
    "utf8",
  ));
  assert.equal(cleanManifest.source_sha, head);
  assert.equal(cleanManifest.source_worktree_dirty, false);
  assert.equal(cleanManifest.allow_dirty, false);
  assert.deepEqual(cleanManifest.checks.allowlisted_fixture_identifiers, [
    "progress-github-personal-token",
  ]);
  const exportedFixture = readFileSync(
    path.join(cleanOutput, "tests", "progress-reconcile.test.mjs"),
    "utf8",
  );
  assert.equal(exportedFixture.includes(allowedFixture), false);
  assert.match(exportedFixture, /ghp_\" \+ \"12345678901234567890/);
  assert.equal(readFileSync(path.join(cleanOutput, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(existsSync(path.join(cleanOutput, "AGENTS.md")), true);
  assert.equal(readFileSync(path.join(cleanOutput, "LICENSE"), "utf8"), "Test license\n");
  const clientPackage = JSON.parse(readFileSync(
    path.join(cleanOutput, "package.json"),
    "utf8",
  ));
  assert.equal(clientPackage.license, "SEE LICENSE IN LICENSE");
  assert.deepEqual(clientPackage.engines, { node: ">=20" });

  writeFileSync(path.join(repo, "dirty.txt"), "untracked\n");
  const refusedOutput = path.join(dir, "refused-export");
  const refused = runExport(repo, refusedOutput);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to export a dirty worktree/);
  assert.match(refused.stderr, /dirty\.txt/);
  assert.equal(existsSync(refusedOutput), false);

  const dirtyOutput = path.join(dir, "dirty-export");
  const allowed = runExport(repo, dirtyOutput, ["--allow-dirty"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  const dirtyManifest = JSON.parse(readFileSync(
    path.join(dirtyOutput, "COVE_CLIENT_MANIFEST.json"),
    "utf8",
  ));
  assert.equal(dirtyManifest.source_worktree_dirty, true);
  assert.equal(dirtyManifest.allow_dirty, true);

  rmSync(path.join(repo, "dirty.txt"));
  mkdirSync(path.join(repo, "src"));
  const fakeGithubToken = "ghp_" + "A".repeat(36);
  writeFileSync(path.join(repo, "src", "leak.txt"), `${fakeGithubToken}\n`);
  git(repo, ["add", "src/leak.txt"]);
  git(repo, [
    "-c",
    "user.name=Cove Test",
    "-c",
    "user.email=cove-test@example.com",
    "commit",
    "-qm",
    "Add secret fixture",
  ]);

  const secretOutput = path.join(dir, "secret-export");
  const secret = runExport(repo, secretOutput);
  assert.notEqual(secret.status, 0);
  assert.match(secret.stderr, /Potential secrets found/);
  assert.match(secret.stderr, /src\/leak\.txt/);
  assert.equal(existsSync(secretOutput), false);

  rmSync(path.join(repo, "src", "leak.txt"));
  writeFileSync(path.join(repo, "README.md"), "# Cove\n\nUse Composio for email.\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["add", "-u", "src/leak.txt"]);
  git(repo, [
    "-c",
    "user.name=Cove Test",
    "-c",
    "user.email=cove-test@example.com",
    "commit",
    "-qm",
    "Add unsupported setup text",
  ]);
  const composioOutput = path.join(dir, "composio-export");
  const composio = runExport(repo, composioOutput);
  assert.notEqual(composio.status, 0);
  assert.match(composio.stderr, /README\.md still instructs clients to use Composio/);
  assert.equal(existsSync(composioOutput), false);

  writeFileSync(path.join(repo, "README.md"), "# Cove\n");
  writeFileSync(
    path.join(repo, "SETUP.md"),
    "# Setup\n\nOptional cloud data for multi-device use.\n",
  );
  git(repo, ["add", "README.md", "SETUP.md"]);
  git(repo, [
    "-c",
    "user.name=Cove Test",
    "-c",
    "user.email=cove-test@example.com",
    "commit",
    "-qm",
    "Add unsupported cloud setup text",
  ]);
  const cloudOutput = path.join(dir, "cloud-export");
  const cloud = runExport(repo, cloudOutput);
  assert.notEqual(cloud.status, 0);
  assert.match(cloud.stderr, /SETUP\.md still advertises an unsupported cloud runtime/);
  assert.equal(existsSync(cloudOutput), false);
});

test("client export excludes known internal paths", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-client-internal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "docs"), { recursive: true });
  mkdirSync(path.join(repo, "data"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# Cove\n");
  writeFileSync(path.join(repo, "SETUP.md"), "# Setup\n");
  writeFileSync(path.join(repo, "STATUS.md"), "Internal status\n");
  writeFileSync(path.join(repo, "BUDDY-DEPLOY.md"), "Internal deployment notes\n");
  writeFileSync(path.join(repo, "docs", "internal.md"), "Internal documentation\n");
  writeFileSync(path.join(repo, "data", "cove-meetings.json"), "{}\n");
  copyFileSync(EXPORT_SCRIPT, path.join(repo, "scripts", "export-cove-client.mjs"));
  git(repo, ["init", "-q"]);
  git(repo, [
    "add",
    "README.md",
    "SETUP.md",
    "STATUS.md",
    "BUDDY-DEPLOY.md",
    "docs/internal.md",
    "data/cove-meetings.json",
    "scripts/export-cove-client.mjs",
  ]);
  git(repo, [
    "-c",
    "user.name=Cove Test",
    "-c",
    "user.email=cove-test@example.com",
    "commit",
    "-qm",
    "Internal path fixture",
  ]);

  const output = path.join(dir, "export");
  const result = runExport(repo, output);
  assert.equal(result.status, 0, result.stderr);
  for (const internalPath of [
    "STATUS.md",
    "BUDDY-DEPLOY.md",
    "docs/internal.md",
    "data/cove-meetings.json",
  ]) {
    assert.equal(existsSync(path.join(output, internalPath)), false, internalPath);
  }
});
