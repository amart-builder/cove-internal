'use client';

import { useState } from 'react';
import type { PendingDelete } from '@/lib/buddy/receipts';
import { useBuddy } from './BuddyProvider';

export default function PendingDeleteCard({ turnId, pending }: { turnId: string; pending: PendingDelete }) {
  const { confirmDelete, dismissDelete, busy } = useBuddy();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  if (pending.disposition === 'dismissed') return null;
  const expired = pending.expiresAt ? new Date(pending.expiresAt).getTime() <= Date.now() : false;
  if (pending.disposition === 'confirmed' || expired) {
    return (
      <div className="mt-2 rounded-xl border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
        Delete: {pending.label} · {expired ? 'expired' : 'handled'}
      </div>
    );
  }
  const run = async (action: 'confirm' | 'cancel') => {
    setWorking(true);
    setError(undefined);
    try {
      if (action === 'confirm') await confirmDelete(turnId, pending);
      else await dismissDelete(turnId, pending);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Delete action failed.');
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="mt-2 rounded-xl border border-accent-red/20 bg-background/70 p-3">
      <p className="text-xs font-medium text-foreground">Delete: {pending.label}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" disabled={working || busy}
          className="rounded-lg bg-accent-red px-2.5 py-1.5 text-xs font-semibold text-white transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none disabled:opacity-50"
          onClick={() => void run('confirm')}>Confirm</button>
        <button type="button" disabled={working}
          className="rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none disabled:opacity-50"
          onClick={() => void run('cancel')}>Cancel</button>
      </div>
      {error && <p className="mt-2 text-[11px] text-accent-red">{error}</p>}
    </div>
  );
}
