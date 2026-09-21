"use client";

import AgentUsage from "./AgentUsage";
import FollowThrough from "./FollowThrough";
import { useCallback, useEffect, useState } from "react";
import { failureSourceLabel } from "@/lib/reliability/failure-source-label";

type FailureItem = {
  id: string;
  source: string;
  message: string;
  occurredAt: string;
};

type FailureResponse = {
  failures?: FailureItem[];
  activity?: ActivityItem[];
  activityHasMore?: boolean;
  activityNextCursor?: ActivityCursor;
  csrfToken?: string;
  error?: string;
};

type ActivityCursor = {
  finishedAt: string;
  id: string;
};

type ActivityItem = {
  id: string;
  title: string;
  detail: string;
  occurredAt: string;
  needsAttention: boolean;
};

function readableTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function FailureInbox({ receiptsEnabled }: { receiptsEnabled: boolean }) {
  const [items, setItems] = useState<FailureItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityCursor, setActivityCursor] = useState<ActivityCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [csrfToken, setCsrfToken] = useState("");
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/failures", { cache: "no-store" });
      const payload = await response.json() as FailureResponse;
      if (!response.ok) throw new Error(payload.error ?? "Could not load issues.");
      setItems(payload.failures ?? []);
      setActivity(payload.activity ?? []);
      setActivityHasMore(payload.activityHasMore === true);
      setActivityCursor(payload.activityNextCursor ?? null);
      setCsrfToken(payload.csrfToken ?? "");
    } catch (loadError) {
      setLoadError(loadError instanceof Error ? loadError.message : "Could not load issues.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function dismiss(id: string) {
    setOperationError("");
    setDismissingId(id);
    try {
      const response = await fetch("/api/failures", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cove-CSRF": csrfToken,
        },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json() as FailureResponse;
      if (!response.ok) throw new Error(payload.error ?? "Could not dismiss issue.");
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (dismissError) {
      setOperationError(
        dismissError instanceof Error ? dismissError.message : "Could not dismiss issue.",
      );
    } finally {
      setDismissingId(null);
    }
  }

  async function loadMoreActivity() {
    setLoadingMore(true);
    setOperationError("");
    try {
      const params = new URLSearchParams({ receiptLimit: "15" });
      if (activityCursor) {
        params.set("receiptCursorFinishedAt", activityCursor.finishedAt);
        params.set("receiptCursorId", activityCursor.id);
      }
      const response = await fetch(
        `/api/failures?${params}`,
        { cache: "no-store" },
      );
      const payload = await response.json() as FailureResponse;
      if (!response.ok) throw new Error(payload.error ?? "Could not load recent activity.");
      setActivity((current) => [...current, ...(payload.activity ?? [])]);
      setActivityHasMore(payload.activityHasMore === true);
      setActivityCursor(payload.activityNextCursor ?? null);
    } catch (loadError) {
      setOperationError(
        loadError instanceof Error ? loadError.message : "Could not load recent activity.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="h-full overflow-y-auto bg-background px-5 pb-8 pt-[80px] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Cove activity
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">
          Issues
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          See what Cove finished and anything that still needs a look.
        </p>

        {operationError && (
          <div className="mt-6 rounded-lg border border-red-300/50 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {operationError}
          </div>
        )}

        {loading ? (
          <div className="mt-7 overflow-hidden rounded-xl border border-border bg-card">
            <p className="px-5 py-8 text-sm text-muted-foreground">Checking for issues...</p>
          </div>
        ) : loadError ? (
          <div className="mt-7 rounded-xl border border-red-300/50 bg-red-50 px-5 py-5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <p>{loadError}</p>
            <button
              type="button"
              className="mt-3 rounded-md border border-current px-3 py-1.5 text-xs font-medium"
              onClick={() => void load()}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
          <div className="mt-7 overflow-hidden rounded-xl border border-border bg-card">
          {items.length === 0 ? (
            <div className="px-5 py-10">
              <p className="text-sm font-medium text-foreground">No failed jobs.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Work Cove could not finish will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id} className="flex gap-4 px-5 py-4">
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-6 text-foreground">{item.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {readableTime(item.occurredAt)} · {failureSourceLabel(item.source)}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={dismissingId !== null}
                    onClick={() => void dismiss(item.id)}
                    aria-label={`Dismiss: ${item.message}`}
                    className="self-start rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {dismissingId === item.id ? "Dismissing..." : "Dismiss"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          </div>

          {receiptsEnabled && <><AgentUsage /><FollowThrough /></>}
          {receiptsEnabled && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
              Recent activity
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              What Cove has done for you lately, newest first.
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
              {activity.length === 0 ? (
                <div className="px-5 py-10">
                  <p className="text-sm font-medium text-foreground">No recent activity yet.</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Inbox checks, meeting notes, briefs, and backups will appear here.
                  </p>
                </div>
              ) : (
                <>
                  <ul className="divide-y divide-border">
                    {activity.map((item) => (
                      <li key={item.id} className="flex gap-4 px-5 py-4">
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                            item.needsAttention ? "bg-amber-500" : "bg-accent-green"
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground">{item.title}</p>
                          <p className="mt-0.5 text-sm leading-6 text-muted-foreground">
                            {item.detail}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {readableTime(item.occurredAt)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {activityHasMore && (
                    <div className="border-t border-border px-5 py-3 text-center">
                      <button
                        type="button"
                        disabled={loadingMore}
                        onClick={() => void loadMoreActivity()}
                        className="rounded-md px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {loadingMore ? "Loading..." : "Show older activity"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
          )}
          </>
        )}
      </div>
    </section>
  );
}
