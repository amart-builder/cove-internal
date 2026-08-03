'use client';

import type { ReadinessState } from '@/lib/health/readiness';
import useCoveReadiness from './useCoveReadiness';

function label(state: ReadinessState) {
  if (state === 'ready') return 'Ready';
  if (state === 'stale') return 'Stale';
  if (state === 'not_configured') return 'Not set up';
  if (state === 'waiting') return 'Waiting for the first run';
  return 'Unavailable';
}

export default function CoveReadinessStrip() {
  const { readiness, error, notApplicable, retry } = useCoveReadiness();
  if (notApplicable) return null;
  if (!readiness) {
    return (
      <button type="button" onClick={() => void retry()} className="mt-3 text-xs text-muted-foreground">
        {error ? 'Cove status unavailable. Retry' : 'Checking Cove status…'}
      </button>
    );
  }
  const hasJobFailure = readiness.jobs.failed > 0 || readiness.jobs.dead > 0;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground" role="status" aria-label="Cove readiness">
      <span>Email: {label(readiness.email.state)}</span>
      <span>Writer ({readiness.writer.label}): {label(readiness.writer.state)}</span>
      <span>Worker: {label(readiness.worker.state)}</span>
      {hasJobFailure ? <span className="text-accent-orange">Jobs need attention</span> : null}
    </div>
  );
}
