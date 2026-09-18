import { morningBriefFromArtifact } from "./brief";
import { relinkSuggestionResponsibility } from "../responsibility/suggestion-links";
import { taskColumnKeyForName } from "../tasks/columns";
/** Transactional links between the day decision and existing source stores. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import type {
  DailyDecision,
  PlannedAction,
  PlanningReference,
} from "../chief-of-staff/daily-planning";
import type { QuietCurrentStore, WorkSuggestion } from "../quiet-current/store";
import { transactQuietCurrent } from "../quiet-current/persistence";
import {
  sourceRecord,
  activeResponsibilitySource,
  sourceVersion,
  type Responsibility,
} from "../responsibility/store";
import type { DayPlan, DayPlanItem, RecommendationCandidate } from "./types";
import { coveEnv } from "../env";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
function quiet<T>(
  db: Database.Database,
  fn: (state: QuietCurrentStore) => T,
): T {
  return transactQuietCurrent(
    db,
    path.join(
      path.dirname(db.name),
      path.basename(coveEnv("QUIET_CURRENT_FILE") ?? "quiet-current.json"),
    ),
    () => ({ version: 1 as const, suggestions: [], decisionEvents: [] }),
    fn,
  );
}
export function assertPlanningReference(
  db: Database.Database,
  ref: PlanningReference,
): void {
  const source = sourceRecord(db, ref.kind, ref.id);
  if (
    !source ||
    sourceVersion(source) !== ref.version ||
    !activeResponsibilitySource(source)
  )
    throw new Error("planning_source_changed");
  if (ref.kind !== "calendar") {
    const row = db
      .prepare(
        "SELECT revision,parent_kind,parent_id,parent_version FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?",
      )
      .get(ref.kind, ref.id) as Responsibility | undefined;
    if (!row || row.revision !== ref.revision)
      throw new Error("planning_responsibility_changed");
    if (row.parent_kind && row.parent_id) {
      const parent = sourceRecord(db, row.parent_kind, row.parent_id);
      if (!parent || sourceVersion(parent) !== row.parent_version)
        throw new Error("planning_source_changed");
    }
  }
}
export function persistDecisionLinks(
  db: Database.Database,
  decision: DailyDecision,
  now: Date,
  options: { applyExisting?: boolean } = {},
): RecommendationCandidate[] {
  // Validate all references before the first write; the caller holds IMMEDIATE.
  for (const ref of [
    ...decision.actions.map((a) => a.source),
    ...decision.actions.flatMap((a) => a.supportingSources ?? []),
    ...decision.watches,
    ...decision.questions.map((q) => q.source),
  ])
    assertPlanningReference(db, ref);
  const candidates: RecommendationCandidate[] = [];
  for (const action of decision.actions) {
    let kind: "task" | "commitment" | "suggestion";
    let id = action.source.id;
    let createdProposal = false;
    if (
      !action.proposal &&
      action.source.kind === "commitment" &&
      !sourceRecord(db, "commitment", id)?.confirmed
    )
      throw new Error("planning_commitment_requires_confirmation");
    if (action.proposal) {
      const key = `daily:${action.source.kind}:${id}:${action.proposal.key}`;
      const suggestion = quiet(db, (state) => {
        const existing = state.suggestions.find((s) => s.claimKey === key);
        if (existing) {
          if (options.applyExisting === false) return existing;
          if (["proposed", "refined", "deferred"].includes(existing.state)) {
            existing.reviewMaterial = JSON.stringify({
              source: action.source,
              assumptions: action.assumptions,
              plannedFor: action.plannedFor,
            });
            existing.updatedAt = now.toISOString();
            if (existing.state === "proposed") {
              existing.title = action.proposal!.title;
              existing.description = action.proposal!.description;
              existing.reason = action.rationale;
            }
          }
          return existing;
        }
        const proposal: WorkSuggestion = {
          id: `plan-${digest(key)}`,
          kind: "create_task",
          title: action.proposal!.title,
          description: action.proposal!.description,
          reason: action.rationale,
          source: "daily-planning",
          priority: "medium",
          claimKey: key,
          reviewMaterial: JSON.stringify({
            source: action.source,
            assumptions: action.assumptions,
            plannedFor: action.plannedFor,
          }),
          state: "proposed",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(+now + 7 * 86400000).toISOString(),
        };
        createdProposal = true;
        state.suggestions.push(proposal);
        state.decisionEvents.push({
          id: randomUUID(),
          eventType: "suggestion_create",
          entityId: proposal.id,
          after: proposal,
          source: "daily-planning",
          createdAt: now.toISOString(),
        });
        return proposal;
      });
      if (["dismissed", "expired"].includes(suggestion.state)) continue;
      kind =
        suggestion.state === "accepted" && suggestion.resolvedTaskId
          ? "task"
          : "suggestion";
      id = kind === "task" ? suggestion.resolvedTaskId! : suggestion.id;
    } else {
      if (action.source.kind === "calendar")
        throw new Error("calendar_requires_proposal");
      kind = action.source.kind;
    }
    let source = sourceRecord(db, kind, id);
    if (!source || !activeResponsibilitySource(source)) continue;
    if (options.applyExisting === false && !createdProposal) continue;
    if (kind === "suggestion" && !action.proposal) {
      const prior = db.prepare("SELECT * FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?").get(id) as Responsibility | undefined;
      if (prior?.parent_kind && prior.parent_id) {
        quiet(db, state => {
          const suggestion = state.suggestions.find(s => s.id === id);
          if (!suggestion) return;
          suggestion.reviewMaterial = JSON.stringify({
            source: { kind: prior.parent_kind, id: prior.parent_id, version: prior.parent_version },
            assumptions: action.assumptions, plannedFor: action.plannedFor,
          });
          suggestion.updatedAt = now.toISOString();
        });
        source = sourceRecord(db, kind, id)!;
      }
    }
    const stamp = now.toISOString();
    const linkedRow = db.prepare("SELECT parent_kind,parent_id FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?").get(kind,id) as Responsibility | undefined;
    const parentKind = action.proposal ? action.source.kind : linkedRow?.parent_kind;
    const parentId = action.proposal ? action.source.id : linkedRow?.parent_id;
    const parent = parentKind && parentId ? sourceRecord(db,parentKind,parentId) : undefined;
    const checkBounds = [action.nextCheckAt, action.plannedFor, parentKind === "calendar" ? parent?.due_at : null]
      .filter((value): value is string => Boolean(value)).map(Date.parse).filter(Number.isFinite);
    const nextCheck = new Date(Math.max(+now, Math.min(...checkBounds))).toISOString();
    db.prepare(
      `INSERT INTO cove_responsibilities(ref_kind,ref_id,original_due_at,source_version,state,owner,next_action,next_check_at,planned_for,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ref_kind,ref_id) DO UPDATE SET source_version=excluded.source_version,state=excluded.state,owner=excluded.owner,next_action=excluded.next_action,next_check_at=excluded.next_check_at,planned_for=excluded.planned_for,revision=revision+1,updated_at=excluded.updated_at`,
    ).run(
      kind,
      id,
      source.due_at,
      sourceVersion(source),
      action.state,
      kind === "suggestion"
        ? "Cove (proposal check)"
        : action.owner === "me"
          ? "you"
          : action.owner,
      action.nextAction,
      nextCheck,
      action.plannedFor,
      stamp,
      stamp,
    );
    if (action.proposal)
      db.prepare(
        "UPDATE cove_responsibilities SET parent_kind=?,parent_id=?,parent_version=? WHERE ref_kind=? AND ref_id=?",
      ).run(
        action.source.kind,
        action.source.id,
        action.source.version,
        kind,
        id,
      );
    const r = db
      .prepare(
        "SELECT revision FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?",
      )
      .get(kind, id) as { revision: number };
    db.prepare(
      "INSERT INTO cove_responsibility_events VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      kind,
      id,
      "daily_plan_proposed",
      JSON.stringify({
        source: action.source,
        assumptions: action.assumptions,
        why: action.rationale,
      }),
      stamp,
    );
    candidates.push({
      candidateId: `${kind}:${id}`,
      taskId: kind === "task" ? id : `${kind}:${id}`,
      outcomeKey: `${kind}:${id}`,
      title: action.nextAction,
      outcome: source.title,
      definitionOfDone: action.proposal?.description,
      owner: kind === "suggestion" ? "me" : action.owner,
      commitment: kind === "suggestion" ? "pencil" : "ink",
      whyToday: action.rationale,
      priority: "medium",
      sourceRefs: [
        {
          sourceType:
            kind === "task"
              ? "task"
              : kind === "suggestion"
                ? "suggestion"
                : "decision",
          recordId: id,
          sourceUpdatedAt: source.updated_at ?? stamp,
          refreshedAt: stamp,
          freshness: "current",
          supports: ["priority"],
        },
      ],
      newestSourceRefreshAt: stamp,
      conflicts: [],
      humanDecisionEventIds: [],
      rankReasons: [],
      planningRef: { kind, id, revision: r.revision },
      // Keep the schedule this action was timed against readable after the
      // decision is stored, so a later read can see that it moved.
      ...(action.supportingSources?.length
        ? {
            planningSupport: action.supportingSources.map((support) => ({
              kind: support.kind,
              id: support.id,
              version: support.version,
            })),
          }
        : {}),
      planningState: action.state,
      planningAssumptions: action.assumptions,
    });
  }
  for (const q of decision.questions) {
    const id = `question-${digest(`${q.outcomeKey}:${q.decisionKey}`)}`;
    // An unanswered question retains identity; answered decisions remain evidence.
    db.prepare(
      `INSERT INTO cove_planning_questions(id,outcome_key,decision_key,question,ref_kind,ref_id,state,next_check_at,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'open',?,?,?,?) ON CONFLICT(outcome_key,decision_key) DO UPDATE SET next_check_at=MIN(next_check_at,excluded.next_check_at),updated_at=excluded.updated_at WHERE state='open'`,
    ).run(
      id,
      q.outcomeKey,
      q.decisionKey,
      q.question,
      q.source.kind,
      q.source.id,
      q.nextCheckAt,
      q.expiresAt,
      now.toISOString(),
      now.toISOString(),
    );
  }
  return candidates;
}
export function acceptPlanningProposal(
  db: Database.Database,
  item: DayPlanItem,
  now: Date,
): void {
  if (item.planningRef?.kind !== "suggestion") return;
  const id = item.planningRef.id;
  quiet(db, (state) => {
    const s = state.suggestions.find((s) => s.id === id);
    if (
      !s ||
      !["proposed", "refined", "accepted"].includes(s.state) ||
      (s.state !== "accepted" && Date.parse(s.expiresAt) <= +now)
    )
      throw new Error(
        "This proposal is no longer available. Refresh your plan.",
      );
    if (s.state !== "accepted") {
      const responsibility = db.prepare("SELECT revision,source_version FROM cove_responsibilities WHERE ref_kind='suggestion' AND ref_id=?").get(id) as {revision:number;source_version:string} | undefined;
      const current = sourceRecord(db,"suggestion",id);
      if (!responsibility || !current || item.planningStale || responsibility.revision !== item.planningRef!.revision || responsibility.source_version !== sourceVersion(current))
        throw new Error("This proposal changed. Review a fresh recommendation before accepting it.");
    }
    if (s.reviewMaterial && s.state !== "accepted") {
      const origin = JSON.parse(s.reviewMaterial).source as
        | PlanningReference
        | undefined;
      if (origin) {
        const current = sourceRecord(db, origin.kind, origin.id);
        if (
          !current ||
          !activeResponsibilitySource(current) ||
          sourceVersion(current) !== origin.version
        )
          throw new Error(
            "The source for this proposal changed. Review a fresh recommendation before accepting it.",
          );
      }
    }
    const taskId = s.resolvedTaskId ?? `accepted-${digest(id)}`;
    if (s.state !== "accepted") {
      const today = (
        db
          .prepare("SELECT id,name FROM task_columns ORDER BY position")
          .all() as Array<{ id: string; name: string }>
      ).find((c) => taskColumnKeyForName(c.name) === "today");
      if (!today)
        throw new Error("Cove needs a Today list before accepting work.");
      db.prepare(
        `INSERT INTO tasks(id,column_id,title,description,priority,project,status,source_type,remind_native,remind_text,created_at,updated_at,origin) VALUES(?,?,?,?,?,'Cove','open','manual',1,0,?,?,?)`,
      ).run(
        taskId,
        today.id,
        item.title,
        s.description,
        s.priority,
        now.toISOString(),
        now.toISOString(),
        `Accepted from Cove's proposed daily plan: ${s.reason}`,
      );
      const before = { ...s };
      s.state = "accepted";
      s.resolvedTaskId = taskId;
      s.updatedAt = now.toISOString();
      state.decisionEvents.push({
        id: randomUUID(),
        eventType: "suggestion_accept",
        entityId: id,
        before,
        after: s,
        source: "day-plan",
        createdAt: now.toISOString(),
      });
    }
    relinkSuggestionResponsibility(db, id, taskId, now);
    const r = db
      .prepare(
        "SELECT revision FROM cove_responsibilities WHERE ref_kind='task' AND ref_id=?",
      )
      .get(taskId) as { revision: number };
    item.taskId = taskId;
    item.sourceRefs = [
      {
        sourceType: "task",
        recordId: taskId,
        sourceUpdatedAt: now.toISOString(),
        refreshedAt: now.toISOString(),
        freshness: "current",
        supports: ["commitment"],
      },
    ];
    item.commitment = "ink";
    item.planningRef = { kind: "task", id: taskId, revision: r?.revision ?? 1 };
  });
}
export function resolvePlanningItems(
  db: Database.Database,
  plan: DayPlan,
): DayPlan {
  return {
    ...plan,
    items: plan.items.map((item) => {
      if (!item.planningRef) return item;
      const ref = item.planningRef;
      const source = sourceRecord(db, ref.kind, ref.id);
      const row = db
        .prepare(
          "SELECT * FROM cove_responsibilities WHERE ref_kind=? AND ref_id=?",
        )
        .get(ref.kind, ref.id) as Responsibility | undefined;
      const parent =
        row?.parent_kind && row.parent_id
          ? sourceRecord(db, row.parent_kind, row.parent_id)
          : undefined;
      const parentChanged = Boolean(
        row?.parent_kind &&
        (!parent ||
          !activeResponsibilitySource(parent) ||
          sourceVersion(parent) !== row.parent_version),
      );
      // A supporting schedule is evidence, not the work. When the meeting a
      // reused preparation was timed against moves, is cancelled or disappears,
      // the timing rationale is obsolete, so it is withdrawn and a fresh
      // recommendation is pending. The accepted work keeps its own state: a
      // moved meeting never resolves, cancels or blocks it.
      const supportChanged = (item.planningSupport ?? []).some((support) => {
        const record = sourceRecord(db, support.kind, support.id);
        return (
          !record ||
          !activeResponsibilitySource(record) ||
          sourceVersion(record) !== support.version
        );
      });
      const resolved = !source || !activeResponsibilitySource(source);
      const changed =
        parentChanged ||
        resolved ||
        !row ||
        row.revision !== ref.revision ||
        row.source_version !== sourceVersion(source!);
      // Withdrawing the annotation must not reintroduce the key on every read:
      // storage drops an undefined value, so an unconditional `brief: undefined`
      // would make each resolution look like a change and bump the version.
      const withdrawBrief = item.brief === undefined ? {} : { brief: undefined };
      return {
        ...item,
        planningState: resolved
          ? "resolved"
          : parentChanged
            ? "blocked"
            : !row || row.source_version !== sourceVersion(source!) ? "blocked" : row.state,
        title: resolved ? item.title : (row?.next_action ?? item.title),
        planningRef: { ...ref, revision: row?.revision ?? ref.revision },
        ...(changed
          ? {
              ...withdrawBrief,
              whyToday:
                "Current source state changed. A fresh recommendation is pending.",
              planningAssumptions: [],
              planningStale: true,
            }
          : supportChanged
            ? {
                ...withdrawBrief,
                whyToday:
                  "A scheduled event this preparation was timed against changed. The work is still yours; a fresh recommendation is pending for its timing.",
                planningAssumptions: [],
                planningStale: true,
              }
            : {}),
      };
    }),
  };
}
export function decisionMatchesPlan(
  decision: DailyDecision,
  plan: DayPlan | null,
): boolean {
  return (
    decision.basePlanId === (plan?.id ?? null) &&
    decision.basePlanVersion === (plan?.version ?? null)
  );
}
export function plannedActionReference(action: PlannedAction): string {
  return `${action.source.kind}:${action.source.id}`;
}

/** Preserve the written brief; current choices remain authoritative in plan.items. */
export function projectPlanningBrief(
  db: Database.Database,
  plan: DayPlan,
  artifact: import("./brief").MorningBriefArtifact | undefined,
): import("./brief").PublicMorningBrief {
  const selected = [...plan.items]
    .filter((i) => ["preselected", "pending", "accepted"].includes(i.decision))
    .sort((a, b) => a.position - b.position);
  // The brief is a saved document, not a summary of the current selection.
  // Editing Today must never replace its prose with task titles or rationales.
  // Missing/corrupt artifacts expose no narrative so Arrival can show recovery.
  const written = morningBriefFromArtifact(artifact);
  const linked = written?.dailyDecision;
  const headline = written?.headline;
  const narrative = written?.narrativeParagraphs ?? [];
  const watches: import("./brief").MorningBriefWatchItem[] = [];
  const refs = [
    ...(linked?.watches ?? []),
    ...selected
      .filter((i) => i.planningRef?.kind === "suggestion")
      .map((i) => ({ kind: i.planningRef!.kind, id: i.planningRef!.id })),
  ];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = db
      .prepare(
        "SELECT * FROM cove_responsibilities WHERE ref_kind=? AND ref_id=? AND state<>'resolved'",
      )
      .get(ref.kind, ref.id) as Responsibility | undefined;
    const source = sourceRecord(db, ref.kind, ref.id);
    if (!r || !source || !activeResponsibilitySource(source)) continue;
    const parent = r.parent_kind && r.parent_id ? sourceRecord(db, r.parent_kind, r.parent_id) : undefined;
    const stale = sourceVersion(source) !== r.source_version || Boolean(r.parent_kind && (!parent || !activeResponsibilitySource(parent) || sourceVersion(parent) !== r.parent_version));
    const state = stale ? "blocked" : r.state;
    watches.push({
      recordId: key,
      label: source.title,
      evidence: `${r.owner}. ${state}. Next check: ${new Intl.DateTimeFormat("en-US", { timeZone: plan.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(r.next_check_at))}.`,
      lastSeenState: state,
      evidenceRefs: [key],
    });
  }
  return {
    id: artifact?.id ?? `plan:${plan.id}`,
    targetLocalDate: plan.localDate,
    generatedAt: artifact?.finishedAt ?? plan.updatedAt,
    modelAlias: artifact?.modelAlias ?? "",
    effort: artifact?.effort ?? "",
    writer: artifact?.writer,
    planVersion: plan.version,
    headline,
    narrativeParagraphs: narrative,
    lensNarrative: written?.lensNarrative ?? "",
    watchItems: watches,
    ...(!artifact || plan.items.some((i) => i.planningStale)
      ? {
          statusNote:
            "This is your current selection. A fresh recommendation has not been committed yet.",
        }
      : {}),
  };
}
