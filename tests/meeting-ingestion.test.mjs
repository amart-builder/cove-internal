import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { LocalCRMBackend } from "../src/lib/crm/index.ts";
import {
  claimMessageIngestion,
  completeMessageIngestion,
  getMessageIngestion,
} from "../src/lib/intake/message-ingestion.ts";
import {
  processMeetingNotesEmail,
  writeWaitingCommitment,
} from "../src/lib/intake/meeting-pipeline.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";
import { listRecentReceipts } from "../src/lib/reliability/receipts.ts";

const START = new Date("2026-07-29T15:00:00.000Z");
const email = {
  messageId: "gmail-shared-1",
  threadId: "thread-shared-1",
  sender: "Gemini <gemini-noreply@google.com>",
  subject: "Notes: Client planning",
  body: "Next steps\n- [Sam Rivera] Send the scope: Share the final PDF.",
  detectedTool: "gemini",
};

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-meeting-ingestion-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "forge.db");
  const crm = new LocalCRMBackend({ dbPath, now: () => START });
  t.after(() => {
    crm.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, crm };
}

function pipelineOptions(files, overrides = {}) {
  return {
    sourceDoor: "watcher",
    dbPath: files.dbPath,
    dataDir: files.dir,
    baseUrl: "http://forge.test",
    now: () => START,
    crmBackend: files.crm,
    extractFollowUps: async () => [{
      owner: "Sam Rivera",
      title: "Send the scope",
      detail: "Share the final PDF.",
    }],
    isOperatorOwnedImpl: () => false,
    recordEventImpl: async () => ({
      event: { id: "event-1", state: "pending" },
      existed: false,
    }),
    resolveEventImpl: async () => {},
    ...overrides,
  };
}

test("the same Gmail message through watcher and triage processes once", async (t) => {
  const files = fixture(t);
  let commitmentWrites = 0;
  const first = await processMeetingNotesEmail(email, pipelineOptions(files, {
    writeCommitmentImpl: async (_item, context) => {
      commitmentWrites += 1;
      assert.ok(context.contactId);
      return "commitment-1";
    },
  }));
  const second = await processMeetingNotesEmail(email, pipelineOptions(files, {
    sourceDoor: "triage",
    writeCommitmentImpl: async () => {
      commitmentWrites += 1;
      return "duplicate";
    },
  }));

  assert.equal(first.status, "processed");
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "already-processed");
  assert.equal(commitmentWrites, 1);
  assert.equal(getMessageIngestion(email.messageId, files).sourceDoor, "watcher");
  assert.equal(listRecentReceipts({ dbPath: files.dbPath }).length, 1);
  assert.equal(
    files.crm.getContactWithRecentActivities(
      files.crm.listContacts()[0].id,
      10,
    ).activities.length,
    1,
  );
});

test("an expired claim recovers after a crash between claim and completion", (t) => {
  const files = fixture(t);
  const first = claimMessageIngestion({
    messageId: "gmail-crash",
    threadId: "thread-crash",
    sourceDoor: "watcher",
    detectedTool: "gemini",
    dbPath: files.dbPath,
    now: START,
    leaseMs: 30_000,
  });
  assert.equal(first.claimed, true);

  const blocked = claimMessageIngestion({
    messageId: "gmail-crash",
    threadId: "thread-crash",
    sourceDoor: "triage",
    detectedTool: "gemini",
    dbPath: files.dbPath,
    now: new Date(START.getTime() + 20_000),
    leaseMs: 30_000,
  });
  assert.equal(blocked.claimed, false);
  assert.equal(blocked.reason, "lease-active");

  const recovered = claimMessageIngestion({
    messageId: "gmail-crash",
    threadId: "thread-crash",
    sourceDoor: "triage",
    detectedTool: "gemini",
    dbPath: files.dbPath,
    now: new Date(START.getTime() + 31_000),
    leaseMs: 30_000,
  });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.attempts, 2);
  const complete = completeMessageIngestion({
    messageId: "gmail-crash",
    leaseToken: recovered.leaseToken,
    startedAt: START.toISOString(),
    summary: "Recovered one meeting note.",
    actions: { recovered: true },
    outcome: "success",
    attempts: recovered.attempts,
    dbPath: files.dbPath,
    now: new Date(START.getTime() + 32_000),
  });
  assert.equal(complete.status, "processed");
  assert.equal(complete.attempts, 2);
  assert.equal(listRecentReceipts({ dbPath: files.dbPath }).length, 1);
});

test("waiting-on writes receive and persist the resolved contact id", async (t) => {
  const files = fixture(t);
  let posted;
  const responses = [
    new Response("[]", { status: 200 }),
    new Response(JSON.stringify({ csrfToken: "token" }), { status: 200 }),
    new Response("[]", { status: 201 }),
  ];
  await writeWaitingCommitment(
    {
      owner: "Sam Rivera",
      title: "Send the scope",
      detail: "Share the final PDF.",
    },
    {
      sourceId: "gmail-contact:0",
      meetingTitle: "Client planning",
      baseUrl: "http://forge.test",
      contactId: "contact-real-1",
    },
    {
      fetchImpl: async (_url, init = {}) => {
        if (init.method === "POST") posted = JSON.parse(init.body);
        return responses.shift();
      },
    },
  );
  assert.equal(posted.contact_id, "contact-real-1");
});

test("an ambiguous person is recorded without blocking other people", async (t) => {
  const files = fixture(t);
  files.crm.createContact({ name: "Jordan Smith", source: "manual" });
  files.crm.createContact({ name: "Jordan Smith", source: "manual" });
  const commitments = [];
  const result = await processMeetingNotesEmail(
    { ...email, messageId: "gmail-ambiguous", threadId: "thread-ambiguous" },
    pipelineOptions(files, {
      extractFollowUps: async () => [
        {
          owner: "Jordan Smith",
          title: "Review the draft",
          detail: "",
        },
        {
          owner: "Morgan Lee",
          title: "Send the numbers",
          detail: "",
        },
      ],
      writeCommitmentImpl: async (item, context) => {
        commitments.push({ owner: item.owner, contactId: context.contactId });
        return `commitment-${commitments.length}`;
      },
    }),
  );

  assert.equal(result.status, "processed");
  assert.equal(result.summary.waitingOn, 2);
  assert.equal(result.summary.contactsAmbiguous, 1);
  assert.equal(result.summary.contactsCreated, 1);
  assert.deepEqual(commitments, [
    { owner: "Jordan Smith", contactId: null },
    { owner: "Morgan Lee", contactId: files.crm.listContacts({
      search: "Morgan Lee",
    })[0].id },
  ]);
  const failures = listFailures({ dbPath: files.dbPath });
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Jordan Smith.*ambiguous/);
  const receipts = listRecentReceipts({ dbPath: files.dbPath });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, "partial");
});

test("reordered retry parsing keeps stable item ids and cannot duplicate writes", async (t) => {
  const files = fixture(t);
  const alpha = {
    owner: "Sam Rivera",
    title: "Send the scope",
    detail: "Share the final PDF.",
  };
  const beta = {
    owner: "Morgan Lee",
    title: "Confirm the budget",
    detail: "Reply with the approved ceiling.",
  };
  let extraction = 0;
  let failBetaOnce = true;
  const idsByTitle = new Map();
  const durableWrites = new Set();
  const options = pipelineOptions(files, {
    extractFollowUps: async () => {
      extraction += 1;
      return extraction === 1 ? [alpha, beta] : [beta, alpha];
    },
    writeCommitmentImpl: async (item, context) => {
      const ids = idsByTitle.get(item.title) ?? [];
      ids.push(context.sourceId);
      idsByTitle.set(item.title, ids);
      if (item.title === beta.title && failBetaOnce) {
        failBetaOnce = false;
        throw new Error("retry after partial write");
      }
      durableWrites.add(context.sourceId);
      return context.sourceId;
    },
  });

  await assert.rejects(
    processMeetingNotesEmail(
      { ...email, messageId: "gmail-reordered", threadId: "thread-reordered" },
      options,
    ),
    /retry after partial write/,
  );
  const retried = await processMeetingNotesEmail(
    { ...email, messageId: "gmail-reordered", threadId: "thread-reordered" },
    options,
  );
  assert.equal(retried.status, "processed");
  assert.equal(extraction, 2);
  assert.equal(new Set(idsByTitle.get(alpha.title)).size, 1);
  assert.equal(new Set(idsByTitle.get(beta.title)).size, 1);
  assert.equal(durableWrites.size, 2);
  assert.ok(
    [...durableWrites].every((sourceId) =>
      /^gmail-reordered:[a-f0-9]{24}$/.test(sourceId)
    ),
  );
});

test("email skill sends detector matches absent from watcher lists to FYI", () => {
  const skill = readFileSync(
    new URL("../skills/cove-email/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(
    skill,
    /A detector match is `meeting_notes` ONLY when one of the thread's\s+message ids is in that handled-id set\./,
  );
  assert.match(
    skill,
    /detector-matched thread whose ids are absent from both lists is \*\*fyi\*\*/,
  );
  assert.match(skill, /apply `Cove\/FYI` \+ `Cove\/Triaged`/);
  assert.match(skill, /write the normal FYI row/);
});

test("normal single-Mac install registers watcher and progress lanes outside --mini", () => {
  const installer = readFileSync(
    new URL("../scripts/install-cove-local.sh", import.meta.url),
    "utf8",
  );
  const normalStart = installer.indexOf(
    "# --- Single-Mac background lanes:",
  );
  const skillsStart = installer.indexOf("# --- Install Cove's skills");
  const miniExit = installer.indexOf('if [ "$MINI" = "1" ]; then\n  exit 0');
  assert.ok(miniExit >= 0);
  assert.ok(normalStart > miniExit);
  assert.ok(skillsStart > normalStart);
  const normalProfile = installer.slice(normalStart);
  assert.match(normalProfile, /com\.cove\.meeting-watch\.plist/);
  assert.match(normalProfile, /com\.cove\.progress\.plist/);
  assert.match(
    normalProfile,
    /launchctl bootstrap "gui\/\$UID_NUM" "\$MEETING_PLIST"/,
  );
  assert.match(
    normalProfile,
    /launchctl bootstrap "gui\/\$UID_NUM" "\$PROGRESS_PLIST"/,
  );
  assert.match(normalProfile, /claim_lane meeting_watch plain/);
  assert.match(normalProfile, /claim_lane progress plain/);
  assert.match(
    normalProfile,
    /Skipping meeting watcher: \$MEETING_OWNER owns this lane\./,
  );
  assert.match(
    normalProfile,
    /Skipping progress reconciler: \$PROGRESS_OWNER owns this lane\./,
  );
  assert.match(installer, /LANE_DATA_DIR="\$\{COVE_DATA_DIR:-\$REPO_DIR\/data\}"/);
  assert.match(installer, /replaceAll\(templateData, dataDir\)/);
  assert.match(
    normalProfile,
    /if \[ "\$INSTALL_MEETING_LANE" = "1" \]; then\s+echo "Meeting watcher: every 5 minutes[\s\S]*else\s+echo "Meeting watcher: skipped because \$MEETING_OWNER owns this lane"/,
  );
  assert.match(
    normalProfile,
    /if \[ "\$INSTALL_PROGRESS_LANE" = "1" \]; then\s+echo "Progress reconciler: every 30 minutes[\s\S]*else\s+echo "Progress reconciler: skipped because \$PROGRESS_OWNER owns this lane"/,
  );
  assert.match(installer, /claim_lane meeting_watch mini/);
  assert.match(installer, /claim_lane progress mini/);
  assert.match(normalProfile, /StartInterval jobs catch up when the Mac wakes/);
});
