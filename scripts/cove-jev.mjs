#!/usr/bin/env node
/**
 * Jev status and shadow readout.
 *
 *   node scripts/cove-jev.mjs status
 *   node scripts/cove-jev.mjs report [--days 7] [--json]
 *   node scripts/cove-jev.mjs waiting [--days 30] [--json]
 *
 * There is deliberately no command that writes the credential. The key is
 * pasted into .env.local by the person who owns it; no Cove script reads it
 * from an argument, prints it, or copies it anywhere.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveEmailRuntimePaths } from "../src/lib/email/runtime-paths.ts";
import { readJevCredential, readJevSettings } from "../src/lib/jev/settings.ts";
import { readJevBreaker } from "../src/lib/jev/policy.ts";
import { readJevSpendSince } from "../src/lib/jev/ledger.ts";
import {
  buildJevReport,
  buildJevWaitingOutcomes,
  formatJevReport,
  formatJevWaitingReport,
} from "../src/lib/jev/report.ts";

const repoDirDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status";
  const days = (() => {
    const index = argv.indexOf("--days");
    if (index === -1) return 7;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 365) : 7;
  })();
  return { command, days, json: argv.includes("--json") };
}

export function jevStatus(options = {}) {
  const repoDir = options.repoDir ?? repoDirDefault;
  const env = options.env ?? process.env;
  const { dataDir, dbPath } = resolveEmailRuntimePaths({ repoDir, env });
  const settings = readJevSettings({ dataDir, env });
  // Presence only. The value never leaves the environment.
  const credential = Boolean(readJevCredential(env));
  const db = options.db ?? new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const now = options.now ?? new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const spend = readJevSpendSince({ since: dayAgo, db });
    return {
      mode: settings.mode,
      features: settings.features,
      model: settings.model,
      credentialConfigured: credential,
      limits: settings.limits,
      last24h: spend,
      breakers: {
        emailTriage: readJevBreaker({ db, feature: "emailTriage", now }),
        commitmentAudit: readJevBreaker({ db, feature: "commitmentAudit", now }),
        meetingAudit: readJevBreaker({ db, feature: "meetingAudit", now }),
        waitingResolution: readJevBreaker({ db, feature: "waitingResolution", now }),
      },
    };
  } finally {
    if (!options.db) db.close();
  }
}

function formatStatus(status) {
  const lines = [];
  lines.push(`mode: ${status.mode}`);
  lines.push(
    `features: ${
      Object.entries(status.features)
        .map(([name, on]) => `${name} ${on ? "on" : "off"}`)
        .join(", ")
    }`,
  );
  lines.push(`model: ${status.model}`);
  lines.push(`credential: ${status.credentialConfigured ? "configured" : "not configured"}`);
  lines.push(
    `last 24h: ${status.last24h.attempts} call(s), ` +
      `$${status.last24h.estimatedCostUsd.toFixed(6)} reserved of ` +
      `$${status.limits.dailySpendUsd}`,
  );
  for (const [feature, breaker] of Object.entries(status.breakers)) {
    if (breaker.state !== "closed") {
      lines.push(`${feature}: breaker ${breaker.state}${breaker.until ? ` until ${breaker.until}` : ""}`);
    }
  }
  if (status.mode === "off") {
    lines.push("");
    lines.push("Jev is off. To run it in shadow, set mode and a feature in");
    lines.push("cove-jev.json under the Cove data directory, and put");
    lines.push("COVE_TYPESAFE_API_KEY in .env.local yourself.");
  }
  return lines.join("\n");
}

export function jevReport(options = {}) {
  const repoDir = options.repoDir ?? repoDirDefault;
  const env = options.env ?? process.env;
  const { dbPath } = resolveEmailRuntimePaths({ repoDir, env });
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.days ?? 7) * 24 * 60 * 60 * 1000)
    .toISOString();
  const db = options.db ?? new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return buildJevReport({ db, since });
  } finally {
    if (!options.db) db.close();
  }
}

/**
 * The waiting lane's own readout. It is separate from `report` because it is
 * scored differently: there is no existing Cove owner to agree with, only what
 * the operator did about the commitment afterwards, which takes longer to
 * accumulate. Hence the longer default window.
 */
export function jevWaiting(options = {}) {
  const repoDir = options.repoDir ?? repoDirDefault;
  const env = options.env ?? process.env;
  const { dbPath } = resolveEmailRuntimePaths({ repoDir, env });
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.days ?? 30) * 24 * 60 * 60 * 1000)
    .toISOString();
  const db = options.db ?? new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return buildJevWaitingOutcomes({ db, since });
  } finally {
    if (!options.db) db.close();
  }
}

async function main(argv) {
  const { command, days, json } = parseArgs(argv);
  if (command === "status") {
    const status = jevStatus();
    console.log(json ? JSON.stringify(status, null, 2) : formatStatus(status));
    return 0;
  }
  if (command === "report") {
    const report = jevReport({ days });
    console.log(json ? JSON.stringify(report, null, 2) : formatJevReport(report));
    return 0;
  }
  if (command === "waiting") {
    const report = jevWaiting({ days: argv.includes("--days") ? days : 30 });
    console.log(json ? JSON.stringify(report, null, 2) : formatJevWaitingReport(report));
    return 0;
  }
  console.error(`Unknown command: ${command}. Use status, report or waiting.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
