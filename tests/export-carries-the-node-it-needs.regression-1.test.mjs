// The export rewrites package.json, and it restated engines as a literal. So
// requiring Node 24 in this repository changed nothing for the only
// package.json a person installing Cove ever sees: the export kept saying 20
// and 22 were fine. Same shape as the skills that named a port the installer
// had already moved on from -- a value written down in a second place the
// first writer never revisits.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();

// The exporter reads git to refuse a dirty worktree, so it only runs in a
// checkout. This same suite ships to the people who install Cove, where there
// is no .git and nobody will ever run an export; the claim below is about a
// repository, so it is skipped rather than failed there. The source assertion
// after it is the half that holds everywhere, and it is the half that catches
// a literal creeping back in.
const inCheckout = existsSync(path.join(ROOT, ".git"));

test("the exported package.json carries this repository's Node requirement", {
  skip: inCheckout ? false : "not a git checkout, so the exporter cannot run here",
}, (t) => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "cove-export-engines-")), "client");
  t.after(() => rmSync(path.dirname(out), { recursive: true, force: true }));

  execFileSync(process.execPath, [
    path.join(ROOT, "scripts", "export-cove-client.mjs"), "--output", out, "--allow-dirty",
  ], { cwd: ROOT, encoding: "utf8" });

  const mine = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const shipped = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
  assert.deepEqual(shipped.engines, mine.engines,
    "the export must not restate a Node requirement of its own");
  assert.equal(shipped.engines.node, ">=24");

  // The one field the export does deliberately replace still is.
  assert.equal(shipped.license, "SEE LICENSE IN LICENSE");
});

test("the exporter reads the requirement rather than spelling it out", () => {
  const exporter = readFileSync(path.join(ROOT, "scripts", "export-cove-client.mjs"), "utf8");
  assert.match(exporter, /engines: sourcePackage\.engines/);
  assert.doesNotMatch(exporter, /engines: \{\s*node:/,
    "a literal here drifts from package.json the moment one of them changes");
});
