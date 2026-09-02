import type { Contact } from "../data/types";
import { openLocalDatabase } from "../local/database";
import { mergeContactsInDatabase } from "./local";
import { LocalPipelineStore } from "./pipeline-store";

export function mergeContactAtomic(input: {
  winnerId: string;
  loserId: string;
  dbPath?: string;
  now?: Date;
}): Contact {
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const now = (input.now ?? new Date()).toISOString();
      LocalPipelineStore.reparentInDatabase(
        db,
        input.loserId,
        input.winnerId,
        now,
      );
      return mergeContactsInDatabase(db, input, now);
    }).immediate();
  } finally {
    db.close();
  }
}
