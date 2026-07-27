#!/usr/bin/env node
/**
 * Parse meeting notes into follow-ups and hand every item to Forge intake.
 *
 * The intake CLI owns durable capture, triage, task creation, and surfacing.
 * This script only acquires notes and splits Gemini's "Next steps" section.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { recordEvent, resolveEvent } = require("../src/lib/intake/inbox.ts");
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const intakeScript = path.join(repoDir, "scripts", "forge-intake.mjs");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function titleFromText(text, fallback) {
  const first = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!first || first.length > 120 || /[.!?]$/.test(first)) return fallback;
  return first;
}

async function loadNotes() {
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
  });
  if (acquisition.event.spooled === false) {
    throw new Error("Meeting document could not be captured before fetch.");
  }
  const { stdout } = await execFileAsync(
    "composio",
    [
      "execute",
      "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT",
      "--params",
      JSON.stringify({ document_id: docId }),
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const payload = JSON.parse(stdout);
  const data = payload?.data ?? payload;
  return {
    title: data.title ?? docId,
    text: data.plain_text ?? "",
    occurrenceId: `doc:${docId}`,
    acquisition: acquisition.event.spooled === true ? undefined : acquisition.event,
  };
}

export function parseNextSteps(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*next steps\s*$/i.test(line));
  if (start === -1) return [];

  const items = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(details|summary|decisions|transcript|attachments)\s*$/i.test(line)) {
      break;
    }
    const match = line.match(/^\s*[-•*]\s*\[([^\]]+)\]\s*(.+?)\s*$/);
    if (!match) continue;
    const owner = match[1].trim();
    const body = match[2].trim();
    const split = body.match(/^([^:]{3,60}):\s*(.+)$/);
    items.push({
      owner,
      title: split ? split[1].trim() : body,
      detail: split ? split[2].trim() : "",
    });
  }
  return items;
}

function stableSourceId(value) {
  return `meeting:${createHash("sha256").update(value).digest("hex")}`;
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
      ...(sourceId ? ["--source-id", sourceId] : []),
    ],
    {
      cwd: repoDir,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (stderr) process.stderr.write(stderr);
}

const spoken = arg("--text");
if (spoken) {
  await runIntake(spoken);
  console.log("Sent 1 spoken follow-up through Forge intake.");
} else {
  const notes = await loadNotes();
  const meetingTitle = notes.title
    .replace(/\s*-\s*\d{4}\/\d{2}\/\d{2}.*$/, "")
    .trim();
  const items = parseNextSteps(notes.text);
  if (items.length === 0) {
    await runIntake(
      notes.text,
      stableSourceId(`${notes.occurrenceId}\0${notes.text}`),
    );
    console.log("No structured Next steps found; sent the notes through Forge intake.");
  } else {
    const failures = [];
    for (const item of items) {
      const text = [
        item.title,
        item.detail,
        `Meeting: ${meetingTitle}`,
        `Named owner: ${item.owner}`,
      ].filter(Boolean).join("\n");
      try {
        await runIntake(
          text,
          stableSourceId(
            `${notes.occurrenceId}\0${item.owner}\0${item.title}\0${item.detail}`,
          ),
        );
      } catch (error) {
        failures.push(error);
        console.error(`Meeting follow-up capture failed for "${item.title}".`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} meeting follow-up${failures.length === 1 ? "" : "s"} could not be captured.`,
      );
    }
    console.log(`Sent ${items.length} meeting follow-ups through Forge intake.`);
  }
  if (
    notes.acquisition &&
    !notes.acquisition.task_id &&
    (notes.acquisition.state === "pending" || notes.acquisition.state === "failed")
  ) {
    await resolveEvent(notes.acquisition.id, { state: "dismissed" });
  }
}
