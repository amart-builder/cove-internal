import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { MorningBriefSourceManifest } from "../day-plan/brief";

const BRIEF_INPUT_RETENTION = 60;

export type StoredMorningBriefInput = {
  artifact_id: string;
  target_local_date: string;
  target_timezone: string;
  prompt_version: number;
  schema_version: number;
  sections: ReadonlyArray<{ id: string; label: string; text: string }>;
  manifest: MorningBriefSourceManifest;
  written_at: string;
};

function briefInputFilename(artifactId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(artifactId)) {
    throw new Error("brief_input_artifact_id_invalid");
  }
  return `${artifactId}.json`;
}

function pruneMorningBriefInputs(directory: string, newestPath: string): void {
  try {
    const newestName = path.basename(newestPath);
    const files = readdirSync(directory)
      .filter((name) => /^[A-Za-z0-9._-]+\.json$/.test(name))
      .map((name) => {
        const filePath = path.join(directory, name);
        return { name, filePath, modifiedAt: statSync(filePath).mtimeMs };
      })
      .sort((left, right) =>
        right.modifiedAt - left.modifiedAt ||
        Number(right.name === newestName) - Number(left.name === newestName) ||
        right.name.localeCompare(left.name));
    // Bounded retention limits the private-data footprint without risking a
    // generation failure when an old input cannot be removed.
    for (const file of files.slice(BRIEF_INPUT_RETENTION)) {
      try {
        unlinkSync(file.filePath);
      } catch {
        // Retention is maintenance only. The newly written input remains valid.
      }
    }
  } catch {
    // Directory scans and metadata reads never participate in generation.
  }
}

export function writeMorningBriefInput(
  input: StoredMorningBriefInput,
  dataDir: string,
): string {
  const directory = path.join(dataDir, "brief-inputs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, briefInputFilename(input.artifact_id));
  const temporary = path.join(
    directory,
    `.${input.artifact_id}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(input, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    // Rename is atomic on the same filesystem, so a backtest never reads a
    // partial manifest while the worker is still writing it.
    renameSync(temporary, destination);
    pruneMorningBriefInputs(directory, destination);
    return destination;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
