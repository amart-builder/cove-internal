// A wrong Node version fails in two disguises, neither of which says "Node":
// on 22 the gate fails in bulk on plain assertions, and a native module built
// under another version throws "Module did not self-register" from
// better-sqlite3. SETUP.md named 24 as the supported release while engines
// accepted 20 and 22 and the installer checked nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");

test("engines requires the release SETUP.md names", () => {
  const { engines } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(engines.node, ">=24");
});

test("the documents no longer promise a version the code will not take", () => {
  const setup = readFileSync(path.join(ROOT, "SETUP.md"), "utf8");
  assert.doesNotMatch(setup, /engines also accepts/);
  assert.doesNotMatch(setup, /installer does not check the version/);
  assert.match(setup, /Node 24 LTS is the supported release/);
});

// The check runs on the real thing: the installer's own lines, in a shell, with
// a stub `node` reporting the version under test.
function runVersionCheck(t, version) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-node-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = installer.indexOf('NODE_BIN="$(dirname "$NODE_REAL")"');
  const end = installer.indexOf("NODE_MAJOR=", start) === -1 ? -1 : installer.indexOf("fi\n", installer.indexOf("NODE_MAJOR=", start));
  assert.ok(start > 0 && end > start, "install-cove-local.sh no longer checks the Node version");
  const block = installer.slice(start, end + 3);

  const stub = path.join(dir, "node");
  writeFileSync(stub, `#!/bin/sh\ncase "$*" in\n  *versions.node*) printf '%s' "${version.split(".")[0]}" ;;\n  -v) printf 'v%s' "${version}" ;;\nesac\n`, { mode: 0o755 });
  const harness = path.join(dir, "check.sh");
  writeFileSync(harness, ["set -euo pipefail", `NODE_REAL=${JSON.stringify(stub)}`, block, "echo version-check-passed"].join("\n"));
  try {
    return { ok: true, output: execFileSync("bash", [harness], { encoding: "utf8" }) };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("the installer stops on an old Node and says so in plain words", (t) => {
  for (const version of ["20.19.0", "22.13.1"]) {
    const result = runVersionCheck(t, version);
    assert.equal(result.ok, false, `Node ${version} must not install`);
    assert.match(result.output, /Cove needs Node 24 or newer/);
    assert.match(result.output, new RegExp(version.replace(/\./g, "\\.")), "the message names the version found");
    assert.doesNotMatch(result.output, /version-check-passed/);
  }
});

test("Node 24 and newer carry on", (t) => {
  for (const version of ["24.21.0", "25.0.0"]) {
    const result = runVersionCheck(t, version);
    assert.equal(result.ok, true, `Node ${version} must install`);
    assert.match(result.output, /version-check-passed/);
  }
});
