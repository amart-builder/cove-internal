#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEmail } from "../src/lib/email/classifier.ts";
import { coveEnv } from "../src/lib/env-runtime.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = coveEnv("DB_PATH") ?? path.join(repoDir, "data", "cove.db");
const fixturePath = path.join(repoDir, "fixtures", "email-triage.sample.json");
const buckets = ["reply", "action", "fyi", "noise"];

function fixtureBaseline(email) {
  if (email.recommended_action === "reply") return "reply";
  if (email.classification === "tiding") return "fyi";
  if (email.classification === "log_only") return "noise";
  return "action";
}

function distribution(rows, key) {
  return Object.fromEntries(buckets.map((bucket) => [
    bucket,
    rows.filter((row) => row[key] === bucket).length,
  ]));
}

function storedSample() {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      `SELECT messages.message_id, messages.classification_json,
              items.account_email, items.sender_name, items.sender_email,
              items.subject, items.body_excerpt, items.received_at
         FROM cove_email_messages messages
         JOIN email_items items ON items.id = messages.email_item_id
        WHERE messages.state = 'processed'
          AND messages.classification_json IS NOT NULL
          AND items.body_excerpt IS NOT NULL
          AND trim(items.body_excerpt) <> ''
        ORDER BY items.received_at DESC, messages.message_id`,
    ).all();
    const counts = new Map();
    return rows.flatMap((row) => {
      let baseline;
      try {
        baseline = JSON.parse(row.classification_json).bucket;
      } catch {
        return [];
      }
      if (!buckets.includes(baseline)) return [];
      const count = counts.get(baseline) ?? 0;
      if (count >= 2) return [];
      counts.set(baseline, count + 1);
      return [{
        source: "stored",
        baseline,
        accountEmail: row.account_email || "operator@example.com",
        sender: `${row.sender_name || "Sender"} <${row.sender_email || "unknown@example.invalid"}>`,
        subject: row.subject || "Email",
        text: row.body_excerpt,
      }];
    });
  } finally {
    db.close();
  }
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const cases = [
  ...fixture.emails.map((email) => ({
    source: "fixture",
    baseline: fixtureBaseline(email),
    accountEmail: fixture.account_email,
    sender: `${email.sender_name} <${email.sender_email}>`,
    subject: email.subject,
    text: email.full_body,
  })),
  ...storedSample(),
];

// Both arms run on the same email in the same run. Comparing a stored
// production bucket against a fresh call would mix a prompt change with a
// different corpus and different context, and could not attribute either.
// COVE_BACKTEST_ARMS=aa runs the control prompt twice instead, which measures
// how much the buckets move on their own. A/B shifts at or below that noise
// floor say nothing about the urgency lines.
const noiseFloorRun = coveEnv("BACKTEST_ARMS") === "aa";
const results = [];
let failure;
for (const entry of cases) {
  const call = (urgency) => classifyEmail({
    accountEmail: entry.accountEmail,
    sender: entry.sender,
    subject: entry.subject,
    text: entry.text,
    voice: "",
    repoDir,
    urgency,
  });
  try {
    const control = await call(false);
    const treatment = await call(noiseFloorRun ? false : true);
    results.push({
      source: entry.source,
      subject: entry.subject,
      baseline: entry.baseline,
      control: control.bucket,
      after: treatment.bucket,
      urgent: treatment.urgent === true,
      modelVersion: treatment.modelVersion,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    break;
  }
}

process.stdout.write(`${JSON.stringify({
  totalCases: cases.length,
  baseline: distribution(cases, "baseline"),
  compared: results.length,
  fixtureCount: results.filter((row) => row.source === "fixture").length,
  storedSampleCount: results.filter((row) => row.source === "stored").length,
  arms: noiseFloorRun ? "control vs control (noise floor)" : "control vs urgency",
  storedBaseline: distribution(results, "baseline"),
  control: distribution(results, "control"),
  treatment: distribution(results, "after"),
  // The decisive number: same email, same run, prompt with and without the
  // urgency lines. Anything else mixes in model nondeterminism and drift.
  urgencyBucketShifts: results.filter((row) => row.control !== row.after).length,
  urgent: results.filter((row) => row.urgent).length,
  modelVersions: [...new Set(results.map((row) => row.modelVersion))],
  shiftedCases: results
    .filter((row) => row.control !== row.after)
    .map((row) => ({
      source: row.source,
      subject: row.subject.slice(0, 60),
      control: row.control,
      treatment: row.after,
      urgent: row.urgent,
    })),
  urgentCases: results
    .filter((row) => row.urgent)
    .map((row) => ({ subject: row.subject.slice(0, 60), bucket: row.after })),
  failure,
}, null, 2)}\n`);
if (failure) process.exitCode = 1;
