import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { coveConfigPath, coveConfigWritePath } from "../env";
import { coveDataDir } from "../operator";

export type TaskSettings = {
  stale_after_days: number;
};

export const DEFAULT_TASK_SETTINGS: TaskSettings = {
  stale_after_days: 14,
};

export function taskSettingsPath(dataDir?: string): string {
  return coveConfigPath(coveDataDir(dataDir), "task-settings.json");
}

function taskSettingsWritePath(dataDir?: string): string {
  return coveConfigWritePath(coveDataDir(dataDir), "task-settings.json");
}

function validateTaskSettings(value: unknown): TaskSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cove_task_settings_invalid");
  }
  const days = (value as Record<string, unknown>).stale_after_days;
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 365) {
    throw new Error("cove_task_settings_invalid");
  }
  return { stale_after_days: Number(days) };
}

export function readTaskSettings(dataDir?: string): TaskSettings {
  try {
    return validateTaskSettings(
      JSON.parse(readFileSync(taskSettingsPath(dataDir), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...DEFAULT_TASK_SETTINGS };
  }
}

export function writeTaskSettings(
  settings: TaskSettings,
  dataDir?: string,
): TaskSettings {
  const validated = validateTaskSettings(settings);
  const file = taskSettingsWritePath(dataDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return validated;
}
