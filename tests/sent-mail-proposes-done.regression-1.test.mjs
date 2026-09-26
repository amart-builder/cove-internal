/**
 * Cove recorded what Alex said he would do and never read what he then did.
 * A promise stayed open after the email that fulfilled it was sent, so the
 * brief kept asking about finished work and the card stayed on the board
 * until he tidied it.
 *
 * Sent mail is now read against the operator's own open promises. A message
 * to the counterparty that carries the promise's words writes a "looks done"
 * proposal into the commitment's evidence, in the shape the day dump already
 * uses, so the brief lists it under proposed clarifications. The status is
 * never changed here, and one message proposes once.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import {
  reconcileSentMailWithCommitments,
  sentMailMatchesCommitment,
} from "../src/lib/intake/sent-mail-reconciliation.ts";
import { runEmailTriage } from "../scripts/cove-email-runner.ts";

const now = new Date("2026-09-25T18:00:00Z");

function fixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-sent-mail-"));
  const dbPath = path.join(dataDir, "cove.db");
  const db = openLocalDatabase(dbPath);
  db.prepare("INSERT INTO contacts(id,name,email,created_at,updated_at) VALUES('kia','Kia Tran','kia@example.com',?,?)").run(now.toISOString(), now.toISOString());
  const insert = db.prepare(
    "INSERT INTO commitments(id,kind,title,details,counterparty,contact_id,source_kind,due_at,confidence,confirmed,status,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,'chat',?,'high',1,'open',?,?,?)",
  );
  insert.run("kia-link", "promise", "Send Kia the discovery link", "She asked for the booking link after the intro call.", "Kia Tran", "kia", "2026-09-28T16:00:00Z", null, now.toISOString(), now.toISOString());
  insert.run("kia-deck", "promise", "Send Kia the pricing deck", null, "Kia Tran", "kia", null, null, now.toISOString(), now.toISOString());
  insert.run("radius", "waiting_on", "Radius confirms the onboarding date", null, "Radius", null, null, null, now.toISOString(), now.toISOString());
  db.close();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, dbPath };
}

const sent = {
  id: "m-1", threadId: "t-1", historyId: null, labelIds: ["SENT"], internalDate: String(Date.parse("2026-09-25T15:00:00Z")),
  headers: [{ name: "To", value: "Kia Tran <kia@example.com>" }, { name: "Subject", value: "Discovery call booking link" }],
  snippet: "", text: "Hi Kia, here is the link to book the discovery call we talked about.",
};

function mail(messages) {
  const calls = [];
  return {
    calls,
    listMessages: async (input) => { calls.push(input); return { messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })) }; },
    getMessage: async ({ messageId }) => messages.find((m) => m.id === messageId),
  };
}

test("a match needs both the counterparty and the promise's own words", () => {
  const promise = { title: "Send Kia the discovery link", details: null, counterparty: "Kia Tran", contact_email: "kia@example.com" };
  assert.ok(sentMailMatchesCommitment(sent, promise));
  assert.equal(sentMailMatchesCommitment({ ...sent, headers: [{ name: "To", value: "someone@else.com" }, sent.headers[1]] }, promise), null, "right words, wrong person");
  assert.equal(sentMailMatchesCommitment({ ...sent, headers: [sent.headers[0], { name: "Subject", value: "Lunch" }], text: "Free Thursday?" }, promise), null, "right person, other topic");
  assert.ok(sentMailMatchesCommitment({ ...sent, headers: [{ name: "To", value: "kia tran <k@other.org>" }, sent.headers[1]] }, { ...promise, contact_email: null }), "name in the To header is enough when no email is known");
});

test("sent mail writes a looks-done proposal on the matching promise and never closes it", async (t) => {
  const { dbPath } = fixture(t);
  const gateway = mail([sent]);
  const first = await reconcileSentMailWithCommitments({ mail: gateway, dbPath, now });
  assert.deepEqual(first, { scanned: 1, proposed: 1, proposedCommitmentIds: ["kia-link"] });
  assert.match(gateway.calls[0].query, /^in:sent newer_than:3d$/);
  const db = openLocalDatabase(dbPath);
  const rows = db.prepare("SELECT id, status, evidence FROM commitments ORDER BY id").all();
  assert.ok(rows.every((row) => row.status === "open"), "nothing is closed by this lane");
  const link = JSON.parse(rows.find((row) => row.id === "kia-link").evidence);
  assert.equal(link.proposed_resolution.action, "done");
  assert.equal(link.proposed_resolution.source, "sent_mail");
  assert.equal(link.proposed_resolution.message_id, "m-1");
  assert.match(link.proposed_resolution.quote, /Discovery call booking link/);
  assert.equal(rows.find((row) => row.id === "kia-deck").evidence, null, "the other promise to Kia is untouched");
  assert.equal(rows.find((row) => row.id === "radius").evidence, null, "waiting-on items are not the operator's to fulfil");
  db.close();
  const second = await reconcileSentMailWithCommitments({ mail: gateway, dbPath, now });
  assert.equal(second.proposed, 0, "a proposal is written once");
});

test("the email runner reports the proposals and survives a sent-mail read failure", async (t) => {
  const { dataDir, dbPath } = fixture(t);
  writeFileSync(path.join(dataDir, "cove-workspace.json"), JSON.stringify({
    version: 1, provider: "google-api", profile_id: "primary", account_email: "alex@example.com",
    oauth_client_id: "client.apps.googleusercontent.com", capabilities: { mail: true, calendar: false, documents: false },
    calendar_id: "primary", gmail: { support_draft_recipients: [] },
  }));
  const gateway = {
    getProfile: async () => ({ emailAddress: "alex@example.com" }),
    ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
    listMessages: async (input) => input.query.startsWith("in:sent") ? { messages: [{ id: sent.id, threadId: sent.threadId }] } : { messages: [] },
    getMessage: async () => sent,
  };
  const result = await runEmailTriage({ dataDir, dbPath, gateway, now: () => now, warn: () => {} });
  assert.equal(result.commitmentsLookingDone, 1);
  const warnings = [];
  const broken = { ...gateway, listMessages: async (input) => { if (input.query.startsWith("in:sent")) throw new Error("sent folder offline"); return { messages: [] }; } };
  const again = await runEmailTriage({ dataDir, dbPath, gateway: broken, now: () => now, warn: (line) => warnings.push(line) });
  assert.equal(again.commitmentsLookingDone, 0);
  assert.match(warnings.join("\n"), /sent folder offline/);
});
