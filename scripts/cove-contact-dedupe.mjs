#!/usr/bin/env node
// One-time duplicate-contact scan. READ ONLY: it prints a proposed merge
// list and never writes. Applying a merge is a human decision through the
// CRM API (POST /api/crm with action "merge", winnerId + loserId).

import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.COVE_DB_PATH ?? path.join(repoDir, "data", "cove.db");

// Minimal copies of the canonical helpers (src/lib/crm/identity.ts and
// src/lib/email/from-header.ts) so this script runs under plain node.
function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .trim()
    .replace(/\s+/g, " ");
}

function parseDisplayName(value) {
  const raw = String(value ?? "").trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1").trim();
  const beforeAngle = raw.split("<")[0].replace(/\([^)]*\)/g, "").trim();
  if (beforeAngle && !beforeAngle.includes("@")) return beforeAngle;
  return "";
}

function cleanedNormalizedName(storedName) {
  const parsed = parseDisplayName(storedName);
  const normalized = normalizeName(parsed || storedName);
  const tokens = normalized.split(" ").filter(Boolean);
  // Welded form: "sarah chen sarahworkcom" from a raw From header. Drop a
  // trailing token that looks like a squashed email address: it ends like a
  // domain and repeats one of the name tokens (or is unusually long).
  if (tokens.length >= 3) {
    const last = tokens[tokens.length - 1];
    const head = tokens.slice(0, -1);
    const weldedTail = /(com|net|org|io|ai|co|dev|edu|gov)$/.test(last) &&
      (last.length >= 10 ||
        head.some((token) => token.length >= 3 && last.includes(token)));
    if (weldedTail) return head.join(" ");
  }
  return normalized;
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const contacts = db.prepare(
    `SELECT id, name, email, created_at
     FROM contacts
     ORDER BY COALESCE(created_at, ''), id`,
  ).all();
  const groups = new Map();
  for (const contact of contacts) {
    const key = cleanedNormalizedName(contact.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(contact);
  }
  const duplicates = [...groups.entries()].filter(([, rows]) => rows.length > 1);
  if (duplicates.length === 0) {
    console.log(`No likely duplicate contacts found in ${dbPath}.`);
  } else {
    console.log(`Likely duplicate contacts in ${dbPath} (nothing was changed):\n`);
    for (const [key, rows] of duplicates) {
      const [winner, ...losers] = rows;
      console.log(`# ${key}`);
      console.log(`  keep:  ${winner.id}  ${JSON.stringify(winner.name)}  ${winner.email ?? "(no email)"}`);
      for (const loser of losers) {
        console.log(`  merge: ${loser.id}  ${JSON.stringify(loser.name)}  ${loser.email ?? "(no email)"}`);
        console.log(`    -> action "merge", winnerId ${winner.id}, loserId ${loser.id}`);
      }
      console.log("");
    }
    console.log(
      "Review each pair, then apply chosen merges through POST /api/crm with action \"merge\".",
    );
  }
} finally {
  db.close();
}
