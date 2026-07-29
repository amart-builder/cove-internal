'use client';

import { useState } from 'react';
import type { BuddyReplanReceipt } from '@/lib/buddy/receipts';
import { useBuddy } from './BuddyProvider';

const markers = {
  add: '+',
  change: '~',
  complete: '✓',
  move: '↕',
} as const;

export default function ReplanPreviewCard({
  turnId,
  replan,
}: {
  turnId: string;
  replan: BuddyReplanReceipt;
}) {
  const { applyReplan } = useBuddy();
  const [applying, setApplying] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const canApply = !stale && replan.status === 'proposed' && replan.operations.length > 0;

  async function apply() {
    setApplying(true);
    setError('');
    try {
      await applyReplan(turnId, replan);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'ReplanStaleError') setStale(true);
      setError(cause instanceof Error ? cause.message : 'Cove could not apply that plan.');
    } finally {
      setApplying(false);
    }
  }

  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-accent-blue/20 bg-background/70">
      <div className="border-b border-border/70 px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground">
          {replan.status === 'applied' ? 'Today is updated' : 'Proposed changes'}
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
          {replan.status === 'applied'
            ? 'Cove applied the changes you reviewed.'
            : 'Nothing changes until you tap Apply.'}
        </p>
      </div>

      {replan.preview.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {replan.preview.map((line, index) => (
            <li key={`${line.kind}:${line.label}:${index}`} className="flex gap-2.5 px-3 py-2.5">
              <span
                className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent-blue/10 text-[11px] font-semibold text-accent-blue"
                aria-hidden="true"
              >
                {markers[line.kind]}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium leading-5 text-foreground">{line.label}</p>
                {(line.before || line.after) && (
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {line.before && <span className="line-through opacity-70">{line.before}</span>}
                    {line.before && line.after && <span aria-hidden="true"> → </span>}
                    {line.after && <span>{line.after}</span>}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
          {replan.assistantText}
        </p>
      )}

      {error && <p className="px-3 pt-2 text-xs text-accent-red" role="alert">{error}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2.5">
        {replan.status === 'applied' ? (
          <span className="text-xs font-medium text-accent-green">✓ Applied</span>
        ) : canApply ? (
          <button
            type="button"
            disabled={applying}
            onClick={() => void apply()}
            className="min-h-8 rounded-lg bg-accent-blue px-3 text-xs font-semibold text-white transition-transform duration-150 active:scale-[0.97] disabled:opacity-50 motion-reduce:transform-none"
          >
            {applying ? 'Applying...' : 'Apply'}
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {stale ? 'This preview is out of date' : 'No changes to apply'}
          </span>
        )}
      </div>
    </section>
  );
}
