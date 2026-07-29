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
export const MORNING_BRIEF_PROMPT_VERSION = 14;
export const MORNING_BRIEF_SCHEMA_VERSION = 3;

export type MorningBriefStatus = "queued" | "running" | "succeeded" | "failed";

export type MorningBriefTaskCandidate = {
  taskId: string;
  whyToday: string;
  suggestedOwner: DayPlanOwner;
  whatClaudeCanStart: string;
  evidenceRefs: string[];
};

export type MorningBriefSuggestedAddition = {
  title: string;
  outcome: string;
  why: string;
  suggestedOwner: DayPlanOwner;
};

export type MorningBriefWatchItem = {
  label: string;
  evidence: string;
  lastSeenState: string;
  evidenceRefs: string[];
};

export type MorningBriefDraftKind = "full" | "beats_only" | "pointer" | "blocked";

export type MorningBriefSalesAction = {
  contact: string;
  channel: string;
  evidenceRefs: string[];
  draftKind: MorningBriefDraftKind;
  draftOrBeats: string;
  approvalRequired: true;
};

export type MorningBrief = {
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
  suggestedAdditions: MorningBriefSuggestedAddition[];
  watchItems: MorningBriefWatchItem[];
  salesActions: MorningBriefSalesAction[];
  // Cove-added record of items dropped during validation (for example a watch
  // item whose evidence refs cite no collected source). Never model-authored.
  validationNotes?: string[];
};

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

export type MorningBriefSalesActionState = "approved" | "edited" | "skipped";

export type MorningBriefSalesActionRecord = {
  briefId: string;
  actionIndex: number;
  state: MorningBriefSalesActionState;
  editedText?: string;
  updatedAt: string;
};

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
  sourceFreshness: ReadonlyArray<{ id: string; freshness: BriefSourceFreshness }>;
  promptVersion: number;
  schemaVersion: number;
  modelAlias: string;
  effort: string;
  budgetUsd: number;
  writer?: "codex" | "claude";
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
const DRAFT_KINDS = new Set<MorningBriefDraftKind>([
  "full",
  "beats_only",
  "pointer",
  "blocked",
]);

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

// Bounded grounding for watch items and sales actions: every evidence ref must
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

// Strict validation of the model's structured output. Structural violations
// throw; a candidate that references a task that no longer exists is dropped
// with a warning (rehydration would drop it anyway). suggested_additions are
// validated as their own list and can never become task candidates: they carry
// no taskId and are returned on a separate field.
export function validateMorningBrief(
  value: unknown,
  options: {
    knownTaskIds?: ReadonlySet<string>;
    // Collected source ids (present sources only). When provided, watch items
    // and sales actions whose evidence refs do not resolve are dropped and
    // counted in validationNotes.
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
    3,
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

  const suggestedAdditions: MorningBriefSuggestedAddition[] = briefArray(
    raw.suggested_additions,
    "suggested_additions",
    5,
  ).map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MorningBriefInvalid(`addition_${index}_shape`);
    }
    const addition = entry as Record<string, unknown>;
    return {
      title: briefString(addition.title, `addition_${index}_title`, 240),
      outcome: briefString(addition.outcome, `addition_${index}_outcome`, 1200),
      why: briefString(addition.why, `addition_${index}_why`, 600),
      suggestedOwner: briefOwner(addition.suggested_owner, `addition_${index}`),
    };
  });

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

  const salesActions: MorningBriefSalesAction[] = [];
  for (const [index, entry] of briefArray(
    raw.sales_actions,
    "sales_actions",
    10,
  ).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MorningBriefInvalid(`sales_${index}_shape`);
    }
    const action = entry as Record<string, unknown>;
    const draftKind = action.draft_kind;
    if (
      typeof draftKind !== "string" ||
      !DRAFT_KINDS.has(draftKind as MorningBriefDraftKind)
    ) {
      throw new MorningBriefInvalid(`sales_${index}_draft_kind`);
    }
    // Approval is the human gate. A sales action that does not declare it is a
    // contract violation, never a silently-corrected one.
    if (action.approval_required !== true) {
      throw new MorningBriefInvalid(`sales_${index}_approval_required`);
    }
    const parsedAction: MorningBriefSalesAction = {
      contact: briefString(action.contact, `sales_${index}_contact`, 200),
      channel: briefString(action.channel, `sales_${index}_channel`, 80),
      evidenceRefs: briefStringArray(
        action.evidence_refs,
        `sales_${index}_evidence_refs`,
        8,
        300,
      ),
      draftKind: draftKind as MorningBriefDraftKind,
      draftOrBeats: briefString(
        action.draft_or_beats,
        `sales_${index}_draft_or_beats`,
        2400,
      ),
      approvalRequired: true,
    };
    if (!evidenceRefsResolve(parsedAction.evidenceRefs, options.sourceIds)) {
      validationNotes.push(`dropped_sales_action:${index}:unresolved_evidence`);
      continue;
    }
    salesActions.push(parsedAction);
  }

  return {
    brief: {
      ...(headline ? { headline } : {}),
      narrativeParagraphs,
      lensNarrative,
      existingTaskCandidates,
      suggestedAdditions,
      watchItems,
      salesActions,
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

// The brief is presentation and rationale, never task evidence. Every selected
// taskId must rehydrate against the fresh candidate pool; selections whose task
// vanished (or was never real) are dropped, and the remaining slots backfill in
// deterministic pool order. suggested_additions are intentionally not accepted
// here: only existing task candidates can rank.
export function overlayBriefOnCandidates(
  pool: readonly RecommendationCandidate[],
  brief: Pick<MorningBrief, "existingTaskCandidates"> | undefined,
  maximum = 3,
): ArrivalCandidateSelection[] {
  const byTask = new Map(pool.map((candidate) => [candidate.taskId, candidate]));
  const used = new Set<string>();
  const selected: ArrivalCandidateSelection[] = [];

  for (const briefCandidate of brief?.existingTaskCandidates ?? []) {
    if (selected.length >= maximum) break;
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
        Boolean(artifact.briefJson),
    )
    .sort((left, right) =>
      (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    )[0];
}

export type MorningBriefGenerationState =
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
  // How long this run is expected to take, from recent history. Attached by the
  // read path (which can reach the store), never by the pure selector below, and
  // only while a run is actually live. Drives the arrival's progress bar.
  estimateSeconds?: number;
};

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
    .filter((artifact) => artifact.status === "running")
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
    return { state: "queued", ...(queued.startedAt ? { startedAt: queued.startedAt } : {}) };
  }

  const succeeded = forDate
    .filter(
      (artifact) =>
        artifact.status === "succeeded" &&
        artifact.promptVersion === MORNING_BRIEF_PROMPT_VERSION &&
        artifact.schemaVersion === MORNING_BRIEF_SCHEMA_VERSION &&
        Boolean(artifact.briefJson),
    )
    .sort((left, right) =>
      (right.finishedAt ?? right.createdAt).localeCompare(left.finishedAt ?? left.createdAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id),
    )[0];
  if (succeeded) return { state: "succeeded" };

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
    return { state: "failed", ...(failed.startedAt ? { startedAt: failed.startedAt } : {}) };
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
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
    const additionsRaw = parsed.suggestedAdditions;
    const watchRaw = parsed.watchItems;
    const salesRaw = parsed.salesActions;
    if (
      !Array.isArray(candidatesRaw) ||
      !Array.isArray(additionsRaw) ||
      !Array.isArray(watchRaw) ||
      !Array.isArray(salesRaw)
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
    const additions: MorningBriefSuggestedAddition[] = [];
    for (const entry of additionsRaw) {
      const addition = storedRecord(entry);
      if (
        !addition ||
        !storedString(addition.title) ||
        !storedString(addition.outcome) ||
        !storedString(addition.why) ||
        !storedOwner(addition.suggestedOwner)
      ) {
        return undefined;
      }
      additions.push({
        title: addition.title,
        outcome: addition.outcome,
        why: addition.why,
        suggestedOwner: addition.suggestedOwner,
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
    const salesActions: MorningBriefSalesAction[] = [];
    for (const entry of salesRaw) {
      const action = storedRecord(entry);
      if (
        !action ||
        !storedString(action.contact) ||
        !storedString(action.channel) ||
        !storedStringArray(action.evidenceRefs) ||
        typeof action.draftKind !== "string" ||
        !DRAFT_KINDS.has(action.draftKind as MorningBriefDraftKind) ||
        !storedString(action.draftOrBeats) ||
        action.approvalRequired !== true
      ) {
        return undefined;
      }
      salesActions.push({
        contact: action.contact,
        channel: action.channel,
        evidenceRefs: action.evidenceRefs,
        draftKind: action.draftKind as MorningBriefDraftKind,
        draftOrBeats: action.draftOrBeats,
        approvalRequired: true,
      });
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
      suggestedAdditions: additions,
      watchItems,
      salesActions,
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
  if (today > settledLocalDate) return today;
  const next = new Date(`${settledLocalDate}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
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
  id: string;
  targetLocalDate: string;
  generatedAt: string;
  headline?: string;
  narrativeParagraphs: string[];
  lensNarrative: string;
  watchItems: MorningBriefWatchItem[];
  suggestedAdditions: MorningBriefSuggestedAddition[];
  salesActions: Array<
    MorningBriefSalesAction & {
      state?: MorningBriefSalesActionState;
      editedText?: string;
    }
  >;
};

// brief_json carries contact names and message drafts. Exactly like a run's
// claudeSessionId, it is only exposed when the request comes from this machine.
export function publicMorningBrief(
  artifact: MorningBriefArtifact,
  brief: MorningBrief,
  actionStates: readonly MorningBriefSalesActionRecord[],
  accessMode: string | undefined,
): PublicMorningBrief | undefined {
  if (accessMode !== "loopback") return undefined;
  const stateByIndex = new Map(
    actionStates.map((record) => [record.actionIndex, record]),
  );
  return {
    id: artifact.id,
    targetLocalDate: artifact.targetLocalDate,
    generatedAt: artifact.finishedAt ?? artifact.updatedAt,
    ...(brief.headline ? { headline: brief.headline } : {}),
    narrativeParagraphs: brief.narrativeParagraphs,
    lensNarrative: brief.lensNarrative,
    watchItems: brief.watchItems,
    suggestedAdditions: brief.suggestedAdditions,
    salesActions: brief.salesActions.map((action, index) => {
      const record = stateByIndex.get(index);
      return {
        ...action,
        state: record?.state,
        editedText: record?.editedText,
      };
    }),
  };
}
