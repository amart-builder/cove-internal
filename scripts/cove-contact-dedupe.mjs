#!/usr/bin/env -S node --import tsx

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { mergeContactAtomic } from "../src/lib/crm/merge.ts";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.COVE_DB_PATH ?? path.join(repoDir, "data", "cove.db");

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

function parseDisplayName(value) {
  const raw = String(value ?? "").trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1").trim();
  const beforeAngle = raw.split("<")[0].replace(/\([^)]*\)/g, "").trim();
  return beforeAngle && !beforeAngle.includes("@") ? beforeAngle : "";
}

export function cleanedNormalizedName(storedName) {
  const parsed = parseDisplayName(storedName);
  const normalized = normalizeName(parsed || storedName);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length >= 3) {
    const last = tokens[tokens.length - 1];
    const head = tokens.slice(0, -1);
    const weldedTail = /(com|net|org|io|ai|co|dev|edu|gov)$/.test(last) &&
      (last.length >= 10 || head.some((token) => token.length >= 3 && last.includes(token)));
    if (weldedTail) return head.join(" ");
  }
  return normalized;
}

function unionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    const value = parent.get(id);
    if (value !== id) parent.set(id, find(value));
    return parent.get(id);
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  return { find, union };
}

function contactSnapshot(db, memberIds) {
  const filter = memberIds?.length
    ? `WHERE contacts.id IN (${memberIds.map(() => "?").join(",")})`
    : "";
  const rows = db.prepare(
    `SELECT contacts.id, contacts.name, contacts.email, contacts.phone,
            contacts.created_at, contacts.updated_at,
            pipeline_deals.stage AS deal,
            (SELECT count(*) FROM contact_activities
             WHERE contact_activities.contact_id = contacts.id) AS activities
     FROM contacts
     LEFT JOIN pipeline_deals ON pipeline_deals.contact_id = contacts.id
     ${filter}
     ORDER BY COALESCE(contacts.created_at, ''), contacts.id`,
  ).all(...(memberIds ?? []));
  const aliases = db.prepare(
    "SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY lower(email), id",
  );
  return rows.map((row) => ({
    ...row,
    emails: [...new Set(
      [row.email, ...aliases.all(row.id).map((alias) => alias.email)]
        .map(normalizeEmail)
        .filter(Boolean),
    )].sort(),
  }));
}

export function fingerprintContacts(contacts) {
  const stable = [...contacts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((contact) => ({
      id: contact.id,
      name: contact.name,
      emails: [...contact.emails].sort(),
      updated_at: contact.updated_at ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function buildDedupePlan(db, generatedAt = new Date().toISOString()) {
  const contacts = contactSnapshot(db);
  const uf = unionFind(contacts.map((contact) => contact.id));
  const owners = new Map();
  const connect = (key, contactId) => {
    if (!key) return;
    const existing = owners.get(key);
    if (existing) uf.union(existing, contactId);
    else owners.set(key, contactId);
  };
  for (const contact of contacts) {
    const name = cleanedNormalizedName(contact.name);
    const phone = normalizePhone(contact.phone);
    if (name) connect(`name:${name}`, contact.id);
    if (phone) connect(`phone:${phone}`, contact.id);
    for (const email of contact.emails) connect(`email:${email}`, contact.id);
  }
  const components = new Map();
  for (const contact of contacts) {
    const root = uf.find(contact.id);
    const members = components.get(root) ?? [];
    members.push(contact);
    components.set(root, members);
  }
  const groups = [...components.values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      const ranked = [...members].sort((left, right) =>
        Number(Boolean(right.deal)) - Number(Boolean(left.deal)) ||
        right.activities - left.activities ||
        String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")) ||
        left.id.localeCompare(right.id)
      );
      return {
        fingerprint: fingerprintContacts(members),
        contacts: [...members]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((member) => ({
            id: member.id,
            name: member.name,
            email: member.email,
            emails: member.emails,
            deal: member.deal ?? null,
            activities: member.activities,
          })),
        suggestedWinnerId: ranked[0].id,
        approved: false,
      };
    })
    .sort((left, right) => left.contacts[0].name.localeCompare(right.contacts[0].name));
  return {
    generatedAt,
    groups,
  };
}

async function backupDatabase(file) {
  const backupDir = path.join(path.dirname(file), "backups");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const base = path.join(backupDir, `cove-${timestamp}.db`);
  const source = new Database(file, { readonly: true, fileMustExist: true });
  try {
    source.pragma("busy_timeout = 5000");
    await source.backup(base);
  } finally {
    source.close();
  }
  return base;
}

function recordGroupReceipt(file, group, winnerId, mergedIds, now) {
  const db = new Database(file);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `INSERT INTO cove_receipts
         (id, source, started_at, finished_at, summary, actions_json,
          retry_count, outcome, created_at)
       VALUES (?, 'contact-dedupe', ?, ?, ?, ?, 0, 'success', ?)`,
    ).run(
      randomUUID(),
      now,
      now,
      `Approved duplicate-contact group merged into ${winnerId}.`,
      JSON.stringify({ fingerprint: group.fingerprint, winnerId, mergedIds }),
      now,
    );
  } finally {
    db.close();
  }
}

export async function applyDedupePlan(file, plan) {
  let backupPath;
  const results = [];
  for (const group of Array.isArray(plan.groups) ? plan.groups : []) {
    if (group.approved !== true) continue;
    const ids = Array.isArray(group.contacts) ? group.contacts.map((contact) => contact.id) : [];
    if (typeof group.winnerId !== "string" || !ids.includes(group.winnerId)) {
      console.log(`invalid_winner ${group.fingerprint}`);
      results.push("invalid_winner");
      continue;
    }
    const inspect = new Database(file, { readonly: true, fileMustExist: true });
    let live;
    try {
      live = contactSnapshot(inspect, ids);
    } finally {
      inspect.close();
    }
    if (live.length !== ids.length || fingerprintContacts(live) !== group.fingerprint) {
      console.log(`stale ${group.fingerprint}`);
      results.push("stale");
      continue;
    }
    const deals = live.filter((contact) => contact.deal);
    if (deals.length > 1) {
      console.log(`collision ${group.fingerprint}`);
      results.push("collision");
      continue;
    }
    if (!backupPath) backupPath = await backupDatabase(file);
    const mergedIds = [];
    for (const loserId of ids.filter((id) => id !== group.winnerId)) {
      mergeContactAtomic({ winnerId: group.winnerId, loserId, dbPath: file });
      mergedIds.push(loserId);
      console.log(`merged ${loserId} -> ${group.winnerId}`);
    }
    recordGroupReceipt(file, group, group.winnerId, mergedIds, new Date().toISOString());
    results.push("merged");
  }
  if (backupPath) console.log(`backup ${backupPath}`);
  return results;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv.includes("--apply")) {
    const planPath = argument("--plan");
    if (!planPath) throw new Error("--apply requires --plan <file>.");
    await applyDedupePlan(dbPath, JSON.parse(readFileSync(path.resolve(planPath), "utf8")));
    return;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const plan = buildDedupePlan(db);
    const writePlan = argument("--write-plan");
    if (writePlan) {
      writeFileSync(path.resolve(writePlan), `${JSON.stringify(plan, null, 2)}\n`);
      console.log(`plan ${path.resolve(writePlan)}`);
    }
    if (plan.groups.length === 0) {
      console.log(`No likely duplicate contacts found in ${dbPath}.`);
      return;
    }
    console.log(`Likely duplicate contacts in ${dbPath} (nothing was changed):`);
    for (const group of plan.groups) {
      console.log(`# ${group.fingerprint}`);
      for (const contact of group.contacts) {
        console.log(`  ${contact.id}  ${JSON.stringify(contact.name)}  ${contact.email ?? "(no email)"}`);
      }
      console.log(`  suggested winner: ${group.suggestedWinnerId}`);
    }
  } finally {
    db.close();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
