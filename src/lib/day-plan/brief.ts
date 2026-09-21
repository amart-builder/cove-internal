import { readStoredDailyDecision } from "../chief-of-staff/daily-planning";
/**
 * Morning Brief artifact contract and deterministic validation.
 *
 * This module defines what a model may propose, how the exact evidence envelope
 * is hashed, which artifacts are eligible, and how private content becomes a
 * bounded public read model. Artifacts are immutable. Version changes are the
 * explicit migration boundary for prompt or schema behavior.
 */
import { createHash } from "node:crypto";
import { resolveClaudeModel } from "../claude-execution/commands";
import type {
  DayPlanItemBriefAnnotation,
  DayPlanOwner,
  DayPlanReconciliation,
  RecommendationCandidate,
} from "./types";

// Version stamps participate in the composite input hash so a prompt or contract
// change regenerates the brief even when the underlying sources are unchanged.
// v6: computed open commitments, clarification needs, and deterministic gap
// detectors are available to the chief-of-staff writer.
// v7: day-dump commitment resolutions and updates are visible to the writer.
// v8: settlement progress, explicit next steps, and carried streaks guide continuity.
// v9: headline plus real paragraphs, and the label tics ("Quick re-anchor:") the
//     v8 worked example was teaching the model to write are gone.
// 14: five-weekday lookback (recent_dumps, recent_briefs) plus the stale-dump
// guardrail in the chief-of-staff mandate.
// 15 / schema 4: whole-board priority selection plus staged chief-of-staff
// board management actions that activate at Morning Arrival.
// 16 / schema 5: remove the retired outreach section from generation and
// public brief projections while tolerating it as ignored legacy data.
// 17 / schema 6: rank up to eight existing tasks, with the first three as focus.
// 18 / schema 7: a grounded concrete recommendation may create a real Today task.
// 20: restore full narrative alongside the shared planning decision.
// 22: explicit machine-readable review timestamps and evidence-bounded availability.
// 24: preserve undecided terms and bound both positive and negative monitoring claims.
// 25: deterministic local dates and freshness precedence for saved calendar answers.
// Version 27 selects frozen sources by key and renders check times from saved values.
export const MORNING_BRIEF_PROMPT_VERSION = 28;
export const MORNING_BRIEF_SCHEMA_VERSION = 8;

export type MorningBriefStatus = "queued" | "running" | "succeeded" | "failed";

export type MorningBriefTaskCandidate = {
  taskId: string;
  whyToday: string;
  suggestedOwner: DayPlanOwner;
  whatClaudeCanStart: string;
  evidenceRefs: string[];
};

export type MorningBriefWatchItem = {
  recordId?: string;
  label: string;
  evidence: string;
  lastSeenState: string;
  evidenceRefs: string[];
};

type MorningBriefBoardActionBase = {
  why: string;
  evidenceRefs: string[];
};

type MorningBriefExistingTaskActionBase = MorningBriefBoardActionBase & {
  taskId: string;
  expectedTaskUpdatedAt: string;
};

export type MorningBriefBoardAction =
  | (MorningBriefExistingTaskActionBase & (
      | { op: "move_column"; column: "today" | "in_flight" | "not_started" }
      | { op: "set_priority"; priority: "high" | "medium" | "low" }
      | { op: "set_due"; dueLocalDate: string | null }
      | { op: "retitle"; title: string }
      | { op: "edit_description"; description: string }
      | { op: "archive" }
      | { op: "archive_duplicate"; duplicateOfTaskId: string }
    ))
  | (MorningBriefBoardActionBase & {
      op: "create_task";
      title: string;
      description: string;
      priority: "high" | "medium" | "low";
      dueLocalDate: string | null;
    });

export type MorningBrief = {
  dailyDecision?: import("../chief-of-staff/daily-planning").DailyDecision;
  // The day's single decisive move, as one plain sentence. Optional because
  // artifacts written before schema 3 have only the flat narrative.
  headline?: string;
  // The body, already broken where the writer meant it to break. The UI renders
  // one paragraph per entry; a single 1,600-character string rendered into one
  // <p> was the entire reason the brief read as a wall.
  narrativeParagraphs: string[];
  // Derived from headline + paragraphs, kept because exports, the date guard,
  // and the deterministic fallback all speak in one flat string.
  lensNarrative: string;
  existingTaskCandidates: MorningBriefTaskCandidate[];
  watchItems: MorningBriefWatchItem[];
  boardActions: MorningBriefBoardAction[];
  // Cove-added record of items dropped during validation (for example a watch
  // item whose evidence refs cite no collected source). Never model-authored.
  validationNotes?: string[];
};

export function morningBriefCreatedTaskId(artifactId: string, actionIndex: number): string {
  const digest = createHash("sha256")
    .update(`${artifactId}:${actionIndex}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `morning-brief-${digest}`;
}

export type BriefSourceFreshness = "current" | "stale" | "missing";

export type BriefSourceReport = {
  id: string;
  required: boolean;
  freshness: BriefSourceFreshness;
  asOf?: string;
  hash?: string;
  chars: number;
  trimmed: boolean;
  note?: string;
};

export type MorningBriefSourceManifest = {
  sources: BriefSourceReport[];
  // Coverage names what the brief could and could not see. Live integrations
  // remain missing until their collected source supplies content.
  coverage: Record<string, "included" | "stale" | "missing">;
  trims: string[];
  totalChars: number;
};

export type MorningBriefArtifact = {
  id: string;
  targetLocalDate: string;
  status: MorningBriefStatus;
  inputHash?: string;
  promptVersion: number;
  schemaVersion: number;
  sourceManifest?: MorningBriefSourceManifest;
  modelAlias: string;
  effort: string;
  budgetUsd: number;
  writer?: "codex" | "claude";
  briefJson?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  boardActionsPending?: boolean;
};

export function morningBriefWriterFromJson(
  briefJson: string | undefined,
): "codex" | "claude" | undefined {
  if (!briefJson) return undefined;
  try {
    const writer = (JSON.parse(briefJson) as { writer?: unknown }).writer;
    return writer === "codex" || writer === "claude" ? writer : undefined;
  } catch {
    return undefined;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Context assembly (pure): bounding, manifest, coverage, composite input hash.
// ---------------------------------------------------------------------------

export type BriefSourceInput = {
  id: string;
  label: string;
  required: boolean;
  // Per-source character cap applied before the total cap.
  maxChars: number;
  // A plain prefix trim can erase structurally critical tail sections, so a
  // source may choose how its per-source cap is applied.
  contentTrimmer?: (content: string, maxChars: number) => string;
  // Lower number = more important. Total-cap trimming removes content from the
  // least important sources first.
  priority: number;
  content?: string;
  asOf?: string;
  freshness?: "current" | "stale";
  // A readable source older than this many hours (by asOf) is reported stale.
  // Absent threshold or asOf means the source cannot go stale by age.
  freshnessThresholdHours?: number;
  note?: string;
};

export type AssembledBriefContext = {
  sections: Array<{ id: string; label: string; text: string }>;
  manifest: MorningBriefSourceManifest;
  missingRequired: string[];
  trimmedRequired: string[];
};

// Raised from 48k when the brain dump became a source. At 48k the budget sat
// exactly full and the dump displaced the tail of memory_decisions, which is
// the failure this whole change exists to stop.
//
// Raised again from 60k when the five-weekday lookback (recent_dumps,
// recent_briefs) landed: the 2026-07-29 brief already spent 58,469 of 60,000, so
// the new sources would have paid for themselves by silently trimming the tail
// off email_brief and settlement_summary. ~23k input tokens, still a rounding
// error against the $1.50 brief budget.
export const MORNING_BRIEF_TOTAL_MAX_CHARS = 90_000;

// Everything that shapes the generated brief participates in the input hash:
// the exact bounded sections as sent to the selected writer (not the untrimmed source
// bytes), the target date and timezone, both contract versions, the model
// configuration, and each source's freshness state. Two runs with the same hash
// would produce an equivalent artifact, so the second is skipped as a duplicate.
export type MorningBriefGenerationEnvelope = {
  targetLocalDate: string;
  targetTimezone: string;
  sections: ReadonlyArray<{ id: string; label: string; text: string }>;
  sourceFreshness: ReadonlyArray<{ id: string; freshness: BriefSourceFreshness;
  }>;
  promptVersion: number;
  schemaVersion: number;
  modelAlias: string;
  effort: string;
  budgetUsd: number;
  writer?: "codex" | "claude";
  // The exact chief-of-staff mandate is not stored in the artifact, but its
  // bytes participate in the hash so an instruction edit always regenerates.
  mandate?: string;
};

export function morningBriefInputHash(
  envelope: MorningBriefGenerationEnvelope,
): string {
  const canonical = JSON.stringify({
    versions: [envelope.promptVersion, envelope.schemaVersion],
    target: [envelope.targetLocalDate, envelope.targetTimezone],
    model: [
      envelope.writer ?? "claude",
      // The resolved model, not the alias. "opus" meant claude-opus-4-8 and
      // now means claude-opus-5; hashing the alias would leave yesterday's
      // artifact eligible and he would keep reading a brief the old model
      // wrote while thinking he had switched.
      resolveClaudeModel(envelope.modelAlias),
      envelope.effort,
      envelope.budgetUsd,
    ],
    mandate: envelope.mandate ?? "",
    freshness: [...envelope.sourceFreshness]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => `${entry.id}=${entry.freshness}`),
    sections: [...envelope.sections]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({ id: entry.id, text: entry.text })),
  });
  return sha256(canonical);
}

export function morningBriefTargetDateLabel(
  targetLocalDate: string,
  targetTimezone: string,
): string {
  // targetLocalDate is already the calendar date in targetTimezone. Format the
  // calendar value in UTC so converting it to an instant cannot shift the day.
  new Intl.DateTimeFormat("en-US", { timeZone: targetTimezone }).format(new Date(0));
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetLocalDate);
  if (!match) throw new Error("brief_target_date_invalid");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== targetLocalDate) {
    throw new Error("brief_target_date_invalid");
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

// The brief must never assert the wrong day, but it should not announce the
// right one either: the arrival screen prints the date above the headline, so a
// narrative opening with "Today is Friday, July 24, 2026." spends its first
// sentence telling him something already on screen. This strips any leading
// date claim and reports whether the one it removed disagreed with the target,
// which is the signal the callers actually log.
export function normalizeMorningBriefNarrativeDate(
  narrative: string,
  targetLocalDate: string,
  targetTimezone: string,
): { narrative: string; contradicted: boolean } {
  const expectedLabel = morningBriefTargetDateLabel(targetLocalDate, targetTimezone);
  const trimmed = narrative.trim();
  const assertedOpening = /^Today is\b([^.!?]*)(?:[.!?]|$)\s*/i.exec(trimmed);
  if (!assertedOpening) return { narrative: trimmed, contradicted: false };
  const asserted = (assertedOpening[1] ?? "").trim();
  return {
    narrative: trimmed.slice(assertedOpening[0].length).trimStart(),
    contradicted: asserted.toLocaleLowerCase() !== expectedLabel.toLocaleLowerCase(),
  };
}

// Applies the date guard to every surface the writer could have opened with,
// then rebuilds the flat narrative from the cleaned parts so the stored artifact
// and the rendered one can never disagree.
export function stripMorningBriefDateClaim(
  brief: MorningBrief,
  targetLocalDate: string,
  targetTimezone: string,
): { brief: MorningBrief; contradicted: boolean } {
  const headlinePass = brief.headline
    ? normalizeMorningBriefNarrativeDate(brief.headline, targetLocalDate, targetTimezone)
    : undefined;
  const paragraphs = [...brief.narrativeParagraphs];
  let paragraphContradicted = false;
  // First paragraph only. "Today is the day it ships" further down is prose,
  // not an opener, and rewriting it would be vandalism.
  if (paragraphs.length > 0) {
    const pass = normalizeMorningBriefNarrativeDate(
      paragraphs[0] ?? "",
      targetLocalDate,
      targetTimezone,
    );
    paragraphContradicted = pass.contradicted;
    paragraphs[0] = pass.narrative;
  }
  const headline = headlinePass ? headlinePass.narrative : brief.headline;
  const narrativeParagraphs = paragraphs.filter(Boolean);
  const next: MorningBrief = {
    ...brief,
    narrativeParagraphs,
    lensNarrative: [headline, ...narrativeParagraphs].filter(Boolean).join("\n\n"),
    ...(brief.dailyDecision?.narrativeParagraphs ? {
      dailyDecision: { ...brief.dailyDecision, narrativeParagraphs },
    } : {}),
  };
  // A headline that was nothing but a date claim is now empty, and spreading
  // brief would otherwise quietly keep the original.
  if (headline) next.headline = headline;
  else delete next.headline;
  return {
    brief: next,
    contradicted: Boolean(headlinePass?.contradicted) || paragraphContradicted,
  };
}

function sourceFreshnessState(
  source: BriefSourceInput,
  present: boolean,
  now: Date | undefined,
): BriefSourceFreshness {
  if (!present) return "missing";
  if (source.freshness) return source.freshness;
  if (source.asOf && source.freshnessThresholdHours !== undefined && now) {
    const ageMs = now.getTime() - new Date(source.asOf).getTime();
    if (
      Number.isFinite(ageMs) &&
      ageMs > source.freshnessThresholdHours * 60 * 60 * 1000
    ) {
      return "stale";
    }
  }
  return "current";
}

export function assembleMorningBriefContext(
  sources: readonly BriefSourceInput[],
  options: {
    totalMaxChars?: number;
    now?: Date;
  } = {},
): AssembledBriefContext {
  const totalMaxChars = options.totalMaxChars ?? MORNING_BRIEF_TOTAL_MAX_CHARS;
  const trims: string[] = [];
  const prepared = sources.map((source) => {
    const raw = source.content?.trim();
    let text = raw ?? "";
    let trimmed = false;
    if (text.length > source.maxChars) {
      text = source.contentTrimmer
        ? source.contentTrimmer(text, source.maxChars)
        : text.slice(0, source.maxChars);
      if (text.length > source.maxChars) {
        throw new Error(`brief_source_trimmer_exceeded_cap:${source.id}`);
      }
      trimmed = true;
      trims.push(`${source.id}:source_cap`);
    }
    return { source, text, present: Boolean(raw), trimmed };
  });

  // Enforce the total budget by trimming the least important sources first.
  let total = prepared.reduce((sum, entry) => sum + entry.text.length, 0);
  if (total > totalMaxChars) {
    const byLeastImportant = [...prepared].sort(
      (left, right) => right.source.priority - left.source.priority,
    );
    for (const entry of byLeastImportant) {
      if (total <= totalMaxChars) break;
      const excess = total - totalMaxChars;
      const keep = Math.max(0, entry.text.length - excess);
      if (keep === entry.text.length) continue;
      const previousLength = entry.text.length;
      // keep === 0 means trimmed out entirely; a content trimmer given a zero
      // budget would throw instead of vanishing, so bypass it.
      entry.text = keep === 0
        ? ""
        : entry.source.contentTrimmer
          ? entry.source.contentTrimmer(entry.text, keep)
          : entry.text.slice(0, keep);
      if (entry.text.length > keep) {
        throw new Error(`brief_source_trimmer_exceeded_cap:${entry.source.id}`);
      }
      // A source-aware trimmer may preserve less than its target. Account for
      // what it actually returned so later sources receive the correct budget.
      total -= previousLength - entry.text.length;
      entry.trimmed = true;
      trims.push(keep === 0 ? `${entry.source.id}:trimmed_out` : `${entry.source.id}:total_cap`);
    }
  }

  const reports: BriefSourceReport[] = prepared.map((entry) => ({
    id: entry.source.id,
    required: entry.source.required,
    freshness: sourceFreshnessState(entry.source, entry.present, options.now),
    asOf: entry.source.asOf,
    // Provenance hash of the bounded text exactly as it ships in the prompt.
    hash: entry.present ? sha256(entry.text) : undefined,
    chars: entry.text.length,
    trimmed: entry.trimmed,
    note: entry.source.note,
  }));

  const coverage: MorningBriefSourceManifest["coverage"] = {
    // Keep unavailable live integrations explicit even when a caller omits
    // their source rows entirely.
    calendar: "missing",
    crm_last_touch: "missing",
  };
  for (const report of reports) {
    // A source whose text was entirely trimmed out by the total cap shipped
    // zero bytes: from the model's perspective it is missing, and coverage
    // must say so (chars/trimmed in the report tell the operator story).
    coverage[report.id] = report.freshness === "missing" || report.chars === 0
      ? "missing"
      : report.freshness === "stale"
        ? "stale"
        : "included";
  }

  return {
    sections: prepared
      .filter((entry) => entry.text.length > 0)
      .map((entry) => ({
        id: entry.source.id,
        label: entry.source.label,
        text: entry.text,
      })),
    manifest: {
      sources: reports,
      coverage,
      trims,
      totalChars: total,
    },
    // Keyed on the final text, not on `present`. `present` records whether the
    // source arrived, which is decided before the budget pass runs; a required
    // source that arrived and then got trimmed to nothing would drop out of
    // `sections` while still reporting itself as satisfied. Empty is missing,
    // whatever emptied it.
    missingRequired: prepared
      .filter((entry) => entry.source.required && entry.text.length === 0)
      .map((entry) => entry.source.id),
    trimmedRequired: prepared
      .filter((entry) => entry.source.required && entry.present && entry.trimmed)
      .map((entry) => entry.source.id),
  };
}

// ---------------------------------------------------------------------------
// Output contract validation (pure, strict).
// ---------------------------------------------------------------------------

const OWNER_VALUES = new Set<DayPlanOwner>(["me", "claude", "together"]);

class MorningBriefInvalid extends Error {
  constructor(detail: string) {
    super(`brief_invalid:${detail}`);
    this.name = "MorningBriefInvalid";
  }
}

function briefString(
  value: unknown,
  name: string,
  maximum: number,
  options: { required?: boolean } = { required: true },
): string {
  if (typeof value !== "string" || !value.trim()) {
    const emptyish =
      value === undefined || value === null || (typeof value === "string" && !value.trim());
    if (options.required === false && emptyish) return "";
    throw new MorningBriefInvalid(`${name}_required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) throw new MorningBriefInvalid(`${name}_too_long`);
  return trimmed;
}

function briefOwner(value: unknown, name: string): DayPlanOwner {
  if (typeof value !== "string" || !OWNER_VALUES.has(value as DayPlanOwner)) {
    throw new MorningBriefInvalid(`${name}_owner`);
  }
  return value as DayPlanOwner;
}

function briefStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new MorningBriefInvalid(`${name}_bounds`);
  }
  return value.map((entry, index) =>
    briefString(entry, `${name}_${index}`, maxLength),
  );
}

// The one place that decides where a flat narrative breaks. Blank-line splitting
// only: a single newline inside a paragraph is the writer wrapping a line, not
// starting a new thought.
export function splitNarrativeParagraphs(narrative: string): string[] {
  return narrative
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function briefArray(value: unknown, name: string, maxItems: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new MorningBriefInvalid(`${name}_bounds`);
  }
  return value;
}

export type MorningBriefValidation = {
  brief: MorningBrief;
  warnings: string[];
};

// Bounded grounding for watch items: every evidence ref must
// name a collected source ("goals", "sprint_memo:gio", ...). This is not the
// full per-fact evidence registry (explicitly deferred); it only guarantees
// each surviving item cites something Cove actually showed the model.
function evidenceRefsResolve(
  refs: readonly string[],
  sourceIds: ReadonlySet<string> | undefined,
): boolean {
  if (refs.length === 0) return false;
  if (!sourceIds) return true;
  return refs.every((ref) => sourceIds.has(ref.split(":", 1)[0] ?? ref));
}

function creationEvidenceIsActionable(
  refs: readonly string[],
  sourceIds: ReadonlySet<string> | undefined,
): boolean {
  if (!evidenceRefsResolve(refs, sourceIds)) return false;
  const planningOnlySources = new Set(["goals", "operator_profile", "recent_briefs"]);
  return refs.some((ref) => !planningOnlySources.has(ref.split(":", 1)[0] ?? ref));
}

const CREATED_TASK_ACTION_VERBS = new Set([
  "add",
  "analyze",
  "approve",
  "ask",
  "audit",
  "book",
  "build",
  "buy",
  "call",
  "cancel",
  "check",
  "clean",
  "compare",
  "complete",
  "confirm",
  "connect",
  "contact",
  "create",
  "decide",
  "deliver",
  "deploy",
  "design",
  "draft",
  "edit",
  "email",
  "evaluate",
  "file",
  "finish",
  "fix",
  "follow",
  "implement",
  "install",
  "investigate",
  "meet",
  "message",
  "nudge",
  "order",
  "organize",
  "outline",
  "pay",
  "plan",
  "prepare",
  "publish",
  "read",
  "reconcile",
  "record",
  "remove",
  "renew",
  "reply",
  "research",
  "review",
  "revise",
  "run",
  "schedule",
  "send",
  "set",
  "share",
  "sign",
  "submit",
  "summarize",
  "test",
  "update",
  "verify",
  "write",
]);

const CREATED_TASK_GENERIC_WORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "anybody",
  "anyone",
  "anything",
  "at",
  "else",
  "everybody",
  "everyone",
  "everything",
  "for",
  "in",
  "it",
  "item",
  "items",
  "material",
  "materials",
  "misc",
  "nobody",
  "noone",
  "nothing",
  "of",
  "on",
  "or",
  "other",
  "others",
  "some",
  "somebody",
  "someone",
  "something",
  "stuff",
  "task",
  "tasks",
  "that",
  "the",
  "them",
  "thing",
  "things",
  "this",
  "to",
  "todo",
  "unspecified",
  "up",
  "various",
  "whatever",
  "whichever",
  "whoever",
  "with",
  "work",
]);

function createdTaskWords(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

function createdTaskTitleIsConcrete(title: string): boolean {
  const words = createdTaskWords(title);
  if (title.trim().length < 8 || words.length < 2) return false;
  if (!CREATED_TASK_ACTION_VERBS.has(words[0] ?? "")) return false;
  return words.slice(1).some((word) => !CREATED_TASK_GENERIC_WORDS.has(word));
}

function createdTaskDescriptionIsUseful(description: string): boolean {
  const words = createdTaskWords(description);
  if (description.trim().length < 20 || words.length < 5) return false;
  return words.some(
    (word) =>
      !CREATED_TASK_GENERIC_WORDS.has(word) &&
      !CREATED_TASK_ACTION_VERBS.has(word),
  );
}

// Strict validation of the model's structured output. Structural violations
// throw; a candidate that references a task that no longer exists is dropped
// with a warning (rehydration would drop it anyway). Legacy
// suggested_additions fields are ignored so old v16 artifacts remain readable.
export function validateMorningBrief(
  value: unknown,
  options: {
    knownTaskIds?: ReadonlySet<string>;
    taskUpdatedAtById?: ReadonlyMap<string, string>;
    recurringTaskIds?: ReadonlySet<string>;
    // Collected source ids (present sources only). When provided, watch items
    // whose evidence refs do not resolve are dropped and counted in
    // validationNotes.
    sourceIds?: ReadonlySet<string>;
  } = {},
): MorningBriefValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MorningBriefInvalid("not_an_object");
  }
  const raw = value as Record<string, unknown>;
  const warnings: string[] = [];
  const validationNotes: string[] = [];

  // Schema 3 writes a headline plus real paragraphs; older payloads carry only
  // the flat lens_narrative. The wire schema forces the new shape at generation
  // time, so this leniency is only the net that keeps a stray old-shape answer
  // (a replay, a fallback writer) from costing him his morning.
  const headline = briefString(raw.headline, "headline", 180, { required: false });
  const authoredParagraphs = briefStringArray(
    raw.narrative_paragraphs,
    "narrative_paragraphs",
    6,
    600,
  );
  const legacyNarrative = briefString(raw.lens_narrative, "lens_narrative", 1600, {
    required: !headline && authoredParagraphs.length === 0,
  });
  const narrativeParagraphs =
    authoredParagraphs.length > 0
      ? authoredParagraphs
      : splitNarrativeParagraphs(legacyNarrative);
  const lensNarrative = [headline, ...narrativeParagraphs].filter(Boolean).join("\n\n");

  const seenTasks = new Set<string>();
  const existingTaskCandidates: MorningBriefTaskCandidate[] = [];
  for (const [index, entry] of briefArray(
    raw.existing_task_candidates,
    "existing_task_candidates",
    8,
  ).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MorningBriefInvalid(`candidate_${index}_shape`);
    }
    const candidate = entry as Record<string, unknown>;
    const taskId = briefString(candidate.task_id, `candidate_${index}_task_id`, 200);
    if (seenTasks.has(taskId)) {
      warnings.push(`duplicate_candidate:${taskId}`);
      continue;
    }
    seenTasks.add(taskId);
    const parsed: MorningBriefTaskCandidate = {
      taskId,
      whyToday: briefString(candidate.why_today, `candidate_${index}_why_today`, 600),
      suggestedOwner: briefOwner(candidate.suggested_owner, `candidate_${index}`),
      whatClaudeCanStart: briefString(
        candidate.what_claude_can_start,
        `candidate_${index}_what_claude_can_start`,
        600,
        { required: false },
      ),
      evidenceRefs: briefStringArray(
        candidate.evidence_refs,
        `candidate_${index}_evidence_refs`,
        8,
        300,
      ),
    };
    if (options.knownTaskIds && !options.knownTaskIds.has(taskId)) {
      warnings.push(`unknown_task:${taskId}`);
      continue;
    }
    existingTaskCandidates.push(parsed);
  }

  const watchItems: MorningBriefWatchItem[] = [];
  for (const [index, entry] of briefArray(
    raw.watch_items,
    "watch_items",
    10,
  ).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MorningBriefInvalid(`watch_${index}_shape`);
    }
    const watch = entry as Record<string, unknown>;
    const item: MorningBriefWatchItem = {
      label: briefString(watch.label, `watch_${index}_label`, 240),
      evidence: briefString(watch.evidence, `watch_${index}_evidence`, 600),
      lastSeenState: briefString(
        watch.last_seen_state,
        `watch_${index}_last_seen_state`,
        300,
      ),
      evidenceRefs: briefStringArray(
        watch.evidence_refs,
        `watch_${index}_evidence_refs`,
        8,
        300,
      ),
    };
    if (!evidenceRefsResolve(item.evidenceRefs, options.sourceIds)) {
      validationNotes.push(`dropped_watch_item:${index}:unresolved_evidence`);
      continue;
    }
    watchItems.push(item);
  }

  const boardActions: MorningBriefBoardAction[] = [];
  const createdTaskTitles = new Set<string>();
  let createdTaskCount = 0;
  for (const [index, entry] of briefArray(raw.board_actions, "board_actions", 15).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MorningBriefInvalid(`board_action_${index}_shape`);
    }
    const action = entry as Record<string, unknown>;
    const op = briefString(action.op, `board_action_${index}_op`, 40);
    const evidenceRefs = briefStringArray(
      action.evidence_refs,
      `board_action_${index}_evidence_refs`,
      8,
      300,
    );
    const why = briefString(action.why, `board_action_${index}_why`, 600);
    if (op === "create_task") {
      if (createdTaskCount >= 3) {
        validationNotes.push(`dropped_board_action:${index}:create_task_limit`);
        continue;
      }
      if (!creationEvidenceIsActionable(evidenceRefs, options.sourceIds)) {
        validationNotes.push(`dropped_board_action:${index}:unresolved_creation_evidence`);
        continue;
      }
      const title = briefString(action.title, `board_action_${index}_title`, 240);
      if (!createdTaskTitleIsConcrete(title)) {
        validationNotes.push(`dropped_board_action:${index}:vague_created_task`);
        continue;
      }
      const normalizedTitle = title.replace(/\s+/g, " ").trim().toLocaleLowerCase();
      if (createdTaskTitles.has(normalizedTitle)) {
        validationNotes.push(`dropped_board_action:${index}:duplicate_created_task`);
        continue;
      }
      const description = briefString(
        action.description,
        `board_action_${index}_description`,
        4_000,
        { required: false },
      );
      if (!createdTaskDescriptionIsUseful(description)) {
        validationNotes.push(`dropped_board_action:${index}:incomplete_created_task`);
        continue;
      }
      createdTaskTitles.add(normalizedTitle);
      const priority = action.priority;
      if (priority !== "high" && priority !== "medium" && priority !== "low") {
        throw new MorningBriefInvalid(`board_action_${index}_priority`);
      }
      const dueLocalDate = action.due_local_date;
      if (
        dueLocalDate !== null &&
        (typeof dueLocalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueLocalDate))
      ) {
        throw new MorningBriefInvalid(`board_action_${index}_due_local_date`);
      }
      if (
        dueLocalDate !== null &&
        (dueLocalDate < "2024-01-01" || dueLocalDate > "2036-12-31")
      ) {
        validationNotes.push(`dropped_board_action:${index}:due_date_out_of_range`);
        continue;
      }
      boardActions.push({
        op,
        title,
        description,
        priority,
        dueLocalDate,
        why,
        evidenceRefs,
      });
      createdTaskCount += 1;
      continue;
    }
    const taskId = briefString(action.task_id, `board_action_${index}_task_id`, 200);
    if (options.knownTaskIds && !options.knownTaskIds.has(taskId)) {
      validationNotes.push(`dropped_board_action:${index}:unknown_task`);
      continue;
    }
    if (options.recurringTaskIds?.has(taskId)) {
      validationNotes.push(`dropped_board_action:${index}:recurring_task`);
      continue;
    }
    const base: MorningBriefExistingTaskActionBase = {
      taskId,
      why,
      evidenceRefs,
      expectedTaskUpdatedAt: options.taskUpdatedAtById?.get(taskId) ?? "",
    };
    let parsedAction: MorningBriefBoardAction;
    if (op === "move_column") {
      const column = action.column;
      if (column !== "today" && column !== "in_flight" && column !== "not_started") {
        throw new MorningBriefInvalid(`board_action_${index}_column`);
      }
      parsedAction = { ...base, op, column };
    } else if (op === "set_priority") {
      const priority = action.priority;
      if (priority !== "high" && priority !== "medium" && priority !== "low") {
        throw new MorningBriefInvalid(`board_action_${index}_priority`);
      }
      parsedAction = { ...base, op, priority };
    } else if (op === "set_due") {
      const dueLocalDate = action.due_local_date;
      if (
        dueLocalDate !== null &&
        (typeof dueLocalDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueLocalDate))
      ) {
        throw new MorningBriefInvalid(`board_action_${index}_due_local_date`);
      }
      if (
        dueLocalDate !== null &&
        (dueLocalDate < "2024-01-01" || dueLocalDate > "2036-12-31")
      ) {
        validationNotes.push(`dropped_board_action:${index}:due_date_out_of_range`);
        continue;
      }
      if (!evidenceRefsResolve(evidenceRefs, options.sourceIds)) {
        validationNotes.push(`dropped_board_action:${index}:unresolved_deadline_evidence`);
        continue;
      }
      parsedAction = { ...base, op, dueLocalDate };
    } else if (op === "retitle") {
      parsedAction = {
        ...base,
        op,
        title: briefString(action.title, `board_action_${index}_title`, 240),
      };
    } else if (op === "edit_description") {
      parsedAction = {
        ...base,
        op,
        description: briefString(
          action.description,
          `board_action_${index}_description`,
          4000,
          { required: false },
        ),
      };
    } else if (op === "archive") {
      parsedAction = { ...base, op };
    } else if (op === "archive_duplicate") {
      const duplicateOfTaskId = briefString(
        action.duplicate_of_task_id,
        `board_action_${index}_duplicate_of_task_id`,
        200,
      );
      if (options.knownTaskIds && !options.knownTaskIds.has(duplicateOfTaskId)) {
        validationNotes.push(`dropped_board_action:${index}:unknown_survivor`);
        continue;
      }
      if (options.recurringTaskIds?.has(duplicateOfTaskId)) {
        validationNotes.push(`dropped_board_action:${index}:recurring_survivor`);
        continue;
      }
      parsedAction = { ...base, op, duplicateOfTaskId };
    } else {
      throw new MorningBriefInvalid(`board_action_${index}_op`);
    }
    boardActions.push(parsedAction);
  }

  const archivedIds = new Set(
    boardActions
      .filter((action) => action.op === "archive" || action.op === "archive_duplicate")
      .map((action) => action.taskId),
  );
  if (existingTaskCandidates.some((candidate) => archivedIds.has(candidate.taskId))) {
    throw new MorningBriefInvalid("candidate_archived_by_board_action");
  }

  return {
    brief: {
      ...(headline ? { headline } : {}),
      narrativeParagraphs,
      lensNarrative,
      existingTaskCandidates,
      watchItems,
      boardActions,
      ...(validationNotes.length > 0 ? { validationNotes } : {}),
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Arrival consumption (pure): rehydration overlay + deterministic backfill.
// ---------------------------------------------------------------------------

export type ArrivalCandidateSelection = {
  candidate: RecommendationCandidate;
  brief?: DayPlanItemBriefAnnotation;
};

// Existing-task rankings remain annotations over the deterministic candidate
// pool. New task creation is a separate, grounded board action that the store
// applies before a fresh candidate pool is built.
export function overlayBriefOnCandidates(
  pool: readonly RecommendationCandidate[],
  brief:
    | (Pick<MorningBrief, "existingTaskCandidates"> &
    Partial<Pick<MorningBrief, "boardActions">>) | undefined,
  maximum = brief
    ? Math.min(8, Math.max(
        3,
        brief.existingTaskCandidates.length +
          (brief.boardActions ?? []).filter((action) => action.op === "create_task").length,
      ))
    : 3,
): ArrivalCandidateSelection[] {
  const byTask = new Map(pool.map((candidate) => [candidate.taskId, candidate]));
  const used = new Set<string>();
  const selected: ArrivalCandidateSelection[] = [];
  const normalizedTitle = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const createdSelections = (brief?.boardActions ?? [])
    .filter((action) => action.op === "create_task")
    .map((action) => ({
      action,
      candidate: pool.find((candidate) => normalizedTitle(candidate.title) === normalizedTitle(action.title)),
    }))
    .filter((entry): entry is {
      action: Extract<MorningBriefBoardAction, { op: "create_task" }>;
      candidate: RecommendationCandidate;
    } => Boolean(entry.candidate))
    .filter((entry, index, entries) =>
      entries.findIndex((candidate) => candidate.candidate.taskId === entry.candidate.taskId) === index,
    );
  const existingSelectionLimit = Math.max(0, maximum - createdSelections.length);

  for (const briefCandidate of brief?.existingTaskCandidates ?? []) {
    if (selected.length >= existingSelectionLimit) break;
    const candidate = byTask.get(briefCandidate.taskId);
    if (!candidate || used.has(candidate.taskId)) continue;
    used.add(candidate.taskId);
    selected.push({
      candidate,
      brief: {
        whyToday: briefCandidate.whyToday,
        whatClaudeCanStart: briefCandidate.whatClaudeCanStart || undefined,
        suggestedOwner: briefCandidate.suggestedOwner,
      },
    });
  }

  for (const { action, candidate } of createdSelections) {
    if (selected.length >= maximum || used.has(candidate.taskId)) continue;
    used.add(candidate.taskId);
    selected.push({
      candidate,
      brief: {
        whyToday: action.why,
        suggestedOwner: "me",
      },
    });
  }

  for (const candidate of pool) {
    if (selected.length >= maximum) break;
    if (used.has(candidate.taskId)) continue;
    used.add(candidate.taskId);
    selected.push({ candidate });
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Artifact selection + staleness (pure).
// ---------------------------------------------------------------------------

// Newest eligible artifact wins. Rows are immutable per input hash, so a
// late-finishing older generation lands in its own row and simply loses this
// selection instead of clobbering a newer artifact.
export function selectEligibleMorningBrief(
  artifacts: readonly MorningBriefArtifact[],
  targetLocalDate: string,
  versions: { promptVersion: number; schemaVersion: number } = {
    promptVersion: MORNING_BRIEF_PROMPT_VERSION,
    schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
  },
): MorningBriefArtifact | undefined {
  return [...artifacts]
    .filter(
      (artifact) =>
        artifact.status === "succeeded" &&
        artifact.targetLocalDate === targetLocalDate &&
        artifact.promptVersion === versions.promptVersion &&
        artifact.schemaVersion === versions.schemaVersion &&
        Boolean(artifact.briefJson) &&
        !artifact.boardActionsPending,
    )
    .sort((left, right) =>
      (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    )[0];
}

export type MorningBriefGenerationState =
  | "deferred"
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

// The generation/availability state the arrival needs, with the start time when
// a row has actually begun. This carries no brief content: only the coarse
// lifecycle and, at most, a timestamp.
export type MorningBriefGeneration = {
  state: MorningBriefGenerationState;
  startedAt?: string;
  retryAt?: string;
  failureMessage?: string;
  pickedTasks?: Array<{ taskId: string; whyToday: string }>;
  // How long this run is expected to take, from recent history. Attached by the
  // read path (which can reach the store), never by the pure selector below, and
  // only while a run is actually live. Drives the arrival's progress bar.
  estimateSeconds?: number;
};

// Deferred timestamps live in the existing error column so queued work survives
// restart without a second queue. Never expose arbitrary worker error text.
export const BRIEF_DEFERRED_PREFIX = "budget_deferred:";

export function morningBriefRetryAt(code?: string): string | undefined {
  if (!code?.startsWith(BRIEF_DEFERRED_PREFIX)) return undefined;
  const value = code.slice(BRIEF_DEFERRED_PREFIX.length);
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value ? value : undefined;
}

// A required source that is missing is a file that is not there, so "try again"
// is advice that fails the same way every morning. The code already names the
// source; say which one and what would fix it. Goals is the one a fresh
// install actually hits: it is required, it lives only on disk, and Cove has
// no screen for editing it.
export function missingBriefSourceSentence(code: string): string {
  const ids = code.slice("required_source_missing:".length).split(",").filter(Boolean);
  // Goals is the one a fresh install actually hits, and the only one a retry
  // cannot fix: it is required, it lives only on disk, and Cove has no screen
  // for editing it. Every other required source is a read that can fail once
  // and succeed next time, so those keep the retry.
  if (ids.includes("goals")) {
    return "Cove has no goals to plan your day against, so it could not write your brief. Your plan is still here. Ask your Cove setup agent to add your goals file.";
  }
  return "Cove could not load all the information needed to write your brief. Your plan is still here. Try again.";
}

export function morningBriefFailureDetail(code: string): string {
  if (code === "runner_budget_exceeded") return "Cove reached its writing allowance before it could start your brief. Your plan is still here.";
  if (code === "runner_input_too_large") return "Cove could not fit the supplied context into this request. Your plan is still here.";
  if (code.startsWith("required_source_missing:")) return missingBriefSourceSentence(code);
  if (code.includes("unavailable")) return "Cove could not reach your selected writer. Check that Codex or Claude is signed in.";
  if (code.includes("timeout")) return "Your brief writer ran out of time. Your plan is still here, and you can try again.";
  if (code.includes("output_too_large")) return "Your writer returned more data than Cove could safely process. Your plan is still here.";
  return "Your writer could not finish a valid brief. Your plan is still here, and you can try again.";
}

// How recently a failed generation is still worth reporting. Past this a stale
// failure is treated as idle: the arrival stays silent and does not imply a
// brief is on its way.
export const MORNING_BRIEF_FAILED_WINDOW_HOURS = 6;

// Derives the generation state for a target date from its brief rows (pure; the
// caller supplies now). An active queued/running row wins, running first since
// it carries a real start time; otherwise an eligible succeeded artifact is
// surfaced so a pristine arrival can attach it, then the most recent failure
// inside the window, otherwise idle. Never surfaces brief_json.
export function selectMorningBriefGeneration(
  artifacts: readonly MorningBriefArtifact[],
  targetLocalDate: string,
  now: Date,
  options: {
    failedWindowHours?: number;
    // The read path passes the same duration used by the worker. Expired rows
    // stop looking live so the arrival can render its existing retry control.
    runningStaleAfterMs?: number;
    // A live (unexpired) brief generation on another machine in the relay mesh.
    // When present and no local row is already active, the arrival stays
    // in-progress until that machine's artifact syncs in and is imported.
    remoteAttempt?: { startedAt?: string };
  } = {},
): MorningBriefGeneration {
  const forDate = artifacts.filter(
    (artifact) => artifact.targetLocalDate === targetLocalDate,
  );

  const running = forDate
    .filter((artifact) => {
      if (artifact.status !== "running") return false;
      if (!options.runningStaleAfterMs) return true;
      const startedAt = Date.parse(artifact.startedAt ?? artifact.createdAt);
      return (
        Number.isFinite(startedAt) &&
        now.getTime() - startedAt <= options.runningStaleAfterMs
      );
    })
    .sort((left, right) =>
      (right.startedAt ?? right.createdAt).localeCompare(left.startedAt ?? left.createdAt),
    )[0];
  if (running) {
    return { state: "running", ...(running.startedAt ? { startedAt: running.startedAt } : {}) };
  }

  const queued = forDate
    .filter((artifact) => artifact.status === "queued")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (queued) {
    const retryAt = morningBriefRetryAt(queued.errorCode);
    if (retryAt && Date.parse(retryAt) > now.getTime()) return { state: "deferred", retryAt };
    return { state: "queued", ...(queued.startedAt ? { startedAt: queued.startedAt } : {}) };
  }

  const succeeded = forDate
    .filter(
      (artifact) =>
        artifact.status === "succeeded" &&
        artifact.promptVersion === MORNING_BRIEF_PROMPT_VERSION &&
        artifact.schemaVersion === MORNING_BRIEF_SCHEMA_VERSION &&
        Boolean(artifact.briefJson) &&
        !artifact.boardActionsPending,
    )
    .sort((left, right) =>
      (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    )[0];
  if (succeeded) {
    const brief = morningBriefFromArtifact(succeeded);
    return {
      state: "succeeded",
      ...(brief
        ? {
            pickedTasks: [
              ...brief.existingTaskCandidates.map((candidate) => ({
                taskId: candidate.taskId,
                whyToday: candidate.whyToday,
              })),
            ],
          }
        : {}),
    };
  }

  const windowHours = options.failedWindowHours ?? MORNING_BRIEF_FAILED_WINDOW_HOURS;
  const cutoff = now.getTime() - windowHours * 60 * 60 * 1000;
  const failed = forDate
    .filter((artifact) => artifact.status === "failed")
    .filter((artifact) => {
      const at = new Date(artifact.finishedAt ?? artifact.updatedAt).getTime();
      return Number.isFinite(at) && at >= cutoff;
    })
    .sort((left, right) =>
      (right.finishedAt ?? right.updatedAt).localeCompare(left.finishedAt ?? left.updatedAt),
    )[0];
  // A live remote attempt keeps the arrival in-progress even when this machine
  // has no active row (the common case: the Mini generates, the MBP watches).
  // It outranks a local stale-failed row so the UI does not flicker to quiet.
  if (options.remoteAttempt) {
    return {
      state: "running",
      ...(options.remoteAttempt.startedAt
        ? { startedAt: options.remoteAttempt.startedAt }
        : {}),
    };
  }

  if (failed) {
    return { state: "failed", ...(failed.startedAt ? { startedAt: failed.startedAt } : {}),
      ...(failed.errorCode ? { failureMessage: morningBriefFailureDetail(failed.errorCode) } : {}),
    };
  }

  return { state: "idle" };
}

function storedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function storedString(value: unknown): value is string {
  return typeof value === "string";
}

function storedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function storedOwner(value: unknown): value is DayPlanOwner {
  return typeof value === "string" && OWNER_VALUES.has(value as DayPlanOwner);
}

// Fail-open parse of a stored artifact, validating the full stored camel-case
// contract including every nested entry. A row that passed generation-time
// validation always passes; anything corrupted, hand-edited, or drifted (for
// example existingTaskCandidates: [null]) makes the brief absent, which is
// exactly the deterministic-arrival fallback. Consumption must never 500.
export function morningBriefFromArtifact(
  artifact: MorningBriefArtifact | undefined,
): MorningBrief | undefined {
  if (!artifact?.briefJson || artifact.status !== "succeeded") return undefined;
  try {
    const parsed = storedRecord(JSON.parse(artifact.briefJson));
    if (!parsed || !storedString(parsed.lensNarrative)) return undefined;
    if (
      parsed.validationNotes !== undefined &&
      !storedStringArray(parsed.validationNotes)
    ) {
      return undefined;
    }
    const candidatesRaw = parsed.existingTaskCandidates;
    const watchRaw = parsed.watchItems;
    const boardRaw = parsed.boardActions;
    if (
      !Array.isArray(candidatesRaw) ||
      !Array.isArray(watchRaw) ||
      (artifact.schemaVersion >= 4 && !Array.isArray(boardRaw))
    ) {
      return undefined;
    }
    const candidates: MorningBriefTaskCandidate[] = [];
    for (const entry of candidatesRaw) {
      const candidate = storedRecord(entry);
      if (
        !candidate ||
        !storedString(candidate.taskId) ||
        !storedString(candidate.whyToday) ||
        !storedOwner(candidate.suggestedOwner) ||
        !storedString(candidate.whatClaudeCanStart) ||
        !storedStringArray(candidate.evidenceRefs)
      ) {
        return undefined;
      }
      candidates.push({
        taskId: candidate.taskId,
        whyToday: candidate.whyToday,
        suggestedOwner: candidate.suggestedOwner,
        whatClaudeCanStart: candidate.whatClaudeCanStart,
        evidenceRefs: candidate.evidenceRefs,
      });
    }
    const watchItems: MorningBriefWatchItem[] = [];
    for (const entry of watchRaw) {
      const watch = storedRecord(entry);
      if (
        !watch ||
        !storedString(watch.label) ||
        !storedString(watch.evidence) ||
        !storedString(watch.lastSeenState) ||
        !storedStringArray(watch.evidenceRefs)
      ) {
        return undefined;
      }
      watchItems.push({
        label: watch.label,
        evidence: watch.evidence,
        lastSeenState: watch.lastSeenState,
        evidenceRefs: watch.evidenceRefs,
      });
    }
    const boardActions: MorningBriefBoardAction[] = [];
    for (const entry of Array.isArray(boardRaw) ? boardRaw : []) {
      const action = storedRecord(entry);
      if (
        action?.op === "create_task" &&
        storedString(action.title) &&
        storedString(action.description) &&
        (action.priority === "high" || action.priority === "medium" || action.priority === "low") &&
        (action.dueLocalDate === null || storedString(action.dueLocalDate)) &&
        storedString(action.why) &&
        storedStringArray(action.evidenceRefs)
      ) {
        boardActions.push({
          op: action.op,
          title: action.title,
          description: action.description,
          priority: action.priority,
          dueLocalDate: action.dueLocalDate,
          why: action.why,
          evidenceRefs: action.evidenceRefs,
        });
        continue;
      }
      if (
        !action ||
        !storedString(action.op) ||
        !storedString(action.taskId) ||
        !storedString(action.why) ||
        !storedStringArray(action.evidenceRefs) ||
        !storedString(action.expectedTaskUpdatedAt)
      ) {
        return undefined;
      }
      const base = {
        taskId: action.taskId,
        why: action.why,
        evidenceRefs: action.evidenceRefs,
        expectedTaskUpdatedAt: action.expectedTaskUpdatedAt,
      };
      if (
        action.op === "move_column" &&
        (action.column === "today" || action.column === "in_flight" || action.column === "not_started")
      ) {
        boardActions.push({ ...base, op: action.op, column: action.column });
      } else if (
        action.op === "set_priority" &&
        (action.priority === "high" || action.priority === "medium" || action.priority === "low")
      ) {
        boardActions.push({ ...base, op: action.op, priority: action.priority });
      } else if (
        action.op === "set_due" &&
        (action.dueLocalDate === null || storedString(action.dueLocalDate))
      ) {
        boardActions.push({ ...base, op: action.op, dueLocalDate: action.dueLocalDate });
      } else if (action.op === "retitle" && storedString(action.title)) {
        boardActions.push({ ...base, op: action.op, title: action.title });
      } else if (action.op === "edit_description" && storedString(action.description)) {
        boardActions.push({ ...base, op: action.op, description: action.description });
      } else if (action.op === "archive") {
        boardActions.push({ ...base, op: action.op });
      } else if (action.op === "archive_duplicate" && storedString(action.duplicateOfTaskId)) {
        boardActions.push({
          ...base,
          op: action.op,
          duplicateOfTaskId: action.duplicateOfTaskId,
        });
      } else {
        return undefined;
      }
    }
    // Artifacts written before schema 3 have neither field. Splitting the flat
    // narrative gives them the same paragraph rendering as a new brief, so an
    // old brief still reads correctly instead of collapsing into a block.
    const headline = storedString(parsed.headline) ? (parsed.headline as string) : undefined;
    const storedParagraphs = storedStringArray(parsed.narrativeParagraphs)
      ? (parsed.narrativeParagraphs as string[])
      : undefined;
    return {
      ...(headline ? { headline } : {}),
      narrativeParagraphs:
        storedParagraphs && storedParagraphs.length > 0
          ? storedParagraphs
          : splitNarrativeParagraphs(parsed.lensNarrative),
      lensNarrative: parsed.lensNarrative,
      existingTaskCandidates: candidates,
      watchItems,
      ...(parsed.dailyDecision
        ? {
            dailyDecision:
              readStoredDailyDecision(parsed.dailyDecision),
          }
        : {}),
      boardActions,
      ...(parsed.validationNotes ? { validationNotes: parsed.validationNotes } : {}),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scheduling math (pure, plan-timezone based; never server-local Date parts).
// ---------------------------------------------------------------------------

export function localDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Client components import these from the pure weekday module; re-exported
// here so server-side callers keep one import surface.
export { isWeekendLocalDate, nextWeekdayLocalDate } from "./weekday";
import { isWeekendLocalDate, nextWeekdayLocalDate } from "./weekday";

// The brief generated after a settlement targets the next morning: today in the
// plan's timezone when the settled day is already behind us (the normal evening
// close), otherwise the calendar day after the settled date (a stale plan being
// closed the next morning still briefs that same morning).
export function nextBriefTargetLocalDate(
  settledLocalDate: string,
  now: Date,
  timezone: string,
): string {
  const today = localDateInTimezone(now, timezone);
  if (today > settledLocalDate) {
    return isWeekendLocalDate(today) ? nextWeekdayLocalDate(today) : today;
  }
  return nextWeekdayLocalDate(settledLocalDate);
}

// Settlement reconciliation is complete when no immediate ('pending')
// defer/drop work remains for THIS settlement's snapshot. Scoping matters: an
// unacked defer from an earlier settlement must not suppress tonight's brief,
// and resurfaces (scheduled or otherwise) never participate.
export function settlementReconciliationComplete(
  reconciliations: readonly DayPlanReconciliation[],
  snapshotId?: string,
): boolean {
  return !reconciliations.some(
    (entry) =>
      entry.state === "pending" &&
      entry.action !== "resurface" &&
      (!snapshotId || entry.snapshotId === snapshotId),
  );
}

// ---------------------------------------------------------------------------
// Public projection: brief content is only exposed to loopback requests.
// ---------------------------------------------------------------------------

export type PublicMorningBrief = {
  planVersion?: number;
  statusNote?: string;
  proposalId?: string;
  proposedActions?: Array<{ title: string; reason: string }>;
  id: string;
  targetLocalDate: string;
  generatedAt: string;
  writer?: "codex" | "claude";
  modelAlias: string;
  effort: string;
  headline?: string;
  narrativeParagraphs: string[];
  lensNarrative: string;
  managementSummary?: string;
  watchItems: MorningBriefWatchItem[];
};

// brief_json carries contact names and message drafts. Exactly like a run's
// claudeSessionId, it is only exposed when the request comes from this machine.
export function publicMorningBrief(
  artifact: MorningBriefArtifact,
  brief: MorningBrief,
  accessMode: string | undefined,
  managementSummary?: string,
): PublicMorningBrief | undefined {
  if (accessMode !== "loopback") return undefined;
  return {
    id: artifact.id,
    targetLocalDate: artifact.targetLocalDate,
    generatedAt: artifact.finishedAt ?? artifact.updatedAt,
    ...(artifact.writer ? { writer: artifact.writer } : {}),
    modelAlias: artifact.modelAlias,
    effort: artifact.effort,
    ...(brief.headline ? { headline: brief.headline } : {}),
    narrativeParagraphs: brief.narrativeParagraphs,
    lensNarrative: brief.lensNarrative,
    ...(managementSummary ? { managementSummary } : {}),
    watchItems: brief.watchItems,
  };
}
