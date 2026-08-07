import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { coveDataDir } from "../operator";
import { coveConfigPath, coveConfigWritePath } from "../env";

// "full" stays reserved until reviewed full-task execution exists.
export type CoveAutonomyLevel = "off" | "groundwork";

export type CoveAutonomySettings = {
  level: CoveAutonomyLevel;
  first_groundwork_at: string | null;
  checkin_answered: boolean;
  checkin_presented_count: number;
};

export const DEFAULT_AUTONOMY_SETTINGS: CoveAutonomySettings = {
  level: "off",
  first_groundwork_at: null,
  checkin_answered: false,
  checkin_presented_count: 0,
};

export function coveAutonomySettingsPath(dataDir?: string): string {
  return coveConfigPath(coveDataDir(dataDir), "autonomy.json");
}

// Writes always land on the new name; an install that still has the old
// cove-autonomy.json is read from it once and migrated on the next write.
function autonomySettingsWritePath(dataDir?: string): string {
  return coveConfigWritePath(coveDataDir(dataDir), "autonomy.json");
}

function validateSettings(value: unknown): CoveAutonomySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cove_autonomy_invalid");
  }
  const row = value as Record<string, unknown>;
  const firstGroundworkAt = row.first_groundwork_at === undefined
    ? null
    : row.first_groundwork_at;
  const checkinAnswered = row.checkin_answered === undefined
    ? false
    : row.checkin_answered;
  const presentedCount = row.checkin_presented_count === undefined
    ? 0
    : row.checkin_presented_count;
  if (
    (row.level !== "off" && row.level !== "groundwork") ||
    (
      firstGroundworkAt !== null &&
      (
        typeof firstGroundworkAt !== "string" ||
        !Number.isFinite(Date.parse(firstGroundworkAt))
      )
    ) ||
    typeof checkinAnswered !== "boolean" ||
    !Number.isInteger(presentedCount) ||
    Number(presentedCount) < 0 ||
    Number(presentedCount) > 3
  ) {
    throw new Error("cove_autonomy_invalid");
  }
  return {
    level: row.level,
    first_groundwork_at: firstGroundworkAt,
    checkin_answered: checkinAnswered,
    checkin_presented_count: Number(presentedCount),
  };
}

function atomicWriteSettings(
  file: string,
  settings: CoveAutonomySettings,
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readCoveAutonomySettings(options: {
  dataDir?: string;
  createIfMissing?: boolean;
} = {}): CoveAutonomySettings | undefined {
  const file = coveAutonomySettingsPath(options.dataDir);
  try {
    return validateSettings(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!options.createIfMissing) return undefined;
    atomicWriteSettings(autonomySettingsWritePath(options.dataDir), DEFAULT_AUTONOMY_SETTINGS);
    return { ...DEFAULT_AUTONOMY_SETTINGS };
  }
}

export function ensureCoveAutonomySettings(
  dataDir?: string,
): CoveAutonomySettings {
  return readCoveAutonomySettings({
    dataDir,
    createIfMissing: true,
  })!;
}

export function markFirstGroundworkSuccess(
  options: {
    dataDir?: string;
    now?: Date;
  } = {},
): CoveAutonomySettings {
  const current = ensureCoveAutonomySettings(options.dataDir);
  if (current.first_groundwork_at) return current;
  const next = {
    ...current,
    first_groundwork_at: (options.now ?? new Date()).toISOString(),
  };
  atomicWriteSettings(autonomySettingsWritePath(options.dataDir), next);
  return next;
}

export function groundworkCheckinDue(
  settings: CoveAutonomySettings,
  now = new Date(),
): boolean {
  if (
    settings.level !== "groundwork" ||
    settings.checkin_answered ||
    settings.checkin_presented_count >= 3 ||
    !settings.first_groundwork_at
  ) {
    return false;
  }
  return (
    now.getTime() - Date.parse(settings.first_groundwork_at) >=
    14 * 24 * 60 * 60_000
  );
}

export function recordGroundworkCheckinPresentation(
  options: {
    dataDir?: string;
  } = {},
): CoveAutonomySettings {
  const current = ensureCoveAutonomySettings(options.dataDir);
  const presentedCount = Math.min(3, current.checkin_presented_count + 1);
  const next = {
    ...current,
    checkin_presented_count: presentedCount,
    checkin_answered: current.checkin_answered || presentedCount >= 3,
  };
  atomicWriteSettings(autonomySettingsWritePath(options.dataDir), next);
  return next;
}
