"use client";

import { useCallback, useEffect, useState } from "react";

type FailureItem = {
  id: string;
  source: string;
  message: string;
  occurredAt: string;
};

type FailureResponse = {
  failures?: FailureItem[];
  csrfToken?: string;
  error?: string;
};

function readableTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function FailureInbox() {
  const [items, setItems] = useState<FailureItem[]>([]);
  const [csrfToken, setCsrfToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/failures", { cache: "no-store" });
      const payload = await response.json() as FailureResponse;
      if (!response.ok) throw new Error(payload.error ?? "Could not load issues.");
      setItems(payload.failures ?? []);
      setCsrfToken(payload.csrfToken ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load issues.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function dismiss(id: string) {
    setError("");
    try {
      const response = await fetch("/api/failures", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forge-CSRF": csrfToken,
        },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json() as FailureResponse;
      if (!response.ok) throw new Error(payload.error ?? "Could not dismiss issue.");
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (dismissError) {
      setError(
        dismissError instanceof Error ? dismissError.message : "Could not dismiss issue.",
      );
    }
  }

  return (
    <section className="h-full overflow-y-auto bg-background px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Reliability
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">
          Issues
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          Work Cove could not finish. Dismiss an item once it is understood or resolved.
        </p>

        {error && (
          <div className="mt-6 rounded-lg border border-red-300/50 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="mt-7 overflow-hidden rounded-xl border border-border bg-card">
          {loading ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Checking for issues...</p>
          ) : items.length === 0 ? (
            <div className="px-5 py-10">
              <p className="text-sm font-medium text-foreground">Nothing needs attention.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Failed processing and jobs that stop retrying will appear here.
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
                      {readableTime(item.occurredAt)} · {item.source}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void dismiss(item.id)}
                    className="self-start rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    Dismiss
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
