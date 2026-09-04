'use client';

import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { BuddyTurnView } from './BuddyProvider';
import { isClaudeNotSignedIn } from '@/lib/buddy/errors';
import PendingDeleteCard from './PendingDeleteCard';
import ReceiptChips from './ReceiptChips';
import SessionLinkCard from './SessionLinkCard';
import ReplanPreviewCard from './ReplanPreviewCard';
import FeedbackReceiptCard from './FeedbackReceiptCard';

const AUTH_POLL_INTERVAL_MS = 4_000;
const AUTH_POLL_LIMIT_MS = 5 * 60 * 1000;
const SIGN_IN_FALLBACK = 'Open Terminal and run: claude auth login, then tap Retry.';

type SignInPhase = 'idle' | 'opening' | 'waiting' | 'fallback';

/**
 * Shown when a turn failed because the Claude login on this computer expired.
 * Retry alone cannot fix that, so this card opens the login in Terminal, then
 * watches the auth status and retries the turn once the login is back.
 */
export function ClaudeSignInCard({ hostname, deepLinksEnabled, onRetry, getCsrfToken }: {
  hostname?: string;
  deepLinksEnabled?: boolean;
  onRetry: () => void;
  getCsrfToken?: () => Promise<string>;
}) {
  const [phase, setPhase] = useState<SignInPhase>('idle');
  const hostLabel = hostname ?? 'this computer';
  const retriedRef = useRef(false);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  useEffect(() => {
    if (phase !== 'waiting') return;
    let stopped = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const poll = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > AUTH_POLL_LIMIT_MS) {
        setPhase('fallback');
        return;
      }
      let signedIn = false;
      try {
        const response = await fetch('/api/buddy/claude-auth-status', { cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        signedIn = response.ok && payload?.signedIn === true;
      } catch {
        signedIn = false;
      }
      if (stopped) return;
      if (signedIn && !retriedRef.current) {
        retriedRef.current = true;
        onRetryRef.current();
        return;
      }
      timer = window.setTimeout(() => void poll(), AUTH_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void poll(), AUTH_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [phase]);

  const startSignIn = async () => {
    setPhase('opening');
    try {
      if (!getCsrfToken) throw new Error('Cove request token is unavailable.');
      const token = await getCsrfToken();
      const response = await fetch('/api/buddy/claude-login', {
        method: 'POST',
        headers: { 'X-Cove-CSRF': token },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error('Could not open Terminal.');
      setPhase('waiting');
    } catch {
      setPhase('fallback');
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
      <p className="font-medium">Claude needs you to sign in again</p>
      <p className="text-muted-foreground">
        Your Claude login expired and could not be refreshed. This is not something Retry can fix.
      </p>
      {deepLinksEnabled === false && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Heads up: Cove here runs on {hostLabel}, so the sign-in has to happen on that machine (Screen Sharing into it, or ssh, then run <code className="font-mono">claude auth login</code> there).
        </p>
      )}
      {phase === 'waiting' ? (
        <p className="text-sm leading-relaxed text-muted-foreground" role="status">
          Finish signing in in the Terminal window that just opened. Buddy will retry on its own once you&apos;re back.
        </p>
      ) : phase === 'fallback' ? (
        <p className="text-sm leading-relaxed text-muted-foreground" role="status">
          {SIGN_IN_FALLBACK}
        </p>
      ) : (
        <button
          type="button"
          disabled={phase === 'opening'}
          className="rounded-md bg-accent-blue px-3 py-1.5 text-xs font-semibold text-white transition-transform duration-150 ease-out hover:opacity-90 active:scale-[0.97] disabled:opacity-60 motion-reduce:transform-none"
          onClick={() => void startSignIn()}
        >
          {phase === 'opening' ? 'Opening Terminal…' : 'Sign in again'}
        </button>
      )}
    </div>
  );
}

export default function BuddyMessage({ turn, thinking, hostname, deepLinksEnabled, onRetry, getCsrfToken }: {
  turn: BuddyTurnView;
  thinking?: boolean;
  hostname?: string;
  deepLinksEnabled?: boolean;
  onRetry: (text: string) => void;
  getCsrfToken?: () => Promise<string>;
}) {
  const isConfirmedDelete = /^CONFIRM_DELETE\b/.test(turn.user_text);
  const needsClaudeSignIn = turn.state === 'failed' && isClaudeNotSignedIn(turn.assistant_text);
  return (
    <article className="space-y-2">
      <div className="ml-auto w-fit max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-blue px-3.5 py-2.5 text-sm leading-relaxed text-white">
        {isConfirmedDelete ? 'Confirmed delete' : turn.user_text}
      </div>
      <div className="mr-auto max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
        {needsClaudeSignIn ? (
          <ClaudeSignInCard
            hostname={hostname}
            deepLinksEnabled={deepLinksEnabled}
            onRetry={() => onRetry(turn.user_text)}
            getCsrfToken={getCsrfToken}
          />
        ) : turn.assistant_text ? (
          <p className="whitespace-pre-wrap">{turn.assistant_text}</p>
        ) : thinking || turn.state === 'running' ? (
          <div className="flex min-w-44 items-center gap-3 py-0.5 pr-2 text-[15.5px] text-muted-foreground">
            <ThinkingOrb
              state="composing"
              size={64}
              aria-hidden="true"
              className="shrink-0"
            />
            <span>Thinking…</span>
          </div>
        ) : (
          <p className="text-muted-foreground">Buddy was interrupted.</p>
        )}
        {turn.state === 'failed' && (
          <button
            type="button"
            className="mt-2 text-xs font-semibold text-accent-blue transition-transform duration-150 ease-out hover:underline hover:underline-offset-2 active:scale-[0.97] motion-reduce:transform-none"
            onClick={() => onRetry(turn.user_text)}
          >
            Retry
          </button>
        )}
        {turn.state !== 'running' && turn.receipts && (
          <>
            {turn.receipts.replan && (
              <ReplanPreviewCard turnId={turn.id} replan={turn.receipts.replan} />
            )}
            {turn.receipts.feedback && (
              <FeedbackReceiptCard feedback={turn.receipts.feedback} />
            )}
            <ReceiptChips changes={turn.receipts.changes} />
            {turn.receipts.pendingDeletes.map((pending, index) => (
              <PendingDeleteCard key={`${pending.table}:${pending.id}:${index}`} turnId={turn.id} pending={pending} />
            ))}
            {turn.receipts.sessions?.map((session) => (
              <SessionLinkCard key={session.sessionId} session={session} />
            ))}
          </>
        )}
      </div>
    </article>
  );
}
