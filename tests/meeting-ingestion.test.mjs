import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
import { runMeetingWatch } from "../scripts/cove-meeting-watch.mjs";
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
  const dbPath = path.join(dir, "cove.db");
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
    baseUrl: "http://cove.test",
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

test("a missing meeting config disables the watcher without a failure", async (t) => {
  const files = fixture(t);
  const heartbeatPath = path.join(files.dir, "intake", "heartbeats.json");
  let gmailReads = 0;
  const result = await runMeetingWatch({
    configPath: path.join(files.dir, "missing-cove-meetings.json"),
    statePath: path.join(files.dir, "meeting-state.json"),
    heartbeatPath,
    dataDir: files.dir,
    dbPath: files.dbPath,
    gateway: {
      listMessages: async () => {
        gmailReads += 1;
        return { messages: [] };
      },
    },
    machineIdentity: {
      id: "99999999-9999-4999-8999-999999999999",
      hostname: "test-mac",
    },
    now: () => START,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.examined, 0);
  assert.equal(gmailReads, 0);
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8"));
  assert.equal(
    heartbeat.machines["99999999-9999-4999-8999-999999999999"]
      .meeting_watch.disabled,
    true,
  );
  assert.equal(listFailures({ dbPath: files.dbPath }).length, 0);
});

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

test("waiting-on writes receive and persist the resolved contact id", async () => {
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
      baseUrl: "http://cove.test",
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
  assert.equal(extraction, 1);
  assert.equal(new Set(idsByTitle.get(alpha.title)).size, 1);
  assert.equal(new Set(idsByTitle.get(beta.title)).size, 1);
  assert.equal(durableWrites.size, 2);
  assert.ok(
    [...durableWrites].every((sourceId) =>
      /^gmail-reordered:[a-f0-9]{24}$/.test(sourceId)
    ),
  );
});

test("multiple operator follow-ups consolidate into one task with a stable sourceId", async (t) => {
  const files = fixture(t);
  const wordings = [
    [
      { owner: "Alex", title: "Send the recap", detail: "Cover pricing." },
      { owner: "Alex", title: "Book the venue", detail: "" },
      { owner: "Alex", title: "Ping legal", detail: "NDA redlines." },
    ],
    [
      { owner: "Alex", title: "Send Dan the recap", detail: "Pricing section." },
      { owner: "Alex", title: "Reserve the venue", detail: "" },
      { owner: "Alex", title: "Nudge legal", detail: "Redlines." },
    ],
  ];
  let extraction = 0;
  let failOnce = true;
  const intakes = [];
  const options = pipelineOptions(files, {
    extractFollowUps: async () => wordings[Math.min(extraction++, 1)],
    isOperatorOwnedImpl: () => true,
    runIntakeImpl: async (payload) => {
      intakes.push(payload);
      if (failOnce) {
        failOnce = false;
        throw new Error("intake down");
      }
      return { event: { id: `event-${intakes.length}` }, exitCode: 0 };
    },
    writeCommitmentImpl: async () => {
      throw new Error("no waiting-on writes expected");
    },
  });

  await assert.rejects(
    processMeetingNotesEmail(
      { ...email, messageId: "gmail-bundle", threadId: "thread-bundle" },
      options,
    ),
    /intake down/,
  );
  const result = await processMeetingNotesEmail(
    { ...email, messageId: "gmail-bundle", threadId: "thread-bundle" },
    options,
  );

  assert.equal(result.status, "processed");
  assert.equal(result.summary.tasks, 1);
  assert.equal(result.summary.waitingOn, 0);
  assert.equal(intakes.length, 2);
  assert.ok(intakes.every((payload) => payload.sourceId === "gmail-bundle:followups"));
  assert.match(intakes[1].text, /^Follow ups: Notes: Client planning\n/);
  assert.equal(intakes[1].text.match(/- \[ \] /g).length, 3);
  assert.match(result.quietLine, /1 task \(3 follow-ups\)/);
});

test("one operator item with other owners keeps the per-item path", async (t) => {
  const files = fixture(t);
  const intakes = [];
  const commitments = [];
  const result = await processMeetingNotesEmail(
    { ...email, messageId: "gmail-mixed", threadId: "thread-mixed" },
    pipelineOptions(files, {
      extractFollowUps: async () => [
        { owner: "Alex", title: "Send the recap", detail: "" },
        { owner: "Sam Rivera", title: "Send the scope", detail: "PDF." },
        { owner: "Morgan Lee", title: "Confirm the budget", detail: "" },
      ],
      isOperatorOwnedImpl: (owner) => owner === "Alex",
      runIntakeImpl: async (payload) => {
        intakes.push(payload);
        return { event: { id: `event-${intakes.length}` }, exitCode: 0 };
      },
      writeCommitmentImpl: async (item, context) => {
        commitments.push({ owner: item.owner, sourceId: context.sourceId });
        return `commitment-${commitments.length}`;
      },
    }),
  );

  assert.equal(result.status, "processed");
  assert.equal(result.summary.tasks, 1);
  assert.equal(result.summary.waitingOn, 2);
  assert.equal(intakes.length, 1);
  assert.match(intakes[0].sourceId, /^gmail-mixed:[a-f0-9]{24}$/);
  assert.deepEqual(
    commitments.map((entry) => entry.owner),
    ["Sam Rivera", "Morgan Lee"],
  );
  assert.ok(
    commitments.every((entry) => /^gmail-mixed:[a-f0-9]{24}$/.test(entry.sourceId)),
  );
  assert.doesNotMatch(result.quietLine, /follow-ups?\)/);
});

test("a missing subject still produces a real bundle title and footer", async (t) => {
  const files = fixture(t);
  const intakes = [];
  const result = await processMeetingNotesEmail(
    { ...email, messageId: "gmail-untitled", threadId: "thread-untitled", subject: "" },
    pipelineOptions(files, {
      extractFollowUps: async () => [
        { owner: "Alex", title: "Send the recap", detail: "" },
        { owner: "Alex", title: "Book the venue", detail: "" },
      ],
      isOperatorOwnedImpl: () => true,
      runIntakeImpl: async (payload) => {
        intakes.push(payload);
        return { event: { id: `event-${intakes.length}` }, exitCode: 0 };
      },
    }),
  );

  assert.equal(result.status, "processed");
  assert.equal(result.summary.tasks, 1);
  assert.equal(intakes.length, 1);
  assert.match(intakes[0].text, /^Follow ups: gemini meeting notes\n/);
  assert.match(intakes[0].text, /\nMeeting: gemini meeting notes$/);
});

test("email skill delegates Gmail work to the deterministic runner and preserves the meeting marker", () => {
  const skill = readFileSync(
    new URL("../skills/cove-email/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /npm run email:triage/);
  assert.match(skill, /do not replace the command with an agent-led inbox pass/i);
  assert.match(skill, /`Cove\/Meeting-Processed` remains reserved/);
  assert.doesNotMatch(skill, /Cove\/(?:Reply|Action|FYI|Archived|Done)/);
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
  assert.match(normalProfile, /com\.cove\.meeting-drain\.plist/);
  assert.match(normalProfile, /com\.cove\.progress\.plist/);
  assert.match(
    normalProfile,
    /launchctl bootstrap "gui\/\$UID_NUM" "\$MEETING_PLIST"/,
  );
  assert.match(
    normalProfile,
    /launchctl bootstrap "gui\/\$UID_NUM" "\$MEETING_DRAIN_PLIST"/,
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
  assert.match(installer, /LANE_PLIST_RENDERER="\$REPO_DIR\/scripts\/lib\/render-lane-plist\.mjs"/);
  assert.match(normalProfile, /"\$NODE_REAL" "\$LANE_PLIST_RENDERER"/);
  assert.match(
    normalProfile,
    /if \[ "\$INSTALL_MEETING_LANE" = "1" \]; then\s+echo "Meeting watcher: weekdays every 15 minutes, 08:00-18:00 local, plus login catch-up"\s+echo "Meeting analysis drain: every 15 minutes, always on"[\s\S]*else\s+echo "Meeting watcher: skipped because \$MEETING_OWNER owns this lane"\s+echo "Meeting analysis drain: skipped because \$MEETING_OWNER owns this lane"/,
  );
  assert.match(
    normalProfile,
    /if \[ "\$INSTALL_PROGRESS_LANE" = "1" \]; then\s+echo "Progress reconciler: every 30 minutes[\s\S]*else\s+echo "Progress reconciler: skipped because \$PROGRESS_OWNER owns this lane"/,
  );
  assert.match(installer, /claim_lane meeting_watch mini/);
  assert.match(installer, /claim_lane progress mini/);
  assert.match(
    installer,
    /Installed the Mini meeting watcher \(weekdays every 15 minutes, 08:00-18:00 local, plus login catch-up\)/,
  );
  assert.match(
    installer,
    /Installed the Mini meeting analysis drain \(every 15 minutes, always on\)/,
  );
  assert.match(normalProfile, /RunAtLoad provides\s+# login catch-up/);
});
