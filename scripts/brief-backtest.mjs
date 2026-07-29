#!/usr/bin/env -S node --import tsx

/*
 * PRIVATE DATA WARNING: Stored inputs contain the same private data as forge.db.
 * Results go to stdout only. A run with --run costs about $1.50.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  buildMorningBriefCommand,
  buildMorningBriefPrompt,
  morningBriefModelConfig,
  parseMorningBriefOutput,
} from "../src/lib/claude-execution/brief-commands.ts";
import { validateMorningBrief } from "../src/lib/day-plan/brief.ts";
import { coveEnv } from "../src/lib/env.ts";
import { coveDataDir } from "../src/lib/operator.ts";

export const BACKTEST_WARNING =
  "PRIVATE DATA: brief inputs have the same sensitivity as forge.db. Output goes to stdout only. --run costs about $1.50.";

export function parseBacktestArgs(argv) {
  const run = argv.includes("--run");
  const positional = argv.filter((argument) => argument !== "--run");
  if (positional[0] === "--latest") {
    const count = Number(positional[1]);
    if (!Number.isInteger(count) || count < 1 || positional.length !== 2) {
      throw new Error("Usage: brief-backtest.mjs <artifact-id | --latest N> [--run]");
    }
    return { run, latest: count };
  }
  if (
    positional.length !== 1 ||
    !/^[A-Za-z0-9._-]+$/.test(positional[0] ?? "")
  ) {
    throw new Error("Usage: brief-backtest.mjs <artifact-id | --latest N> [--run]");
  }
  return { run, artifactId: positional[0] };
}

export function knownTaskIdsFromSections(sections) {
  const ids = new Set();
  for (const section of sections) {
    if (section.id !== "task_snapshot") continue;
    for (const line of section.text.split("\n")) {
      const match = /\bid=([^\s"]+).*?\bcandidate_ok\b/.exec(line);
      if (match) ids.add(match[1]);
    }
  }
  return ids;
}

export function storedBriefHeadline(storedBrief) {
  const headline = typeof storedBrief?.headline === "string"
    ? storedBrief.headline.replace(/\s+/g, " ").trim()
    : "";
  if (headline) return headline.slice(0, 240);
  const narrative = typeof storedBrief?.lensNarrative === "string"
    ? storedBrief.lensNarrative.replace(/\s+/g, " ").trim()
    : "";
  if (!narrative) return undefined;
  const firstSentence = /^.*?[.!?](?:\s|$)/.exec(narrative)?.[0] ?? narrative;
  return firstSentence.trim().slice(0, 240) || undefined;
}

function storedInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("brief input is not an object");
  }
  const requiredStrings = [
    "artifact_id",
    "target_local_date",
    "target_timezone",
    "written_at",
  ];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || !value[key]) {
      throw new Error(`brief input is missing ${key}`);
    }
  }
  if (
    !Number.isInteger(value.prompt_version) ||
    !Number.isInteger(value.schema_version) ||
    !Array.isArray(value.sections) ||
    !value.manifest ||
    typeof value.manifest !== "object"
  ) {
    throw new Error("brief input has an invalid generation shape");
  }
  return value;
}

export function formatBacktestSummary(input, storedBrief) {
  const prompt = buildMorningBriefPrompt({
    targetLocalDate: input.target_local_date,
    targetTimezone: input.target_timezone,
    sections: input.sections,
    manifest: input.manifest,
  });
  return [
    `Artifact: ${input.artifact_id}`,
    `Prompt chars: ${prompt.length}`,
    `Stored headline: ${storedBriefHeadline(storedBrief) ??
      (storedBrief ? "(stored artifact has no headline text)" : "(stored artifact unavailable)")}`,
    "Sections:",
    ...input.sections.map(
      (section) => `- ${section.id} (${section.label}): ${section.text.length} chars`,
    ),
  ].join("\n");
}

function loadInput(inputPath) {
  return storedInput(JSON.parse(readFileSync(inputPath, "utf8")));
}

function selectInputs(inputDir, selection) {
  if (selection.artifactId) {
    const inputPath = path.join(inputDir, `${selection.artifactId}.json`);
    if (!existsSync(inputPath)) throw new Error(`No stored input for ${selection.artifactId}`);
    return [loadInput(inputPath)];
  }
  return readdirSync(inputDir)
    .filter((name) => /^[A-Za-z0-9._-]+\.json$/.test(name))
    .map((name) => loadInput(path.join(inputDir, name)))
    .sort((left, right) => right.written_at.localeCompare(left.written_at))
    .slice(0, selection.latest);
}

function readStoredBrief(database, artifactId) {
  const row = database.prepare(
    "SELECT brief_json FROM day_plan_briefs WHERE id = ? AND status = 'succeeded'",
  ).get(artifactId);
  if (!row?.brief_json) return undefined;
  try {
    const brief = JSON.parse(row.brief_json);
    return brief && typeof brief === "object" ? brief : undefined;
  } catch {
    return undefined;
  }
}

function candidatesLabel(brief) {
  const candidates = brief?.existingTaskCandidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "none";
  return candidates
    .map((candidate) => `${candidate.taskId}: ${candidate.whyToday}`)
    .join(" | ");
}

function runReplay(input, storedBrief, repoDir) {
  const config = morningBriefModelConfig();
  const command = buildMorningBriefCommand({
    claudePath:
      coveEnv("CLAUDE_BIN") ?? path.join(homedir(), ".local", "bin", "claude"),
    emptyMcpConfigPath: path.join(repoDir, "scripts", "cove-empty-mcp.json"),
    cwd: repoDir,
    targetLocalDate: input.target_local_date,
    targetTimezone: input.target_timezone,
    sections: input.sections,
    manifest: input.manifest,
    modelAlias: config.modelAlias,
    effort: config.effort,
    budgetUsd: config.budgetUsd,
  });
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd,
    input: command.stdin,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: config.timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const reason = String(result.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error(`Claude exited ${result.status}: ${reason || "no error text"}`);
  }
  const sourceIds = new Set(
    input.manifest.sources
      .filter((source) => source.freshness !== "missing" && source.chars > 0)
      .map((source) => source.id),
  );
  const replay = validateMorningBrief(parseMorningBriefOutput(result.stdout), {
    knownTaskIds: knownTaskIdsFromSections(input.sections),
    sourceIds,
  }).brief;
  return [
    `Stored headline: ${storedBriefHeadline(storedBrief) ??
      (storedBrief ? "(stored artifact has no headline text)" : "(stored artifact unavailable)")}`,
    `Replay headline: ${replay.headline}`,
    `Stored candidates: ${candidatesLabel(storedBrief)}`,
    `Replay candidates: ${candidatesLabel(replay)}`,
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const selection = parseBacktestArgs(argv);
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = coveDataDir();
  const inputDir = path.join(dataDir, "brief-inputs");
  if (!existsSync(inputDir)) throw new Error(`No brief input directory at ${inputDir}`);
  const dbPath = coveEnv("DB_PATH") ?? path.join(dataDir, "forge.db");
  const database = existsSync(dbPath)
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : undefined;
  try {
    process.stdout.write(`${BACKTEST_WARNING}\n\n`);
    const inputs = selectInputs(inputDir, selection);
    for (const [index, input] of inputs.entries()) {
      const brief = database ? readStoredBrief(database, input.artifact_id) : undefined;
      if (index > 0) process.stdout.write("\n");
      process.stdout.write(`${formatBacktestSummary(input, brief)}\n`);
      if (selection.run) {
        process.stdout.write(`${runReplay(input, brief, repoDir)}\n`);
      }
    }
  } finally {
    database?.close();
  }
}

function isMainModule() {
  try {
    return Boolean(process.argv[1]) &&
      realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
