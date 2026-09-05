"use client";

import { useEffect, useState } from "react";

type UsageResponse = {
  enabled?: boolean;
  error?: string;
  settings?: { model: string; effort: string; backgroundLimits: { callsPerHour: number; callsPerDay: number; callsPerWeek: number } };
  usage?: { windows: Record<"hour" | "day" | "week", { calls: number; callsWithoutTokenUsage: number }> };
};

export default function AgentUsage() {
  const [state, setState] = useState<UsageResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/agent-usage", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const value = await response.json() as UsageResponse;
        if (!controller.signal.aborted) setState(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ error: "Background usage is unavailable. Refresh to try again." });
      });
    return () => controller.abort();
  }, []);
  if (!state || (!state.enabled && !state.error)) return null;
  if (state.error) return <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{state.error}</p>;
  if (!state.settings || !state.usage) return null;
  const modelName = ({ "gpt-6-astra": "GPT-6 Astra", "claude-fable-5-1": "Claude Fable 5.1" } as Record<string, string>)[state.settings.model] ?? state.settings.model;
  const limits = state.settings.backgroundLimits;
  const windows = state.usage.windows;
  const paused = windows.hour.calls >= limits.callsPerHour || windows.day.calls >= limits.callsPerDay || windows.week.calls >= limits.callsPerWeek;
  return (
    <section aria-label="Background AI usage" className="mt-7 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-medium text-foreground">Background AI</h2>
      <p className="mt-1 text-sm text-muted-foreground">{modelName} · {state.settings.effort} effort</p>
      <p className="mt-3 text-sm text-foreground">
        {windows.hour.calls} of {limits.callsPerHour} calls in the past hour. {windows.day.calls} of {limits.callsPerDay} calls in the past 24 hours. {windows.week.calls} of {limits.callsPerWeek} in the past 7 days.
      </p>
      {paused && <p role="status" className="mt-2 text-sm text-amber-800 dark:text-amber-200">AI reviews are paused until a usage window clears. Your scheduled task reminders can still run.</p>}
      <p className="mt-2 text-xs text-muted-foreground">These are Cove&apos;s call limits. Your provider&apos;s subscription allowance is not available here. Retries count toward the limit. Routine work leaves part of this same allowance for the chief of staff and Morning Brief. Jobs held by the allowance wait for capacity instead of using up retries.</p>
    </section>
  );
}
