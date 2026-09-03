'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  archiveEmailItemFromCard,
  listEmailItems,
  listHandledEmailItems,
} from '@/lib/data/email';
import type { EmailItem } from '@/lib/data/types';
import { emitDataChanged, useDataChanged } from '@/lib/data/refresh-bus';
import type { ReadinessState } from '@/lib/health/readiness';
import useCoveReadiness from './useCoveReadiness';

type OpenBucket = 'reply' | 'action';

function gmailThreadUrl(item: EmailItem): string | undefined {
  if (!item.thread_id) return undefined;
  const account = item.account_email
    ? `?authuser=${encodeURIComponent(item.account_email)}`
    : '';
  return `https://mail.google.com/mail/u/${account}#all/${encodeURIComponent(item.thread_id)}`;
}

function bucketOf(item: EmailItem): OpenBucket {
  if (item.bucket === 'reply') return 'reply';
  if (item.bucket === 'action') return 'action';
  const payload =
    item.source_payload && typeof item.source_payload === 'object'
      ? item.source_payload as Record<string, unknown>
      : {};
  return payload.bucket === 'reply' || item.recommended_action === 'reply'
    ? 'reply'
    : 'action';
}

function senderLabel(item: EmailItem): string {
  return item.sender_name || item.sender_email || 'Unknown sender';
}

function shortRelativeTime(value?: string | null): string {
  if (!value) return '';
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return '';
  const now = new Date();
  const elapsed = Math.max(0, now.getTime() - then.getTime());
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const calendarDays = Math.round(
    (startOfToday.getTime() - startOfThen.getTime()) / (24 * 60 * 60_000),
  );
  if (calendarDays === 0) {
    if (elapsed < 60_000) return 'Now';
    if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  }
  if (calendarDays === 1) return 'Yesterday';
  if (calendarDays >= 2 && calendarDays <= 5) {
    return then.toLocaleDateString('en-US', { weekday: 'short' });
  }
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function emailEmptyStateMessage(input: {
  readinessState?: ReadinessState;
  checking: boolean;
  notApplicable: boolean;
}): string {
  if (input.notApplicable || input.readinessState === 'ready') {
    return 'Inbox is clear. Nothing needs you right now.';
  }
  if (input.checking) {
    return 'No open email is recorded in Cove. Checking the inbox connection.';
  }
  if (input.readinessState === 'not_configured') {
    return 'Email is not set up in Cove.';
  }
  if (input.readinessState === 'waiting') {
    return 'No open email is recorded in Cove. Waiting for the first run.';
  }
  return 'No open email is recorded in Cove, but the inbox check is stale or unavailable.';
}

export default function EmailCardDetail({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<EmailItem[] | null>(null);
  const [handledItems, setHandledItems] = useState<EmailItem[]>([]);
  const [handledError, setHandledError] = useState<string>();
  const [showAllHandled, setShowAllHandled] = useState(false);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failureNote, setFailureNote] = useState<string>();
  const {
    readiness,
    error: readinessError,
    checking: readinessChecking,
    notApplicable: readinessNotApplicable,
    retry: retryReadiness,
  } = useCoveReadiness();

  const load = useCallback(async () => {
    setError(undefined);
    setHandledError(undefined);
    try {
      setItems(await listEmailItems('pending'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
    try {
      setHandledItems(await listHandledEmailItems({ days: 7, limit: 200 }));
    } catch {
      setHandledItems([]);
      setHandledError('Could not load this list.');
    }
  }, []);

  useDataChanged(['email_items', 'drafts'], () => void load());

  useEffect(() => {
    void load();
  }, [load]);

  async function markHandled(id: string) {
    setBusyId(id);
    setFailureNote(undefined);
    const previous = items;
    setItems((current) => current?.filter((item) => item.id !== id) ?? current);
    try {
      await archiveEmailItemFromCard(id);
      emitDataChanged(['email_items']);
    } catch (archiveError) {
      setItems(previous);
      setFailureNote(
        `Gmail did not confirm the archive, so Cove left this email open. ${
          archiveError instanceof Error ? archiveError.message : 'Try again.'
        }`,
      );
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return (
      <div className="rounded-md border bg-card p-4 text-sm">
        <p className="font-medium text-foreground">Could not load email.</p>
        <p className="mt-1 text-muted-foreground">{error}</p>
        <button
          onClick={() => void load()}
          className="mt-3 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background"
        >
          Retry
        </button>
      </div>
    );
  }

  if (items === null) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading email...</p>;
  }

  const reply = items.filter((item) => bucketOf(item) === 'reply');
  const action = items.filter((item) => bucketOf(item) === 'action');
  const visibleHandledItems = showAllHandled ? handledItems : handledItems.slice(0, 12);

  function CheckRow({ item, kind }: { item: EmailItem; kind: OpenBucket }) {
    const url = gmailThreadUrl(item);
    return (
      <li className="flex items-start gap-2 rounded-md border bg-background px-2.5 py-2">
        <input
          type="checkbox"
          checked={false}
          disabled={busyId === item.id}
          onChange={() => void markHandled(item.id)}
          aria-label={`Mark handled: ${item.subject ?? senderLabel(item)}`}
          className="mt-0.5 h-4 w-4 accent-[var(--accent-green)]"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-foreground">
            {senderLabel(item)}
            {item.subject ? (
              <span className="font-normal text-muted-foreground"> {item.subject}</span>
            ) : null}
          </p>
          {item.summary ? (
            <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{item.summary}</p>
          ) : null}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-[11px] font-medium text-accent-blue hover:underline"
            >
              {kind === 'reply' ? 'Open draft in Gmail' : 'Open in Gmail'}
            </a>
          ) : null}
        </div>
      </li>
    );
  }

  function HandledRow({ item }: { item: EmailItem }) {
    const url = gmailThreadUrl(item);
    const relativeTime = shortRelativeTime(
      item.actioned_at ?? item.updated_at ?? item.created_at ?? item.received_at,
    );
    return (
      <li className="rounded-md border bg-background px-2.5 py-2">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <p className="min-w-0 truncate text-[13px] leading-snug text-foreground">
            <span className="font-medium">{senderLabel(item)}</span>
            {item.subject ? (
              <span className="text-muted-foreground"> {item.subject}</span>
            ) : null}
          </p>
          {relativeTime ? (
            <time className="shrink-0 text-[11px] text-muted-foreground">
              {relativeTime}
            </time>
          ) : null}
        </div>
        {item.summary ? (
          <p className="mt-0.5 truncate text-[12px] leading-snug text-muted-foreground">
            {item.summary}
          </p>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-[11px] font-medium text-accent-blue hover:underline"
          >
            Open in Gmail
          </a>
        ) : null}
      </li>
    );
  }

  return (
    <div className="space-y-4">
      {failureNote ? (
        <p
          role="status"
          className="rounded-md border border-accent-orange/30 bg-accent-orange/10 px-3 py-2 text-[12px] text-foreground"
        >
          {failureNote}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-6 text-center text-sm text-muted-foreground">
          {emailEmptyStateMessage({
            readinessState: readiness?.email.state,
            checking: readinessChecking,
            notApplicable: readinessNotApplicable,
          })}
        </p>
      ) : null}

      {readinessError && !readinessNotApplicable ? (
        <button type="button" onClick={() => void retryReadiness()} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          Email connection status unavailable. Retry
        </button>
      ) : null}

      {reply.length > 0 ? (
        <Section title="Reply, drafts ready" count={reply.length}>
          <ul className="space-y-1.5">
            {reply.map((item) => <CheckRow key={item.id} item={item} kind="reply" />)}
          </ul>
        </Section>
      ) : null}

      {action.length > 0 ? (
        <Section title="Action or review" count={action.length}>
          <ul className="space-y-1.5">
            {action.map((item) => <CheckRow key={item.id} item={item} kind="action" />)}
          </ul>
        </Section>
      ) : null}

      <Section title="Things you should know" count={handledItems.length}>
        {handledError ? (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {handledError}
          </p>
        ) : handledItems.length > 0 ? (
          <>
            <ul className="space-y-1.5">
              {visibleHandledItems.map((item) => <HandledRow key={item.id} item={item} />)}
            </ul>
            {handledItems.length > 12 ? (
              <button
                type="button"
                aria-expanded={showAllHandled}
                onClick={() => setShowAllHandled((current) => !current)}
                className="mt-2 text-[11px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {showAllHandled ? 'Show fewer' : `Show all (${handledItems.length})`}
              </button>
            ) : null}
            {handledItems.length >= 200 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Showing the most recent 200.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Nothing else happened in email in the last 7 days.
          </p>
        )}
      </Section>

      <p className="border-t pt-3 text-[12px] leading-relaxed text-muted-foreground">
        Replies and actions still need you. Things you should know shows what Cove handled. Search Gmail or Recent activity for more history.
      </p>

      <div className="flex justify-end border-t pt-3">
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title} <span className="tabular-nums">({count})</span>
      </h3>
      {children}
    </div>
  );
}
