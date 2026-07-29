'use client';

import { useCallback, useEffect, useState } from 'react';
import { archiveEmailItemFromCard, listEmailItems } from '@/lib/data/email';
import type { EmailItem } from '@/lib/data/types';
import { useDataChanged } from '@/lib/data/refresh-bus';

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

export default function EmailCardDetail({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<EmailItem[] | null>(null);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failureNote, setFailureNote] = useState<string>();

  const load = useCallback(async () => {
    try {
      setError(undefined);
      setItems(await listEmailItems('pending'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
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
          Inbox is clear. Nothing needs you right now.
        </p>
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

      <p className="border-t pt-3 text-[12px] leading-relaxed text-muted-foreground">
        If it is here, it still needs you. Once handled, Cove archives it. Search Gmail or Recent activity for history.
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
