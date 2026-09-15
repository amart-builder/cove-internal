import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWake } from "../src/lib/chief-of-staff/driver.ts";
import { enqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/storage.ts";
import { createDayPlanStore } from "../src/lib/day-plan/store.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";

test("chief replan queues configured brief provenance while keeping the chosen provider model", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-chief-replan-config-"));
  const dbPath = path.join(dataDir, "cove.db");
  const now = new Date("2026-09-15T16:00:00Z");
  const settings = {
    COVE_DATA_DIR: dataDir, COVE_DB_PATH: dbPath,
    COVE_BRIEF_MODEL: "sonnet", COVE_BRIEF_EFFORT: "low", COVE_BRIEF_BUDGET_USD: "0.43",
    COVE_TIMEZONE: "America/Los_Angeles", COVE_SALES_PIPELINE: "0",
  };
  const before = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
  writeFileSync(path.join(dataDir, "agent-settings.json"), JSON.stringify({
    version: 1, provider: "claude", model: "claude-fable-5-1", effort: "low",
  }));
  const binary = path.join(dataDir, "fake-claude");
  const argsFile = path.join(dataDir, "argv.txt");
  const schema = JSON.parse(readFileSync(path.join(process.cwd(), "prompts/chief-of-staff-output.schema.json"), "utf8"));
  const action = { ...Object.fromEntries(schema.properties.actions.items.required.map((key) => [key, null])),
    action_id: "replan-config", kind: "replan_day", why: "Manual request to replan today" };
  const output = JSON.stringify({ structured_output: { journal: ["Reviewed current work.", "A revised plan is needed."],
    watching: [], actions: [action] }, usage: { input_tokens: 10, output_tokens: 10 } });
  writeFileSync(binary, `#!/bin/sh
cat >/dev/null
printf '%s\\n' "$@" > '${argsFile}'
printf '%s\\n' '${output}'
`, { mode: 0o700 });
  const store = createDayPlanStore({ dbPath, now: () => now });
  store.ensureDayPlan({ localDate: "2026-09-15", timezone: "America/Los_Angeles", mutationId: "test-plan", candidates: [] });
  store.close();
  const db = openLocalDatabase(dbPath);
  try {
    const job = enqueueChiefOfStaffWake(db, { reason: "manual", note: "Replan today", now }).job;
    await runWake(job, { repoDir: process.cwd(), dataDir, dbPath, now: () => now,
      claudePath: binary, env: { ...settings, HOME: dataDir, PATH: process.env.PATH } });
    assert.deepEqual(db.prepare("SELECT target_local_date, model_alias, effort, budget_usd FROM day_plan_briefs WHERE status='queued'").all(), [{
      target_local_date: "2026-09-15", model_alias: "sonnet", effort: "low", budget_usd: 0.43,
    }]);
    assert.match(readFileSync(argsFile, "utf8"), /claude-fable-5-1/);
  } finally { db.close(); }
});
