#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const tests = readdirSync("tests")
  .filter((file) => file.endsWith(".test.mjs"))
  .sort()
  .map((file) => `tests/${file}`);

const steps = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "lint"]],
  ["npx", ["tsx", "--test", ...tests]],
  ["npm", ["run", "build"]],
];

for (const [command, args] of steps) {
  process.stdout.write(`\n[cove-verify] ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write("\n[cove-verify] all checks passed\n");
