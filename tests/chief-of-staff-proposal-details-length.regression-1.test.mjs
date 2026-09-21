import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyChiefOfStaffActions } from "../src/lib/chief-of-staff/driver.ts";
import { enqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/storage.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { getQuietCurrentSnapshot } from "../src/lib/quiet-current/store.ts";
import { validateChiefOfStaffOutput } from "../src/lib/chief-of-staff/types.ts";

const NOW = new Date("2026-09-21T16:00:00Z");
const SCHEMA_DETAILS_MAX = 5_000;

// Ordinary prose, not filler: an unbroken run of 40 characters reads as a
// secret to the scrubber and would be redacted before any limit is reached.
function prose(length) {
  return "Send the revised scope to the client. ".repeat(200).slice(0, length);
}

function applyProposal(details, title) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-cos-details-"));
  const dbPath = path.join(dataDir, "cove.db");
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
      details,
    }],
    now: NOW,
  });
  return { counts, suggestions: getQuietCurrentSnapshot(dataDir).suggestions };
}

test("details as long as the schema allows still reach the person", () => {
  // The output schema and the validator both permit 5000 characters, so a model
  // writing that much is obeying its contract. The applier used to reject it at
  // 4000 and the proposal was lost with nothing on the board to show for it.
  const details = prose(SCHEMA_DETAILS_MAX);
  const { counts, suggestions } = applyProposal(details, "Long details");
  assert.deepEqual(
    { applied: counts.applied, rejected: counts.rejected },
    { applied: 1, rejected: 0 },
  );
  assert.equal(
    suggestions.find((item) => item.title === "Long details")?.description,
    details,
  );
});

test("the validator and the applier agree on the details limit", () => {
  const output = validateChiefOfStaffOutput({
    journal: ["One line.", "Another line."],
    watching: [],
    actions: [{
      action_id: "a1",
      kind: "task_create",
      why: "Agreed limit.",
      title: "Limit",
      details: prose(SCHEMA_DETAILS_MAX),
    }],
  });
  assert.equal(output.actions[0].details.length, SCHEMA_DETAILS_MAX);
});

test("details beyond the contract are rejected where the contract is enforced", () => {
  // The scrubber caps every model string at its own limit, so the applier never
  // sees an over-length value. The validator the wake runs first is what refuses
  // one, and that is the boundary this limit has to agree with.
  assert.throws(
    () => validateChiefOfStaffOutput({
      journal: ["One line.", "Another line."],
      watching: [],
      actions: [{
        action_id: "a1",
        kind: "task_create",
        why: "Over the limit.",
        title: "Limit",
        details: prose(SCHEMA_DETAILS_MAX + 40),
      }],
    }),
    /details is too long/,
  );
});
