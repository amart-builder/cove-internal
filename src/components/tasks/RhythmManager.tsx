'use client';

import { useEffect, useRef, useState } from 'react';
import {
  updateRecurringTemplate,
} from '@/lib/data/recurrence';
import type {
  RecurrenceCadence,
  RecurringTemplate,
} from '@/lib/tasks/recurrence';

const WEEKLY: RecurrenceCadence[] = [
  'weekly:sunday',
  'weekly:monday',
  'weekly:tuesday',
  'weekly:wednesday',
  'weekly:thursday',
  'weekly:friday',
  'weekly:saturday',
];

export function cadenceDisplay(cadence: string): string {
  if (cadence === 'daily') return 'Daily rhythm';
  if (cadence === 'weekdays') return 'Weekday rhythm';
  if (cadence.startsWith('weekly:')) {
    const day = cadence.slice('weekly:'.length);
    return `Weekly, ${day[0]?.toUpperCase()}${day.slice(1)}`;
  }
  if (cadence.startsWith('monthly:')) {
    return `Monthly, day ${cadence.slice('monthly:'.length)}`;
  }
  return 'Rhythm';
}

export default function RhythmManager({
  templates,
  onChanged,
}: {
  templates: RecurringTemplate[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | undefined>(undefined);

  // The panel opens over the Today screen and covers a focus card while it is
  // there, so it has to close the way everything else on that screen closes.
  // Escape closes the panel and leaves the Second Current drawer open, which is
  // why this listens in the capture phase and stops the event: the drawer's own
  // Escape handler is on window and would otherwise take the pair down at once.
  // A pointer press outside closes the panel too, including the press that
  // closes the drawer -- without that the panel stayed open behind the hidden
  // drawer and came back over the card the next time the drawer was opened.
  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    function closeOnOutsidePress(event: Event) {
      if (wrapperRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', closeOnEscape, true);
    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.removeEventListener('keydown', closeOnEscape, true);
      document.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [open]);

  useEffect(() => () => {
    if (settleTimer.current !== undefined) window.clearTimeout(settleTimer.current);
  }, []);

  // The list is ordered active first, so stopping a rhythm drops it down the
  // panel and pulls the next one up into the space it left. A round trip here
  // takes about 60ms, which is inside the gap between the two halves of one
  // double click. Measured before this: double-clicking Stop on the first
  // rhythm stopped that rhythm and the one below it, because by the second
  // click the second rhythm's Stop button was sitting under the cursor --
  // and this panel has no undo. Double-clicking Pause was the same shape in
  // reverse: it paused and resumed, so the rhythm was never paused and the
  // panel said nothing about it. Guarding by row id could not catch either,
  // because the second click is a different row's button or a different
  // button on the same row. The guard is the whole panel now, and it is held
  // a moment past the re-render so the settled list cannot take a click
  // nobody aimed at it. A failure clears it at once, so a real retry is
  // never delayed.
  async function change(
    id: string,
    patch: Parameters<typeof updateRecurringTemplate>[0],
  ) {
    setBusyId(id);
    setError(undefined);
    try {
      await updateRecurringTemplate({ ...patch, id });
      await onChanged();
      settleTimer.current = window.setTimeout(() => setBusyId(undefined), 400);
    } catch {
      setError("Cove couldn't update that rhythm.");
      setBusyId(undefined);
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="second-current-rhythms"
        onClick={() => setOpen((current) => !current)}
        className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[12px] font-medium normal-case tracking-normal text-muted-foreground hover:text-foreground"
      >
        Rhythms
      </button>
      {open && (
        <div id="second-current-rhythms" className="absolute right-0 top-8 z-30 w-80 rounded-xl border bg-card p-3 text-left shadow-lg">
          <div className="mb-2">
            <strong className="text-[21px] font-[650] tracking-[-0.018em] text-foreground">Rhythms</strong>
            <p className="mt-0.5 text-[13.5px] leading-[1.55] normal-case tracking-normal text-muted-foreground">
              Recurring work in the second current.
            </p>
          </div>
          {error && <p role="alert" className="mb-2 text-[12px] font-medium text-accent-red">{error}</p>}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {templates.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-[13.5px] leading-[1.55] normal-case tracking-normal text-muted-foreground">
                No rhythms yet.
              </p>
            ) : templates.map((template) => (
              <div key={template.id} className="rounded-lg border border-border/70 bg-background/60 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[15.5px] font-[550] normal-case tracking-[-0.012em] text-foreground">
                      {template.title}
                    </p>
                    {!template.active && (
                      <span className="text-[12px] font-medium normal-case tracking-normal text-muted-foreground">
                        Stopped
                      </span>
                    )}
                  </div>
                  {!template.active && (
                    <button
                      type="button"
                      disabled={busyId !== undefined}
                      onClick={() => void change(template.id, { id: template.id, active: true })}
                      className="-my-1.5 py-1.5 text-[12px] font-medium normal-case tracking-normal text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      Restart
                    </button>
                  )}
                  {template.active && (
                    <button
                      type="button"
                      disabled={busyId !== undefined}
                      onClick={() => void change(template.id, { id: template.id, active: false })}
                      className="-my-1.5 py-1.5 text-[12px] font-medium normal-case tracking-normal text-muted-foreground hover:text-accent-red disabled:opacity-50"
                    >
                      Stop
                    </button>
                  )}
                </div>
                {template.active && (
                  <>
                    <select
                      aria-label={`Cadence for ${template.title}`}
                      value={template.cadence}
                      disabled={busyId !== undefined}
                      onChange={(event) =>
                        void change(template.id, {
                          id: template.id,
                          cadence: event.target.value,
                        })}
                      className="mt-2 w-full rounded-md border bg-card px-2 py-1.5 text-[12px] font-medium normal-case tracking-normal text-foreground"
                    >
                      <option value="daily">Daily</option>
                      <option value="weekdays">Weekdays</option>
                      {WEEKLY.map((cadence) => (
                        <option key={cadence} value={cadence}>{cadenceDisplay(cadence)}</option>
                      ))}
                      {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                        <option key={day} value={`monthly:${day}`}>Monthly, day {day}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={busyId !== undefined}
                      onClick={() =>
                        void change(template.id, {
                          id: template.id,
                          pausedUntil: template.pausedUntil ? null : '9999-12-31',
                        })}
                      className="mt-0.5 py-1.5 text-[12px] font-medium normal-case tracking-normal text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      {template.pausedUntil ? 'Resume' : 'Pause'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
