import { morningBriefModelConfig } from "../claude-execution/brief-commands";
import {
  localDateInTimezone,
  nextBriefTargetLocalDate,
  settlementReconciliationComplete,
} from "./brief";
import { writeBriefAttemptStatus } from "./brief-relay";
import type { MorningBriefArtifact } from "./brief";
import type {
  DayPlan,
  DayPlanMutationResult,
  DayPlanReconciliation,
  DayPlanReconciliationResult,
} from "./types";

// The slice of the store the trigger decision needs. Structural so tests can
// exercise every branch with a recording fake instead of a full settlement flow.
export type MorningBriefTriggerStore = {
  listPendingReconciliations(): DayPlanReconciliation[];
  getPlan(id: string): DayPlan | undefined;
  latestEligibleMorningBrief(
    targetLocalDate: string,
  ): MorningBriefArtifact | undefined;
  enqueueMorningBrief(
    targetLocalDate: string,
    provenance: { modelAlias: string; effort: string; budgetUsd: number },
  ): unknown;
};

// Wraps a trigger store so every REAL enqueue (created: true) immediately
// publishes a write-once `queued` attempt-status file to the relay. Without
// this, the first status the peer machine sees is `running` after claim,
// leaving an enqueue→claim window in which both machines could start the same
// generation. Fail-open: a status-write failure never blocks the enqueue.
export function withQueuedAttemptStatus(
  store: MorningBriefTriggerStore,
  relay: { dataDir?: string; host?: string; now?: () => Date } = {},
): MorningBriefTriggerStore {
  return {
    listPendingReconciliations: () => store.listPendingReconciliations(),
    getPlan: (id) => store.getPlan(id),
    latestEligibleMorningBrief: (date) => store.latestEligibleMorningBrief(date),
    enqueueMorningBrief: (targetLocalDate, provenance) => {
      const result = store.enqueueMorningBrief(targetLocalDate, provenance);
      try {
        const enqueued = result as { created?: boolean; brief?: { id?: string } };
        if (enqueued?.created && enqueued.brief?.id) {
          writeBriefAttemptStatus(
            { targetLocalDate, attemptId: enqueued.brief.id, state: "queued" },
            { dataDir: relay.dataDir, host: relay.host, now: relay.now?.() },
          );
        }
      } catch {
        // Fail open: the enqueue already succeeded.
      }
      return result;
    },
  };
}

// The settlement triggers enqueue UNCONDITIONALLY: they are never gated on the
// previous day being closed, and that asymmetry is deliberate. Gating them
// deadlocks. Picture an old plan he is never going to close sitting behind a
// day he settles normally: if closing a day could itself be blocked by that
// older day, no brief would ever be produced again. Closing a day always earns
// a brief.
function enqueueAfterSettlement(
  store: MorningBriefTriggerStore,
  settledLocalDate: string,
  timezone: string,
  now: Date,
): void {
  const target = nextBriefTargetLocalDate(settledLocalDate, now, timezone);
  store.enqueueMorningBrief(target, morningBriefModelConfig());
}

// Queues Morning Brief generation on the spec's triggers, always fail-open:
// brief machinery must never block or delay the ritual response.
// - After Day Settlement reconciliation completes for THIS settlement. A
//   settlement with no defer/drop work is complete the moment it commits; one
//   with defer/drop rows completes on its last reconciliation ack. Pending
//   work from an earlier settlement never suppresses it, resurfaces never
//   participate, and idempotent replays never re-queue.
// - When arrival opens (or the plan is ensured) without an eligible artifact:
//   the arrival stays deterministic today and regeneration happens in the
//   background. A plan that already consumed a brief never re-queues.
export function maybeQueueMorningBrief(
  store: MorningBriefTriggerStore,
  action: string,
  result: unknown,
  now: Date = new Date(),
  options: {
    // When the other machine has a live generation for the target date, the
    // MBP's arrival backfill waits for that artifact to sync in rather than
    // racing a second generation. Fail-open: absent predicate = no wait.
    isRemoteAttemptLive?: (targetLocalDate: string) => boolean;
  } = {},
): void {
  try {
    if (action === "settlement_commit") {
      const mutation = result as DayPlanMutationResult;
      // A replayed commit already ran this trigger the first time.
      if (mutation.replayed) return;
      const plan = mutation.plan;
      if (!plan) return;
      if (
        !settlementReconciliationComplete(
          store.listPendingReconciliations(),
          mutation.snapshot?.id,
        )
      ) {
        return;
      }
      enqueueAfterSettlement(store, plan.localDate, plan.timezone, now);
      return;
    }
    if (action === "reconciliation_applied") {
      const ack = result as DayPlanReconciliationResult;
      if (ack.replayed) return;
      const reconciliation = ack.reconciliation;
      // Resurface acks land days after the settlement; only the settlement-night
      // defer/drop applications conclude a settlement's reconciliation.
      if (reconciliation.action === "resurface") return;
      if (
        !settlementReconciliationComplete(
          store.listPendingReconciliations(),
          reconciliation.snapshotId,
        )
      ) {
        return;
      }
      const plan = store.getPlan(reconciliation.dayPlanId);
      if (!plan) return;
      enqueueAfterSettlement(store, plan.localDate, plan.timezone, now);
      return;
    }
    if (action === "ensure" || action === "arrival_open") {
      const plan = (result as DayPlanMutationResult).plan;
      if (!plan || plan.briefId) return;
      // Only today's arrival regenerates. A stale plan surfacing here heads to
      // settlement, whose reconciliation trigger targets the right morning.
      if (plan.localDate !== localDateInTimezone(now, plan.timezone)) return;
      if (store.latestEligibleMorningBrief(plan.localDate)) return;
      // No closure gate here, and none is needed: `day_plans.open_slot` is
      // UNIQUE, so at most one plan is ever unsettled, and ensureDayPlan hands
      // back that open plan whatever date it is asked for. A plan for TODAY can
      // therefore only exist once every earlier day is closed, which the check
      // three lines above already relies on. The blind-backfill case this path
      // was suspected of is unrepresentable in the schema.
      //
      // Backfill waits while the other machine is mid-generation for this date.
      if (options.isRemoteAttemptLive?.(plan.localDate)) return;
      store.enqueueMorningBrief(plan.localDate, morningBriefModelConfig());
    }
  } catch {
    // Fail open. The ritual response already succeeded.
  }
}
