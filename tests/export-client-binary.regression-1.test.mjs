import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
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

function commit(repo, message) {
  git(repo, [
    "-c",
    "user.name=Cove Test",
    "-c",
    "user.email=cove-test@example.com",
    "commit",
    "-qam",
    message,
  ]);
}

// Regression: ISSUE-001 — client export decoded binary files as UTF-8
// Found by /qa on 2026-08-06
// Report: .gstack/qa-reports/qa-report-cove-local-2026-08-06.md
test("client export preserves binary bytes and still scans their ASCII secrets", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-client-binary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "# Cove\n");
  writeFileSync(path.join(repo, "SETUP.md"), "# Setup\n");
  copyFileSync(EXPORT_SCRIPT, path.join(repo, "scripts", "export-cove-client.mjs"));
  const binary = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x00, 0x80]);
  writeFileSync(path.join(repo, "src", "fixture.bin"), binary);
  git(repo, ["init", "-q"]);
  git(repo, ["add", "README.md", "SETUP.md", "scripts/export-cove-client.mjs", "src/fixture.bin"]);
  commit(repo, "Add binary fixture");

  const output = path.join(dir, "export");
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "export-cove-client.mjs"), "--output", output],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const exported = readFileSync(path.join(output, "src", "fixture.bin"));
  assert.deepEqual(exported, binary);
  const manifest = JSON.parse(readFileSync(
    path.join(output, "COVE_CLIENT_MANIFEST.json"),
    "utf8",
  ));
  const entry = manifest.files.find((file) => file.path === "src/fixture.bin");
  assert.equal(entry.bytes, binary.length);
  assert.equal(
    entry.sha256,
    createHash("sha256").update(binary).digest("hex"),
  );

  const fakeGithubToken = "ghp_" + "A".repeat(36);
  writeFileSync(
    path.join(repo, "src", "fixture.bin"),
    Buffer.concat([Buffer.from([0xff]), Buffer.from(fakeGithubToken, "ascii")]),
  );
  git(repo, ["add", "src/fixture.bin"]);
  commit(repo, "Add binary secret fixture");
  const secretOutput = path.join(dir, "secret-export");
  const secret = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "export-cove-client.mjs"), "--output", secretOutput],
    { encoding: "utf8" },
  );
  assert.notEqual(secret.status, 0);
  assert.match(secret.stderr, /Potential secrets found/);
  assert.match(secret.stderr, /src\/fixture\.bin/);
});
