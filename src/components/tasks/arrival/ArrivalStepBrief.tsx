'use client';

import type { MorningBriefGeneration, PublicMorningBrief } from '@/lib/day-plan/brief';
import { morningBriefArrivalPresentation } from '@/lib/day-plan/presentation';
import BriefProgress from './BriefProgress';

export default function ArrivalStepBrief({
  recap,
  headline,
  paragraphs,
  watchItems,
  briefWriting,
  briefGeneration,
  briefAttached,
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
  briefAttached: boolean;
  hasBriefContent: boolean;
  onForceBrief?: () => void;
  forcingBrief?: boolean;
}) {
  const { stalled, failed, leadHeadline, body } =
    morningBriefArrivalPresentation({
      headline,
      paragraphs,
      hasBriefContent,
      briefWriting,
      briefAttached,
      generationState: briefGeneration?.state,
    });

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
            generationState={briefGeneration?.state}
          />
        )}

        {failed && (
          <p role="alert" className="text-sm leading-relaxed text-muted-foreground">
            Your plan is still here. Try the brief again, or continue to Today.
          </p>
        )}

        {stalled && onForceBrief && (
          <button
            type="button"
            className="press-scale min-h-11 w-full rounded-xl bg-foreground px-5 text-sm font-semibold text-background hover:opacity-90 disabled:cursor-default disabled:opacity-60 sm:w-auto"
            onClick={onForceBrief}
            // The round trip can take a beat, and the optimistic progress state
            // only lands after it. Without this, an impatient second tap fires a
            // second request before the first has said anything.
            disabled={forcingBrief}
          >
            {forcingBrief ? 'Starting…' : 'Generate your brief'}
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
