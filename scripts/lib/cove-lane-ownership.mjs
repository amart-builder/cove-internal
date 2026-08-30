import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeMachineIdentity,
  resolveMachineIdentity,
} from "../../src/lib/machine-identity.mjs";

export const BACKGROUND_LANES = ["meeting_watch", "progress", "voice_review"];
export const INSTALLED_LANES = ["meeting_watch", "progress_reconcile", "voice_review"];

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function currentIdentity(identity, homeDir) {
  return identity
    ? normalizeMachineIdentity(identity)
    : resolveMachineIdentity({ homeDir });
}

function ownerEntry(value) {
  const entry = objectValue(value);
  if (
    typeof entry?.id !== "string" ||
    typeof entry?.hostname_at_claim !== "string"
  ) {
    // The pre-release ownership format used a mutable hostname as identity.
    // Treat it as unclaimed so the next installer can write a stable UUID.
    return undefined;
  }
  try {
    const normalized = normalizeMachineIdentity({
      id: entry.id,
      hostname: entry.hostname_at_claim,
    });
    return {
      id: normalized.id,
      hostnameAtClaim: normalized.hostname,
      claimedAt: typeof entry.claimed_at === "string"
        ? entry.claimed_at
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function laneOwnerLabel(owner) {
  return owner?.hostnameAtClaim || owner?.id || "another Mac";
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function assertLane(lane) {
  if (!BACKGROUND_LANES.includes(lane)) {
    throw new Error(`Unknown background lane: ${lane}`);
  }
}

function assertInstalledLane(lane) {
  if (!INSTALLED_LANES.includes(lane)) {
    throw new Error(`Unknown installed lane: ${lane}`);
  }
}

export function laneOwnersPath(dataDir) {
  return path.join(dataDir, "cove-lane-owners.json");
}

export function installedLanesPath(dataDir) {
  return path.join(dataDir, "intake", "installed-lanes.json");
}

export function readLaneOwner(dataDir, lane) {
  assertLane(lane);
  const parsed = objectValue(readJson(laneOwnersPath(dataDir)));
  const entry = objectValue(objectValue(parsed?.lanes)?.[lane]);
  return ownerEntry(entry);
}

export function checkLaneOwnership({
  dataDir,
  lane,
  identity,
  homeDir,
}) {
  const machine = currentIdentity(identity, homeDir);
  const owner = readLaneOwner(dataDir, lane);
  return {
    identity: machine,
    owner,
    shouldRun: !owner || owner.id === machine.id,
  };
}

export function claimLaneOwnership({
  dataDir,
  lane,
  identity,
  homeDir,
  force = false,
  now = new Date(),
}) {
  assertLane(lane);
  const machine = currentIdentity(identity, homeDir);
  const file = laneOwnersPath(dataDir);
  const parsed = objectValue(readJson(file)) ?? {};
  const lanes = { ...(objectValue(parsed.lanes) ?? {}) };
  const owner = ownerEntry(lanes[lane]);
  if (owner && owner.id !== machine.id && !force) {
    return {
      claimed: false,
      identity: machine,
      owner,
    };
  }
  lanes[lane] = {
    id: machine.id,
    hostname_at_claim: machine.hostname,
    claimed_at: now.toISOString(),
  };
  atomicWriteJson(file, {
    ...parsed,
    version: 2,
    lanes,
  });
  const claimedOwner = readLaneOwner(dataDir, lane);
  return {
    claimed: true,
    identity: machine,
    owner: claimedOwner,
    replacedOwner: owner && owner.id !== machine.id ? owner : undefined,
  };
}

export function markLaneInstalled({
  dataDir,
  lane,
  identity,
  homeDir,
  now = new Date(),
}) {
  assertInstalledLane(lane);
  const current = currentIdentity(identity, homeDir);
  const file = installedLanesPath(dataDir);
  const parsed = objectValue(readJson(file)) ?? {};
  const machines = { ...(objectValue(parsed.machines) ?? {}) };
  const machine = { ...(objectValue(machines[current.id]) ?? {}) };
  machine.hostname = current.hostname;
  machine[lane] = { installed_at: now.toISOString() };
  machines[current.id] = machine;
  atomicWriteJson(file, {
    ...parsed,
    version: 3,
    machines,
  });
  return machine[lane];
}

export function laneInstalledForMachine({
  dataDir,
  lane,
  identity,
  homeDir,
}) {
  assertInstalledLane(lane);
  const current = currentIdentity(identity, homeDir);
  const parsed = objectValue(readJson(installedLanesPath(dataDir)));
  const machines = objectValue(parsed?.machines);
  const machine = objectValue(machines?.[current.id]);
  return Boolean(objectValue(machine?.[lane])?.installed_at);
}

async function main(args = process.argv.slice(2)) {
  const [command, dataDir, lane, fourth, fifth] = args;
  if (!command || !dataDir || !lane) {
    throw new Error(
      "Usage: cove-lane-ownership.mjs <claim|mark-installed> <data-dir> <lane> [plain|mini] [home-dir]",
    );
  }
  if (command === "claim") {
    const result = claimLaneOwnership({
      dataDir,
      lane,
      homeDir: fifth,
      force: fourth === "mini",
    });
    process.stdout.write(
      result.claimed
        ? `claimed:${laneOwnerLabel(result.owner)}\n`
        : `skipped:${laneOwnerLabel(result.owner)}\n`,
    );
    return;
  }
  if (command === "mark-installed") {
    const identity = resolveMachineIdentity({ homeDir: fourth });
    markLaneInstalled({ dataDir, lane, identity });
    process.stdout.write(`installed:${identity.hostname}\n`);
    return;
  }
  throw new Error(`Unknown lane ownership command: ${command}`);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
