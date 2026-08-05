'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  briefProgress,
  briefRemainingLabel,
  DEFAULT_BRIEF_ESTIMATE_SECONDS,
  morningBriefPendingLabel,
} from '@/lib/day-plan/presentation';
import type { MorningBriefGenerationState } from '@/lib/day-plan/brief';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
// Its own ticker, deliberately independent of the 15s brief poll: the bar has to
// move smoothly enough to read as alive while the server is polled far less often.
const TICK_MS = 1000;

function subscribeToReducedMotion(onChange: () => void) {
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

function reducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

// The waiting state for a brief that is not on the page yet. Answers the one
// question he has while it runs: is this worth waiting for or worth walking away
// from. Every waiting state keeps the bar, because a bar that vanishes at the
// last moment reads as the work stopping rather than finishing. What changes is
// how much the bar is willing to claim: a sweep when there is no elapsed time to
// measure, a real fill while it writes, and a near-full hold once it is written
// and only the hand-off is left.
export default function BriefProgress({
  startedAt,
  estimateSeconds,
  generationState,
}: {
  startedAt?: string;
  estimateSeconds?: number;
  generationState?: MorningBriefGenerationState;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Written, waiting to attach. There is no elapsed time left worth measuring,
  // so the ticker stops here rather than burning a timer to no effect.
  const attaching = generationState === 'succeeded';
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  // A queued brief that has not started yet cannot honestly fill a bar.
  const indeterminate = !attaching && !Number.isFinite(startedMs);

  useEffect(() => {
    if (!startedAt || attaching) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt, attaching]);

  const estimate = estimateSeconds ?? DEFAULT_BRIEF_ESTIMATE_SECONDS;
  // Clock skew between the server timestamp and this browser can only make
  // elapsed negative; briefProgress floors it at zero rather than reading
  // backwards.
  const elapsedSeconds = (nowMs - startedMs) / 1000;
  const { fraction, overrun } = briefProgress(elapsedSeconds, estimate);
  // Attaching pins to the same near-full stop the overrun uses: the last
  // sliver belongs to the brief actually landing on the page.
  const percent = attaching ? 95 : Math.round(fraction * 100);
  // Both states have run out of honest numbers, so both pulse instead of moving.
  const holding = attaching || overrun;
  const measuring = !attaching && !indeterminate;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        {/* The live region is scoped to this sentence, which changes at most
            twice (queued → writing → finishing up), so each transition is
            announced. The countdown beside it is deliberately left out: it
            changes every second and would talk over him rather than inform him.
            The progressbar role carries that state for anyone who goes looking. */}
        <p className="text-sm text-muted-foreground" role="status">
          {measuring
            ? 'Your brief is being written…'
            : morningBriefPendingLabel(generationState)}
        </p>
        {measuring ? (
          <p className="text-xs tabular-nums text-muted-foreground">
            {briefRemainingLabel(elapsedSeconds, estimate)}
          </p>
        ) : null}
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-border/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // A held or sweeping bar is honestly indeterminate: no value, so a
        // screen reader says "busy" instead of a percentage that is not true.
        {...(holding || indeterminate ? {} : { 'aria-valuenow': percent })}
        aria-label="Morning brief progress"
      >
        <div
          className={[
            'h-full rounded-full bg-foreground/60',
            indeterminate ? 'brief-progress-sweep' : '',
            !indeterminate && !reducedMotion ? 'transition-[width] duration-1000 ease-linear' : '',
            holding && !reducedMotion ? 'motion-safe:animate-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
