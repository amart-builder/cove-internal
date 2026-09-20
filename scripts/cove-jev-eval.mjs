#!/usr/bin/env node
/**
 * Evaluate a Jev lane against frozen labels.
 *
 *   node scripts/cove-jev-eval.mjs prepare [--lane email] [--split dev] [--json]
 *   node scripts/cove-jev-eval.mjs run [--lane meeting] [--split dev]
 *
 * `prepare` is the default and is the safe one: it builds the exact request
 * Cove would send for every case and prints it, with no credential and no
 * network call. Read it before anyone decides what Cove is allowed to send.
 *
 * `run` calls the live API and scores the answers. It refuses without a
 * credential, and it refuses the held-out split outright, because a split you
 * can rerun while editing question wording is not held out.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { askJev } from "../src/lib/jev/client.ts";
import { readJevCredential } from "../src/lib/jev/settings.ts";
import {
  caseEvidence,
  formatJevEvaluation,
  formatJevMeetingEvaluation,
  meetingCaseEvidence,
  parseJevEmailCases,
  parseJevMeetingCases,
  prepareJevEmailCases,
  prepareJevMeetingCases,
  scoreJevEmailCases,
  scoreJevMeetingCases,
} from "../src/lib/jev/evaluation.ts";
import { buildJevEmailQuestions, buildJevEmailState } from "../src/lib/jev/email.ts";
import { buildJevMeetingQuestions, buildJevMeetingState } from "../src/lib/jev/meeting.ts";

const repoDirDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadCases(repoDir = repoDirDefault) {
  const file = path.join(repoDir, "fixtures", "jev", "email-cases.json");
  return parseJevEmailCases(JSON.parse(readFileSync(file, "utf8")));
}

export function loadMeetingCases(repoDir = repoDirDefault) {
  const file = path.join(repoDir, "fixtures", "jev", "meeting-cases.json");
  return parseJevMeetingCases(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * One lane is one set of cases, one request shape and one scorer. Keeping them
 * behind the same two commands means the offline `prepare` habit carries to
 * every lane rather than being something the email lane happened to get.
 */
const LANES = {
  email: {
    load: loadCases,
    prepare: prepareJevEmailCases,
    request: (item) => {
      const evidence = caseEvidence(item);
      return {
        state: buildJevEmailState(evidence),
        questions: buildJevEmailQuestions({
          evidence,
          triage: true,
          commitmentAudit: (item.commitments ?? []).length > 0,
        }),
      };
    },
    score: scoreJevEmailCases,
    format: formatJevEvaluation,
  },
  meeting: {
    load: loadMeetingCases,
    prepare: prepareJevMeetingCases,
    request: (item) => {
      const evidence = meetingCaseEvidence(item);
      return {
        state: buildJevMeetingState(evidence),
        questions: buildJevMeetingQuestions(evidence),
      };
    },
    score: scoreJevMeetingCases,
    format: formatJevMeetingEvaluation,
  },
};

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "prepare";
  const splitIndex = argv.indexOf("--split");
  const split = splitIndex === -1 ? "dev" : argv[splitIndex + 1];
  const laneIndex = argv.indexOf("--lane");
  const lane = laneIndex === -1 ? "email" : argv[laneIndex + 1];
  return { command, split, lane, json: argv.includes("--json") };
}

function selected(cases, split) {
  return split === "all" ? cases : cases.filter((item) => item.split === split);
}

async function main(argv) {
  const { command, split, lane, json } = parseArgs(argv);
  const laneImpl = LANES[lane];
  if (!laneImpl) {
    console.error(`Unknown lane: ${lane}. Use ${Object.keys(LANES).join(" or ")}.`);
    return 1;
  }
  const cases = selected(laneImpl.load(), split);
  if (cases.length === 0) {
    console.error(`No ${lane} cases in split ${split}.`);
    return 1;
  }

  if (command === "prepare") {
    const prepared = laneImpl.prepare(cases);
    if (json) {
      console.log(JSON.stringify(prepared, null, 2));
      return 0;
    }
    for (const item of prepared) {
      console.log(`${item.id} (${item.split}), ${item.requestBytes} bytes`);
      console.log(`  state: ${JSON.stringify(item.state)}`);
      console.log(`  questions: ${Object.keys(item.questions).join(", ")}`);
      console.log("");
    }
    console.log(
      `${prepared.length} case(s) prepared. No credential was read and no request was sent.`,
    );
    return 0;
  }

  if (command !== "run") {
    console.error(`Unknown command: ${command}. Use prepare or run.`);
    return 1;
  }

  if (split === "heldout" || split === "all") {
    console.error(
      "Refusing to run against the held-out split. Score it once, deliberately, "
        + "after the wording is frozen.",
    );
    return 1;
  }
  const apiKey = readJevCredential();
  if (!apiKey) {
    console.error(
      "No TypeSafe credential is configured. Set COVE_TYPESAFE_API_KEY to run live, "
        + "or use prepare to inspect the requests offline.",
    );
    return 1;
  }

  const answersById = {};
  for (const item of cases) {
    const result = await askJev(laneImpl.request(item), { apiKey });
    if (!result.ok) {
      console.error(`${item.id}: ${result.error.code} ${result.error.message}`);
      continue;
    }
    answersById[item.id] = result.answers;
  }
  const summary = laneImpl.score({ cases, answersById });
  console.log(json ? JSON.stringify(summary, null, 2) : laneImpl.format(summary));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
