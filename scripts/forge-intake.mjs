#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runForgeIntake } = require("../src/lib/intake/run.ts");
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = new Set([
  "imessage",
  "chat",
  "buddy",
  "day-plan",
  "meeting",
  "email",
  "voice",
]);

function option(args, name, { allowLeadingDash = false } = {}) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || (!allowLeadingDash && value.startsWith("--"))) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseForgeIntakeArgs(args) {
  const text = option(args, "--text", { allowLeadingDash: true });
  const file = option(args, "--file");
  if (Boolean(text) === Boolean(file)) {
    throw new Error("Pass exactly one of --text or --file.");
  }
  const source = option(args, "--source");
  if (!source || !SOURCES.has(source)) {
    throw new Error(
      "--source must be imessage, chat, buddy, day-plan, meeting, email, or voice.",
    );
  }
  return {
    text: text ?? readFileSync(file, "utf8"),
    source,
    ...(option(args, "--source-id")
      ? { sourceId: option(args, "--source-id") }
      : {}),
    dryRun: args.includes("--dry-run"),
  };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const result = await runForgeIntake(parseForgeIntakeArgs(args), {
      repoDir,
    });
    return result.exitCode;
  } catch (error) {
    process.stderr.write(
      `ERROR ${JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    return 2;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
