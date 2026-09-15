"use client";
import { useRef, useState } from "react";
import type { DayPlan } from "@/lib/day-plan/types";
import type { PublicMorningBrief } from "@/lib/day-plan/brief";
import { mutateDayPlan, newDayPlanMutationId } from "@/lib/data/day-plan";
import { emitDataChanged } from "@/lib/data/refresh-bus";
import ModalScrim from "./ModalScrim";

export default function PlanningFollowUp({
  plan,
  brief,
}: {
  plan: DayPlan;
  brief?: PublicMorningBrief;
}) {
  const [review, setReview] = useState<{ brief: PublicMorningBrief; planId: string; version: number }>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  async function apply() {
    if (!review?.brief.proposalId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await mutateDayPlan({
        action: "plan_revision_accept",
        planId: review.planId,
        expectedVersion: review.version,
        mutationId: newDayPlanMutationId(),
        briefId: review.brief.proposalId,
      });
      setReview(undefined);
      emitDataChanged(["day_plan", "tasks"]);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The plan changed. Refresh and review the proposal again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  if (!brief?.statusNote && !brief?.proposalId) return null;
  return (
    <aside className="mt-2 text-sm" aria-label="Planning update">
      {(brief.proposalId || brief.statusNote) && (
        <button
          type="button"
          ref={triggerRef}
          className="mt-2 min-h-10 font-medium underline"
          onClick={() => { setError(""); setReview({ brief, planId: plan.id, version: plan.version }); }}
        >
          {brief.proposalId ? 'Review proposed changes' : 'Planning status'}
        </button>
      )}
      {review && (
        <ModalScrim labelledBy="planning-review-title" returnFocus={triggerRef.current}
          onClose={() => { if (!busyRef.current) setReview(undefined); }}
          panelClassName="max-h-[85dvh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 id="planning-review-title" className="text-xl font-semibold">{review.brief.proposalId ? 'Review proposed changes' : 'Planning status'}</h2>
            <button type="button" className="quiet-pencil-action" disabled={busy} onClick={() => setReview(undefined)}>Keep current plan</button>
          </div>
          {review.brief.statusNote && <p className="text-muted-foreground">{review.brief.statusNote}</p>}
          {review.brief.proposalId && <><p>
            This replaces the order of your open work. Selected proposals become
            tasks only when you accept them.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            {review.brief.proposedActions?.map((action, index) => (
              <li key={index}>
                <strong>{action.title}</strong>
                <p className="text-muted-foreground">{action.reason}</p>
              </li>
            ))}
          </ol>
          {error && <p role="alert" className="text-accent-red">{error}</p>}
          <button
            type="button"
            disabled={busy}
            className="min-h-11 rounded-lg bg-foreground px-4 text-background disabled:opacity-50"
            onClick={() => void apply()}
          >
            {busy
              ? "Applying…"
              : plan.state === "active"
                ? "Accept proposals and update my plan"
                : "Use this proposed plan"}
          </button>
          </>}
        </div>
        </ModalScrim>
      )}
    </aside>
  );
}
