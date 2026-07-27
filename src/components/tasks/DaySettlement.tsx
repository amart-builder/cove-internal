'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DayPlan, DayPlanItem } from '@/lib/day-plan/types';
import {
  allSettlementDecisionsMade,
  ownerDescription,
  ownerLabel,
  shouldAutoPostProgress,
  staleSettlementNotice,
  type SettlementDecision,
} from '@/lib/day-plan/presentation';

const DECISIONS: Array<{
  value: SettlementDecision;
  label: string;
  description: string;
}> = [
  { value: 'progress', label: 'Progress', description: 'You moved this forward today. It stays priority and continues tomorrow.' },
  { value: 'carry', label: 'Carry', description: 'Did not get to it. Keep the commitment for tomorrow.' },
  { value: 'defer', label: 'Defer', description: 'Move it to Not Started and bring it back in seven days.' },
  { value: 'drop', label: 'Drop', description: 'Archive the underlying task without deleting its history.' },
];

type ProgressFields = { progressNote?: string; nextStep?: string };

export type SettlementCompletedItem = {
  id: string;
  title: string;
  detail?: string;
};

export type SettlementOpenItem = {
  item: DayPlanItem;
  title: string;
  outcome?: string;
};

interface DaySettlementProps {
  plan: DayPlan;
  completed: SettlementCompletedItem[];
  unresolved: SettlementOpenItem[];
  decisions: Readonly<Record<string, SettlementDecision | undefined>>;
  proposedTomorrowTitle?: string;
  savingItemIds?: ReadonlySet<string>;
  closing?: boolean;
  canDefer?: boolean;
  error?: string;
  note: string;
  // The hoisted DayRitualLayer owns the dialog chrome; these ids label it.
  titleId: string;
  descriptionId: string;
  onDecision: (
    itemId: string,
    decision: SettlementDecision,
    progress?: ProgressFields,
  ) => void | Promise<void>;
  onCancel: () => void;
  onNoteChange: (note: string) => void;
  onCloseDay: () => void | Promise<void>;
}

export default function DaySettlement({
  plan,
  completed,
  unresolved,
  decisions,
  proposedTomorrowTitle,
  savingItemIds = new Set<string>(),
  closing = false,
  canDefer = true,
  error,
  note,
  titleId,
  descriptionId,
  onDecision,
  onCancel,
  onNoteChange,
  onCloseDay,
}: DaySettlementProps) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const autoAttemptsRef = useRef(new Map<string, number>());
  const autoPostedPlanIdRef = useRef(plan.id);
  const [progressDrafts, setProgressDrafts] = useState<Record<string, ProgressFields>>(() =>
    Object.fromEntries(unresolved.map(({ item }) => [item.id, {
      progressNote: item.settlementDecision?.progressNote ?? '',
      nextStep: item.settlementDecision?.nextStep ?? '',
    }])),
  );
  useLayoutEffect(() => {
    const textarea = noteRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [note]);
  const allDecided = allSettlementDecisionsMade(
    unresolved.map((view) => view.item),
    decisions,
  );
  const anyDecisionSaving = savingItemIds.size > 0;
  useEffect(() => {
    setProgressDrafts((current) => {
      const next = { ...current };
      for (const { item } of unresolved) {
        if (next[item.id]) continue;
        next[item.id] = {
          progressNote: item.settlementDecision?.progressNote ?? '',
          nextStep: item.settlementDecision?.nextStep ?? '',
        };
      }
      return next;
    });
  }, [unresolved]);
  useEffect(() => {
    if (autoPostedPlanIdRef.current !== plan.id) {
      autoAttemptsRef.current.clear();
      autoPostedPlanIdRef.current = plan.id;
    }
    if (closing || anyDecisionSaving) return;
    const candidate = unresolved.find(({ item }) => shouldAutoPostProgress({
      workedToday: item.workedToday === true,
      hasDecision: Boolean(decisions[item.id]),
      attempts: autoAttemptsRef.current.get(item.id) ?? 0,
    }));
    if (!candidate) return;
    const itemId = candidate.item.id;
    autoAttemptsRef.current.set(itemId, (autoAttemptsRef.current.get(itemId) ?? 0) + 1);
    void Promise.resolve(onDecision(itemId, 'progress')).catch(() => undefined);
  }, [anyDecisionSaving, closing, decisions, onDecision, plan.id, unresolved]);

  const chooseDecision = (itemId: string, decision: SettlementDecision) => {
    const progress = decision === 'progress' ? progressDrafts[itemId] : undefined;
    return onDecision(itemId, decision, progress);
  };
  const saveProgress = (itemId: string) => {
    if (decisions[itemId] !== 'progress') return;
    return onDecision(itemId, 'progress', progressDrafts[itemId]);
  };
  const planDateLabel = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${plan.localDate}T12:00:00.000Z`));
  // When settlement opens days later for a plan that was never closed, say why it is here.
  const todayLocalDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: plan.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const staleNotice = staleSettlementNotice(plan.localDate, todayLocalDate);

  return (
      <div
        className="my-auto overflow-hidden rounded-3xl border bg-background shadow-2xl"
        data-day-plan-id={plan.id}
      >
        <div className="max-h-[calc(100dvh-7rem)] overflow-y-auto">
          <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-5 backdrop-blur sm:px-7">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Day settlement</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Closing <time dateTime={plan.localDate}>{planDateLabel}</time>
            </p>
            {staleNotice && (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-foreground">
                {staleNotice}
              </p>
            )}
            <h1 id={titleId} tabIndex={-1} className="mt-2 text-2xl font-semibold tracking-tight text-foreground outline-none sm:text-3xl">
              Close the open loops.
            </h1>
            <p id={descriptionId} className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Keep what still matters, defer what does not need tomorrow, and deliberately drop the rest.
            </p>
          </header>

          <div className="space-y-6 px-4 py-5 sm:px-7">
            <section aria-labelledby={`${titleId}-completed`}>
              <div className="flex items-baseline justify-between gap-4">
                <h2 id={`${titleId}-completed`} className="text-base font-semibold">Completed work</h2>
                <span className="text-sm text-muted-foreground">{completed.length}</span>
              </div>
              {completed.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {completed.map((item) => (
                    <li key={item.id} className="rounded-xl border bg-card px-4 py-3">
                      <p className="text-sm font-medium text-foreground">{item.title}</p>
                      {item.detail && <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">Nothing is marked complete for this plan.</p>
              )}
            </section>

            <section aria-labelledby={`${titleId}-unresolved`}>
              <h2 id={`${titleId}-unresolved`} className="text-base font-semibold">Unresolved commitments</h2>
              {unresolved.length > 0 ? (
                <ol className="mt-3 space-y-3">
                  {unresolved.map((view, index) => {
                    const saving = savingItemIds.has(view.item.id);
                    return (
                      <li key={view.item.id}>
                        <article className="rounded-2xl border bg-card p-4 sm:p-5">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs text-muted-foreground">Priority {index + 1} · Owner {ownerLabel(view.item.owner)}</p>
                              <h3 className="mt-1 text-base font-semibold text-foreground">{view.title}</h3>
                              {view.outcome && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{view.outcome}</p>}
                            </div>
                            {saving && <span role="status" className="text-xs text-muted-foreground">Saving…</span>}
                          </div>
                          {view.item.owner === 'claude' && (
                            <p className="mt-2 text-xs text-muted-foreground">{ownerDescription('claude')}</p>
                          )}
                          {view.item.workedToday === true && (
                            <p className="mt-2 text-xs text-muted-foreground">Claude worked on this today.</p>
                          )}

                          <fieldset className="mt-4" disabled={anyDecisionSaving || closing}>
                            <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What happens next?</legend>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {DECISIONS.map((decision) => (
                                <label
                                  key={decision.value}
                                  className={`flex min-h-11 items-start gap-2 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-accent-blue/40 ${
                                    decision.value === 'defer' && !canDefer ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                                  } ${
                                    decisions[view.item.id] === decision.value ? 'border-accent-blue bg-accent-blue/5' : ''
                                  }`}
                                >
                                  <input
                                    type="radio"
                                    name={`settlement-${view.item.id}`}
                                    value={decision.value}
                                    checked={decisions[view.item.id] === decision.value}
                                    disabled={decision.value === 'defer' && !canDefer}
                                    onChange={() => void chooseDecision(view.item.id, decision.value)}
                                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-blue)]"
                                  />
                                  <span>
                                    <strong className="block text-sm text-foreground">{decision.label}</strong>
                                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                                      {decision.value === 'defer' && !canDefer
                                        ? 'Unavailable until the board has a Not Started or To Do list.'
                                        : decision.description}
                                    </span>
                                  </span>
                                </label>
                              ))}
                            </div>
                            {decisions[view.item.id] === 'progress' && (
                              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                <input
                                  type="text"
                                  value={progressDrafts[view.item.id]?.progressNote ?? ''}
                                  maxLength={500}
                                  aria-label={`Progress note for ${view.title}`}
                                  placeholder="What moved today?"
                                  onChange={(event) => setProgressDrafts((current) => ({
                                    ...current,
                                    [view.item.id]: {
                                      ...current[view.item.id],
                                      progressNote: event.target.value,
                                    },
                                  }))}
                                  onBlur={() => void saveProgress(view.item.id)}
                                  className="min-h-11 rounded-xl border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-accent-blue/40"
                                />
                                <input
                                  type="text"
                                  value={progressDrafts[view.item.id]?.nextStep ?? ''}
                                  maxLength={200}
                                  aria-label={`Next step for ${view.title}`}
                                  placeholder="First thing to do next"
                                  onChange={(event) => setProgressDrafts((current) => ({
                                    ...current,
                                    [view.item.id]: {
                                      ...current[view.item.id],
                                      nextStep: event.target.value,
                                    },
                                  }))}
                                  onBlur={() => void saveProgress(view.item.id)}
                                  className="min-h-11 rounded-xl border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-accent-blue/40"
                                />
                              </div>
                            )}
                          </fieldset>
                        </article>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">There are no unresolved essential outcomes.</p>
              )}
            </section>

            {proposedTomorrowTitle && (
              <section className="rounded-2xl border bg-muted/60 p-4" aria-labelledby={`${titleId}-tomorrow`}>
                <h2 id={`${titleId}-tomorrow`} className="text-sm font-semibold">Proposed first move tomorrow</h2>
                <p className="mt-1 text-sm text-foreground">{proposedTomorrowTitle}</p>
              </section>
            )}

            <section className="border-t pt-5" aria-labelledby={`${titleId}-day-note`}>
              <div className="flex items-baseline justify-between gap-4">
                <label id={`${titleId}-day-note`} htmlFor={`${titleId}-day-note-input`} className="text-sm font-semibold text-foreground">
                  Tell me about your day
                </label>
                {note.length > 6000 && (
                  <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                    {note.length.toLocaleString()} / 8,000
                  </span>
                )}
              </div>
              <textarea
                ref={noteRef}
                id={`${titleId}-day-note-input`}
                value={note}
                maxLength={8000}
                rows={3}
                disabled={closing}
                onChange={(event) => onNoteChange(event.target.value)}
                placeholder="Anything I couldn't see today — who texted you, what you decided, ideas, and anything you want me to take care of."
                className="mt-3 min-h-24 w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:ring-0 disabled:opacity-60"
              />
            </section>

            {error && <p role="alert" className="rounded-xl border border-accent-red/30 bg-accent-red/5 p-3 text-sm text-accent-red">{error}</p>}
          </div>

          <footer className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background/95 px-4 py-4 backdrop-blur sm:px-7">
            <button
              type="button"
              disabled={closing}
              className="min-h-11 rounded-xl px-4 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
              onClick={onCancel}
            >
              Not yet
            </button>
            {!allDecided && unresolved.length > 0 && (
              <p role="status" className="text-xs text-muted-foreground">Choose Progress, Carry, Defer, or Drop for each open item.</p>
            )}
            <button
              type="button"
              data-ritual-primary
              disabled={closing || !allDecided || savingItemIds.size > 0}
              className="min-h-11 rounded-xl bg-foreground px-5 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-40 sm:ml-auto"
              onClick={() => void onCloseDay()}
            >
              {closing ? 'Closing the day…' : 'Close the day'}
            </button>
          </footer>
        </div>
      </div>
  );
}

export type { DaySettlementProps, SettlementDecision };
