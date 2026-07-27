'use client';

import type { BuddyTurnView } from './BuddyProvider';
import { isClaudeNotSignedIn } from '@/lib/buddy/errors';
import PendingDeleteCard from './PendingDeleteCard';
import ReceiptChips from './ReceiptChips';
import SessionLinkCard from './SessionLinkCard';

export default function BuddyMessage({ turn, thinking, hostname, deepLinksEnabled, onRetry }: {
  turn: BuddyTurnView;
  thinking?: boolean;
  hostname?: string;
  deepLinksEnabled?: boolean;
  onRetry: (text: string) => void;
}) {
  const isConfirmedDelete = /^CONFIRM_DELETE\b/.test(turn.user_text);
  const needsClaudeSignIn = turn.state === 'failed' && isClaudeNotSignedIn(turn.assistant_text);
  const hostLabel = hostname ?? 'this computer';
  return (
    <article className="space-y-2">
      <div className="ml-auto w-fit max-w-[86%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-blue px-3.5 py-2.5 text-sm leading-relaxed text-white">
        {isConfirmedDelete ? 'Confirmed delete' : turn.user_text}
      </div>
      <div className="mr-auto max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
        {needsClaudeSignIn ? (
          <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
            <p className="font-medium">Claude needs to be signed in on this computer first.</p>
            <p className="text-muted-foreground">
              I run on Claude, and Claude&apos;s sign-in on {hostLabel} has expired or was never done. It takes about a minute to fix, one time, in the Terminal app.
            </p>
            {deepLinksEnabled === false && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Heads up: Forge here runs on {hostLabel}, so the sign-in has to happen on that machine (Screen Sharing into it, or ssh, then the same steps).
              </p>
            )}
            <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              <li>Open the Terminal app (press Cmd+Space, type &quot;Terminal&quot;, press Return).</li>
              <li>Type <code className="font-mono">claude</code> and press Return.</li>
              <li>Type <code className="font-mono">/login</code> and press Return, then pick &quot;Claude account with subscription&quot;.</li>
              <li>Your web browser will open. Approve the sign-in, then copy the code it shows you.</li>
              <li>Paste that code back into Terminal and press Return.</li>
              <li>Come back here and tap Retry.</li>
            </ol>
          </div>
        ) : turn.assistant_text ? (
          <p className="whitespace-pre-wrap">{turn.assistant_text}</p>
        ) : thinking ? (
          <p className="buddy-thinking text-muted-foreground">thinking…</p>
        ) : turn.state === 'running' ? (
          <p className="text-muted-foreground">Working…</p>
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
