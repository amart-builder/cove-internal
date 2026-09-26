import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyChiefOfStaffActions } from "../src/lib/chief-of-staff/driver.ts";
import { enqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/storage.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { getQuietCurrentSnapshot } from "../src/lib/quiet-current/store.ts";

const NOW = new Date("2026-09-21T16:00:00Z");

// The proposed deadline is read by the person on the suggestion card, so it is
// written in the same plain form as every other date Cove shows them.
function proposeTask(dueAt, title) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-cos-deadline-"));
  const dbPath = path.join(dataDir, "cove.db");
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_TIMEZONE = "America/Los_Angeles";
  const db = openLocalDatabase(dbPath);
  let job;
  try {
    job = db.transaction(() =>
      enqueueChiefOfStaffWake(db, { reason: "manual", note: title, now: NOW }),
    ).immediate().job;
  } finally {
    db.close();
  }
  const counts = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [{
      action_id: "propose",
      kind: "task_create",
      why: "The person asked for this in the meeting.",
      title,
      details: "Send the revised scope.",
      due_at: dueAt,
    }],
    now: NOW,
  });
  assert.equal(counts.applied, 1, "the proposal should be recorded");
  const suggestion = getQuietCurrentSnapshot(dataDir).suggestions
    .find((item) => item.title === title);
  assert.ok(suggestion, "the proposal should reach the suggestion store");
  return suggestion.description;
}

test("a proposed deadline reads as a date, not a machine timestamp", () => {
  const description = proposeTask("2026-09-22T09:00:00-07:00", "Timestamp deadline");
  assert.doesNotMatch(
    description,
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    "the raw ISO timestamp used to be pasted straight onto the card the person reads",
  );
  assert.match(description, /Proposed deadline, not yet confirmed: Sep 22, 2026/);
});

test("a date-only deadline keeps its own day", () => {
  const description = proposeTask("2026-09-22", "Date-only deadline");
  // Parsed as an instant and rendered in a negative-offset zone, a bare date
  // slides to the day before, which would move the person's deadline.
  assert.match(description, /Proposed deadline, not yet confirmed: Sep 22, 2026/);
});

test("the details the person wrote are still on the card", () => {
  assert.match(proposeTask("2026-09-22T09:00:00-07:00", "Kept details"), /Send the revised scope\./);
});
