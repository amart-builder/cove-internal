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
    <section className="w-full px-6 pb-2 pt-10 sm:px-10 lg:px-16" aria-label="The brief">
      <div className="w-full max-w-[40rem]">
        {leadHeadline && (
          <h2 className="text-balance text-[21px] font-semibold leading-[1.42] tracking-[-0.016em] text-foreground">
            {leadHeadline}
          </h2>
        )}

        {recap && (
          <p className="mt-5 text-pretty text-[13px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground/75">Since the last close:</span>{' '}
            {recap}
          </p>
        )}

        {body.length > 0 && (
          <div className="mt-4.5 space-y-[18px]">
            {body.map((paragraph, index) => (
              <p
                key={index}
                className="text-pretty text-[15px] leading-[1.62] text-foreground/75 dark:text-foreground/80"
              >
                {paragraph}
              </p>
            ))}
          </div>
        )}

        {briefWriting && (
          <div className="mt-7">
            <BriefProgress
              startedAt={briefGeneration?.startedAt}
              estimateSeconds={briefGeneration?.estimateSeconds}
              generationState={briefGeneration?.state}
            />
          </div>
        )}

        {failed && (
          <p role="alert" className="mt-6 text-sm leading-relaxed text-muted-foreground">
            {briefGeneration?.failureMessage ?? 'Your plan is still here. Try the brief again, or continue to Today.'}
          </p>
        )}

        {briefGeneration?.state === 'deferred' && (
          <p role="status" className="mt-6 text-sm leading-relaxed text-muted-foreground">
            Cove will try again automatically{briefGeneration.retryAt ? ` after ${new Date(briefGeneration.retryAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}. You can continue to Today.
          </p>
        )}

        {stalled && onForceBrief && (
          <button
            type="button"
            className="press-scale mt-6 min-h-11 w-full rounded-xl bg-foreground px-5 text-sm font-semibold text-background outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:cursor-default disabled:opacity-60 sm:w-auto"
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
          <div className="mt-12" aria-label="Watching for you">
            <h2 className="mb-[18px] text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Watching for you
            </h2>
            <div className="space-y-3.5">
            {watchItems.map((watch, index) => (
              <p key={index} className="flex gap-3 text-pretty text-sm leading-[1.55] text-muted-foreground">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/45" aria-hidden="true" />
                <span>
                  <span className="font-medium text-foreground">{watch.label}.</span>{' '}
                  {watch.evidence}
                </span>
              </p>
            ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
