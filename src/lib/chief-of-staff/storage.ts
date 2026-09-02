import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { localDateInTimezone } from "../day-plan/brief";
import { coveConfigPath } from "../env";
import { operatorTimezone } from "../operator";
import { enqueueJobInDatabase } from "../reliability/jobs";
import {
  CHIEF_OF_STAFF_JOB_TYPE,
  CHIEF_OF_STAFF_REASONS,
  scrubModelText,
  stripStoredText,
  type ChiefOfStaffReason,
} from "./types";

export type ChiefOfStaffSession = {
  sessionId: string | null;
  createdAt: string;
  mandateHash: string;
  wakes: number;
  lastWakeAt: string | null;
  lastWakeReason: ChiefOfStaffReason | null;
};

export type ChiefOfStaffPaths = {
  root: string;
  agent: string;
  workspace: string;
  codexHome: string;
  codexConfig: string;
  codexAuth: string;
  mandate: string;
  session: string;
  archive: string;
  journal: string;
  snapshots: string;
  reviews: string;
};

const WORKSPACE_README = `# Empty workspace

The chief-of-staff agent must not run commands or read files. Cove supplies the complete bounded desk snapshot on stdin. Anything read outside that snapshot is discarded and must not be returned.
`;

export const CHIEF_OF_STAFF_CODEX_CONFIG = `model = "gpt-5.6-sol"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
shell_tool = false
apps = false
multi_agent = false

[tools]
view_image = false
web_search = false
`;

export function chiefOfStaffPaths(dataDir: string): ChiefOfStaffPaths {
  const root = path.join(dataDir, "chief-of-staff");
  const agent = path.join(root, "agent");
  const codexHome = path.join(root, "codex-home");
  return {
    root,
    agent,
    workspace: path.join(agent, "workspace"),
    codexHome,
    codexConfig: path.join(codexHome, "config.toml"),
    codexAuth: path.join(codexHome, "auth.json"),
    mandate: path.join(agent, "AGENTS.md"),
    session: path.join(root, "session.json"),
    archive: path.join(root, "archive"),
    journal: path.join(root, "journal"),
    snapshots: path.join(root, "snapshots"),
    reviews: path.join(root, "reviews"),
  };
}

function operatorCodexHome(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return path.resolve(configured);
  const operatorHome = env.HOME?.trim() || os.homedir();
  return path.join(operatorHome, ".codex");
}

export function ensureChiefOfStaffCodexHome(input: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}): { paths: ChiefOfStaffPaths; configRewritten: boolean; operatorAuth: string } {
  const paths = chiefOfStaffPaths(input.dataDir);
  const env = input.env ?? process.env;
  const sourceHome = operatorCodexHome(env);
  if (path.resolve(sourceHome) === path.resolve(paths.codexHome)) {
    throw new Error("The operator CODEX_HOME cannot be the chief-of-staff Codex home.");
  }
  const operatorAuth = path.join(sourceHome, "auth.json");
  if (!existsSync(operatorAuth)) {
    throw new Error(`Chief-of-staff Codex auth is unavailable. Expected operator auth at ${operatorAuth}.`);
  }
  mkdirSync(paths.codexHome, { recursive: true, mode: 0o700 });

  let existingConfig = "";
  try {
    existingConfig = readFileSync(paths.codexConfig, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const expectedHash = createHash("sha256").update(CHIEF_OF_STAFF_CODEX_CONFIG).digest("hex");
  const currentHash = createHash("sha256").update(existingConfig).digest("hex");
  const configRewritten = currentHash !== expectedHash;
  if (configRewritten) atomicWrite(paths.codexConfig, CHIEF_OF_STAFF_CODEX_CONFIG);

  let authIsCorrect = false;
  try {
    if (!lstatSync(paths.codexAuth).isSymbolicLink()) {
      throw new Error("Chief-of-staff auth.json exists but is not a symlink.");
    }
    authIsCorrect = path.resolve(paths.codexHome, readlinkSync(paths.codexAuth)) === path.resolve(operatorAuth);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!authIsCorrect) {
    if (existsSync(paths.codexAuth) || (() => {
      try {
        lstatSync(paths.codexAuth);
        return true;
      } catch {
        return false;
      }
    })()) unlinkSync(paths.codexAuth);
    symlinkSync(operatorAuth, paths.codexAuth);
  }
  return { paths, configRewritten, operatorAuth };
}

function atomicWrite(file: string, content: string, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode });
  renameSync(temporary, file);
}

function parseSession(value: unknown): ChiefOfStaffSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chief-of-staff session file is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (
    !(row.sessionId === null || typeof row.sessionId === "string") ||
    typeof row.createdAt !== "string" ||
    typeof row.mandateHash !== "string" ||
    !Number.isInteger(row.wakes) || Number(row.wakes) < 0 ||
    !(row.lastWakeAt === null || typeof row.lastWakeAt === "string") ||
    !(row.lastWakeReason === null || (
      typeof row.lastWakeReason === "string" &&
      (CHIEF_OF_STAFF_REASONS as readonly string[]).includes(row.lastWakeReason)
    ))
  ) {
    throw new Error("Chief-of-staff session file is invalid.");
  }
  return row as unknown as ChiefOfStaffSession;
}

export function readChiefOfStaffSession(dataDir: string): ChiefOfStaffSession | null {
  const file = chiefOfStaffPaths(dataDir).session;
  try {
    return parseSession(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeChiefOfStaffSession(
  dataDir: string,
  session: ChiefOfStaffSession,
): void {
  atomicWrite(
    chiefOfStaffPaths(dataDir).session,
    `${JSON.stringify(session, null, 2)}\n`,
  );
}

function mandateSource(repoDir: string, dataDir: string): string {
  const privateFile = coveConfigPath(dataDir, "mandate.md");
  const fallback = path.join(repoDir, "prompts", "chief-of-staff-mandate.md");
  return readFileSync(existsSync(privateFile) ? privateFile : fallback, "utf8").trim();
}

export function ensureChiefOfStaffHome(input: {
  repoDir: string;
  dataDir: string;
  now?: Date;
}): { paths: ChiefOfStaffPaths; session: ChiefOfStaffSession; mandateRewritten: boolean } {
  const now = input.now ?? new Date();
  const paths = chiefOfStaffPaths(input.dataDir);
  for (const directory of [
    paths.root,
    paths.agent,
    paths.workspace,
    paths.archive,
    paths.journal,
    paths.snapshots,
    paths.reviews,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(path.join(paths.agent, ".git"))) {
    execFileSync("git", ["init", "--quiet"], { cwd: paths.agent, stdio: "ignore" });
  }
  const workspaceReadme = path.join(paths.workspace, "README.md");
  let currentReadme = "";
  try {
    currentReadme = readFileSync(workspaceReadme, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (currentReadme !== WORKSPACE_README) {
    atomicWrite(workspaceReadme, WORKSPACE_README, 0o444);
    chmodSync(workspaceReadme, 0o444);
  } else if ((statSync(workspaceReadme).mode & 0o777) !== 0o444) {
    chmodSync(workspaceReadme, 0o444);
  }
  const mandate = mandateSource(input.repoDir, input.dataDir);
  const mandateHash = createHash("sha256").update(mandate).digest("hex");
  let session = readChiefOfStaffSession(input.dataDir) ?? {
    sessionId: null,
    createdAt: now.toISOString(),
    mandateHash: "",
    wakes: 0,
    lastWakeAt: null,
    lastWakeReason: null,
  };
  const mandateRewritten = session.mandateHash !== mandateHash || !existsSync(paths.mandate);
  if (mandateRewritten) {
    atomicWrite(paths.mandate, `${mandate}\n`, 0o444);
    chmodSync(paths.mandate, 0o444);
    session = { ...session, mandateHash };
    writeChiefOfStaffSession(input.dataDir, session);
  } else if ((statSync(paths.mandate).mode & 0o777) !== 0o444) {
    chmodSync(paths.mandate, 0o444);
  }
  return { paths, session, mandateRewritten };
}

export function appendChiefOfStaffJournal(input: {
  dataDir: string;
  reason: ChiefOfStaffReason | "reset" | "review";
  lines: string[];
  now?: Date;
  timezone?: string;
  maxCharsPerLine?: number;
  maxTotalCharsPerLine?: number;
}): void {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? operatorTimezone();
  const date = localDateInTimezone(now, timezone);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const file = path.join(chiefOfStaffPaths(input.dataDir).journal, `${date}.md`);
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const maximum = input.maxCharsPerLine ?? 240;
  const prefix = `- ${time} [${input.reason}] `;
  const contentMaximum = input.maxTotalCharsPerLine === undefined
    ? maximum
    : Math.max(0, Math.min(maximum, input.maxTotalCharsPerLine - prefix.length));
  const lines = input.lines.map((line) =>
    `${prefix}${scrubModelText(stripStoredText(line, contentMaximum), contentMaximum)}`
  );
  atomicWrite(file, `${existing}${lines.join("\n")}\n`);
}

export function readChiefOfStaffJournalLines(dataDir: string, limit: number): string[] {
  const directory = chiefOfStaffPaths(dataDir).journal;
  if (!existsSync(directory)) return [];
  const lines = readdirSync(directory)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort()
    .flatMap((name) => readFileSync(path.join(directory, name), "utf8").split("\n"))
    .filter(Boolean);
  return lines.slice(-Math.max(0, limit));
}

export function resetChiefOfStaffSession(input: {
  dataDir: string;
  why?: string;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  const paths = chiefOfStaffPaths(input.dataDir);
  mkdirSync(paths.archive, { recursive: true, mode: 0o700 });
  let archived: string | null = null;
  if (existsSync(paths.session)) {
    const timestamp = now.toISOString().replace(/[:]/g, "-");
    archived = path.join(paths.archive, `session-${timestamp}.json`);
    renameSync(paths.session, archived);
  }
  appendChiefOfStaffJournal({
    dataDir: input.dataDir,
    reason: "reset",
    lines: [`Session reset${input.why?.trim() ? `: ${input.why.trim()}` : "."}`],
    now,
  });
  return archived;
}

function reasonKey(input: {
  reason: ChiefOfStaffReason;
  payload: Record<string, unknown>;
  now: Date;
  timezone: string;
}): string {
  const localDate = localDateInTimezone(input.now, input.timezone);
  if (input.reason === "brief") {
    const date = typeof input.payload.date === "string" ? input.payload.date : localDate;
    return `cos:brief:${date}`;
  }
  if (input.reason === "triage") {
    if (typeof input.payload.receiptId !== "string" || !input.payload.receiptId.trim()) {
      throw new Error("Triage wakes require payload.receiptId.");
    }
    return `cos:triage:${input.payload.receiptId.trim()}`;
  }
  if (input.reason === "meeting") {
    if (typeof input.payload.jobId !== "string" || !input.payload.jobId.trim()) {
      throw new Error("Meeting wakes require payload.jobId.");
    }
    return `cos:meeting:${input.payload.jobId.trim()}`;
  }
  if (input.reason === "nightly") return `cos:nightly:${localDate}`;
  return `cos:manual:${randomUUID()}`;
}

export function enqueueChiefOfStaffWake(
  db: Database.Database,
  input: {
    reason: ChiefOfStaffReason;
    payload?: Record<string, unknown>;
    note?: string;
    now?: Date;
    timezone?: string;
  },
) {
  if (!(CHIEF_OF_STAFF_REASONS as readonly string[]).includes(input.reason)) {
    throw new Error("Chief-of-staff wake reason is invalid.");
  }
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? operatorTimezone();
  const payload = input.payload ?? {};
  const note = input.note?.trim();
  if (note && note.length > 4_000) throw new Error("Wake note exceeds 4000 characters.");
  return enqueueJobInDatabase(db, {
    type: CHIEF_OF_STAFF_JOB_TYPE,
    payload: { reason: input.reason, payload, ...(note ? { note } : {}) },
    idempotencyKey: reasonKey({ reason: input.reason, payload, now, timezone }),
    maxAttempts: 2,
  }, now);
}
