import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Commitment, CommitmentKind } from "../data/types";
import { countSpooledEvents } from "../intake/inbox";
import {
  forgeDataDir,
  loadOperatorProfile,
  operatorName,
  operatorProfilePath,
  operatorTimezone,
  type OperatorProfile,
} from "../operator";
import type { DayPlanStore } from "./store";
import { localDateInTimezone, type BriefSourceInput } from "./brief";
import { buildSettlementSummary, readDumpRelay, readSettlementRelay } from "./brief-relay";
import { contentQuotaGap, followUpsDue, staleOpenItems } from "./gap-detectors";

const EXTERNAL_FETCH_TIMEOUT_MS = 10_000;
// The operator's own zone, not a fixed one: this is the fallback used when
// no caller or env var pinned a timezone, and a wrong fallback silently
// targets the wrong calendar day. Read per call, because the profile that
// supplies it is written during setup, after this module first loads.
const defaultBriefTimezone = () => operatorTimezone();
const COMPOSIO_MCP_URL = "https://connect.composio.dev/mcp";
const ATTIO_PEOPLE_QUERY_URL = "https://api.attio.com/v2/objects/people/records/query";

export type BriefFileSourcePolicyEntry = {
  path: string;
  required: boolean;
  format?: "operator-profile-json";
};

export type BriefFileSourcePolicy = {
  goals: BriefFileSourcePolicyEntry;
  operator_profile: BriefFileSourcePolicyEntry;
  leadup: BriefFileSourcePolicyEntry;
  sprint_memo: BriefFileSourcePolicyEntry;
};

type BriefFileSourcePolicyOptions = {
  dataDir?: string;
  homeDir?: string;
  goalsPath?: string;
  operatorProfilePath?: string;
  leadupPath?: string;
  sprintMemoPath?: string;
};

function nonEmptyEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function legacyBrainPath(homeDir: string, filename: string): string {
  return path.join(homeDir, "Atlas", "brain", filename);
}

export function resolveBriefFileSourcePolicy(
  options: BriefFileSourcePolicyOptions = {},
): BriefFileSourcePolicy {
  const dataDir = forgeDataDir(options.dataDir);
  const homeDir = options.homeDir ?? homedir();
  const legacyGoals = legacyBrainPath(homeDir, "GOALS.md");
  const clientGoals = path.join(dataDir, "brief", "goals.md");
  const legacySprintMemo = legacyBrainPath(homeDir, "path-to-30k-2026-07.md");
  const legacyOperatorProfile = legacyBrainPath(homeDir, "operator-profile.md");
  const legacyLeadup = legacyBrainPath(homeDir, "brief-leadup.md");
  const jsonProfile = operatorProfilePath(dataDir);

  const explicitGoals = options.goalsPath?.trim();
  const envGoals = nonEmptyEnv("FORGE_BRIEF_GOALS_PATH");
  const explicitSprintMemo = options.sprintMemoPath?.trim();
  const envSprintMemo = nonEmptyEnv("FORGE_BRIEF_SPRINT_MEMO_PATH");
  const explicitOperatorProfile = options.operatorProfilePath?.trim();
  const envOperatorProfile = nonEmptyEnv("FORGE_BRIEF_OPERATOR_PROFILE_PATH");
  const explicitLeadup = options.leadupPath?.trim();
  const envLeadup = nonEmptyEnv("FORGE_BRIEF_LEADUP_PATH");

  const operatorPath = explicitOperatorProfile || envOperatorProfile ||
    (existsSync(legacyOperatorProfile) ? legacyOperatorProfile : jsonProfile);

  return {
    goals: {
      path: explicitGoals || envGoals ||
        (existsSync(clientGoals) ? clientGoals : legacyGoals),
      required: true,
    },
    sprint_memo: {
      path: explicitSprintMemo || envSprintMemo || legacySprintMemo,
      required: Boolean(explicitSprintMemo || envSprintMemo),
    },
    operator_profile: {
      path: operatorPath,
      required: false,
      ...(!explicitOperatorProfile && !envOperatorProfile && operatorPath === jsonProfile
        ? { format: "operator-profile-json" as const }
        : {}),
    },
    leadup: {
      path: explicitLeadup || envLeadup || legacyLeadup,
      required: false,
    },
  };
}

export function briefCheckpointSources(
  options: BriefFileSourcePolicyOptions = {},
): Record<string, { path: string; required: boolean }> {
  return Object.fromEntries(
    Object.entries(resolveBriefFileSourcePolicy(options)).map(([id, source]) => [
      id,
      { path: source.path, required: source.required },
    ]),
  );
}

export function defaultSupernovaDir(homeDir = homedir()): string | undefined {
  const configured = nonEmptyEnv("FORGE_SUPERNOVA_DIR");
  if (configured) return configured;
  const candidates = [
    path.join(homeDir, "Atlas", "Projects", "supernova-engine"),
    path.join(homeDir, "Desktop", "Atlas", "Projects", "supernova-engine"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

// Forge installs on port 3200 (see scripts/install-forge-local.sh), so the
// task-snapshot fetch must default there or every installed brief would fail
// with required_source_missing:task_snapshot.
export function defaultBriefWebBase(): string {
  return process.env.FORGE_BRIEF_WEB_BASE ?? "http://127.0.0.1:3200";
}

// Per-source staleness thresholds in hours, each overridable through the
// environment (for example FORGE_BRIEF_STALE_HOURS_GOALS=2160). Past the
// threshold the source is reported "stale" in the manifest, the model is told,
// and the freshness state participates in the input hash.
function staleThresholdHours(id: string, fallback: number): number {
  const override = Number(process.env[`FORGE_BRIEF_STALE_HOURS_${id.toUpperCase()}`]);
  return Number.isFinite(override) && override > 0 ? override : fallback;
}

export type CollectedBriefSources = {
  sources: BriefSourceInput[];
  // Open task ids seen in the snapshot; generation-time validation drops brief
  // candidates that reference anything else.
  knownTaskIds: Set<string>;
};

export type MorningBriefSourceOptions = {
  store: DayPlanStore;
  homeDir?: string;
  goalsPath?: string;
  operatorProfilePath?: string;
  leadupPath?: string;
  sprintMemoPath?: string;
  memoryDecisionsPath?: string;
  targetLocalDate?: string;
  targetTimezone?: string;
  now?: Date;
  // Loopback base URL of the Forge web app; the task snapshot goes through the
  // same forge-rest surface the UI uses, so local and Supabase runtimes both work.
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  // Overrides the relay data directory (defaults to the forge.db directory).
  // Tests point this at a temp dir to exercise the settlement relay fallback.
  dataDir?: string;
};

function readKeyFile(filePath: string): string | null {
  try {
    const resolved = filePath.startsWith("~/")
      ? path.join(homedir(), filePath.slice(2))
      : filePath;
    return readFileSync(resolved, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readEnvLocalVar(name: string): string | null {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return process.env[name]?.trim() || null;
  }
  try {
    const lines = readFileSync(path.join(process.cwd(), ".env.local"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || match[1] !== name) continue;
      let value = match[2].trim();
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
      if (quote) {
        const closingQuote = value.indexOf(quote, 1);
        if (closingQuote > 0) value = value.slice(1, closingQuote);
      } else {
        const inlineComment = value.indexOf(" #");
        if (inlineComment >= 0) value = value.slice(0, inlineComment);
      }
      return value.trim() || null;
    }
  } catch {
    // A missing or unreadable .env.local is the same as an absent variable.
  }
  return null;
}

type TaskRow = {
  id?: string;
  column_id?: string | null;
  title?: string;
  description?: string;
  priority?: string;
  due_at?: string | null;
  status?: string;
  updated_at?: string;
  position?: number;
  tags?: unknown;
};

function taskTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type ColumnRow = { id?: string; name?: string };

const TODAY_ALIASES = new Set(["Must happen today", "Needs to happen today", "Today"]);
const IN_FLIGHT_ALIASES = new Set(["In Flight / Waiting", "In Progress", "Waiting"]);
const NOT_STARTED_ALIASES = new Set(["Not Started", "To Do", "Backlog"]);

function columnBucket(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (TODAY_ALIASES.has(name)) return "today";
  if (IN_FLIGHT_ALIASES.has(name)) return "in_flight";
  if (NOT_STARTED_ALIASES.has(name)) return "not_started";
  return undefined;
}

function fileSource(
  id: string,
  label: string,
  filePath: string,
  options: {
    required: boolean;
    maxChars: number;
    priority: number;
    freshnessThresholdHours?: number;
  },
): BriefSourceInput {
  try {
    const content = readFileSync(filePath, "utf8");
    const asOf = statSync(filePath).mtime.toISOString();
    return { id, label, ...options, content, asOf, note: filePath };
  } catch {
    return { id, label, ...options, note: `unreadable:${filePath}` };
  }
}

// Whitelist for the rendered OPERATOR_PROFILE block. self_emails and
// memory_hub_url are deliberately excluded: they are wiring the runtime reads
// (own-record CRM filter, memory hub address), not context the brief should
// ever quote back at the operator.
const OPERATOR_PROFILE_FIELDS = [
  "name",
  "timezone",
  "workday",
  "responsibilities",
  "ninety_day_outcomes",
  "protected_time",
  "work_sources",
  "jarvis_may_carry",
  "jarvis_must_return",
  "failure_patterns",
  "communication_style",
  "never_drop",
  "key_people",
  "money",
] as const;

function readableLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableProfileValue(value: unknown, indent = ""): string[] {
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed ? [`${indent}${trimmed}`] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [`${indent}${String(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const lines = readableProfileValue(item, `${indent}  `);
      if (lines.length === 0) return [];
      return [
        `${indent}- ${lines[0].trimStart().replace(/^-\s*/, "")}`,
        ...lines.slice(1),
      ];
    });
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, item]) => {
    const lines = readableProfileValue(item, `${indent}  `);
    if (lines.length === 0) return [];
    if (lines.length === 1) {
      return [`${indent}- ${readableLabel(key)}: ${lines[0].trimStart()}`];
    }
    return [`${indent}- ${readableLabel(key)}:`, ...lines];
  });
}

export function renderOperatorProfile(profile: OperatorProfile, maxChars = 6000): string {
  const lines = OPERATOR_PROFILE_FIELDS.flatMap((field) => {
    const valueLines = readableProfileValue(profile[field]);
    if (valueLines.length === 0) return [];
    return valueLines.length === 1 && !Array.isArray(profile[field]) &&
      !asRecord(profile[field])
      ? [`${readableLabel(field)}: ${valueLines[0].trimStart()}`]
      : [`${readableLabel(field)}:`, ...valueLines];
  });
  return lines.join("\n").slice(0, maxChars);
}

function operatorProfileJsonSource(
  sourcePath: string,
  options: {
    required: boolean;
    maxChars: number;
    priority: number;
  },
): BriefSourceInput {
  try {
    const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
    const profile = asRecord(parsed);
    if (!profile) throw new Error("profile_not_object");
    const content = renderOperatorProfile(profile, options.maxChars);
    if (!content) throw new Error("profile_empty");
    const asOf = statSync(sourcePath).mtime.toISOString();
    return {
      id: "operator_profile",
      label: "OPERATOR_PROFILE",
      ...options,
      content,
      asOf,
      note: sourcePath,
    };
  } catch {
    return {
      id: "operator_profile",
      label: "OPERATOR_PROFILE",
      ...options,
      note: `unreadable:${sourcePath}`,
    };
  }
}

function compactLine(value: string | undefined, maximum: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export async function fetchRows(
  fetchImpl: typeof fetch,
  baseUrl: string,
  table: string,
  timeoutMs: number,
  query = "select=*&order=position.asc",
): Promise<unknown[]> {
  const response = await fetchImpl(
    `${baseUrl}/api/forge-rest/${table}?${query}`,
    { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`forge-rest ${table} ${response.status}`);
  const rows = (await response.json()) as unknown;
  if (!Array.isArray(rows)) throw new Error(`forge-rest ${table} shape`);
  return rows;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function errorNote(error: unknown, fallback: string): string {
  const reason = error instanceof Error ? error.message : fallback;
  const bounded = reason.replace(/\s+/g, " ").trim().slice(0, 160);
  return `error:${bounded || fallback}`;
}

function inboundAge(createdAt: unknown, now: Date): string {
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return "unknown";
  const minutes = Math.max(0, Math.floor((now.getTime() - created) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function inboundVerbatim(value: unknown): string {
  if (typeof value !== "string") return "\"\"";
  return JSON.stringify(value.slice(0, 120));
}

async function inboundSource(input: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  dataDir?: string;
  now: Date;
}): Promise<BriefSourceInput> {
  const source = {
    id: "untriaged_inbound",
    label: "UNTRIAGED_INBOUND",
    required: false,
    maxChars: 60_000,
    priority: 0,
  } as const;
  let rows: unknown[] | undefined;
  let fetchWarning: string | undefined;
  try {
    rows = await fetchRows(
      input.fetchImpl,
      input.baseUrl,
      "inbound_events",
      input.timeoutMs,
      "select=source,raw_text,state,created_at" +
        "&state=in.(pending,failed)&order=created_at.asc&limit=50",
    );
  } catch (error) {
    fetchWarning = errorNote(error, "inbound_events_failed").replace(/^error:/, "");
  }
  let spoolCount: number | undefined;
  let spoolWarning: string | undefined;
  try {
    spoolCount = countSpooledEvents(input.dataDir);
  } catch (error) {
    spoolWarning = errorNote(error, "inbound_spool_failed").replace(/^error:/, "");
  }
  const unresolved = (rows ?? [])
    .map(asRecord)
    .filter((row): row is UnknownRecord =>
      Boolean(row && (row.state === "pending" || row.state === "failed"))
    );
  const lines = unresolved.map((row) => {
    const state = row.state === "failed" ? "failed" : "pending";
    const sourceName = typeof row.source === "string" ? row.source : "unknown";
    return `- [${state}] source=${sourceName} age=${inboundAge(row.created_at, input.now)} text=${inboundVerbatim(row.raw_text)}`;
  });
  if (fetchWarning) {
    lines.unshift(`WARNING: inbound inbox unavailable (${fetchWarning}).`);
  } else if (lines.length === 0) {
    lines.push("No pending or failed inbound events.");
  }
  if (spoolWarning) {
    lines.push(`WARNING: inbound spool unavailable (${spoolWarning}).`);
  } else {
    lines.push(`Spool lines waiting: ${spoolCount ?? 0}.`);
  }
  return {
    ...source,
    content: lines.join("\n"),
    asOf: input.now.toISOString(),
    ...(fetchWarning || spoolWarning
      ? { note: `error:${[fetchWarning, spoolWarning].filter(Boolean).join(";")}` }
      : {}),
  };
}

const COMMITMENT_KIND_ORDER: CommitmentKind[] = [
  "follow_up",
  "promise",
  "waiting_on",
  "open_decision",
  "overnight_request",
  "idea",
];

function commitmentRow(value: unknown): Commitment | undefined {
  const row = asRecord(value);
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.kind !== "string" ||
    !COMMITMENT_KIND_ORDER.includes(row.kind as CommitmentKind) ||
    typeof row.title !== "string" ||
    row.status !== "open"
  ) {
    return undefined;
  }
  const optionalString = (candidate: unknown) => typeof candidate === "string" ? candidate : null;
  const confidence = row.confidence === "low" || row.confidence === "medium"
    ? row.confidence
    : "high";
  return {
    id: row.id,
    kind: row.kind as CommitmentKind,
    title: row.title,
    details: optionalString(row.details),
    counterparty: optionalString(row.counterparty),
    contact_id: optionalString(row.contact_id),
    source_kind: ["brain_dump", "manual", "chat", "detector", "brief"].includes(String(row.source_kind))
      ? row.source_kind as Commitment["source_kind"]
      : "manual",
    source_quote: optionalString(row.source_quote),
    source_ref: optionalString(row.source_ref),
    due_at: optionalString(row.due_at),
    review_at: optionalString(row.review_at),
    confidence,
    confirmed: row.confirmed === true || row.confirmed === 1,
    status: "open",
    evidence: optionalString(row.evidence),
    created_at: optionalString(row.created_at) ?? "",
    updated_at: optionalString(row.updated_at) ?? "",
  };
}

function commitmentDate(commitment: Commitment): number {
  const values = [commitment.due_at, commitment.review_at]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  // Undated items still sort behind dated ones, but MAX_SAFE_INTEGER instead of
  // Infinity keeps the subtraction finite so the recency tiebreaker below runs.
  // Infinity - Infinity is NaN, which would silently skip it.
  return values.length > 0 ? Math.min(...values) : Number.MAX_SAFE_INTEGER;
}

// Tiebreaker for items sharing a date, and the only ordering undated items get.
// Everything a brain dump creates lands undated, so without this the newest
// commitments pile up at the end of the section and are exactly what the
// character cap removes first. Newest survives.
function commitmentRecency(commitment: Commitment): number {
  const created = Date.parse(commitment.created_at);
  return Number.isFinite(created) ? created : 0;
}

function commitmentLine(
  commitment: Commitment,
  dueSoonIds: ReadonlySet<string>,
  staleIds: ReadonlySet<string>,
  updatedFromNotesIds: ReadonlySet<string>,
): string {
  const parts = [`- ${compactLine(commitment.title, 120)}`];
  if (commitment.counterparty) parts.push(`counterparty=${compactLine(commitment.counterparty, 80)}`);
  if (commitment.due_at) parts.push(`due=${commitment.due_at}`);
  if (commitment.review_at) parts.push(`review=${commitment.review_at}`);
  if (dueSoonIds.has(commitment.id)) parts.push("due_or_review_by_tomorrow");
  if (staleIds.has(commitment.id)) parts.push("stale_open_over_7d");
  if (commitment.source_quote) parts.push(`source="${compactLine(commitment.source_quote, 180)}"`);
  if (updatedFromNotesIds.has(commitment.id)) parts.push("updated_from_your_notes");
  return parts.join(" | ");
}

function commitmentEvidence(value: string | null | undefined): UnknownRecord | undefined {
  if (!value?.trim()) return undefined;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function recentEvidenceTimestamp(
  evidence: UnknownRecord | undefined,
  key: string,
  nowEpoch: number,
): boolean {
  const timestamp = typeof evidence?.[key] === "string" ? Date.parse(evidence[key]) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp <= nowEpoch && timestamp >= nowEpoch - 36 * 60 * 60 * 1000;
}

async function commitmentsSource(input: {
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  targetLocalDate: string;
  now: Date;
}): Promise<BriefSourceInput> {
  const base: BriefSourceInput = {
    id: "commitments",
    label: "OPEN_COMMITMENTS_AND_GAPS",
    required: false,
    // 4500 fit roughly a dozen items. One evening brain dump can add thirteen
    // at once, and the overflow was silently dropping the newest of them.
    maxChars: 9000,
    priority: 5,
    freshness: "current",
  };
  const [openResult, resolvedResult] = await Promise.allSettled([
    fetchRows(
      input.fetchImpl,
      input.baseUrl,
      "commitments",
      input.timeoutMs,
      "select=*&status=eq.open&order=due_at.asc.nullslast",
    ),
    fetchRows(
      input.fetchImpl,
      input.baseUrl,
      "commitments",
      input.timeoutMs,
      "select=*&status=eq.done&order=updated_at.desc&limit=20",
    ),
  ]);
  if (openResult.status === "rejected" && resolvedResult.status === "rejected") {
    return { ...base, note: errorNote(openResult.reason, "commitments_failed") };
  }
  try {
    const commitments = (openResult.status === "fulfilled" ? openResult.value : [])
      .map(commitmentRow)
      .filter((row): row is Commitment => Boolean(row))
      .sort((left, right) =>
        commitmentDate(left) - commitmentDate(right) ||
        commitmentRecency(right) - commitmentRecency(left) ||
        left.id.localeCompare(right.id));
    const nowEpoch = input.now.getTime();
    const evidenceById = new Map(
      commitments.map((commitment) => [commitment.id, commitmentEvidence(commitment.evidence)]),
    );
    const dueSoonIds = new Set(followUpsDue(commitments, input.targetLocalDate).map((item) => item.id));
    const staleIds = new Set(staleOpenItems(commitments, input.now).map((item) => item.id));
    const updatedFromNotesIds = new Set(
      commitments
        .filter((commitment) => {
          const evidence = evidenceById.get(commitment.id);
          return evidence?.updated_by === "day_dump" &&
            recentEvidenceTimestamp(evidence, "updated_at", nowEpoch);
        })
        .map((commitment) => commitment.id),
    );
    const groups = COMMITMENT_KIND_ORDER.flatMap((kind) => {
      const group = commitments.filter((commitment) => commitment.kind === kind);
      return group.length > 0
        ? [
            `${kind.toUpperCase()}:`,
            ...group.map((item) => commitmentLine(item, dueSoonIds, staleIds, updatedFromNotesIds)),
          ]
        : [];
    });
    const proposedIds = new Set<string>();
    const proposedClarifications = commitments.flatMap((commitment) => {
      const proposal = asRecord(evidenceById.get(commitment.id)?.proposed_resolution);
      if (
        !proposal ||
        (proposal.action !== "done" && proposal.action !== "update") ||
        typeof proposal.quote !== "string" ||
        !proposal.quote.trim()
      ) {
        return [];
      }
      proposedIds.add(commitment.id);
      return [
        `- ${compactLine(commitment.title, 120)}` +
          ` | you said: "${compactLine(proposal.quote, 140)}"` +
          ` | proposed: ${proposal.action === "done" ? "close" : "update"}`,
      ];
    });
    const lowConfidenceClarifications = commitments
      .filter(
        (commitment) =>
          commitment.confidence === "low" &&
          !commitment.confirmed &&
          !proposedIds.has(commitment.id),
      )
      .map((item) => `- ${compactLine(item.title, 120)} | confidence=low | confirmed=false`);
    const clarificationLines = [...lowConfidenceClarifications, ...proposedClarifications];
    const resolvedFromNotes = (resolvedResult.status === "fulfilled" ? resolvedResult.value : [])
      .flatMap((value) => {
        const row = asRecord(value);
        const evidence = commitmentEvidence(typeof row?.evidence === "string" ? row.evidence : null);
        if (
          !row ||
          row.status !== "done" ||
          typeof row.title !== "string" ||
          evidence?.resolved_by !== "day_dump" ||
          typeof evidence.quote !== "string" ||
          !recentEvidenceTimestamp(evidence, "resolved_at", nowEpoch)
        ) {
          return [];
        }
        return [{
          line: `- ${compactLine(row.title, 120)} | you said: "${compactLine(evidence.quote, 140)}"`,
          updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
        }];
      });
    const quotaValue = Number(process.env.FORGE_CONTENT_QUOTA_POSTS);
    const quota = Number.isFinite(quotaValue) && quotaValue >= 0 ? quotaValue : 2;
    const supernovaDir = defaultSupernovaDir();
    const quotaGap = supernovaDir
      ? contentQuotaGap({
          engineDir: supernovaDir,
          targetLocalDate: input.targetLocalDate,
          quota,
        })
      : null;
    const overnight = commitments.filter((commitment) => commitment.kind === "overnight_request");
    const content = [
      "OPEN COMMITMENTS",
      ...(openResult.status === "rejected"
        ? ["Unavailable (fetch failed)."]
        : groups.length > 0
          ? groups
          : ["None."]),
      "",
      "NEEDS CLARIFICATION",
      ...(clarificationLines.length > 0 ? clarificationLines : ["None."]),
      ...(resolvedFromNotes.length > 0
        ? [
            "",
            "RESOLVED FROM YOUR NOTES",
            ...resolvedFromNotes.map((item) => item.line),
          ]
        : []),
      "",
      "CONTENT QUOTA",
      quotaGap
        ? `scheduled=${quotaGap.scheduled} | posted=${quotaGap.posted} | awaiting_approval=${quotaGap.awaitingApproval} | quota=${quotaGap.quota} | gap=${quotaGap.gap}`
        : "Unavailable: Supernova pipeline directories could not be read.",
      "",
      "OVERNIGHT REQUESTS",
      ...(overnight.length > 0
        ? overnight.map((item) => `- ${compactLine(item.title, 120)} | recorded — overnight execution not yet live`)
        : ["None recorded. Overnight execution is not yet live."]),
    ].join("\n");
    const newestUpdate = commitments.reduce(
      (newest, item) => item.updated_at > newest ? item.updated_at : newest,
      resolvedFromNotes.reduce(
        (newest, item) => item.updatedAt > newest ? item.updatedAt : newest,
        "",
      ),
    );
    const notes = [
      openResult.status === "rejected" ? errorNote(openResult.reason, "open_commitments_failed") : undefined,
      resolvedResult.status === "rejected" ? errorNote(resolvedResult.reason, "resolved_commitments_failed") : undefined,
      quotaGap ? undefined : "content_engine_unavailable",
    ].filter((note): note is string => Boolean(note));
    return {
      ...base,
      content,
      asOf: newestUpdate || input.now.toISOString(),
      note: notes.length > 0 ? notes.join(";") : undefined,
    };
  } catch (error) {
    return { ...base, note: errorNote(error, "commitments_failed") };
  }
}

function addCalendarDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("calendar target date invalid");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days, 12));
  return date.toISOString().slice(0, 10);
}

function zonedMidnight(localDate: string, timezone: string): { instant: Date; offset: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("calendar target date invalid");
  const desiredEpoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(desiredEpoch).toISOString().slice(0, 10) !== localDate) {
    throw new Error("calendar target date invalid");
  }
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone: timezone,
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
  const instant = new Date(instantEpoch);
  if (localDateInTimezone(instant, timezone) !== localDate) {
    throw new Error("calendar timezone conversion failed");
  }
  const offsetMinutes = Math.round((desiredEpoch - instantEpoch) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return { instant, offset };
}

function calendarDayBounds(localDate: string, timezone: string): { timeMin: string; timeMax: string } {
  const nextDate = addCalendarDays(localDate, 1);
  const start = zonedMidnight(localDate, timezone);
  const end = zonedMidnight(nextDate, timezone);
  return {
    timeMin: `${localDate}T00:00:00${start.offset}`,
    timeMax: `${nextDate}T00:00:00${end.offset}`,
  };
}

type CalendarEvent = {
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
  hangoutLink?: string;
  conferenceData?: unknown;
};

function calendarTime(value: string, timezone: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "time unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(timestamp))
    .replace(/\s+/g, "")
    .toLowerCase();
}

function formatCalendarEvents(events: readonly CalendarEvent[], timezone: string): string {
  const visible = events
    .filter(
      (event) =>
        !event.attendees?.some(
          (attendee) => attendee.self === true && attendee.responseStatus === "declined",
        ),
    )
    .sort((left, right) => {
      const leftStart = left.start?.dateTime ?? left.start?.date ?? "";
      const rightStart = right.start?.dateTime ?? right.start?.date ?? "";
      return leftStart.localeCompare(rightStart);
    });
  if (visible.length === 0) return "No calendar events today.";
  return visible
    .map((event) => {
      const summary = compactLine(event.summary, 240) || "Untitled event";
      if (event.start?.date && !event.start.dateTime) return `all day — ${summary}`;
      const start = event.start?.dateTime;
      const end = event.end?.dateTime;
      const startTime = start ? calendarTime(start, timezone) : "time unknown";
      const endTime = end ? calendarTime(end, timezone) : undefined;
      const range = startTime === "time unknown"
        ? startTime
        : `${startTime}${endTime && endTime !== "time unknown" ? `-${endTime}` : ""}`;
      const otherAttendees = (event.attendees ?? [])
        .filter((attendee) => !attendee.self && attendee.email)
        .slice(0, 3)
        .map((attendee) => attendee.email as string);
      const people = otherAttendees.length > 0 ? ` (with ${otherAttendees.join(", ")})` : "";
      const meeting = event.hangoutLink || event.conferenceData ? " [Meet]" : "";
      return `${range} — ${summary}${people}${meeting}`;
    })
    .join("\n");
}

function parseCalendarItems(sse: string): CalendarEvent[] {
  const dataLines = sse
    .split(/\r?\n/)
    .map((line) => /^data:\s?(.*)$/.exec(line)?.[1])
    .filter((line): line is string => line !== undefined);
  if (dataLines.length === 0) throw new Error("calendar MCP response missing data");
  const frames = dataLines.map((line) => {
    try {
      return asRecord(JSON.parse(line));
    } catch {
      return undefined;
    }
  });
  const rpc = [...frames]
    .reverse()
    .find((frame) => frame?.id === 2 || (frame && "result" in frame)) ?? frames.at(-1);
  if (!rpc) throw new Error("calendar MCP response invalid");
  const result = asRecord(rpc?.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = asRecord(content[0])?.text;
  if (typeof text !== "string") throw new Error("calendar MCP response missing text");
  const toolPayload = asRecord(JSON.parse(text));
  const data = asRecord(toolPayload?.data);
  const results = Array.isArray(data?.results) ? data.results : [];
  const response = asRecord(asRecord(results[0])?.response);
  const responseData = asRecord(response?.data);
  if (!Array.isArray(responseData?.items)) throw new Error("calendar MCP items missing");
  return responseData.items as CalendarEvent[];
}

async function calendarSource(
  fetchImpl: typeof fetch,
  targetLocalDate: string,
  targetTimezone: string,
  now: Date,
): Promise<BriefSourceInput> {
  const source = {
    id: "calendar",
    label: "CALENDAR_TODAY",
    required: false,
    maxChars: 3000,
    priority: 7,
  } as const;
  const rawKey = process.env.FORGE_BRIEF_COMPOSIO_KEY?.trim();
  const keyPath = process.env.FORGE_BRIEF_COMPOSIO_KEY_PATH?.trim()
    || path.join(homedir(), ".config", "edge-ai", "composio.key");
  const key = rawKey || readKeyFile(keyPath);
  if (!key) return { ...source, note: "not_configured" };
  try {
    const baseHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": key,
    };
    const initialized = await fetchImpl(COMPOSIO_MCP_URL, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "forge-brief", version: "1.0" },
        },
      }),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    const sessionId = initialized.headers.get("mcp-session-id");
    await initialized.text();
    if (!initialized.ok) throw new Error(`calendar initialize ${initialized.status}`);
    if (!sessionId) throw new Error("calendar MCP session missing");
    const bounds = calendarDayBounds(targetLocalDate, targetTimezone);
    const called = await fetchImpl(COMPOSIO_MCP_URL, {
      method: "POST",
      headers: { ...baseHeaders, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "COMPOSIO_MULTI_EXECUTE_TOOL",
          arguments: {
            tools: [
              {
                tool_slug: "GOOGLECALENDAR_EVENTS_LIST",
                arguments: {
                  calendarId: "primary",
                  timeMin: bounds.timeMin,
                  timeMax: bounds.timeMax,
                  singleEvents: true,
                  orderBy: "startTime",
                },
              },
            ],
          },
        },
      }),
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!called.ok) throw new Error(`calendar tools call ${called.status}`);
    return {
      ...source,
      content: formatCalendarEvents(parseCalendarItems(await called.text()), targetTimezone),
      asOf: now.toISOString(),
    };
  } catch (error) {
    return { ...source, note: errorNote(error, "calendar_failed") };
  }
}

function firstAttioValue(record: UnknownRecord, slug: string): UnknownRecord | undefined {
  const values = asRecord(record.values);
  const entries = values?.[slug];
  return Array.isArray(entries) ? asRecord(entries[0]) : undefined;
}

function attioEmailAddresses(record: UnknownRecord): string[] {
  const values = asRecord(record.values);
  const entries = values?.email_addresses;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const direct = asRecord(entry);
      const value = asRecord(direct?.value) ?? direct;
      return typeof value?.email_address === "string"
        ? compactLine(value.email_address, 254)
        : "";
    })
    .filter(Boolean);
}

function attioPersonName(record: UnknownRecord): string | undefined {
  const entry = firstAttioValue(record, "name");
  const value = asRecord(entry?.value) ?? entry;
  const fullName = value?.full_name;
  if (typeof fullName === "string" && fullName.trim()) return compactLine(fullName, 160);
  const firstName = typeof value?.first_name === "string" ? value.first_name.trim() : "";
  const lastName = typeof value?.last_name === "string" ? value.last_name.trim() : "";
  const combinedName = compactLine(`${firstName} ${lastName}`, 160);
  if (combinedName) return combinedName;
  return attioEmailAddresses(record)[0];
}

type AttioInteraction = {
  interactedAt: string;
  interactionType?: string;
};

function attioInteraction(record: UnknownRecord, slug: string): AttioInteraction | undefined {
  const entry = firstAttioValue(record, slug);
  const nested = asRecord(entry?.value);
  const interactedAt = typeof entry?.interacted_at === "string"
    ? entry.interacted_at
    : typeof nested?.interacted_at === "string"
      ? nested.interacted_at
      : undefined;
  if (!interactedAt) return undefined;
  const rawType = typeof entry?.interaction_type === "string"
    ? entry.interaction_type
    : typeof nested?.interaction_type === "string"
      ? nested.interaction_type
      : undefined;
  const interactionType = compactLine(rawType, 80);
  return { interactedAt, ...(interactionType ? { interactionType } : {}) };
}

function attioLastTouch(record: UnknownRecord): AttioInteraction | undefined {
  return (
    attioInteraction(record, "last_email_interaction") ??
    attioInteraction(record, "last_interaction")
  );
}

// The operator's own CRM record is noise in a last-touch list. Which addresses
// are "theirs" is install-specific, so it comes from the profile; with none
// configured we filter nothing rather than guess.
export function operatorSelfEmails(): ReadonlySet<string> {
  const configured = loadOperatorProfile()?.self_emails;
  if (!Array.isArray(configured)) return new Set();
  return new Set(
    configured.flatMap((value) =>
      typeof value === "string" && value.trim() ? [value.trim().toLowerCase()] : []),
  );
}

function formatCrmLastTouches(
  records: readonly unknown[],
  now: Date,
  timezone: string,
  selfEmails: ReadonlySet<string>,
): string {
  const people = records
    .map((value) => {
      const record = asRecord(value);
      if (!record) return undefined;
      const emails = attioEmailAddresses(record);
      if (emails.some((email) => selfEmails.has(email.toLowerCase()))) {
        return undefined;
      }
      const name = attioPersonName(record);
      if (!name) return undefined;
      const interaction = attioLastTouch(record);
      if (!interaction) return undefined;
      const interactedMs = Date.parse(interaction.interactedAt);
      if (!Number.isFinite(interactedMs)) return undefined;
      return {
        name,
        interactedMs,
        date: localDateInTimezone(new Date(interactedMs), timezone),
        ageDays: Math.max(0, Math.floor((now.getTime() - interactedMs) / 86_400_000)),
        interactionType: interaction.interactionType,
      };
    })
    .filter((person): person is NonNullable<typeof person> => person !== undefined)
    .sort((left, right) => right.interactedMs - left.interactedMs);
  if (people.length === 0) return "No interaction history in CRM yet.";
  const recent = people
    .slice(0, 12)
    .map(
      (person) =>
        `${person.name} — last touch ${person.ageDays}d ago (` +
        `${person.date}${person.interactionType ? `, ${person.interactionType}` : ""})`,
    );
  const quiet = people
    .filter((person) => person.ageDays > 14 && person.ageDays <= 120)
    .slice(0, 15)
    .map((person) => person.name);
  return `Recent touches:\n${recent.join("\n")}\n\nGone quiet (>14d): ${quiet.length > 0 ? quiet.join(", ") : "None."}`;
}

async function crmSource(
  fetchImpl: typeof fetch,
  now: Date,
  timezone: string,
): Promise<BriefSourceInput> {
  const source = {
    id: "crm_last_touch",
    label: "CRM_LAST_TOUCH",
    required: false,
    maxChars: 4000,
    priority: 10,
  } as const;
  const key = readEnvLocalVar("ATTIO_API_KEY") ?? readEnvLocalVar("ATTIO_TOKEN");
  if (!key) return { ...source, note: "not_configured" };
  try {
    const response = await fetchImpl(ATTIO_PEOPLE_QUERY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        limit: 250,
        sorts: [{ attribute: "last_interaction", field: "interacted_at", direction: "desc" }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Attio people query ${response.status}`);
    const payload = asRecord(await response.json());
    const firstData = payload?.data;
    const records = Array.isArray(firstData)
      ? firstData
      : Array.isArray(asRecord(firstData)?.data)
        ? (asRecord(firstData)?.data as unknown[])
        : undefined;
    if (!records) throw new Error("Attio people response shape");
    return {
      ...source,
      content: formatCrmLastTouches(records, now, timezone, operatorSelfEmails()),
      asOf: now.toISOString(),
    };
  } catch (error) {
    return { ...source, note: errorNote(error, "crm_failed") };
  }
}

function formatDecisionResults(results: readonly unknown[]): string {
  const contents = results
    .map((result) => asRecord(result)?.content)
    .filter((content): content is string => typeof content === "string" && content.trim().length > 0);
  if (contents.length === 0) return "No recent decisions recorded.";
  const decisions = contents.filter((content) => content.includes("[DECISION]"));
  const selected = decisions.length >= 3 ? decisions : contents;
  return selected
    .map((content) => `- ${content.replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n");
}

// The memory hub is whichever jarvis-memory server this install owns. There is
// deliberately no default address: an install with no hub configured degrades
// to a missing optional source instead of reaching for someone else's machine.
export function memoryHubUrl(): string | undefined {
  const profileUrl = loadOperatorProfile()?.memory_hub_url;
  const configured = nonEmptyEnv("FORGE_BRIEF_JARVIS_URL")
    ?? (typeof profileUrl === "string" && profileUrl.trim() ? profileUrl.trim() : undefined);
  return configured?.replace(/\/$/, "");
}

function memoryQueries(): readonly string[] {
  return [
    "recent decisions, commitments, and direction changes",
    `what ${operatorName()} worked on in Claude sessions the last three days`,
    "current state of Jarvis Pro, Boomer AI (Slipstream community), content engine",
  ];
}

function memoryResultScore(result: unknown): number {
  const score = asRecord(result)?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}

function memoryResultUuid(result: unknown): string | undefined {
  const record = asRecord(result);
  const uuid = record?.uuid ?? record?.memory_uuid;
  return typeof uuid === "string" && uuid.trim() ? uuid : undefined;
}

async function fetchMemoryResults(
  fetchImpl: typeof fetch,
  hubUrl: string,
  token: string,
  query: string,
): Promise<unknown[]> {
  const response = await fetchImpl(`${hubUrl}/api/v2/scored_search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit: 12 }),
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Jarvis scored search ${response.status}`);
  const results = asRecord(await response.json())?.results;
  if (!Array.isArray(results)) throw new Error("Jarvis search response shape");
  return results;
}

async function memoryDecisionsSource(
  fetchImpl: typeof fetch,
  memoryPath: string | undefined,
  now: Date,
): Promise<BriefSourceInput> {
  const sourceOptions = {
    required: false,
    maxChars: 4000,
    priority: 11,
    freshnessThresholdHours: staleThresholdHours("memory_decisions", 24 * 7),
  } as const;
  if (memoryPath) {
    return fileSource("memory_decisions", "RECENT_DECISIONS", memoryPath, sourceOptions);
  }
  const tokenPath = process.env.FORGE_BRIEF_JARVIS_TOKEN_PATH?.trim()
    || path.join(homedir(), ".config", "jarvis-v2", "hub_token");
  const token = readKeyFile(tokenPath);
  const hubUrl = memoryHubUrl();
  if (!token || !hubUrl) {
    return {
      id: "memory_decisions",
      label: "RECENT_DECISIONS",
      ...sourceOptions,
      note: "not_configured",
    };
  }
  try {
    const queries = memoryQueries();
    const batches: unknown[][] = [
      await fetchMemoryResults(fetchImpl, hubUrl, token, queries[0]),
    ];
    for (const query of queries.slice(1)) {
      try {
        batches.push(await fetchMemoryResults(fetchImpl, hubUrl, token, query));
      } catch {
        // The first search preserves the source. Later context lanes are
        // additive and may fail independently without discarding it.
      }
    }
    const byUuid = new Map<string, unknown>();
    let anonymousIndex = 0;
    for (const result of batches.flat()) {
      const uuid = memoryResultUuid(result) ?? `anonymous:${anonymousIndex++}`;
      const existing = byUuid.get(uuid);
      if (!existing || memoryResultScore(result) > memoryResultScore(existing)) {
        byUuid.set(uuid, result);
      }
    }
    const results = [...byUuid.values()]
      .sort((left, right) => memoryResultScore(right) - memoryResultScore(left))
      .slice(0, 12);
    return {
      id: "memory_decisions",
      label: "RECENT_DECISIONS",
      ...sourceOptions,
      content: formatDecisionResults(results),
      asOf: now.toISOString(),
    };
  } catch (error) {
    return {
      id: "memory_decisions",
      label: "RECENT_DECISIONS",
      ...sourceOptions,
      note: errorNote(error, "memory_failed"),
    };
  }
}

// Resolves configured sources, normalizes and bounds each, and reports every
// outcome truthfully in the source list. Optional sources degrade to "missing"
// on any failure; they are never a validity prerequisite.
export async function collectMorningBriefSources(
  options: MorningBriefSourceOptions,
): Promise<CollectedBriefSources> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.webBaseUrl ?? defaultBriefWebBase()).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 8000;
  const now = options.now ?? new Date();
  const targetTimezone = options.targetTimezone ?? process.env.FORGE_BRIEF_TIMEZONE ?? defaultBriefTimezone();
  let targetLocalDate = options.targetLocalDate;
  if (!targetLocalDate) {
    try {
      targetLocalDate = localDateInTimezone(now, targetTimezone);
    } catch {
      // Keep non-calendar sources available even if a direct caller supplies a
      // bad timezone. The calendar helper will report its own scoped error.
      targetLocalDate = localDateInTimezone(now, defaultBriefTimezone());
    }
  }
  const memoryPath = options.memoryDecisionsPath ?? process.env.FORGE_BRIEF_MEMORY_PATH;
  const filePolicy = resolveBriefFileSourcePolicy({
    dataDir: options.dataDir,
    homeDir: options.homeDir,
    goalsPath: options.goalsPath,
    operatorProfilePath: options.operatorProfilePath,
    leadupPath: options.leadupPath,
    sprintMemoPath: options.sprintMemoPath,
  });
  const operatorProfileSourceOptions = {
    required: filePolicy.operator_profile.required,
    maxChars: 6000,
    priority: 2,
  };
  const operatorProfileSource = filePolicy.operator_profile.format === "operator-profile-json"
    ? operatorProfileJsonSource(
        filePolicy.operator_profile.path,
        operatorProfileSourceOptions,
      )
    : fileSource(
        "operator_profile",
        "OPERATOR_PROFILE",
        filePolicy.operator_profile.path,
        operatorProfileSourceOptions,
      );

  // Start independent external reads together. Each helper catches its own
  // failures so an optional integration can never reject the full collection.
  const calendarPromise = calendarSource(fetchImpl, targetLocalDate, targetTimezone, now);
  const crmPromise = crmSource(fetchImpl, now, targetTimezone);
  const memoryPromise = memoryDecisionsSource(fetchImpl, memoryPath, now);
  const commitmentsPromise = commitmentsSource({
    fetchImpl,
    baseUrl,
    timeoutMs,
    targetLocalDate,
    now,
  });
  const inboundPromise = inboundSource({
    fetchImpl,
    baseUrl,
    timeoutMs,
    dataDir: options.dataDir,
    now,
  });

  // Last night's brain dump, in Alex's own words, and the first thing the brief
  // reads. Priority 0 because it is the only source that can be hours old:
  // GOALS and the sprint memo are written by hand and go stale between edits,
  // so when he changes direction at night the dump is the only place the brief
  // can learn it. Local store first, then the relay, same as settlements, since
  // dumps are typed on the MBP and the 7:30 brief runs on the Mini. Extraction
  // already reached the commitment ledger; what this adds is the reasoning
  // around it, which no extraction preserves.
  let dumpContent: string | undefined;
  let dumpAsOf: string | undefined;
  try {
    const succeeded = options.store
      .listDayDumps()
      .filter((dump) => dump.status === "succeeded" && dump.rawText.trim());
    const newest = succeeded[succeeded.length - 1];
    if (newest) {
      dumpContent = newest.rawText.trim();
      dumpAsOf = newest.createdAt;
    }
  } catch {
    // Fall through to the relay.
  }
  const relayDump = readDumpRelay({ dataDir: options.dataDir, now });
  if (relayDump) {
    const relayMs = Date.parse(relayDump.asOf);
    const localMs = dumpContent && dumpAsOf ? Date.parse(dumpAsOf) : NaN;
    if (!dumpContent || !Number.isFinite(localMs) || relayMs > localMs) {
      dumpContent = relayDump.content;
      dumpAsOf = relayDump.asOf;
    }
  }

  const sources: BriefSourceInput[] = [
    dumpContent
      ? {
          id: "day_dump",
          label: "LAST_NIGHT_BRAIN_DUMP",
          required: false,
          maxChars: 12_000,
          priority: 0,
          content: dumpContent,
          asOf: dumpAsOf,
          // A dump two nights old is still the freshest statement of direction
          // he has made; older than that and it describes a finished week.
          freshnessThresholdHours: staleThresholdHours("day_dump", 60),
        }
      : {
          id: "day_dump",
          label: "LAST_NIGHT_BRAIN_DUMP",
          required: false,
          maxChars: 12_000,
          priority: 0,
          note: "day_dump_unavailable",
        },
    await inboundPromise,
    fileSource("goals", "GOALS", filePolicy.goals.path, {
      required: filePolicy.goals.required,
      maxChars: 9000,
      priority: 1,
      // Goals change rarely; a month untouched is worth flagging.
      freshnessThresholdHours: staleThresholdHours("goals", 24 * 30),
    }),
    operatorProfileSource,
    fileSource(
      "leadup",
      "LEADUP",
      filePolicy.leadup.path,
      {
        required: filePolicy.leadup.required,
        maxChars: 9000,
        priority: 3,
      },
    ),
    fileSource(
      "sprint_memo",
      "SPRINT_MEMO",
      filePolicy.sprint_memo.path,
      {
        required: filePolicy.sprint_memo.required,
        maxChars: 12_000,
        priority: 4,
        // The sprint memo should move weekly.
        freshnessThresholdHours: staleThresholdHours("sprint_memo", 24 * 7),
      },
    ),
  ];

  const knownTaskIds = new Set<string>();
  let emailBrief: BriefSourceInput = {
    id: "email_brief",
    label: "EMAIL_BRIEF",
    required: false,
    maxChars: 3000,
    priority: 9,
    // Email triage runs twice a day; older than a day is stale.
    freshnessThresholdHours: staleThresholdHours("email_brief", 24),
  };
  sources.push(await commitmentsPromise);
  try {
    const [taskRows, columnRows] = await Promise.all([
      fetchRows(fetchImpl, baseUrl, "tasks", timeoutMs),
      fetchRows(fetchImpl, baseUrl, "task_columns", timeoutMs),
    ]);
    const columns = new Map(
      (columnRows as ColumnRow[]).map((column) => [column.id, column.name]),
    );
    const lines: string[] = [];
    let newestUpdate = "";
    for (const row of taskRows as TaskRow[]) {
      if (!row.id || row.status !== "open") continue;
      const bucket = columnBucket(columns.get(row.column_id ?? undefined));
      if (!bucket) continue;
      const title = compactLine(row.title, 160);
      const tags = taskTags(row.tags).map((tag) => tag.trim().toLowerCase());
      // Candidate eligibility mirrors the arrival pool exactly (Today and
      // In-Flight commitments, excluding Jarvis-held work and the running email
      // digest card). Everything else is context the model can see but must not
      // rank, so a valid brief candidate always rehydrates at ensure time.
      const candidateEligible =
        (bucket === "today" || bucket === "in_flight") &&
        !tags.includes("jarvis-held") &&
        !title.startsWith("Emails:");
      if (candidateEligible) knownTaskIds.add(row.id);
      if (row.updated_at && row.updated_at > newestUpdate) newestUpdate = row.updated_at;
      lines.push(
        `- [${bucket}] id=${row.id} "${title}"` +
          ` priority=${row.priority ?? "medium"}` +
          (candidateEligible ? " candidate_ok" : "") +
          (row.due_at ? ` due=${row.due_at}` : "") +
          (row.updated_at ? ` updated=${row.updated_at}` : "") +
          (row.description ? ` :: ${compactLine(row.description, 240)}` : ""),
      );
      if (title.startsWith("Emails:")) {
        emailBrief = {
          ...emailBrief,
          content: `${title}\n${compactLine(row.description, 2400)}`,
          asOf: row.updated_at,
        };
      }
    }
    sources.push({
      id: "task_snapshot",
      label: "OPEN_TASKS",
      required: true,
      maxChars: 14_000,
      priority: 6,
      content: lines.length > 0 ? lines.join("\n") : "The task board has no open Today, In-Flight, or Not Started work.",
      asOf: newestUpdate || undefined,
      // A board untouched for three days is a signal worth surfacing.
      freshnessThresholdHours: staleThresholdHours("task_snapshot", 72),
    });
  } catch (error) {
    sources.push({
      id: "task_snapshot",
      label: "OPEN_TASKS",
      required: true,
      maxChars: 14_000,
      priority: 6,
      note: error instanceof Error ? error.message.slice(0, 200) : "task_snapshot_failed",
    });
  }

  sources.push(await calendarPromise);

  // Settlement summary: the local store is authoritative when it holds
  // snapshots. An empty local state (the Mini, whose DB no longer syncs) is
  // never treated as "no settlements"; it falls back to the relay file the MBP
  // publishes, whose as_of drives the same staleness threshold. Newest valid
  // source wins; if neither is available the source records missing.
  const settlementThreshold = staleThresholdHours("settlement_summary", 96);
  let settlementContent: string | undefined;
  let settlementAsOf: string | undefined;
  try {
    const snapshots = options.store.listRecentSnapshots(7);
    if (snapshots.length > 0) {
      const summary = buildSettlementSummary(snapshots);
      settlementContent = summary.content;
      settlementAsOf = summary.asOf;
    }
  } catch {
    // Fall through to the relay fallback below.
  }
  const relaySettlement = readSettlementRelay({ dataDir: options.dataDir });
  if (relaySettlement) {
    // Newest valid wins, compared as parsed epochs (never as strings): prefer
    // whichever source has the later as_of; an unparseable local as_of loses.
    const relayMs = Date.parse(relaySettlement.asOf);
    const localMs = settlementContent && settlementAsOf ? Date.parse(settlementAsOf) : NaN;
    if (!settlementContent || !Number.isFinite(localMs) || relayMs > localMs) {
      settlementContent = relaySettlement.content;
      settlementAsOf = relaySettlement.asOf;
    }
  }
  sources.push(
    settlementContent
      ? {
          id: "settlement_summary",
          label: "RECENT_SETTLEMENTS",
          required: true,
          maxChars: 6000,
          priority: 8,
          content: settlementContent,
          asOf: settlementAsOf,
          freshnessThresholdHours: settlementThreshold,
        }
      : {
          id: "settlement_summary",
          label: "RECENT_SETTLEMENTS",
          required: true,
          maxChars: 6000,
          priority: 8,
          note: "settlement_summary_unavailable",
        },
  );

  sources.push(emailBrief);
  sources.push(await crmPromise);
  sources.push(await memoryPromise);

  return { sources, knownTaskIds };
}
