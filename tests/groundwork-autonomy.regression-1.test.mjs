import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readCoveAutonomySettings } from "../src/lib/autonomy/settings.ts";

// Regression: ISSUE-001 — SETUP's minimal off setting crashed the watch worker
// Found by /qa on 2026-08-06
// Report: .gstack/qa-reports/qa-report-cove-local-2026-08-06.md
test("the documented minimal autonomy-off file expands to safe defaults", (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-autonomy-off-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dataDir, "cove-autonomy.json"),
    `${JSON.stringify({ level: "off" })}\n`,
  );

  assert.deepEqual(readCoveAutonomySettings({ dataDir }), {
    level: "off",
    first_groundwork_at: null,
    checkin_answered: false,
    checkin_presented_count: 0,
  });
});
