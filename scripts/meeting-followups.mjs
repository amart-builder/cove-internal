#!/usr/bin/env node
/**
 * Parse meeting notes into follow-ups and hand every item to Cove intake.
 *
 * The intake CLI owns durable capture, triage, task creation, and surfacing.
 * This script only acquires notes and uses the shared meeting extractor.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  extractMeetingFollowUps,
  inboundAckState,
  isOperatorOwned,
  meetingFollowUpText,
  parseNextSteps,
} from "../src/lib/intake/meeting-followups.mjs";
import {
  createComposioExecutor,
  writeWaitingCommitment,
} from "./cove-meeting-watch.mjs";
import { coveEnv } from "../src/lib/env-runtime.mjs";

export { parseNextSteps };

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { recordEvent, resolveEvent } = require("../src/lib/intake/inbox.ts");
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = coveEnv("DATA_DIR")?.trim() || path.join(repoDir, "data");
const intakeScript = path.join(repoDir, "scripts", "cove-intake.mjs");
const composio = createComposioExecutor({ cwd: repoDir });

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function titleFromText(text, fallback) {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first || first.length > 120 || /[.!?]$/.test(first)) return fallback;
  return first;
}

function stableSourceId(value) {
  return `meeting:${createHash("sha256").update(value).digest("hex")}`;
}

async function loadNotes() {
  const spoken = arg("--text");
  if (spoken) {
    return {
      title: "Spoken meeting follow-up",
      text: spoken,
      occurrenceId: stableSourceId(`spoken:${spoken}`),
    };
  }

  const file = arg("--file");
  if (file) {
    const text = readFileSync(file, "utf8");
    const title = titleFromText(text, path.basename(file));
    return {
      title,
      text,
      occurrenceId:
        `file:${path.resolve(file)}:${title}:${createHash("sha256").update(text).digest("hex")}`,
    };
  }

  const docId = arg("--doc");
  if (!docId) {
    throw new Error('Pass --file <path>, --doc <googleDocId>, or --text "what was said".');
  }
  const acquisition = await recordEvent({
    source: "meeting",
    sourceId: `meeting-document:${docId}`,
    rawText: `Review meeting document ${docId} for follow-ups.`,
  }, {
    dataDir,
  });
  const acquisitionState = inboundAckState(acquisition);
  if (acquisitionState === "failed") {
    throw new Error("Meeting document could not be captured before fetch.");
  }
  const data = await composio(
    "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT",
    { document_id: docId },
  );
  return {
    title: data.title ?? docId,
    text: data.plain_text ?? "",
    occurrenceId: `doc:${docId}`,
    acquisition: acquisitionState === "db" ? acquisition.event : undefined,
  };
}

async function runIntake(text, sourceId) {
  const { stderr } = await execFileAsync(
    process.execPath,
    [
      intakeScript,
      "--text",
      text,
      "--source",
      "meeting",
      "--source-id",
      sourceId,
    ],
    {
      cwd: repoDir,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (stderr) process.stderr.write(stderr);
}

async function processItem(item, notes, index) {
  const sourceId = stableSourceId(
    `${notes.occurrenceId}\0${index}\0${item.owner}\0${item.title}\0${item.detail}`,
  );
  const text = meetingFollowUpText(item, notes.title);
  if (isOperatorOwned(item.owner)) {
    await runIntake(text, sourceId);
    return "task";
  }
  const receipt = await recordEvent(
    {
      source: "meeting",
      sourceId,
      rawText: text,
    },
    { dataDir },
  );
  const state = inboundAckState(receipt);
  if (state === "failed") {
    throw new Error("Meeting follow-up could not be captured.");
  }
  await writeWaitingCommitment(
    item,
    {
      sourceId,
      meetingTitle: notes.title,
      baseUrl: (
        coveEnv("BRIEF_WEB_BASE") ?? "http://127.0.0.1:3200"
      ).replace(/\/$/, ""),
    },
  );
  if (state === "db") {
    await resolveEvent(receipt.event.id, { state: "triaged" });
  }
  return "waiting_on";
}

const notes = await loadNotes();
notes.title = notes.title.replace(/\s*-\s*\d{4}\/\d{2}\/\d{2}.*$/, "").trim();
const items = await extractMeetingFollowUps(notes.text, { repoDir });
const failures = [];
let taskCount = 0;
let waitingCount = 0;
for (let index = 0; index < items.length; index += 1) {
  try {
    const result = await processItem(items[index], notes, index);
    if (result === "task") taskCount += 1;
    else waitingCount += 1;
  } catch (error) {
    failures.push(error);
    console.error(`Meeting follow-up capture failed for "${items[index].title}".`);
  }
}
if (failures.length > 0) {
  throw new Error(
    `${failures.length} meeting follow-up${failures.length === 1 ? "" : "s"} could not be captured.`,
  );
}
if (
  notes.acquisition &&
  !notes.acquisition.task_id &&
  (notes.acquisition.state === "pending" || notes.acquisition.state === "failed")
) {
  await resolveEvent(notes.acquisition.id, { state: "dismissed" });
}
console.log(
  `Captured ${taskCount} operator follow-up${taskCount === 1 ? "" : "s"} and ${waitingCount} waiting-on commitment${waitingCount === 1 ? "" : "s"}.`,
);
