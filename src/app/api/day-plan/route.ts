import { NextRequest, NextResponse } from "next/server";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import {
  currentDayPlanAccessMode,
  hasDayPlanRouteAccess,
  type DayPlanAccessMode,
} from "@/lib/request-security";
import {
  DayPlanInvalidTransition,
  DayPlanNotFound,
  DayPlanVersionConflict,
  getDayPlanStore,
} from "@/lib/day-plan/store";
import type { DayPlanStore } from "@/lib/day-plan/store";
import type {
  DayPlanMutationAction,
  DayPlanMutationInput,
  DayPlanOwner,
  EnsureDayPlanInput,
  RecommendationCandidate,
  RecommendationSourceRef,
  SettlementDisposition,
  DayPlan,
} from "@/lib/day-plan/types";
import { isClaudeWorkerAvailable } from "@/lib/claude-execution/trigger";
import {
  morningBriefFromArtifact,
  stripMorningBriefDateClaim,
  publicMorningBrief,
  selectMorningBriefGeneration,
} from "@/lib/day-plan/brief";
import {
  maybeQueueMorningBrief,
  withQueuedAttemptStatus,
} from "@/lib/day-plan/brief-triggers";
import {
  morningBriefModelConfig,
  morningBriefStaleAfterMs,
} from "@/lib/claude-execution/brief-commands";
import { estimateBriefSeconds } from "@/lib/day-plan/presentation";
import {
  liveRemoteBriefAttempt,
  scanAndImportBriefRelay,
  writeDayClosureRelay,
  writeSettlementRelay,
  writeSourceCheckpoint,
} from "@/lib/day-plan/brief-relay";
import {
  briefCheckpointSources,
  defaultBriefWebBase,
  fetchRows,
} from "@/lib/day-plan/brief-sources";
import {
  publicDayPlan,
  publicExecutionRun,
  publicKickoffSkip,
  publicUnreadyItem,
} from "@/lib/day-plan/public-execution";
import { taskColumnKeyForName } from "@/lib/tasks/columns";
import { coveEnv } from "../../../lib/env";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { expireRecurringInstances } from "@/lib/tasks/recurrence";
import { openLocalDatabase } from "@/lib/local/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const ACTIONS = new Set<DayPlanMutationAction>([
  "arrival_open",
  "arrival_snooze",
  "arrival_skip",
  "arrival_bypass",
  "arrival_reopen",
  "item_accept",
  "item_edit",
  "item_later",
  "item_dismiss",
  "item_add",
  "item_owner",
  "item_reorder",
  "start_day",
  "settlement_offer",
  "settlement_skip",
  "settlement_start",
  "settlement_decide",
  "settlement_commit",
]);
const OWNERS = new Set<DayPlanOwner>(["me", "claude", "together"]);
const DISPOSITIONS = new Set<SettlementDisposition>(["progress", "carry", "defer", "drop"]);
const PRIORITIES = new Set(["low", "medium", "high"]);
const SOURCE_TYPES = new Set(["task", "suggestion", "snapshot", "email", "crm", "decision"]);
const SUPPORTS = new Set([
  "commitment",
  "deadline",
  "waiting_person",
  "carryover",
  "returned_work",
  "priority",
]);

export function assertRecurringCarryAllowed(
  store: Pick<DayPlanStore, "getPlan">,
  input: Pick<DayPlanMutationInput, "planId" | "itemId">,
  dbPath?: string,
): void {
  const plan = store.getPlan(input.planId);
  const taskId = plan?.items.find((item) => item.id === input.itemId)?.taskId;
  if (!taskId) return;
  const db = openLocalDatabase(dbPath);
  try {
    const task = db.prepare(
      "SELECT tags, recurring_template_id FROM tasks WHERE id = ?",
    ).get(taskId) as {
      tags: string | null;
      recurring_template_id: string | null;
    } | undefined;
    let tags: unknown = [];
    try {
      tags = JSON.parse(task?.tags ?? "[]");
    } catch {
      tags = [];
    }
    const recurring = Boolean(task?.recurring_template_id) ||
      (
        Array.isArray(tags) &&
        tags.some((tag) =>
          typeof tag === "string" && tag.trim().toLowerCase() === "recurring"
        )
      );
    if (recurring) {
      throw new DayPlanInvalidTransition(
        "Recurring items end when you close the day and cannot be carried.",
      );
    }
  } finally {
    db.close();
  }
}
const TASK_SUPPORTS = new Set(["commitment", "deadline", "priority"]);
const WHY_TODAY = new Set([
  "This is accepted work already in flight.",
  "This is accepted work already committed for today.",
  "This accepted commitment has a verified overdue date.",
  "This accepted commitment has a verified due date today.",
  "This is overdue and still open.",
  "This is due today and still open.",
]);
const DUE_BACKLOG_WHY_TODAY = new Set([
  "This is overdue and still open.",
  "This is due today and still open.",
]);
const RANK_REASONS = new Set([
  "accepted_in_flight",
  "accepted_today",
  "due_backlog",
  "priority_low",
  "priority_medium",
  "priority_high",
  "verified_overdue",
  "verified_due_today",
]);
const MUTATION_ID = /^[A-Za-z0-9:_-]+$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
type ParsedPost =
  | { action: "ensure"; input: EnsureDayPlanInput }
  | { action: "reconciliation_applied"; reconciliationId: string }
  | { action: "task_mutation_applied"; mutationId: string }
  | { action: "arrival_interact"; planId: string; mutationId: string }
  | { action: "brief_force"; localDate: string }
  | { action: DayPlanMutationAction; input: DayPlanMutationInput };

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  name: string,
  options: { required?: boolean; max?: number; pattern?: RegExp } = {},
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new Error(`${name} is required.`);
  if (trimmed.length > (options.max ?? 4000)) throw new Error(`${name} is too long.`);
  if (options.pattern && !options.pattern.test(trimmed)) {
    throw new Error(`${name} has an invalid format.`);
  }
  return trimmed;
}

function nextDayNoteValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("nextDayNote must be text.");
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 8000) : undefined;
}

function isoValue(
  value: unknown,
  name: string,
  options: { required?: boolean } = {},
): string | undefined {
  const text = stringValue(value, name, { required: options.required, max: 80 });
  if (!text) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date.`);
  return date.toISOString();
}

function stringArray(
  value: unknown,
  name: string,
  options: { maxItems: number; maxLength: number } = { maxItems: 20, maxLength: 200 },
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > options.maxItems) {
    throw new Error(`${name} has too many values.`);
  }
  return value.map((item, index) =>
    stringValue(item, `${name}[${index}]`, {
      required: true,
      max: options.maxLength,
    })!,
  );
}

function sourceRef(value: unknown, index: number): RecommendationSourceRef {
  const source = recordValue(value, `sourceRefs[${index}]`);
  const sourceType = stringValue(source.sourceType, "sourceType", {
    required: true,
    max: 30,
  });
  const freshness = stringValue(source.freshness, "freshness", {
    required: true,
    max: 20,
  });
  if (!sourceType || !SOURCE_TYPES.has(sourceType)) throw new Error("Unknown source type.");
  if (freshness !== "current") {
    throw new Error("Arrival candidates require current task evidence.");
  }
  const supports = stringArray(source.supports, "supports", {
    maxItems: 6,
    maxLength: 40,
  });
  if (supports.some((support) => !SUPPORTS.has(support))) {
    throw new Error("Unknown recommendation support.");
  }
  if (supports.some((support) => !TASK_SUPPORTS.has(support))) {
    throw new Error("Task candidates cannot claim unsupported evidence.");
  }
  return {
    sourceType: sourceType as RecommendationSourceRef["sourceType"],
    recordId: stringValue(source.recordId, "recordId", { required: true, max: 200 })!,
    sourceUpdatedAt: isoValue(source.sourceUpdatedAt, "sourceUpdatedAt", { required: true })!,
    refreshedAt: isoValue(source.refreshedAt, "refreshedAt", { required: true })!,
    freshness: "current",
    supports: supports as RecommendationSourceRef["supports"],
  };
}

function candidateValue(value: unknown, index: number): RecommendationCandidate {
  const candidate = recordValue(value, `candidates[${index}]`);
  const taskId = stringValue(candidate.taskId, "taskId", { required: true, max: 200 })!;
  const owner = stringValue(candidate.owner, "owner", { required: true, max: 20 });
  const priority = stringValue(candidate.priority, "priority", { required: true, max: 20 });
  if (!owner || !OWNERS.has(owner as DayPlanOwner)) throw new Error("Unknown owner.");
  if (!priority || !PRIORITIES.has(priority)) throw new Error("Unknown priority.");
  if (candidate.commitment !== "ink") {
    throw new Error("Phase 1A candidates must be accepted task-backed work.");
  }
  if (!Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length !== 1) {
    throw new Error("A task-backed candidate requires one source record.");
  }
  const sourceRefs = candidate.sourceRefs.map(sourceRef);
  if (
    sourceRefs[0].sourceType !== "task" ||
    sourceRefs[0].recordId !== taskId ||
    !sourceRefs[0].supports.includes("commitment")
  ) {
    throw new Error("Candidate provenance must identify its accepted task.");
  }
  const conflicts = stringArray(candidate.conflicts, "conflicts", {
    maxItems: 3,
    maxLength: 240,
  });
  if (conflicts.length) throw new Error("Conflicted candidates cannot enter arrival.");
  const candidateId = stringValue(candidate.candidateId, "candidateId", {
    required: true,
    max: 240,
  })!;
  if (candidateId !== `task:${taskId}`) {
    throw new Error("Candidate ID must be stable for its task.");
  }
  const whyToday = stringValue(candidate.whyToday, "whyToday", {
    required: true,
    max: 600,
  })!;
  if (!WHY_TODAY.has(whyToday)) {
    throw new Error("Task candidate urgency must come from deterministic evidence.");
  }
  const dueAt = isoValue(candidate.dueAt, "dueAt");
  const hasDeadline = sourceRefs[0].supports.includes("deadline");
  if (hasDeadline && !dueAt) {
    throw new Error("Deadline evidence requires a verified due date.");
  }
  if (
    hasDeadline !==
    (whyToday === "This accepted commitment has a verified overdue date." ||
      whyToday === "This accepted commitment has a verified due date today." ||
      DUE_BACKLOG_WHY_TODAY.has(whyToday))
  ) {
    throw new Error("Task candidate reason does not match its deadline evidence.");
  }
  const rankReasons = stringArray(candidate.rankReasons, "rankReasons", {
    maxItems: 8,
    maxLength: 80,
  });
  if (rankReasons.some((reason) => !RANK_REASONS.has(reason))) {
    throw new Error("Task candidate has an unsupported rank reason.");
  }
  if (!rankReasons.includes(`priority_${priority}`)) {
    throw new Error("Task candidate rank must preserve its explicit priority.");
  }
  if (
    !rankReasons.includes("accepted_today") &&
    !rankReasons.includes("accepted_in_flight") &&
    !rankReasons.includes("due_backlog")
  ) {
    throw new Error("Task candidate rank must preserve its eligibility source.");
  }
  if (
    rankReasons.includes("due_backlog") !== DUE_BACKLOG_WHY_TODAY.has(whyToday)
  ) {
    throw new Error("Due-backlog rank must preserve its open deadline reason.");
  }
  if (
    rankReasons.some((reason) => reason.startsWith("verified_")) !== hasDeadline
  ) {
    throw new Error("Task candidate rank does not match its deadline evidence.");
  }
  const newestSourceRefreshAt = isoValue(
    candidate.newestSourceRefreshAt,
    "newestSourceRefreshAt",
    { required: true },
  )!;
  if (newestSourceRefreshAt !== sourceRefs[0].refreshedAt) {
    throw new Error("Candidate freshness must match its newest source refresh.");
  }
  return {
    candidateId,
    taskId,
    outcomeKey: stringValue(candidate.outcomeKey, "outcomeKey", {
      required: true,
      max: 240,
    })!,
    title: stringValue(candidate.title, "title", { required: true, max: 240 })!,
    outcome: stringValue(candidate.outcome, "outcome", { required: true, max: 1200 })!,
    definitionOfDone: stringValue(candidate.definitionOfDone, "definitionOfDone", {
      max: 1200,
    }),
    project: stringValue(candidate.project, "project", { max: 120 }),
    owner: owner as DayPlanOwner,
    commitment: "ink",
    whyToday,
    priority: priority as RecommendationCandidate["priority"],
    dueAt,
    sourceRefs,
    newestSourceRefreshAt,
    conflicts: [],
    humanDecisionEventIds: stringArray(
      candidate.humanDecisionEventIds,
      "humanDecisionEventIds",
      { maxItems: 20, maxLength: 200 },
    ),
    rankReasons,
  };
}

function timezoneValue(value: unknown): string {
  const timezone = stringValue(value, "timezone", { required: true, max: 100 })!;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("timezone must be a valid IANA timezone.");
  }
  return timezone;
}

function localDateValue(value: unknown): string {
  const localDate = stringValue(value, "localDate", {
    required: true,
    max: 10,
    pattern: LOCAL_DATE,
  })!;
  const parsed = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== localDate) {
    throw new Error("localDate must be a real calendar date.");
  }
  return localDate;
}

function mutationIdValue(value: unknown): string {
  return stringValue(value, "mutationId", {
    required: true,
    max: 240,
    pattern: MUTATION_ID,
  })!;
}

function creationValue(value: unknown): "automatic" | "manual" {
  const creation = stringValue(value, "creation", { max: 20 }) ?? "automatic";
  if (creation !== "automatic" && creation !== "manual") {
    throw new Error("creation must be automatic or manual.");
  }
  return creation;
}

export function parseDayPlanPostBody(value: unknown): ParsedPost {
  const body = recordValue(value, "request body");
  const action = stringValue(body.action, "action", { required: true, max: 40 });
  if (action === "ensure") {
    // The client sends a small deterministic candidate pool; the store keeps
    // at most three items after any Morning Brief overlay.
    if (!Array.isArray(body.candidates) || body.candidates.length > 10) {
      throw new Error("Arrival supports at most ten candidates.");
    }
    const candidates = body.candidates.map(candidateValue);
    if (new Set(candidates.map((candidate) => candidate.taskId)).size !== candidates.length) {
      throw new Error("Arrival candidates must reference distinct tasks.");
    }
    if (new Set(candidates.map((candidate) => candidate.outcomeKey)).size !== candidates.length) {
      throw new Error("Arrival candidates must have distinct outcomes.");
    }
    return {
      action: "ensure",
      input: {
        localDate: localDateValue(body.localDate),
        timezone: timezoneValue(body.timezone),
        mutationId: mutationIdValue(body.mutationId),
        candidates,
        creation: creationValue(body.creation),
        // Late-brief poll mode: attach-or-silent-no-op, never a new plan or a
        // ledger row (only a real brief_attach records anything).
        ...(body.attachOnly === true ? { attachOnly: true } : {}),
      },
    };
  }

  if (action === "reconciliation_applied") {
    return {
      action,
      reconciliationId: stringValue(body.reconciliationId, "reconciliationId", {
        required: true,
        max: 200,
      })!,
    };
  }
  if (action === "task_mutation_applied") {
    return {
      action,
      mutationId: stringValue(body.mutationId, "mutationId", { required: true, max: 200 })!,
    };
  }
  if (action === "arrival_interact") {
    return {
      action,
      planId: stringValue(body.planId, "planId", { required: true, max: 200 })!,
      mutationId: mutationIdValue(body.mutationId),
    };
  }
  if (action === "brief_force") {
    return { action, localDate: localDateValue(body.localDate) };
  }
  if (!action || !ACTIONS.has(action as DayPlanMutationAction)) {
    throw new Error("Unknown day-plan action.");
  }
  const expectedVersion = body.expectedVersion;
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
    throw new Error("expectedVersion must be a positive integer.");
  }
  const owner = stringValue(body.owner, "owner", { max: 20 });
  if (owner && !OWNERS.has(owner as DayPlanOwner)) throw new Error("Unknown owner.");
  const title = stringValue(body.title, "title", {
    required: action === "item_add",
    max: 240,
  });
  const outcome = stringValue(body.outcome, "outcome", {
    required: action === "item_add",
    max: 1200,
  });
  const why = stringValue(body.why, "why", {
    required: action === "item_add",
    max: 1200,
  });
  if (action === "item_add" && !owner) throw new Error("owner is required.");
  const disposition = stringValue(body.disposition, "disposition", { max: 20 });
  if (disposition && !DISPOSITIONS.has(disposition as SettlementDisposition)) {
    throw new Error("Unknown closing choice.");
  }
  const progressNote = stringValue(body.progressNote, "progressNote", { max: 500 });
  const nextStep = stringValue(body.nextStep, "nextStep", { max: 200 });
  if (
    (progressNote || nextStep) &&
    (action !== "settlement_decide" || disposition !== "progress")
  ) {
    throw new Error("Progress details must use the Progress choice.");
  }
  const position = body.position;
  if (position !== undefined && !Number.isInteger(position)) {
    throw new Error("position must be an integer.");
  }
  return {
    action: action as DayPlanMutationAction,
    input: {
      action: action as DayPlanMutationAction,
      planId: stringValue(body.planId, "planId", { required: true, max: 200 })!,
      mutationId: mutationIdValue(body.mutationId),
      expectedVersion: expectedVersion as number,
      itemId: stringValue(body.itemId, "itemId", { max: 240 }),
      title,
      outcome,
      definitionOfDone: stringValue(body.definitionOfDone, "definitionOfDone", {
        max: 1200,
      }),
      why,
      owner: owner as DayPlanOwner | undefined,
      position: position as number | undefined,
      snoozedUntil: isoValue(body.snoozedUntil, "snoozedUntil"),
      disposition: disposition as SettlementDisposition | undefined,
      deferUntil: isoValue(body.deferUntil, "deferUntil"),
      progressNote,
      nextStep,
      completedHumanTaskIds: stringArray(
        body.completedHumanTaskIds,
        "completedHumanTaskIds",
        { maxItems: 10, maxLength: 200 },
      ),
      nextDayNote: nextDayNoteValue(body.nextDayNote),
    },
  };
}

function publicPlan(
  store: DayPlanStore,
  plan: DayPlan,
  accessMode: DayPlanAccessMode | undefined,
): DayPlan {
  return publicDayPlan(store.withSettlementEvidence(plan), accessMode);
}

// The consumed Morning Brief, projected for the read model. Content is only
// exposed on loopback requests and only for the artifact this plan actually
// consumed, so an arrival can never hot-swap to a different brief mid-day.
function readModelMorningBrief(
  store: DayPlanStore,
  plan: { briefId?: string; localDate: string; timezone: string } | undefined,
) {
  try {
    const accessMode = currentDayPlanAccessMode();
    if (accessMode !== "loopback") return undefined;
    if (!plan?.briefId) return undefined;
    const artifact = store.getMorningBrief(plan.briefId);
    if (!artifact) return undefined;
    const brief = morningBriefFromArtifact(artifact);
    if (!brief) return undefined;
    const dated = stripMorningBriefDateClaim(brief, plan.localDate, plan.timezone);
    return publicMorningBrief(
      artifact,
      dated.brief,
      accessMode,
      store.morningBriefManagementSummary(artifact.id),
    );
  } catch {
    return undefined;
  }
}

// The brief generation/availability state for the plan's target date.
// Loopback-only, gated exactly like brief content: a remote session must not
// learn whether a brief exists or is being written. Fail-open: any error yields
// no field and the arrival stays quiet. Carries no brief_json.
function readModelBriefGeneration(
  store: DayPlanStore,
  plan: { localDate?: string } | undefined,
  accessMode: DayPlanAccessMode | undefined,
) {
  try {
    if (accessMode !== "loopback") return undefined;
    if (!plan?.localDate) return undefined;
    // A live generation on the other machine keeps the arrival in-progress until
    // its artifact syncs in and is imported. Fail-open: no status = no attempt.
    const remoteAttempt = liveRemoteBriefAttempt({ targetLocalDate: plan.localDate });
    const generation = selectMorningBriefGeneration(
      store.listMorningBriefs(plan.localDate),
      plan.localDate,
      new Date(),
      {
        remoteAttempt: remoteAttempt ? { startedAt: remoteAttempt.startedAt } : undefined,
        runningStaleAfterMs: morningBriefStaleAfterMs(),
      },
    );
    // Only a live run needs an estimate, and only a live run pays for the query.
    if (generation.state !== "queued" && generation.state !== "running") return generation;
    return {
      ...generation,
      estimateSeconds: estimateBriefSeconds(store.recentBriefDurationsSeconds()),
    };
  } catch {
    return undefined;
  }
}

async function completedPlanTaskIds(
  plan: DayPlan,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const baseUrl = defaultBriefWebBase().replace(/\/$/, "");
  const [taskRows, columnRows] = await Promise.all([
    fetchRows(
      fetchImpl,
      baseUrl,
      "tasks",
      10_000,
      "select=id,column_id,status,updated_at",
    ),
    fetchRows(
      fetchImpl,
      baseUrl,
      "task_columns",
      10_000,
      "select=id,name&order=position.asc",
    ),
  ]);
  const doneColumnIds = new Set(
    columnRows.flatMap((value) => {
      const row = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
      return row && typeof row.id === "string" &&
        typeof row.name === "string" && taskColumnKeyForName(row.name) === "done"
        ? [row.id]
        : [];
    }),
  );
  const completedIds = new Set(
    taskRows.flatMap((value) => {
      const row = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
      return row && typeof row.id === "string" &&
        (row.status === "done" ||
          (typeof row.column_id === "string" && doneColumnIds.has(row.column_id)))
        ? [row.id]
        : [];
    }),
  );
  return plan.items
    .filter(
      (item) =>
        (item.decision === "accepted" || item.decision === "completed") &&
        completedIds.has(item.taskId),
    )
    .map((item) => item.taskId);
}

export async function GET(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  try {
    const store = getDayPlanStore();
    try {
      store.initialize();
    } catch (error) {
      console.error("Day plan initialization skipped.", error);
    }
    const accessMode = currentDayPlanAccessMode();
    // One read model read: the projection is derived from the same plan the
    // response carries, so plan.briefId and the brief id always agree.
    const readModel = store.getReadModel();
    const morningBrief = readModelMorningBrief(store, readModel.currentPlan);
    const briefGeneration = readModelBriefGeneration(
      store,
      readModel.currentPlan,
      accessMode,
    );
    return NextResponse.json({
      ...readModel,
      currentPlan: readModel.currentPlan
        ? publicPlan(store, readModel.currentPlan, accessMode)
        : undefined,
      ...(morningBrief ? { morningBrief } : {}),
      ...(briefGeneration ? { briefGeneration } : {}),
      csrfToken: getQuietCurrentCsrfToken(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Day plan failed." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  const suppliedToken = request.headers.get("x-cove-csrf");
  if (!suppliedToken || suppliedToken !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
  }

  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Day-plan request is too large." }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Day-plan request is too large." }, { status: 413 });
    }
    const parsed = parseDayPlanPostBody(JSON.parse(text) as unknown);
    const store = getDayPlanStore();
    if (parsed.action === "brief_force") {
      // "Brief me anyway": the one path that writes a brief past the gate. It is
      // loopback-only for the same reason brief content is.
      if (currentDayPlanAccessMode() !== "loopback") {
        return NextResponse.json(
          { error: "Morning brief actions are only available on this machine." },
          { status: 403 },
        );
      }
      // Import a peer artifact BEFORE deciding anything. Without this, a brief
      // the Mini already finished and synced to disk is invisible here and the
      // tap buys a second generation of a brief we own.
      scanAndImportBriefRelay({ store, targetLocalDate: parsed.localDate });
      const staleBefore = new Date(Date.now() - morningBriefStaleAfterMs()).toISOString();
      store.interruptStaleMorningBriefs(staleBefore);
      // Idempotent by design, because this button is the one a frustrated person
      // taps twice. A finished brief already exists, or this machine has a live
      // row, or the peer is mid-generation: in all three cases the answer is the
      // state we already have, not a second paid generation.
      const alreadyDone = store.latestEligibleMorningBrief(parsed.localDate);
      const peerIsWriting = Boolean(
        liveRemoteBriefAttempt({ targetLocalDate: parsed.localDate }),
      );
      // The brief can exist and still be invisible: one that finishes after he
      // has touched the arrival is held out by the no-hot-swap guard forever.
      // That is exactly the state this button is pressed in, so pressing it
      // attaches what we already have instead of doing nothing at all.
      const attached = alreadyDone
        ? store.forceAttachMorningBrief(parsed.localDate, alreadyDone.id)
        : false;
      if (!alreadyDone && !peerIsWriting) {
        // enqueueMorningBrief itself returns the live row when one exists, so a
        // local in-flight generation is never duplicated either.
        const relayStore = withQueuedAttemptStatus(store);
        relayStore.enqueueMorningBrief(parsed.localDate, morningBriefModelConfig());
      }
      return NextResponse.json({
        attached,
        briefGeneration: readModelBriefGeneration(
          store,
          { localDate: parsed.localDate },
          currentDayPlanAccessMode(),
        ),
      });
    }
    if (parsed.action === "arrival_interact") {
      // Durable first-interaction marker: freezes the arrival against a late
      // brief attach. Idempotent on the mutation id; never bumps the version.
      const marked = store.markArrivalInteraction(parsed.planId, parsed.mutationId);
      return NextResponse.json({
        plan: publicPlan(store, marked.plan, currentDayPlanAccessMode()),
        replayed: marked.replayed,
      });
    }
    // Import any synced relay artifact BEFORE ensuring or evaluating triggers, so
    // a just-synced brief is consumed (or late-attached) instead of regenerated.
    // Fail-open and only meaningful on the loopback operator surface.
    if (parsed.action === "ensure" && currentDayPlanAccessMode() === "loopback") {
      scanAndImportBriefRelay({ store, targetLocalDate: parsed.input.localDate });
    }
    if (parsed.action === "settlement_start") {
      const plan = store.getPlan(parsed.input.planId);
      if (!plan) throw new DayPlanNotFound();
      // Settlement completion is reconciled from canonical Cove REST state at
      // open time. The returned versioned plan, not the browser's cached board,
      // owns the Completed/Unresolved split. Fail open on a transient REST
      // failure: omitting the optional ids preserves the plan's last-known
      // decisions and still lets the Settlement dialog open.
      try {
        parsed.input.completedHumanTaskIds = stringArray(
          await completedPlanTaskIds(plan),
          "completedHumanTaskIds",
          { maxItems: 10, maxLength: 200 },
        );
      } catch {
        parsed.input.completedHumanTaskIds = undefined;
      }
    }
    if (
      parsed.action === "settlement_decide" &&
      parsed.input.disposition === "carry" &&
      getRuntimeMode() === "local"
    ) {
      assertRecurringCarryAllowed(store, parsed.input);
    }
    const result = parsed.action === "ensure"
      ? store.ensureDayPlan(parsed.input)
      : parsed.action === "reconciliation_applied"
        ? store.acknowledgeReconciliation(parsed.reconciliationId)
        : parsed.action === "task_mutation_applied"
          ? store.acknowledgeTaskMutation(parsed.mutationId)
        : store.mutateDayPlan(parsed.input);
    if (
      parsed.action === "settlement_commit" &&
      getRuntimeMode() === "local" &&
      "plan" in result
    ) {
      expireRecurringInstances({
        localDate: result.plan.localDate,
      });
    }
    // Trigger-driven enqueues announce themselves to the relay as `queued`
    // immediately (see withQueuedAttemptStatus), closing the enqueue→claim
    // duplicate-generation window.
    maybeQueueMorningBrief(withQueuedAttemptStatus(store), parsed.action, result, new Date(), {
      isRemoteAttemptLive: (date) =>
        Boolean(liveRemoteBriefAttempt({ targetLocalDate: date })),
    });
    // The MBP settles days; refresh the settlement relay so the Mini's next
    // brief sees the same reconciliation summary, and publish the source
    // checkpoint alongside it. Role-gated: a machine that itself gates on the
    // checkpoint (the Mini sets COVE_BRIEF_REQUIRE_SOURCE_CHECKPOINT=1) is not
    // the authoritative source publisher and must never write it. Fail-open.
    if (parsed.action === "settlement_commit" || parsed.action === "reconciliation_applied") {
      writeSettlementRelay({ store });
      if (coveEnv("BRIEF_REQUIRE_SOURCE_CHECKPOINT") !== "1") {
        // Closing a day is the moment the closure fact changes. Publishing it
        // here as well as on the worker's 5-minute cadence means the peer's next
        // scheduled run sees the close immediately rather than up to 5 minutes
        // late. Role-gated with the writes below for one reason: day_plans is
        // per-machine, so a second publisher speaks about a different day than
        // the one the gate is meant to describe. One ritual machine, one voice.
        writeDayClosureRelay({ store });
        writeSourceCheckpoint({
          sources: briefCheckpointSources(),
        });
      }
    }
    const queuedRuns = parsed.action === "start_day" && "executionRuns" in result
      ? result.executionRuns?.filter((run) => run.status === "queued").length ?? 0
      : 0;
    const accessMode = currentDayPlanAccessMode();
    // Every payload that carries a plan goes through the same public
    // projection (brief annotations and briefId are loopback-only).
    const publicResult = "plan" in result
      ? {
          ...result,
          plan: publicPlan(store, result.plan, accessMode),
          executionRuns: result.executionRuns?.map((run) =>
            publicExecutionRun(run, accessMode),
          ),
          unreadyItems: result.unreadyItems?.map(publicUnreadyItem),
          kickoffSkips: result.kickoffSkips?.map(publicKickoffSkip),
          ...(parsed.action === "start_day"
            ? {
                worker: {
                  queuedRuns,
                  available: isClaudeWorkerAvailable(),
                },
              }
            : {}),
        }
      : result;
    return NextResponse.json(publicResult, {
      status:
        parsed.action === "ensure" && !("weekendGate" in result)
          ? 201
          : 200,
    });
  } catch (error) {
    if (error instanceof DayPlanVersionConflict) {
      return NextResponse.json(
        {
          error: "version_conflict",
          currentPlan: publicPlan(
            getDayPlanStore(),
            error.currentPlan,
            currentDayPlanAccessMode(),
          ),
        },
        { status: 409 },
      );
    }
    if (error instanceof DayPlanNotFound) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof DayPlanInvalidTransition || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof Error &&
      /required|invalid|unknown|must|supports|candidate|too long|too many/i.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Day plan failed." },
      { status: 500 },
    );
  }
}
