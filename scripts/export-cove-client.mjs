#!/usr/bin/env node
/**
 * Builds the public Cove repository from an explicit allowlist.
 *
 * The internal checkout is never copied wholesale. Every exported file is
 * selected, scanned, hashed, and written into a new empty directory. Keep this
 * boundary strict: adding a root document or source directory requires an
 * intentional allowlist change and an export regression test.
 */
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  throw new Error(
    "Usage: node scripts/export-cove-client.mjs --output <empty-directory> [--allow-dirty]",
  );
}
const output = path.resolve(process.argv[outputIndex + 1]);
const allowDirty = process.argv.includes("--allow-dirty");
const outputCreatedByRun = !existsSync(output);
if (output === root || root.startsWith(`${output}${path.sep}`)) {
  throw new Error("The client export must be outside the Cove repository.");
}
if (existsSync(output) && readdirSync(output).length > 0) {
  throw new Error(`Export destination is not empty: ${output}`);
}
const sourceSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const worktreeStatus = execFileSync(
  "git",
  ["-C", root, "status", "--porcelain=v1"],
  { encoding: "utf8" },
).trim();
if (worktreeStatus && !allowDirty) {
  const dirtyPaths = worktreeStatus
    .split(/\r?\n/)
    .slice(0, 5)
    .map((line) => line.slice(3));
  throw new Error(
    `Refusing to export a dirty worktree. Dirty paths:\n${dirtyPaths.join("\n")}\n` +
      "Commit or clean the worktree, or pass --allow-dirty explicitly.",
  );
}
mkdirSync(output, { recursive: true, mode: 0o700 });

function failWithCleanup(message) {
  if (
    outputCreatedByRun &&
    existsSync(output) &&
    readdirSync(output).length === 0
  ) {
    rmSync(output, { recursive: true });
  }
  throw new Error(message);
}

const rootFiles = new Set([
  ".gitignore",
  "AGENT_CONTRACT.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CODEBASE_GUIDE.md",
  "CLAUDE.md",
  "CONFIGURATION.md",
  "DATA.md",
  "EVALUATION.md",
  "LICENSE",
  "OPERATIONS.md",
  "PLANNING_RELIABILITY.md",
  "README.md",
  "SECURITY_AND_INTEGRATIONS.md",
  "SETUP.md",
  "eslint.config.mjs",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
]);
const allowedDirectories = [
  ".claude/skills/",
  "buddy/",
  "convex/",
  "fixtures/",
  "prompts/",
  "public/",
  "scripts/",
  "skills/",
  "src/",
  "tests/",
];
const allowedData = new Set([
  "data/cove-meetings.example.json",
  "data/cove-support.example.json",
  "data/cove-workspace.example.json",
]);
const excludedPaths = [
  ".claude/skills/cove-pipeline/",
  "skills/cove-pipeline/",
];

function allowed(file) {
  if (excludedPaths.some((directory) => file.startsWith(directory))) return false;
  if (!file.includes("/")) return rootFiles.has(file);
  if (allowedData.has(file)) return true;
  return allowedDirectories.some((directory) => file.startsWith(directory));
}

const listed = execFileSync(
  "git",
  ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
).split(/\r?\n/).filter(Boolean).filter(allowed).sort();

const secretPatterns = [
  /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk-ant-|sk-proj-)[A-Za-z0-9_-]{16,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{48}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bapikey_[0-9a-f]{20,}_[0-9a-f]{40,}\b/g,
  new RegExp("https:\\\/\\\/hooks\\.slack\\.com\\/" + "services\\/[A-Za-z0-9/_-]+", "g"),
  new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "g"),
];
const findings = [];
const manifestFiles = [];
const exportFiles = [];
const allowlistedFixtureIdentifiers = new Set();
const fixtureAllowlist = [
  {
    id: "progress-private-key",
    value: "-----BEGIN RSA " + "PRIVATE KEY-----\\nprivate\\n-----END RSA PRIVATE KEY-----",
    replacement: "-----BEGIN RSA \" + \"PRIVATE KEY-----\\nprivate\\n-----END RSA PRIVATE KEY-----",
  },
  {
    id: "progress-slack-webhook",
    value: "https://hooks.slack.com/" + "services/T0AAAAAAA/B1BBBBBBB/xLmQ9wErTyUiOpAsDfGhJkZx",
    replacement: "https://hooks.slack.com/\" + \"services/T0AAAAAAA/B1BBBBBBB/xLmQ9wErTyUiOpAsDfGhJkZx",
  },
  {
    id: "progress-github-personal-token",
    value: "ghp_" + "12345678901234567890",
    replacement: "ghp_\" + \"12345678901234567890",
  },
  {
    id: "progress-github-oauth-token",
    value: "gho_" + "12345678901234567890",
    replacement: "gho_\" + \"12345678901234567890",
  },
  {
    id: "progress-slack-token",
    value: "xoxb-" + "1234567890",
    replacement: "xoxb-\" + \"1234567890",
  },
];
const clientClaude = Buffer.from("@AGENTS.md\n", "utf8");

for (const file of listed) {
  const source = path.join(root, file);
  if (lstatSync(source).isSymbolicLink()) {
    failWithCleanup(`Symlinks are not allowed in the client export: ${file}`);
  }
  let bytes = file === "CLAUDE.md" ? clientClaude : readFileSync(source);
  if (file === "package.json") {
    const sourcePackage = JSON.parse(bytes.toString("utf8"));
    bytes = Buffer.from(`${JSON.stringify({
      ...sourcePackage,
      license: "SEE LICENSE IN LICENSE",
      engines: { node: "^20.19.0 || ^22.13.0 || >=24" },
    }, null, 2)}\n`, "utf8");
  }
  const isBinary = !isUtf8(bytes);
  let text = bytes.toString(isBinary ? "latin1" : "utf8");
  if (file === "tests/progress-reconcile.test.mjs") {
    for (const fixture of fixtureAllowlist) {
      if (text.includes(fixture.value)) {
        allowlistedFixtureIdentifiers.add(fixture.id);
        text = text.replaceAll(fixture.value, fixture.replacement);
      }
    }
  }
  if (!isBinary) {
    bytes = Buffer.from(text, "utf8");
  }
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}: ${pattern.source}`);
  }
  exportFiles.push({ file, source, bytes });
  manifestFiles.push({
    path: file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

if (findings.length > 0) {
  failWithCleanup(`Potential secrets found:\n${findings.join("\n")}`);
}
for (const setupFile of ["README.md", "SETUP.md"]) {
  const text = readFileSync(path.join(root, setupFile), "utf8");
  if (/\bComposio\b/i.test(text)) {
    failWithCleanup(`${setupFile} still instructs clients to use Composio.`);
  }
  if (/Optional cloud data for multi-device|Convex \(off by default\)/i.test(text)) {
    failWithCleanup(`${setupFile} still advertises an unsupported cloud runtime.`);
  }
}

for (const { file, source, bytes } of exportFiles) {
  const destination = path.join(output, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  chmodSync(destination, statSync(source).mode & 0o777);
}

const manifest = {
  version: 1,
  product: "Cove",
  source_sha: sourceSha,
  source_worktree_dirty: Boolean(worktreeStatus),
  allow_dirty: allowDirty,
  exported_at: new Date().toISOString(),
  file_count: manifestFiles.length,
  files: manifestFiles,
  checks: {
    explicit_allowlist: true,
    secret_patterns: "passed",
    setup_text: "passed",
    live_data_excluded: true,
    allowlisted_fixture_identifiers: [...allowlistedFixtureIdentifiers].sort(),
  },
};
writeFileSync(
  path.join(output, "COVE_CLIENT_MANIFEST.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ output, ...manifest.checks, file_count: manifest.file_count })}\n`);
