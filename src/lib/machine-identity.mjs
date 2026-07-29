import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function boundedHostname(value) {
  const resolved = typeof value === "string" ? value.trim() : "";
  if (!resolved || resolved.length > 255) {
    throw new Error("Could not resolve a bounded hostname for this machine.");
  }
  return resolved;
}

export function normalizeMachineIdentity(value) {
  const row = objectValue(value);
  const id = typeof row?.id === "string" ? row.id.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(id)) {
    throw new Error("Cove machine identity must contain a UUID.");
  }
  return {
    id,
    hostname: boundedHostname(row?.hostname),
  };
}

export function machineIdentityPaths(homeDir = homedir()) {
  return {
    primary: path.join(
      homeDir,
      "Library",
      "Application Support",
      "Cove",
      "machine-id",
    ),
    fallback: path.join(homeDir, ".cove-machine-id"),
  };
}

function readIdentity(file) {
  try {
    return normalizeMachineIdentity(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)
    ) {
      return undefined;
    }
    throw new Error(
      `Cove machine identity is unreadable at ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeIdentity(file, identity) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

export function resolveMachineIdentity(options = {}) {
  const paths = {
    ...machineIdentityPaths(options.homeDir),
    ...(options.paths ?? {}),
  };
  const currentHostname = boundedHostname(options.hostname ?? hostname());
  for (const [index, file] of [paths.primary, paths.fallback].entries()) {
    const existing = readIdentity(file);
    if (!existing) continue;
    const updated = { ...existing, hostname: currentHostname };
    try {
      if (existing.hostname !== currentHostname) {
        writeIdentity(file, updated);
      } else {
        chmodSync(file, 0o600);
      }
      return { ...updated, file };
    } catch (error) {
      if (index !== 0) throw error;
      writeIdentity(paths.fallback, updated);
      return { ...updated, file: paths.fallback };
    }
  }

  const identity = normalizeMachineIdentity({
    id: (options.randomUUID ?? randomUUID)(),
    hostname: currentHostname,
  });
  try {
    writeIdentity(paths.primary, identity);
    return { ...identity, file: paths.primary };
  } catch (primaryError) {
    try {
      writeIdentity(paths.fallback, identity);
      return { ...identity, file: paths.fallback };
    } catch (fallbackError) {
      throw new Error(
        `Could not persist Cove machine identity: ${
          primaryError instanceof Error ? primaryError.message : String(primaryError)
        }; fallback: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
      );
    }
  }
}
