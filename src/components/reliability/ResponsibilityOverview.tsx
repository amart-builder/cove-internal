"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getDayPlanCsrfToken } from "@/lib/data/day-plan";
import FollowThrough from "./FollowThrough";
import { capacityEstimate, responsibilityDate as when } from "@/lib/responsibility/presentation";
type Desk = {
  enabled: boolean;
  total: number;
  counts: { tasks: number; confirmedCommitments: number; unconfirmed: number };
  pendingReview: number;
  plannedCount: number;
  job?: { status: string; nextAttempt: string; error?: string };
  capacity: {
    availableMinutes: number | null;
    proposedMinutes: number;
    unknownEstimates: number;
    overloaded: boolean;
    conclusion: string;
    assumption: string;
  };
  carried: Array<{
    id: string;
    title: string;
    count: number;
    nextAction: string;
    blocker: string | null;
  }>;
  items: Array<{
    ref_kind: string;
    ref_id: string;
    revision: number;
    title: string;
    state: string;
    owner: string;
    next_action: string;
    next_check_at: string;
    due_at: string | null;
    planned_for: string | null;
    needs_confirmation: boolean;
    acknowledged_at: string | null;
  }>;
  preparations: Array<{
    id: string;
    title: string;
    content: string;
    stale: boolean;
    created_at: string;
  }>;
};
export default function ResponsibilityOverview() {
  const [desk, setDesk] = useState<Desk>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<{
    id: string;
    state: "copying" | "copied" | "failed";
  } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch("/api/responsibilities", {
        cache: "no-store",
        signal,
      });
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (!signal?.aborted) {
        setDesk(d);
        setError("");
      }
    } catch {
      if (!signal?.aborted)
        setError("Cove could not check follow-through. Try again.");
    }
  }, []);
  useEffect(() => {
    const c = new AbortController();
    void refresh(c.signal);
    const timer = setInterval(() => void refresh(c.signal), 60000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  async function acknowledge(item: Desk["items"][number]) {
    setBusy(item.ref_id);
    try {
      const token = await getDayPlanCsrfToken();
      const r = await fetch("/api/responsibilities", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cove-CSRF": token },
        body: JSON.stringify({
          action: "acknowledge",
          ref_kind: item.ref_kind,
          ref_id: item.ref_id,
          revision: item.revision,
        }),
      });
      if (!r.ok) throw new Error();
      await refresh();
    } catch {
      setError(
        "That item changed or could not be updated. Refresh and try again.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function copyDraft(draft: Desk["preparations"][number]) {
    setCopyStatus({ id: draft.id, state: "copying" });
    try {
      await navigator.clipboard.writeText(draft.content);
      setCopyStatus({ id: draft.id, state: "copied" });
    } catch {
      setCopyStatus({ id: draft.id, state: "failed" });
    }
  }
  return (
    <main className="mx-auto max-w-3xl px-6 pb-8 pt-16">
      <Link
        href="/tasks"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        Back to Today
      </Link>
      <h1 className="mt-5 text-2xl font-semibold">Your follow-through</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        What Cove is keeping track of, what needs a decision, and what is ready
        for you.
      </p>
      <FollowThrough />
      {error && (
        <p role="alert" className="mt-4 text-sm text-accent-red">
          {error} <button onClick={() => void refresh()}>Refresh</button>
        </p>
      )}
      {!desk && !error && (
        <p className="mt-5 text-sm" role="status">
          Checking your work...
        </p>
      )}
      {desk?.enabled && (
        <>
          <section className="mt-6 rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium">Your day’s capacity</h2>
            <p className="mt-2 text-sm">
              {capacityEstimate(desk.plannedCount, desk.capacity.proposedMinutes, desk.capacity.unknownEstimates)}{" "}
              {desk.capacity.availableMinutes !== null
                ? `${desk.capacity.availableMinutes} minutes remain after calendar time and a buffer.`
                : "Calendar availability is unknown."}
            </p>
            {desk.plannedCount > 0 && (
              <p
                className={`mt-2 text-sm ${desk.capacity.overloaded ? "text-accent-red" : ""}`}
              >
                {desk.capacity.conclusion}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {desk.capacity.assumption} Adjust your day with Buddy if these
              assumptions do not fit.
            </p>
            {desk.carried.map((item) => (
              <div
                key={item.id}
                className="mt-4 border-t border-border pt-3 text-sm"
              >
                <p>{item.title}</p>
                <p className="mt-1 text-muted-foreground">
                  Carried through {item.count} closeouts.{" "}
                  {item.blocker
                    ? `Missing: ${item.blocker}`
                    : `Next step: ${item.nextAction}`}{" "}
                  Ask Buddy to help make the first step smaller.
                </p>
              </div>
            ))}
          </section>
          <section className="mt-5 rounded-xl border border-border bg-card p-5">
            <h2 className="font-medium">Kept in view</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {desk.counts.tasks} open tasks and {desk.counts.confirmedCommitments} confirmed commitments.{" "}
              {desk.counts.unconfirmed > 0 && `${desk.counts.unconfirmed} additional suggestions from your sources are unconfirmed. `}
              {desk.pendingReview
                ? `${desk.pendingReview} await their next agent review.`
                : "All currently scheduled reviews are up to date."}
            </p>
            {desk.job?.error?.includes("background_usage_limit:") && (
              <p className="mt-2 text-sm">
                The AI allowance is resting until {when(desk.job.nextAttempt)}.
                Scheduled deadline reminders continue while this Mac is awake.
              </p>
            )}
            {desk.job?.status === "dead" && (
              <p className="mt-2 text-sm text-accent-red">
                An agent review failed.{" "}
                <a href="/failures" className="underline">
                  Open Issues
                </a>
              </p>
            )}
            {desk.items.map((item) => (
              <div
                key={`${item.ref_kind}:${item.ref_id}`}
                className="mt-4 border-t border-border pt-3 text-sm"
              >
                <p className="font-medium">{item.title}</p>
                <p className="mt-1">{item.next_action}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.state === "waiting"
                    ? `Waiting on ${item.owner}`
                    : item.state === "blocked"
                      ? "Blocked"
                      : `Owner: ${item.owner}`}{" "}
                  · Next review {when(item.next_check_at)}
                  {item.due_at
                    ? ` · Deadline ${when(item.due_at)}`
                    : ""}
                  {item.planned_for
                    ? ` · Proposed work ${when(item.planned_for)}`
                    : ""}
                </p>
                {item.needs_confirmation && (
                  <p className="mt-1 text-xs text-accent-blue">
                    This inferred commitment still needs confirmation in your
                    brief or with Buddy.
                  </p>
                )}
                <button
                  disabled={busy !== null}
                  onClick={() => void acknowledge(item)}
                  className="mt-2 text-xs text-accent-blue disabled:opacity-50"
                >
                  {busy === item.ref_id
                    ? "Saving..."
                    : "On my radar. Check back in an hour."}
                </button>
              </div>
            ))}
            {desk.total > desk.items.length && (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the next {desk.items.length} items. The remaining{" "}
                {desk.total - desk.items.length} retain their next review times.
              </p>
            )}
          </section>
          {desk.preparations.length > 0 && (
            <section className="mt-5 rounded-xl border border-border bg-card p-5">
              <h2 className="font-medium">Prepared for you</h2>
              <p className="mt-2 text-xs text-muted-foreground">
                Drafts for your review. Nothing here has been sent or marked
                complete.
              </p>
              {desk.preparations.map((draft) => (
                <details
                  key={draft.id}
                  className="mt-4 border-t border-border pt-3"
                >
                  <summary className="cursor-pointer text-sm">
                    {draft.title}
                    {draft.stale ? " · Source has changed" : ""}
                  </summary>
                  {draft.stale && (
                    <p className="mt-2 text-xs text-accent-red">
                      Check current facts before using this draft.
                    </p>
                  )}
                  <p className="mt-3 whitespace-pre-wrap text-sm">
                    {draft.content}
                  </p>
                  <button
                    className="mt-3 text-xs text-accent-blue disabled:opacity-50"
                    disabled={copyStatus?.state === "copying"}
                    onClick={() => void copyDraft(draft)}
                  >
                    {copyStatus?.id === draft.id &&
                    copyStatus.state === "copying"
                      ? "Copying..."
                      : "Copy draft"}
                  </button>
                  {copyStatus?.id === draft.id &&
                    copyStatus.state !== "copying" && (
                      <p
                        className="mt-2 text-xs text-muted-foreground"
                        role="status"
                      >
                        {copyStatus.state === "copied"
                          ? "Draft copied."
                          : "Could not copy. Select the draft text and copy it manually."}
                      </p>
                    )}
                </details>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
