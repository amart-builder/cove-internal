'use client';

import type { CoveReadiness, ReadinessState } from '@/lib/health/readiness';
import useCoveReadiness from './useCoveReadiness';

function label(state: ReadinessState) {
  if (state === 'ready') return 'Ready';
  if (state === 'stale') return 'Stale';
  if (state === 'not_configured') return 'Not set up';
  if (state === 'waiting') return 'Waiting for the first run';
  return 'Unavailable';
}

// A ready lane says nothing; the line only carries lanes that need attention.
// When every lane is ready the strip renders nothing at all.
export function readinessLineItems(readiness: CoveReadiness): string[] {
  const items: string[] = [];
  if (readiness.email.state !== 'ready') {
    items.push(`Email: ${label(readiness.email.state)}`);
  }
  if (readiness.writer.state !== 'ready') {
    items.push(`Writer (${readiness.writer.label}): ${label(readiness.writer.state)}`);
  }
  if (readiness.worker.state !== 'ready') {
    items.push(`Worker: ${label(readiness.worker.state)}`);
  }
  return items;
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
  const items = readinessLineItems(readiness);
  const hasJobFailure = readiness.jobs.failed > 0 || readiness.jobs.dead > 0;
  if (items.length === 0 && !hasJobFailure) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground" role="status" aria-label="Cove readiness">
      {items.map((item) => <span key={item}>{item}</span>)}
      {hasJobFailure ? <span className="text-accent-orange">Jobs need attention</span> : null}
    </div>
  );
}
