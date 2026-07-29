import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runEmailTriage } from "../scripts/cove-email-runner.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";

function workspaceConfig(dataDir) {
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
}

test("top-level Google auth failure is surfaced on Issues before the runner exits", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-runner-"));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
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

test("inbox discovery excludes Cove and pre-rename Forge triage markers", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-query-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  let query;

  await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async (input) => {
        query = input.query;
        return { messages: [] };
      },
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.equal(
    query,
    "in:inbox -label:Cove/Triaged -label:Forge/Triaged",
  );
});
