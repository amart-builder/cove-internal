#!/usr/bin/env node
/**
 * Release gate for the exact checkout being shipped.
 *
 * Every child uses this process's Node runtime so native modules, TypeScript,
 * tests, and the production build agree about the environment. Add a new gate
 * here only when it is deterministic and required for every supported install.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const tests = readdirSync("tests")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `tests/${file}`);

const packageBin = (relativePath) => path.resolve("node_modules", relativePath);
const childPath = [path.dirname(process.execPath), process.env.PATH]
  .filter(Boolean)
  .join(path.delimiter);
const steps = [
  [process.execPath, [packageBin("typescript/bin/tsc"), "--noEmit"]],
  [process.execPath, [packageBin("eslint/bin/eslint.js"), "--max-warnings=0"]],
  // Bound concurrent test processes for client laptops. Each test file can
  // load TypeScript and SQLite; CPU-count concurrency can exhaust memory.
  [process.execPath, ["--import", "tsx", "--test", "--test-concurrency=2", ...tests]],
  // Turbopack's CSS worker binds an internal port, which managed coding-agent
  // sandboxes can reject. Webpack is a supported Next build path and keeps the
  // public release gate deterministic in the exact Claude/Codex setup flow.
  [process.execPath, [packageBin("next/dist/bin/next"), "build", "--webpack"]],
];

for (const [command, args] of steps) {
  process.stdout.write(`\n[cove-verify] ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, PATH: childPath },
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write("\n[cove-verify] all checks passed\n");
