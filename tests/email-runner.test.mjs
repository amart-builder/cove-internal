import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runEmailTriage } from "../scripts/cove-email-runner.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";

test("top-level Google auth failure is surfaced on Issues before the runner exits", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-runner-"));
  const dbPath = path.join(dataDir, "forge.db");
  openLocalDatabase(dbPath).close();
  writeFileSync(
    path.join(dataDir, "cove-workspace.json"),
    JSON.stringify({
      version: 1,
      provider: "google-api",
      profile_id: "primary",
      account_email: "alex@example.com",
      oauth_client_id: "client.apps.googleusercontent.com",
      capabilities: { mail: true, calendar: false, documents: false },
      calendar_id: "primary",
      gmail: { support_draft_recipients: [] },
    }),
  );
  await assert.rejects(
    runEmailTriage({
      dataDir,
      dbPath,
      gateway: {
        getProfile: async () => {
          throw new Error("auth offline");
        },
      },
      now: () => new Date("2026-07-29T18:00:00Z"),
    }),
    /auth offline/,
  );
  const failures = listFailures({ dbPath });
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Google Workspace was temporarily unavailable/i);
});
