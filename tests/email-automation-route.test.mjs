import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/email/automation/route.ts";
import { getQuietCurrentCsrfToken } from "../src/lib/quiet-current/store.ts";

// Every path that falls back to coveDataDir() must land in a scratch directory,
// never in <cwd>/data: a fresh checkout's verify run must not mint a database
// or a token the setup playbook would then treat as an existing install.
import { mkdtempSync as isolatedMkdtemp, rmSync as isolatedRm } from 'node:fs';
import isolatedOs from 'node:os';
import isolatedPath from 'node:path';
const ISOLATED_DATA_DIR = isolatedMkdtemp(isolatedPath.join(isolatedOs.tmpdir(), 'cove-test-data-'));
process.env.COVE_DATA_DIR = ISOLATED_DATA_DIR;
delete process.env.COVE_DB_PATH;
test.after(() => isolatedRm(ISOLATED_DATA_DIR, { recursive: true, force: true }));

function request(url, body, headers = {}) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("email automation rejects untrusted hosts and missing CSRF tokens", async () => {
  const untrusted = await POST(request(
    "http://evil.example/api/email/automation",
    { action: "unknown" },
  ));
  assert.equal(untrusted.status, 403);

  const missingToken = await POST(request(
    "http://127.0.0.1:3200/api/email/automation",
    { action: "unknown" },
  ));
  assert.equal(missingToken.status, 403);
});

test("email automation accepts the loopback plus CSRF gate before validating actions", async () => {
  const response = await POST(request(
    "http://127.0.0.1:3200/api/email/automation",
    { action: "unknown" },
    { "X-Cove-CSRF": getQuietCurrentCsrfToken() },
  ));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /unknown email automation action/i);
});

test("the checkbox boundary exposes exact-message archive but no send or generic Google request", () => {
  const automation = readFileSync(
    new URL("../src/lib/email/automation.ts", import.meta.url),
    "utf8",
  );
  const contract = readFileSync(
    new URL("../src/lib/workspace/contracts.ts", import.meta.url),
    "utf8",
  );
  assert.match(automation, /archiveMessages/);
  assert.doesNotMatch(contract, /\bsend[A-Z(]/i);
  assert.doesNotMatch(contract, /\b(?:delete|trash|forward|request|accessToken)\b/i);
});
