"use client";

import { useEffect, useState } from "react";

type UsageResponse = {
  enabled?: boolean;
  error?: string;
  settings?: { model: string; effort: string; backgroundLimits: { callsPerHour: number; callsPerDay: number; callsPerWeek: number } };
  usage?: {
    pools: Record<"background" | "planning", { windows: Record<"hour" | "day" | "week", { calls: number }> }>;
    availability: { routineRetryAt: string | null; chiefRetryAt: string | null; planningRetryAt: string | null };
  };
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
  const windows = state.usage.pools.background.windows;
  const planning = state.usage.pools.planning.windows;
  const availability = state.usage.availability;
  const retryLabel = (value: string) => new Date(value).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <section aria-label="Background AI usage" className="mt-7 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-medium text-foreground">Background AI</h2>
      <p className="mt-1 text-sm text-muted-foreground">{modelName} · {state.settings.effort} effort</p>
      <p className="mt-3 text-sm text-foreground">
        {windows.hour.calls} of {limits.callsPerHour} calls in the past hour. {windows.day.calls} of {limits.callsPerDay} calls in the past 24 hours. {windows.week.calls} of {limits.callsPerWeek} in the past 7 days.
      </p>
      <p className="mt-2 text-sm text-foreground">Daily planning has its own allowance: {planning.day.calls} of {limits.callsPerDay} calls in the past 24 hours. Background checks cannot use it.</p>
      {availability.routineRetryAt && <p role="status" className="mt-2 text-sm text-amber-800 dark:text-amber-200">Routine AI checks are waiting until {retryLabel(availability.routineRetryAt)}.{availability.chiefRetryAt ? ` Chief reviews can resume after ${retryLabel(availability.chiefRetryAt)}.` : ' Chief reviews still have reserved capacity.'}</p>}
      {availability.planningRetryAt && <p role="status" className="mt-2 text-sm text-amber-800 dark:text-amber-200">Daily planning is waiting until {retryLabel(availability.planningRetryAt)}. A queued brief will retry automatically.</p>}
      <p className="mt-2 text-xs text-muted-foreground">These calls include Cove working while you are away. Morning Brief and closeout use a separate allowance with the same hourly, daily and weekly limits. Retries count. Scheduled reminders run without model calls. Your provider&apos;s subscription allowance is not available here.</p>
    </section>
  );
}
