'use client';

import type { MorningBriefGeneration, PublicMorningBrief } from '@/lib/day-plan/brief';
import BriefProgress from './BriefProgress';

export default function ArrivalStepBrief({
  recap,
  headline,
  paragraphs,
  watchItems,
  briefWriting,
  briefGeneration,
  hasBriefContent,
  onForceBrief,
  forcingBrief,
}: {
  recap?: string;
  headline?: string;
  paragraphs: string[];
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
  // Old briefs and the deterministic fallback have no headline, so the first
  // paragraph is promoted into that slot. Without this they would render as a
  // body with nothing above it and lose the whole point of the hierarchy.
  const leadHeadline = headline ?? paragraphs[0];
  const body = headline ? paragraphs : paragraphs.slice(1);

  return (
    <section className="mx-auto w-full max-w-[85rem] space-y-9 px-6 py-8 sm:px-10" aria-label="The brief">
      <div className="mx-auto w-full max-w-[70ch] space-y-7">
        {leadHeadline && <h2 className="arrival-brief-headline text-balance">{leadHeadline}</h2>}

        {recap && (
          <div className="arrival-brief-recap space-y-1">
            <p className="arrival-brief-kicker">Since the last close</p>
            <p className="text-pretty text-[0.95rem] leading-relaxed text-foreground">{recap}</p>
          </div>
        )}

        {body.length > 0 && (
          <div className="space-y-4">
            {body.map((paragraph, index) => (
              <p
                key={index}
                className={
                  index === 0
                    ? 'arrival-brief-lead text-pretty'
                    : 'text-pretty text-base leading-relaxed text-foreground'
                }
              >
                {paragraph}
              </p>
            ))}
          </div>
        )}

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
          <div className="arrival-brief-watch space-y-3" aria-label="Watching for you">
            <h2 className="arrival-brief-kicker">Watching for you</h2>
            {watchItems.map((watch, index) => (
              <p key={index} className="flex gap-2.5 text-pretty text-sm leading-relaxed text-muted-foreground">
                <span className="arrival-brief-watch-dot mt-[0.5rem] shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-medium text-foreground">{watch.label}.</span>{' '}
                  {watch.evidence}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
