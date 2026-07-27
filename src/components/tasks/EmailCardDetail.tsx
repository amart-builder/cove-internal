'use client';

import { useCallback, useEffect, useState } from 'react';
import { listAllEmailItems, updateEmailItem } from '@/lib/data/email';
import type { EmailItem } from '@/lib/data/types';
import { useDataChanged } from '@/lib/data/refresh-bus';

// The interactive body of the daily "Emails: <date>" card. The forge-email skill
// keeps email_items in sync (Gmail is the source of truth); this view renders the
// current open items grouped into the same buckets the skill writes, links each to
// its Gmail thread (draft sits inline), and lets the user check off action items,
// which flips email_items.status so the next triage archives that thread.

type Bucket = 'reply' | 'action' | 'fyi' | 'archived';

function todayStr(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function gmailThreadUrl(threadId?: string | null): string | undefined {
  if (!threadId) return undefined;
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;
}

const GMAIL_REPLY_LABEL_URL =
  'https://mail.google.com/mail/u/0/#search/label%3AForge%2FReply';
const GMAIL_ARCHIVED_LABEL_URL =
  'https://mail.google.com/mail/u/0/#search/label%3AForge%2FArchived';

function meta(e: EmailItem): { bucket?: string; triageDate?: string; archivedNote?: string } {
  const sp =
    e.source_payload && typeof e.source_payload === 'object'
      ? (e.source_payload as Record<string, unknown>)
      : {};
  const str = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  return { bucket: str('bucket'), triageDate: str('triage_date'), archivedNote: str('archived_note') };
}

// Prefer the bucket the skill stored; fall back to classification for older rows.
function bucketOf(e: EmailItem): Bucket {
  const b = meta(e).bucket;
  if (b === 'reply' || b === 'action' || b === 'fyi' || b === 'archived') return b;
  if (e.classification === 'log_only') return 'archived';
  if (e.classification === 'tiding') return 'fyi';
  return e.recommended_action === 'reply' ? 'reply' : 'action';
}

function senderLabel(e: EmailItem): string {
  return e.sender_name || e.sender_email || 'Unknown sender';
}

export default function EmailCardDetail({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<EmailItem[] | null>(null);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const rows = await listAllEmailItems();
      setItems(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useDataChanged(['email_items', 'drafts'], () => void load());

  useEffect(() => {
    void load();
  }, [load]);

  async function markActioned(id: string) {
    setBusyId(id);
    const previous = items;
    // Optimistic: an actioned item drops out of the open sections immediately.
    setItems((cur) => (cur ? cur.map((e) => (e.id === id ? { ...e, status: 'actioned' } : e)) : cur));
    try {
      await updateEmailItem(id, { status: 'actioned' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems(previous);
    } finally {
      setBusyId(null);
    }
  }

  const today = todayStr();
  const all = items ?? [];
  const isOpen = (e: EmailItem) => e.status === 'pending';

  const carried = all.filter(
    (e) =>
      isOpen(e) &&
      (bucketOf(e) === 'reply' || bucketOf(e) === 'action') &&
      !!meta(e).triageDate &&
      (meta(e).triageDate as string) < today,
  );
  const carriedIds = new Set(carried.map((e) => e.id));
  const reply = all.filter((e) => isOpen(e) && bucketOf(e) === 'reply' && !carriedIds.has(e.id));
  const action = all.filter((e) => isOpen(e) && bucketOf(e) === 'action' && !carriedIds.has(e.id));
  const fyi = all.filter((e) => bucketOf(e) === 'fyi' && meta(e).triageDate === today);
  const archived = all.filter((e) => bucketOf(e) === 'archived' && meta(e).triageDate === today);
  const doneToday = all.filter((e) => e.status === 'actioned' && meta(e).triageDate === today);

  if (error) {
    return (
      <div className="rounded-md border bg-card p-4 text-sm">
        <p className="font-medium text-foreground">Could not load today&apos;s email.</p>
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
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading today&apos;s email...</p>;
  }

  const nothingOpen =
    carried.length === 0 && reply.length === 0 && action.length === 0 && fyi.length === 0 && archived.length === 0;

  function CheckRow({ e, kind }: { e: EmailItem; kind: 'reply' | 'action' }) {
    const url = gmailThreadUrl(e.thread_id);
    return (
      <li className="flex items-start gap-2 rounded-md border bg-background px-2.5 py-2">
        <input
          type="checkbox"
          checked={false}
          disabled={busyId === e.id}
          onChange={() => void markActioned(e.id)}
          aria-label={`Mark done: ${e.subject ?? senderLabel(e)}`}
          className="mt-0.5 h-4 w-4 accent-[var(--accent-green)]"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-foreground">
            {senderLabel(e)}
            {e.subject ? <span className="font-normal text-muted-foreground"> {e.subject}</span> : null}
          </p>
          {e.summary ? (
            <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{e.summary}</p>
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
      {nothingOpen ? (
        <p className="rounded-md border bg-card px-3 py-6 text-center text-sm text-muted-foreground">
          Inbox is clear. Nothing needs you right now.
        </p>
      ) : null}

      {carried.length > 0 && (
        <Section title="Carried over" count={carried.length}>
          <ul className="space-y-1.5">
            {carried.map((e) => (
              <CheckRow key={e.id} e={e} kind={bucketOf(e) === 'reply' ? 'reply' : 'action'} />
            ))}
          </ul>
        </Section>
      )}

      {reply.length > 0 && (
        <Section title="Reply, drafts ready" count={reply.length}>
          <ul className="space-y-1.5">
            {reply.map((e) => (
              <CheckRow key={e.id} e={e} kind="reply" />
            ))}
          </ul>
          <a
            href={GMAIL_REPLY_LABEL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            Open all drafts in Gmail
          </a>
        </Section>
      )}

      {action.length > 0 && (
        <Section title="Action items" count={action.length}>
          <ul className="space-y-1.5">
            {action.map((e) => (
              <CheckRow key={e.id} e={e} kind="action" />
            ))}
          </ul>
        </Section>
      )}

      {fyi.length > 0 && (
        <Section title="Notifications" count={fyi.length}>
          <ul className="space-y-1">
            {fyi.map((e) => {
              const url = gmailThreadUrl(e.thread_id);
              return (
                <li key={e.id} className="text-[12px] leading-snug text-muted-foreground">
                  <span className="text-foreground">{senderLabel(e)}</span>
                  {e.summary ? ` ${e.summary}` : e.subject ? ` ${e.subject}` : ''}
                  {url ? (
                    <>
                      {' '}
                      <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent-blue hover:underline">
                        open
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {archived.length > 0 && (
        <Section title="Archived" count={archived.length}>
          <ul className="space-y-0.5">
            {archived.slice(0, 40).map((e) => (
              <li key={e.id} className="truncate text-[12px] text-muted-foreground">
                {meta(e).archivedNote || e.subject || senderLabel(e)}
              </li>
            ))}
            {archived.length > 40 ? (
              <li className="text-[11px] text-muted-foreground">and {archived.length - 40} more</li>
            ) : null}
          </ul>
          <a
            href={GMAIL_ARCHIVED_LABEL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-block text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            Rescue any in Gmail
          </a>
        </Section>
      )}

      {doneToday.length > 0 && (
        <p className="border-t pt-3 text-[12px] text-muted-foreground">
          Done today: {doneToday.length} cleared
        </p>
      )}

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

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title} <span className="tabular-nums">({count})</span>
      </h3>
      {children}
    </div>
  );
}
