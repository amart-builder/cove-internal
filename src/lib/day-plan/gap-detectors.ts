import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Commitment } from "../data/types";

const PACIFIC_TIMEZONE = "America/Los_Angeles";

export type ContentQuotaGap = {
  scheduled: number;
  posted: number;
  awaitingApproval: number;
  quota: number;
  gap: number;
};

export type GapDetectorFs = {
  readdirSync: (directory: string) => string[];
  readFileSync: (filePath: string, encoding: "utf8") => string;
};

type CommitmentForGap = Pick<
  Commitment,
  "id" | "status" | "due_at" | "review_at" | "updated_at"
> & Partial<Commitment>;

function frontmatter(markdown: string): Record<string, string> {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const values: Record<string, string> = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function pacificCalendarDate(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone: PACIFIC_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("target date invalid");
  const epoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (new Date(epoch).toISOString().slice(0, 10) !== localDate) {
    throw new Error("target date invalid");
  }
  return new Date(epoch + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pacificMidnightEpoch(localDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("target date invalid");
  const desiredEpoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instantEpoch = desiredEpoch;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(instantEpoch)).map((part) => [part.type, part.value]),
    );
    const renderedEpoch = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const nextEpoch = desiredEpoch - (renderedEpoch - instantEpoch);
    if (nextEpoch === instantEpoch) break;
    instantEpoch = nextEpoch;
  }
  if (pacificCalendarDate(new Date(instantEpoch)) !== localDate) {
    throw new Error("Pacific cutoff conversion failed");
  }
  return instantEpoch;
}

function markdownFrontmatters(
  directory: string,
  fs: GapDetectorFs,
): Record<string, string>[] | null {
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => frontmatter(fs.readFileSync(path.join(directory, name), "utf8")));
  } catch {
    return null;
  }
}

export function contentQuotaGap(input: {
  engineDir: string;
  targetLocalDate: string;
  quota: number;
  fs?: GapDetectorFs;
}): ContentQuotaGap | null {
  const fs = input.fs ?? { readdirSync, readFileSync };
  const queue = markdownFrontmatters(path.join(input.engineDir, "pipeline", "queue"), fs);
  const postedRows = markdownFrontmatters(path.join(input.engineDir, "pipeline", "posted"), fs);
  if (!queue || !postedRows) return null;

  const scheduled = queue.filter(
    (row) =>
      row.status === "scheduled" &&
      pacificCalendarDate(row.scheduled_for) === input.targetLocalDate,
  ).length;
  const posted = postedRows.filter(
    (row) => pacificCalendarDate(row.posted_at) === input.targetLocalDate,
  ).length;
  const awaitingApproval = queue.filter((row) => row.status === "review").length;
  const quota = Number.isFinite(input.quota) ? Math.max(0, Math.floor(input.quota)) : 0;
  return {
    scheduled,
    posted,
    awaitingApproval,
    quota,
    gap: Math.max(0, quota - (scheduled + posted)),
  };
}

function timestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function targetCutoff(targetDate: string | Date): number | undefined {
  try {
    const localDate = typeof targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)
      ? addCalendarDays(targetDate, 0)
      : pacificCalendarDate(targetDate);
    if (!localDate) return undefined;
    return pacificMidnightEpoch(addCalendarDays(localDate, 2)) - 1;
  } catch {
    return undefined;
  }
}

function nextCommitmentDate(commitment: CommitmentForGap): number | undefined {
  const dates = [timestamp(commitment.due_at), timestamp(commitment.review_at)].filter(
    (value): value is number => value !== undefined,
  );
  return dates.length > 0 ? Math.min(...dates) : undefined;
}

export function followUpsDue<T extends CommitmentForGap>(
  commitments: readonly T[],
  targetDate: string | Date,
): T[] {
  const cutoff = targetCutoff(targetDate);
  if (cutoff === undefined) return [];
  return commitments
    .filter((commitment) => {
      const nextDate = nextCommitmentDate(commitment);
      return commitment.status === "open" && nextDate !== undefined && nextDate <= cutoff;
    })
    .sort((left, right) =>
      (nextCommitmentDate(left) ?? Number.POSITIVE_INFINITY) -
        (nextCommitmentDate(right) ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
    );
}

export function staleOpenItems<T extends CommitmentForGap>(
  commitments: readonly T[],
  now: Date,
): T[] {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoff)) return [];
  return commitments
    .filter((commitment) => {
      const updatedAt = timestamp(commitment.updated_at);
      return commitment.status === "open" && updatedAt !== undefined && updatedAt < cutoff;
    })
    .sort((left, right) =>
      (timestamp(left.updated_at) ?? Number.POSITIVE_INFINITY) -
        (timestamp(right.updated_at) ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
    );
}
