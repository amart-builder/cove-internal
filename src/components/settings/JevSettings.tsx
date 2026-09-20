"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  JEV_LANE_COPY,
  credentialMessage,
  laneStatusMessage,
  type JevSettingsState,
} from "@/lib/jev/presentation";
import type { JevFeature } from "@/lib/jev/settings";

type Busy = JevFeature | "credential" | "mode" | null;

/**
 * The screen for Jev's shadow lanes: paste the TypeSafe key, switch a lane on
 * or off, and see whether each one is actually running.
 *
 * The key is held in component state only until it is sent, and the server
 * never sends one back, so a reload of this screen shows the last four
 * characters and nothing more. Every switch writes through the same route and
 * redraws from the state that route returns, so the screen cannot show a lane
 * as on because the click succeeded locally while the write did not.
 */
export default function JevSettings() {
  const [state, setState] = useState<JevSettingsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const keyFieldId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/jev-settings", { cache: "no-store" });
      const payload = await response.json() as JevSettingsState & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not read these settings.");
      setState(payload);
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : "Could not read these settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(
    body: Record<string, unknown>,
    which: Exclude<Busy, null>,
    confirmation: string,
  ) {
    if (!state) return;
    setBusy(which);
    setError("");
    setNote("");
    try {
      const response = await fetch("/api/jev-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Cove-CSRF": state.csrfToken },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as JevSettingsState & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save that change.");
      setState(payload);
      setNote(confirmation);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save that change.");
    } finally {
      setBusy(null);
    }
  }

  const credentialConfigured = state?.credential.configured ?? false;
  const storedKey = state?.credential.source === "stored";
  const environmentKey = state?.credential.source === "environment";

  return (
    <main className="min-h-screen bg-background px-6 pb-24 pt-16 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Settings
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">
          Second opinions
        </h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          Cove can send an email or a set of meeting notes to TypeSafe and record what it
          would have decided. Nothing it says changes your inbox, your tasks or your day.
          It only builds a record you can judge later.
        </p>

        {note && (
          <p
            role="status"
            className="mt-6 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-foreground"
          >
            {note}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-red-300/50 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            {error}
          </p>
        )}

        {loading ? (
          <p className="mt-7 rounded-xl border border-border bg-card px-5 py-8 text-sm text-muted-foreground">
            Reading your settings...
          </p>
        ) : loadError || !state ? (
          <div className="mt-7 rounded-xl border border-red-300/50 bg-red-50 px-5 py-5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <p>{loadError || "Could not read these settings."}</p>
            <button
              type="button"
              className="mt-3 rounded-md border border-current px-3 py-1.5 text-xs font-medium"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <section className="mt-8 rounded-xl border border-border bg-card px-5 py-5">
              <h2 className="text-base font-semibold tracking-[-0.02em] text-foreground">
                TypeSafe key
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {credentialMessage(state.credential)}
              </p>
              <form
                className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  const pasted = keyDraft;
                  setKeyDraft("");
                  void save(
                    { credential: pasted },
                    "credential",
                    "Key saved. It stays on this Mac.",
                  );
                }}
              >
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={keyFieldId}
                    className="block text-xs font-medium text-muted-foreground"
                  >
                    {credentialConfigured ? "Replace the key" : "Paste your key"}
                  </label>
                  <input
                    id={keyFieldId}
                    type="password"
                    value={keyDraft}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="apikey_..."
                    onChange={(event) => setKeyDraft(event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:border-foreground"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy !== null || keyDraft.trim().length === 0}
                    className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"
                  >
                    {busy === "credential" ? "Saving..." : "Save key"}
                  </button>
                  {storedKey && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void save(
                        { credential: null },
                        "credential",
                        "Key removed. The lanes stay switched on and will run again once a key is back.",
                      )}
                      className="rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </form>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                The key is written to Cove&rsquo;s data folder on this Mac, readable only by
                you, and is sent nowhere except to TypeSafe when a lane below runs. Cove
                never shows it again.
                {environmentKey && " Remove it from .env.local first if you want to change it here."}
              </p>
            </section>

            <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold tracking-[-0.02em] text-foreground">
                    Lanes
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    Each one runs quietly and records what it would have said.
                  </p>
                </div>
                {state.mode !== "off" && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void save(
                      { mode: "off" },
                      "mode",
                      "Everything is stopped. Your switches are remembered.",
                    )}
                    className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {busy === "mode" ? "Stopping..." : "Stop everything"}
                  </button>
                )}
              </div>
              <ul className="divide-y divide-border">
                {state.lanes.map((lane) => {
                  const copy = JEV_LANE_COPY[lane.feature];
                  const status = laneStatusMessage(lane, {
                    mode: state.mode,
                    credentialConfigured,
                  });
                  return (
                    <li key={lane.feature} className="flex items-start gap-4 px-5 py-4">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          lane.running ? "bg-accent-green" : lane.enabled ? "bg-amber-500" : "bg-border"
                        }`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">{copy.title}</p>
                        <p className="mt-0.5 text-sm leading-6 text-muted-foreground">
                          {copy.description}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{status}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={lane.enabled}
                        aria-label={`${copy.title}: ${lane.enabled ? "on" : "off"}`}
                        disabled={busy !== null}
                        onClick={() => void save(
                          { features: { [lane.feature]: !lane.enabled } },
                          lane.feature,
                          lane.enabled
                            ? `${copy.title} is off.`
                            : credentialConfigured
                              ? `${copy.title} is on and recording.`
                              : `${copy.title} is on. It starts once you paste a key.`,
                        )}
                        className={`mt-1 flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
                          lane.enabled
                            ? "justify-end border-foreground bg-foreground"
                            : "justify-start border-border bg-muted"
                        }`}
                      >
                        <span
                          className={`mx-0.5 h-4 w-4 rounded-full ${
                            lane.enabled ? "bg-background" : "bg-muted-foreground"
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {state.last24h
                ? `${state.last24h.attempts} call${state.last24h.attempts === 1 ? "" : "s"} in the last 24 hours, about $${
                    state.last24h.estimatedCostUsd.toFixed(4)
                  } of the $${state.limits.dailySpendUsd} Cove allows itself in a day.`
                : "Cove has not recorded any calls yet."}{" "}
              Model {state.model}.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
