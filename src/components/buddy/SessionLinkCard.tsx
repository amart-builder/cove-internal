'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SpawnedSessionReceipt } from '@/lib/buddy/receipts';
import {
  isBuddySpawnedSessionOpenable,
  isBuddySpawnedSessionPending,
  type BuddySpawnedSessionState,
} from '@/lib/buddy/spawned-session-state';
import { OpenInClaudeCode } from '@/components/tasks/ClaudeRunIndicators';
import { buildClaudeResumeCommand } from '@/lib/claude-execution/resume-command';

type SpawnedSessionStatus = SpawnedSessionReceipt & {
  state: BuddySpawnedSessionState;
  error?: string | null;
  hostname?: string;
  deepLinksEnabled?: boolean;
};

function abbreviatedDir(dir: string): string {
  const atlas = dir.indexOf('/Atlas');
  return atlas >= 0 ? `~${dir.slice(atlas)}` : dir;
}

export default function SessionLinkCard({ session }: { session: SpawnedSessionReceipt }) {
  const [status, setStatus] = useState<SpawnedSessionStatus>({ ...session, state: 'seeding' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const response = await fetch(
          `/api/buddy/spawn-session?id=${encodeURIComponent(session.sessionId)}`,
          { cache: 'no-store' },
        );
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!stopped && response.ok) {
          const next = payload as SpawnedSessionStatus;
          setStatus(next);
          if (!isBuddySpawnedSessionPending(next.state)) return;
        }
      } catch {
        // A later poll can recover a transient request failure.
      }
      if (!stopped && attempts < 40) timer = setTimeout(() => void poll(), 1_500);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [session.sessionId]);

  const command = useMemo(
    () => buildClaudeResumeCommand(status.dir, status.sessionId),
    [status.dir, status.sessionId],
  );
  const openable = isBuddySpawnedSessionOpenable(status.state);

  return (
    <div className="mt-2 rounded-xl border border-accent-blue/25 bg-card/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-foreground">{status.title}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
            {abbreviatedDir(status.dir)}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${
          status.state === 'ready'
            ? 'bg-accent-green/10 text-foreground'
            : status.state === 'launch_failed'
              ? 'bg-accent-red/10 text-accent-red'
              : status.state === 'incomplete' || status.state === 'failed'
                ? 'bg-accent-orange/10 text-foreground'
                : 'bg-accent-blue/10 text-muted-foreground'
        }`}>
          {status.state === 'ready'
            ? 'Ready'
            : status.state === 'launch_failed'
              ? 'Failed'
              : status.state === 'incomplete' || status.state === 'failed'
                ? 'Ready, prep incomplete'
                : 'Preparing…'}
        </span>
      </div>

      {status.state === 'launch_failed' && status.error && (
        <p className="mt-2 text-[11px] text-accent-red">{status.error}</p>
      )}

      {(status.state === 'incomplete' || status.state === 'failed') && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Context prep stopped early. The session can still be opened.
        </p>
      )}

      {openable && status.deepLinksEnabled === true && (
        <OpenInClaudeCode
          sessionId={status.sessionId}
          title={status.title}
          resumeCommand={command}
          className="mt-3"
        />
      )}

      {openable && status.deepLinksEnabled === false && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] text-muted-foreground">
            Created on {status.hostname ?? 'another Forge host'}
          </p>
          <div className="flex items-start gap-2 rounded-lg bg-muted p-2">
            <code className="min-w-0 flex-1 break-all text-[10px] leading-relaxed">{command}</code>
            <button
              type="button"
              className="shrink-0 rounded-md border bg-card px-2 py-1 text-[10px] font-semibold transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none"
              onClick={() => {
                void navigator.clipboard.writeText(command).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1_500);
                }).catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
