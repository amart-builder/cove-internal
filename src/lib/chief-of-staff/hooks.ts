import { coveEnv } from "../env";
import { openLocalDatabase } from "../local/database";
import { enqueueChiefOfStaffWake } from "./storage";
import type { ChiefOfStaffReason } from "./types";

export function chiefOfStaffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["off","0","false"].includes(coveEnv("CHIEF_OF_STAFF", env)?.trim().toLowerCase() ?? "");
}

export function tryEnqueueChiefOfStaffWake(input: {
  reason: ChiefOfStaffReason;
  payload: Record<string, unknown>;
  note?: string;
  dbPath?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): boolean {
  if (!chiefOfStaffEnabled(input.env)) return false;
  try {
    const db = openLocalDatabase(input.dbPath);
    try {
      db.transaction(() => enqueueChiefOfStaffWake(db, {
        reason: input.reason,
        payload: input.payload,
        note: input.note,
        now: input.now,
      })).immediate();
    } finally {
      db.close();
    }
    return true;
  } catch (error) {
    (input.warn ?? console.warn)(
      `Chief-of-staff wake could not be queued: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
