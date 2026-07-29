'use client';

import { useState } from 'react';
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

  async function change(
    id: string,
    patch: Parameters<typeof updateRecurringTemplate>[0],
  ) {
    setBusyId(id);
    setError(undefined);
    try {
      await updateRecurringTemplate({ ...patch, id });
      await onChanged();
    } catch {
      setError("Cove couldn't update that rhythm.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-[10px] font-medium normal-case tracking-normal text-muted-foreground hover:text-foreground"
      >
        Rhythms
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-80 rounded-xl border bg-card p-3 text-left shadow-lg">
          <div className="mb-2">
            <strong className="text-xs text-foreground">Rhythms</strong>
            <p className="mt-0.5 text-[10px] normal-case tracking-normal text-muted-foreground">
              Recurring work in the second current.
            </p>
          </div>
          {error && <p role="alert" className="mb-2 text-[11px] text-accent-red">{error}</p>}
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {templates.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-[11px] normal-case tracking-normal text-muted-foreground">
                No rhythms yet.
              </p>
            ) : templates.map((template) => (
              <div key={template.id} className="rounded-lg border border-border/70 bg-background/60 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium normal-case tracking-normal text-foreground">
                      {template.title}
                    </p>
                    {!template.active && (
                      <span className="text-[10px] normal-case tracking-normal text-muted-foreground">
                        Stopped
                      </span>
                    )}
                  </div>
                  {!template.active && (
                    <button
                      type="button"
                      disabled={busyId === template.id}
                      onClick={() => void change(template.id, { id: template.id, active: true })}
                      className="text-[10px] normal-case tracking-normal text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      Restart
                    </button>
                  )}
                  {template.active && (
                    <button
                      type="button"
                      disabled={busyId === template.id}
                      onClick={() => void change(template.id, { id: template.id, active: false })}
                      className="text-[10px] normal-case tracking-normal text-muted-foreground hover:text-accent-red disabled:opacity-50"
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
                      disabled={busyId === template.id}
                      onChange={(event) =>
                        void change(template.id, {
                          id: template.id,
                          cadence: event.target.value,
                        })}
                      className="mt-2 w-full rounded-md border bg-card px-2 py-1.5 text-[11px] normal-case tracking-normal text-foreground"
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
                      disabled={busyId === template.id}
                      onClick={() =>
                        void change(template.id, {
                          id: template.id,
                          pausedUntil: template.pausedUntil ? null : '9999-12-31',
                        })}
                      className="mt-2 text-[10px] normal-case tracking-normal text-muted-foreground hover:text-foreground disabled:opacity-50"
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
