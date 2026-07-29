'use client';

import { useState } from 'react';
import type { BuddyFeedbackReceipt } from '@/lib/buddy/receipts';

export default function FeedbackReceiptCard({
  feedback,
}: {
  feedback: BuddyFeedbackReceipt;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  async function copy() {
    setCopyError('');
    try {
      await navigator.clipboard.writeText([
        feedback.to ? `To: ${feedback.to}` : undefined,
        `Subject: ${feedback.subject}`,
        '',
        feedback.body,
      ].filter((line): line is string => line !== undefined).join('\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopyError('Copy did not work. Select the message and copy it by hand.');
    }
  }

  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-accent-blue/20 bg-background/70">
      <div className="px-3 py-2.5">
        <p className="text-xs font-semibold text-foreground">
          {feedback.mode === 'gmail_draft' ? 'Feedback draft ready' : 'Feedback message ready'}
        </p>
        {feedback.to && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">
            To: {feedback.to}
          </p>
        )}
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
          Subject: {feedback.subject}
        </p>
      </div>
      {feedback.mode === 'copy' && (
        <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap border-y border-border/70 bg-card/50 px-3 py-2.5 font-sans text-[11px] leading-5 text-foreground">
          {feedback.body}
        </pre>
      )}
      {copyError && <p className="px-3 pt-2 text-xs text-accent-red" role="alert">{copyError}</p>}
      <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2.5">
        {feedback.mode === 'gmail_draft' ? (
          <a
            href="https://mail.google.com/mail/u/0/#drafts"
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-accent-blue px-3 py-2 text-xs font-semibold text-white"
          >
            Open Gmail drafts
          </a>
        ) : (
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition-transform duration-150 active:scale-[0.97] motion-reduce:transform-none"
          >
            {copied ? 'Copied' : 'Copy message'}
          </button>
        )}
      </div>
      <p className="border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
        ✓ Cove prepared this. You choose whether to send it.
      </p>
    </section>
  );
}
