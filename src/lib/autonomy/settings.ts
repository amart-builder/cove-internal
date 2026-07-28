import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { forgeDataDir } from "../operator";

// "full" stays reserved until reviewed full-task execution exists.
export type ForgeAutonomyLevel = "off" | "groundwork";

export type ForgeAutonomySettings = {
  level: ForgeAutonomyLevel;
  first_groundwork_at: string | null;
  checkin_answered: boolean;
  checkin_presented_count: number;
};

export const DEFAULT_AUTONOMY_SETTINGS: ForgeAutonomySettings = {
  level: "off",
  first_groundwork_at: null,
  checkin_answered: false,
  checkin_presented_count: 0,
};

export function forgeAutonomySettingsPath(dataDir?: string): string {
  return path.join(forgeDataDir(dataDir), "forge-autonomy.json");
}

function validateSettings(value: unknown): ForgeAutonomySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("forge_autonomy_invalid");
  }
  const row = value as Record<string, unknown>;
  const presentedCount = row.checkin_presented_count === undefined
    ? 0
    : row.checkin_presented_count;
  if (
    (row.level !== "off" && row.level !== "groundwork") ||
    (
      row.first_groundwork_at !== null &&
      (
        typeof row.first_groundwork_at !== "string" ||
        !Number.isFinite(Date.parse(row.first_groundwork_at))
      )
    ) ||
    typeof row.checkin_answered !== "boolean" ||
    !Number.isInteger(presentedCount) ||
    Number(presentedCount) < 0 ||
    Number(presentedCount) > 3
  ) {
    throw new Error("forge_autonomy_invalid");
  }
  return {
    level: row.level,
    first_groundwork_at: row.first_groundwork_at,
    checkin_answered: row.checkin_answered,
    checkin_presented_count: Number(presentedCount),
  };
}

function atomicWriteSettings(
  file: string,
  settings: ForgeAutonomySettings,
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

export function readForgeAutonomySettings(options: {
  dataDir?: string;
  createIfMissing?: boolean;
} = {}): ForgeAutonomySettings | undefined {
  const file = forgeAutonomySettingsPath(options.dataDir);
  try {
    return validateSettings(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!options.createIfMissing) return undefined;
    atomicWriteSettings(file, DEFAULT_AUTONOMY_SETTINGS);
    return { ...DEFAULT_AUTONOMY_SETTINGS };
  }
}

export function ensureForgeAutonomySettings(
  dataDir?: string,
): ForgeAutonomySettings {
  return readForgeAutonomySettings({
    dataDir,
    createIfMissing: true,
  })!;
}

export function markFirstGroundworkSuccess(
  options: {
    dataDir?: string;
    now?: Date;
  } = {},
): ForgeAutonomySettings {
  const current = ensureForgeAutonomySettings(options.dataDir);
  if (current.first_groundwork_at) return current;
  const next = {
    ...current,
    first_groundwork_at: (options.now ?? new Date()).toISOString(),
  };
  atomicWriteSettings(forgeAutonomySettingsPath(options.dataDir), next);
  return next;
}

export function groundworkCheckinDue(
  settings: ForgeAutonomySettings,
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
): ForgeAutonomySettings {
  const current = ensureForgeAutonomySettings(options.dataDir);
  const presentedCount = Math.min(3, current.checkin_presented_count + 1);
  const next = {
    ...current,
    checkin_presented_count: presentedCount,
    checkin_answered: current.checkin_answered || presentedCount >= 3,
  };
  atomicWriteSettings(forgeAutonomySettingsPath(options.dataDir), next);
  return next;
}
