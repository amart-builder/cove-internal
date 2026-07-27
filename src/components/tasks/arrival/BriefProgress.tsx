'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  briefProgress,
  briefRemainingLabel,
  DEFAULT_BRIEF_ESTIMATE_SECONDS,
} from '@/lib/day-plan/presentation';

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

// The waiting state for a brief that is actually being written. Answers the one
// question he has while it runs: is this worth waiting for or worth walking away
// from. A queued row that has not started yet has no honest elapsed time, so it
// gets the indeterminate pulse instead of a bar pretending to know.
export default function BriefProgress({
  startedAt,
  estimateSeconds,
}: {
  startedAt?: string;
  estimateSeconds?: number;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(startedMs)) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <span className="inline-flex items-center gap-1" aria-hidden="true">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1.5 rounded-full bg-current opacity-35 motion-safe:animate-pulse"
              style={{ animationDelay: `${dot * 180}ms` }}
            />
          ))}
        </span>
        Your brief is queued…
      </p>
    );
  }

  const estimate = estimateSeconds ?? DEFAULT_BRIEF_ESTIMATE_SECONDS;
  // Clock skew between the server timestamp and this browser can only make
  // elapsed negative; briefProgress floors it at zero rather than reading
  // backwards.
  const elapsedSeconds = (nowMs - startedMs) / 1000;
  const { fraction, overrun } = briefProgress(elapsedSeconds, estimate);
  const percent = Math.round(fraction * 100);
  const label = briefRemainingLabel(elapsedSeconds, estimate);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        {/* The live region is scoped to this sentence, which changes exactly once
            (queued → writing), so the transition is announced. The countdown
            beside it is deliberately left out: it changes every second and would
            talk over him rather than inform him. The progressbar role carries
            that state for anyone who goes looking. */}
        <p className="text-sm text-muted-foreground" role="status">
          Your brief is being written…
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">{label}</p>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-border/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // An overrun bar is honestly indeterminate: no value, so a screen reader
        // says "busy" instead of a percentage that stopped being true.
        {...(overrun ? {} : { 'aria-valuenow': percent })}
        aria-label="Morning brief progress"
      >
        <div
          className={[
            'h-full rounded-full bg-foreground/60',
            reducedMotion ? '' : 'transition-[width] duration-1000 ease-linear',
            overrun && !reducedMotion ? 'motion-safe:animate-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
