import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server.js";
import { GET, POST } from "../src/app/api/responsibilities/route.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { getQuietCurrentCsrfToken } from "../src/lib/quiet-current/store.ts";

test("responsibility route preserves request boundaries, unknown coverage and versioned acknowledgement", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-responsibility-route-"));
  const dbPath = path.join(dir, "cove.db");
  const env = {
    COVE_DATA_DIR: dir,
    COVE_DB_PATH: dbPath,
    COVE_WORKSPACE_CONFIG: path.join(dir, "not-connected.json"),
    NEXT_PUBLIC_COVE_RUNTIME: "local",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });
  const db = openLocalDatabase(dbPath);
  db.prepare(
    "INSERT INTO tasks(id,title,status) VALUES('proposal','Proposal','open')",
  ).run();
  db.close();
  const url = "http://127.0.0.1:3200/api/responsibilities";
  const get = await GET(
    new NextRequest(url, { headers: { host: "127.0.0.1:3200" } }),
  );
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.total, 1);
  assert.equal(body.pendingReview, 1);
  assert.equal(body.capacity.availableMinutes, null);
  assert.equal(
    (await GET(new NextRequest(url, { headers: { host: "evil.example" } })))
      .status,
    403,
  );
  const input = {
    action: "acknowledge",
    ref_kind: "task",
    ref_id: "proposal",
    revision: body.items[0].revision,
  };
  assert.equal(
    (
      await POST(
        new NextRequest(url, {
          method: "POST",
          headers: { host: "127.0.0.1:3200" },
          body: JSON.stringify(input),
        }),
      )
    ).status,
    403,
  );
  const headers = {
    host: "127.0.0.1:3200",
    "x-cove-csrf": getQuietCurrentCsrfToken(),
    "content-type": "application/json",
  };
  assert.equal(
    (
      await POST(
        new NextRequest(url, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await POST(
        new NextRequest(url, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        }),
      )
    ).status,
    409,
  );
  const verify = openLocalDatabase(dbPath);
  assert.equal(
    verify.prepare("SELECT status FROM tasks").pluck().get(),
    "open",
  );
  assert.ok(
    verify
      .prepare("SELECT acknowledged_at FROM cove_responsibilities")
      .pluck()
      .get(),
  );
  verify.close();
});
