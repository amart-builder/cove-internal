// Client-safe (no node imports): decides how the client's held Morning Brief
// projection reconciles with a newly accepted plan. The brief state is keyed
// to plan.briefId, so yesterday's brief can never render against today's plan.
export type MorningBriefSyncDecision = "keep" | "clear" | "refresh";

export function morningBriefSyncDecision(
  planBriefId: string | undefined,
  heldBrief: { id: string } | undefined,
): MorningBriefSyncDecision {
  // A plan that consumed no brief must never show one.
  if (!planBriefId) return heldBrief ? "clear" : "keep";
  // Holding exactly the consumed artifact: nothing to do.
  if (heldBrief?.id === planBriefId) return "keep";
  // The plan consumed a brief the client does not hold (or holds the wrong
  // one): refetch the projection pinned to this plan.
  return "refresh";
}
