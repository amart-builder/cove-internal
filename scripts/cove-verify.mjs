#!/usr/bin/env node
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
  [process.execPath, ["--import", "tsx", "--test", ...tests]],
  [process.execPath, [packageBin("next/dist/bin/next"), "build"]],
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
