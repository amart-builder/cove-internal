"use client";
import { useCallback, useEffect, useState } from "react";
import { getDayPlanCsrfToken } from "@/lib/data/day-plan";
import { responsibilityDate } from "@/lib/responsibility/presentation";

type Notice = {
  id: string; title: string; status: string; stage: string; dueAt: string;
  refKind: string; refId: string; error?: string;
  needsAttention: number; snoozedUntil: string | null;
};
type Coverage = {
  protection?: string; unresolved?: number; held?: number;
  enabled: boolean; healthy: boolean; lastCheckedAt: string | null;
  calendar: { status: string; fresh: boolean }; notices: Notice[];
};
function noticeDescription(n: Notice) {
  if (n.snoozedUntil && Date.parse(n.snoozedUntil) > Date.now()) return "Snoozed for one hour";
  if (n.status === "uncertain") return "Delivery could not be confirmed. Check this item before requesting another reminder.";
  if (n.status === "missed") return "The meeting reminder was not delivered before its start.";
  if (n.status === "failed") return "The notification failed before delivery.";
  if (n.status === "delivered") return "Reminder handed to macOS";
  if (n.needsAttention) return n.error?.startsWith("Reminder held")
    ? "This approaching deadline or meeting was held by the alert limit or a recent alert."
    : "Delivery failed. Cove will retry when eligible.";
  return "Waiting for a suitable reminder time";
}
export default function FollowThrough({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<Coverage>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/follow-through", { cache: "no-store", signal });
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (!signal?.aborted) { setState(value); setError(undefined); }
    } catch {
      if (!signal?.aborted) setError("Cove could not check reminder coverage. Refresh to try again.");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 60000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);
  async function update(n: Notice, action: "snooze" | "acknowledge") {
    setBusy(n.id);
    try {
      const token = await getDayPlanCsrfToken();
      const response = await fetch("/api/follow-through", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Cove-CSRF": token },
        body: JSON.stringify({ action, id: n.id }),
      });
      if (!response.ok || !(await response.json()).ok) throw new Error();
      await refresh();
    } catch { setError("Could not update that reminder. Refresh and try again."); }
    finally { setBusy(undefined); }
  }
  if (!state?.enabled && !error) return null;
  if (compact) return <a href="/follow-through#reminders" className="text-xs text-muted-foreground hover:text-foreground" aria-label="View reminder coverage">{error || !state?.healthy ? "Reminder checks need attention" : state.protection === "attention_required" ? `${state.unresolved ?? "Some"} reminder${state.unresolved === 1 ? "" : "s"} need${state.unresolved === 1 ? "s" : ""} review` : state.calendar.fresh ? "Watching deadlines and meetings" : state.calendar.status === "not_connected" ? "Watching deadlines · Calendar not connected" : "Watching deadlines · Calendar needs attention"}</a>;
  const issues = state?.notices.filter(n => n.needsAttention) ?? [];
  const recent = state?.notices.filter(n => !n.needsAttention && ["pending", "delivered"].includes(n.status)).slice(0, 5) ?? [];
  function notice(n: Notice) {
    return <div key={n.id} className="mt-3 border-t border-border pt-3 text-sm">
      {n.refKind === "task" ? <a href={`/tasks?task=${encodeURIComponent(n.refId)}`} className="underline">{n.title}</a> : <p>{n.title}</p>}
      <p className="mt-1 text-xs text-muted-foreground">{noticeDescription(n)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{n.refKind === "meeting" ? "Meeting time" : "Due"}: {responsibilityDate(n.dueAt)}</p>
      <div className="mt-2 flex flex-wrap gap-4">
        {["pending", "delivered", "uncertain", "failed"].includes(n.status) && <button type="button" disabled={!!busy} className="text-xs text-accent-blue disabled:opacity-50" onClick={() => void update(n, "snooze")}>Snooze 1h</button>}
        <button type="button" disabled={!!busy} className="text-xs text-accent-blue disabled:opacity-50" onClick={() => void update(n, "acknowledge")}>{busy === n.id ? "Saving..." : "On my radar"}</button>
      </div>
    </div>;
  }
  return <section id="reminders" aria-label="Reminder coverage" className="mt-5 rounded-xl border border-border bg-card p-5">
    <h2 className="text-base font-medium">Reminder coverage</h2>
    {error && <p role="alert" className="mt-2 text-sm text-accent-red">{error} <button onClick={() => void refresh()} className="underline">Refresh</button></p>}
    {state?.enabled && <>
      <p className="mt-2 text-sm">{state.healthy ? "Cove is checking deadlines while this Mac is awake." : "Deadline checks need attention. Ask your setup agent to check the reminder service."}</p>
      <p className="mt-2 text-sm text-muted-foreground">{state.calendar.fresh ? "Calendar checked. Meeting prep reminders are active." : state.calendar.status === "not_connected" ? "Calendar is not connected. Meeting reminders are unavailable." : "Calendar could not be checked recently. Meeting reminders may be missing."}</p>
      <p className="mt-2 text-xs text-muted-foreground">Mac reminders run from 8am to 6pm in your timezone. Model usage limits do not stop these checks. This Mac must be awake to deliver new Mac reminders.</p>
      {!!state.unresolved && <p role="status" className="mt-4 text-sm text-accent-red">{state.unresolved} reminder{state.unresolved === 1 ? " needs" : "s need"} review. These are delivery problems or time-sensitive reminders held by the alert policy.</p>}
      {issues.map(notice)}
      {!!state.held && <p className="mt-4 text-xs text-muted-foreground">{state.held} routine reminders are waiting because of alert limits or recent alerts. They do not require troubleshooting; the tasks remain open in Cove.</p>}
      {recent.length > 0 && <details className="mt-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">Recent and waiting reminders</summary>
        {recent.map(notice)}
      </details>}
    </>}
  </section>;
}
