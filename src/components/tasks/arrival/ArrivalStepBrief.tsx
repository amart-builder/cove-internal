'use client';

import type { MorningBriefGeneration, PublicMorningBrief } from '@/lib/day-plan/brief';
import BriefProgress from './BriefProgress';

export default function ArrivalStepBrief({
  recap,
  narrative,
  watchItems,
  briefWriting,
  briefGeneration,
  hasBriefContent,
  onForceBrief,
  forcingBrief,
}: {
  recap?: string;
  narrative: string;
  watchItems: PublicMorningBrief['watchItems'];
  briefWriting: boolean;
  briefGeneration?: MorningBriefGeneration;
  hasBriefContent: boolean;
  onForceBrief?: () => void;
  forcingBrief?: boolean;
}) {
  // Nothing written and nothing on its way: a failed run, or a morning the cron
  // never fired. Either way he is staring at a brief-shaped hole, so give him a
  // way out rather than silence.
  const stalled = !hasBriefContent && !briefWriting;

  return (
    <section className="mx-auto w-full max-w-[85rem] space-y-8 px-6 py-8 sm:px-10" aria-label="The brief">
      <div className="space-y-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Your morning brief</h2>
          {recap && (
            <div className="mt-6 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Since the last close
              </p>
              <p className="text-pretty text-base leading-relaxed text-foreground sm:text-lg">{recap}</p>
            </div>
          )}
        </div>

        <p className="text-pretty text-base leading-relaxed text-foreground sm:text-lg">{narrative}</p>

        {briefWriting && (
          <BriefProgress
            startedAt={briefGeneration?.startedAt}
            estimateSeconds={briefGeneration?.estimateSeconds}
          />
        )}

        {stalled && onForceBrief && (
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline disabled:cursor-default disabled:no-underline disabled:opacity-60"
            onClick={onForceBrief}
            // The round trip can take a beat, and the optimistic progress state
            // only lands after it. Without this, an impatient second tap fires a
            // second request before the first has said anything.
            disabled={forcingBrief}
          >
            {forcingBrief ? 'Starting…' : 'Write my brief now'}
          </button>
        )}

        {watchItems.length > 0 && (
          <div className="space-y-4 border-t border-border/60 pt-6" aria-label="Watching for you">
            <h2 className="text-sm font-semibold text-foreground">Watching for you</h2>
            {watchItems.map((watch, index) => (
              <p key={index} className="text-pretty text-sm leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">{watch.label}.</span>{' '}
                {watch.evidence}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
