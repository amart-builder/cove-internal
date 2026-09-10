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

test('current review success supersedes older failure and inferred items stay distinct',async t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-responsibility-status-'));const dbPath=path.join(dir,'cove.db');
 const env={COVE_DATA_DIR:dir,COVE_DB_PATH:dbPath,COVE_WORKSPACE_CONFIG:path.join(dir,'offline.json'),NEXT_PUBLIC_COVE_RUNTIME:'local'};
 const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 t.after(()=>{for(const [k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;rmSync(dir,{recursive:true,force:true});});
 const db=openLocalDatabase(dbPath);
 db.prepare("INSERT INTO tasks(id,title,status) VALUES('task','Accepted task','open')").run();
 db.prepare("INSERT INTO commitments(id,kind,title,source_kind,confirmed,created_at,updated_at) VALUES('inferred','promise','Possible promise','detector',0,?,?)").run('2026-09-10T10:00:00Z','2026-09-10T10:00:00Z');
 const insert=db.prepare("INSERT INTO cove_jobs(id,type,run_after,status,idempotency_key,created_at,finished_at) VALUES(?,'chief-of-staff-wake',?,?,?, ?,?)");
 insert.run('old','2026-09-10T10:00:00Z','dead','old','2026-09-10T10:00:00Z','2026-09-10T10:10:00Z');
 insert.run('new','2026-09-10T11:00:00Z','done','new','2026-09-10T11:00:00Z','2026-09-10T11:10:00Z');db.close();
 const body=await (await GET(new NextRequest('http://127.0.0.1:3200/api/responsibilities',{headers:{host:'127.0.0.1:3200'}}))).json();
 assert.equal(body.job.status,'done');assert.deepEqual(body.counts,{tasks:1,confirmedCommitments:0,unconfirmed:1});
 assert.equal(body.items[0].ref_id,'task');
});
