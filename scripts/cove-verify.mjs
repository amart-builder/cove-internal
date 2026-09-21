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
  //
  // The zone is pinned because Cove's rules are wall-clock rules -- a noon
  // floor, quiet-hour boundaries, a cutoff at the end of tomorrow -- and the
  // suite asserts them against fixed instants written with a Pacific offset.
  // Read in the machine's own zone, the same instant falls on the other side
  // of those boundaries: eight tests in six files pass in Pacific and fail in
  // New York, and eleven fail in UTC, on an install with nothing wrong with
  // it. This gate decides whether a setup may continue, so it pins the zone
  // its fixtures were written in. That does not change what Cove does for a
  // person -- the product takes the timezone from their profile, and Pacific
  // appears in product code only as the fallback for a profile that has not
  // named one yet. Set COVE_VERIFY_TZ to run the suite against another zone
  // on purpose.
  [
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=2", ...tests],
    { TZ: process.env.COVE_VERIFY_TZ ?? "America/Los_Angeles" },
  ],
  // Turbopack's CSS worker binds an internal port, which managed coding-agent
  // sandboxes can reject. Webpack is a supported Next build path and keeps the
  // public release gate deterministic in the exact Claude/Codex setup flow.
  [process.execPath, [packageBin("next/dist/bin/next"), "build", "--webpack"]],
];

for (const [command, args, stepEnv] of steps) {
  process.stdout.write(`\n[cove-verify] ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    // Next.js collects anonymous telemetry by default, so the release gate on
    // a person's own laptop reported the build to Vercel. Nothing sensitive
    // goes, but Cove tells people it is local-first and names the places data
    // leaves the machine, and this was not one of them.
    // `stepEnv` comes last so a step can pin its own value -- the timezone the
    // suite's fixtures were written in is exactly that.
    env: { ...process.env, PATH: childPath, NEXT_TELEMETRY_DISABLED: "1", ...stepEnv },
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write("\n[cove-verify] all checks passed\n");
