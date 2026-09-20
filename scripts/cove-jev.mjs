#!/usr/bin/env node
/**
 * Jev status and shadow readout.
 *
 *   node scripts/cove-jev.mjs status
 *   node scripts/cove-jev.mjs enable <feature...>
 *   node scripts/cove-jev.mjs disable [feature...]
 *   node scripts/cove-jev.mjs report [--days 7] [--json]
 *   node scripts/cove-jev.mjs waiting [--days 30] [--json]
 *
 * `enable` writes the mode and the named feature flags. `disable` with no
 * feature named sets the mode to off, which is the kill switch: it stops every
 * lane in one command without having to remember which are on.
 *
 * There is deliberately no command that writes the credential. The key is
 * pasted into .env.local by the person who owns it; no Cove script reads it
 * from an argument, prints it, or copies it anywhere. `enable` therefore cannot
 * finish the job on its own, and says so when the key is not there yet.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveEmailRuntimePaths } from "../src/lib/email/runtime-paths.ts";
import {
  JEV_FEATURES,
  isJevFeature,
  readJevCredential,
  readJevSettings,
  writeJevSettings,
} from "../src/lib/jev/settings.ts";
import { readJevBreaker } from "../src/lib/jev/policy.ts";
import { readJevSpendSince } from "../src/lib/jev/ledger.ts";
import {
  buildJevReport,
  buildJevWaitingOutcomes,
  formatJevReport,
  formatJevWaitingReport,
} from "../src/lib/jev/report.ts";

const repoDirDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read-only, and it must exist: these commands report on a real install and
 * should say so plainly rather than creating an empty database that would read
 * as "Jev has never run" on a machine where it has.
 */
function openLedger(dbPath) {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    throw new Error(
      `No Cove database at ${dbPath}. Run this on the machine with the install, `
        + "or set COVE_DB_PATH or COVE_DATA_DIR to point at it.",
    );
  }
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "status";
  const days = (() => {
    const index = argv.indexOf("--days");
    if (index === -1) return 7;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 365) : 7;
  })();
  // Everything after the command that is not a flag or a flag's value.
  const names = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--days") {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    names.push(value);
  }
  return { command, days, names, json: argv.includes("--json") };
}

export function jevSetFeatures(options) {
  const repoDir = options.repoDir ?? repoDirDefault;
  const env = options.env ?? process.env;
  const { dataDir } = resolveEmailRuntimePaths({ repoDir, env });
  const features = {};
  for (const name of options.names) features[name] = options.on;
  return writeJevSettings({
    dataDir,
    ...(options.mode ? { mode: options.mode } : {}),
    features,
  });
}

export function jevStatus(options = {}) {
  const repoDir = options.repoDir ?? repoDirDefault;
  const env = options.env ?? process.env;
  const { dataDir, dbPath } = resolveEmailRuntimePaths({ repoDir, env });
  const settings = readJevSettings({ dataDir, env });
  // Presence only. The value never leaves the environment.
  const credential = Boolean(readJevCredential(env));
  const db = options.db ?? openLedger(dbPath);
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
    lines.push("Jev is off. To run a lane in shadow:");
    lines.push("  node scripts/cove-jev.mjs enable emailTriage");
    lines.push("and put COVE_TYPESAFE_API_KEY in .env.local yourself.");
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
  const db = options.db ?? openLedger(dbPath);
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
  const db = options.db ?? openLedger(dbPath);
  try {
    return buildJevWaitingOutcomes({ db, since });
  } finally {
    if (!options.db) db.close();
  }
}

async function main(argv) {
  const { command, days, names, json } = parseArgs(argv);
  if (command === "enable" || command === "disable") {
    const unknown = names.filter((name) => !isJevFeature(name));
    if (unknown.length > 0) {
      console.error(
        `Unknown feature(s): ${unknown.join(", ")}. Available: ${JEV_FEATURES.join(", ")}.`,
      );
      return 1;
    }
    if (command === "enable" && names.length === 0) {
      console.error(`Name at least one feature to enable: ${JEV_FEATURES.join(", ")}.`);
      return 1;
    }
    const next = jevSetFeatures({
      names,
      on: command === "enable",
      // Enabling names shadow explicitly rather than assuming it, and disabling
      // with no feature named is the kill switch for every lane at once.
      ...(command === "enable" ? { mode: "shadow" } : {}),
      ...(command === "disable" && names.length === 0 ? { mode: "off" } : {}),
    });
    console.log(formatStatus({
      ...next,
      credentialConfigured: Boolean(readJevCredential()),
      last24h: { attempts: 0, estimatedCostUsd: 0 },
      breakers: {},
    }));
    if (command === "enable" && !readJevCredential()) {
      console.log("");
      console.log("No credential is set, so nothing will run yet. Put");
      console.log("COVE_TYPESAFE_API_KEY in .env.local yourself and rerun status.");
    }
    return 0;
  }
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
  console.error(
    `Unknown command: ${command}. Use status, enable, disable, report or waiting.`,
  );
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
