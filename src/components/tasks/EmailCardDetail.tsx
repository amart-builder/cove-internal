'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { archiveEmailItemFromCard, listEmailItems, listHandledEmailItems } from '@/lib/data/email';
import type { EmailItem } from '@/lib/data/types';
import { emitDataChanged, useDataChanged } from '@/lib/data/refresh-bus';
import type { CoveReadiness, ReadinessState } from '@/lib/health/readiness';
import useCoveReadiness from './useCoveReadiness';

type OpenBucket = 'reply' | 'action';

function gmailThreadUrl(item: EmailItem): string | undefined {
  if (!item.thread_id) return undefined;
  const account = item.account_email ? `?authuser=${encodeURIComponent(item.account_email)}` : '';
  return `https://mail.google.com/mail/u/${account}#all/${encodeURIComponent(item.thread_id)}`;
}

function bucketOf(item: EmailItem): OpenBucket {
  if (item.bucket === 'reply') return 'reply';
  if (item.bucket === 'action') return 'action';
  const payload = item.source_payload && typeof item.source_payload === 'object'
    ? item.source_payload as Record<string, unknown> : {};
  return payload.bucket === 'reply' || item.recommended_action === 'reply' ? 'reply' : 'action';
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
  const calendarDays = Math.round((startOfToday.getTime() - startOfThen.getTime()) / (24 * 60 * 60_000));
  if (calendarDays === 0) {
    if (elapsed < 60_000) return 'Now';
    if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  }
  if (calendarDays === 1) return 'Yesterday';
  if (calendarDays >= 2 && calendarDays <= 5) return then.toLocaleDateString('en-US', { weekday: 'short' });
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function emailEmptyStateMessage(input: {
  readinessState?: ReadinessState;
  checking: boolean;
  notApplicable: boolean;
  lastRunOutcome?: string | null;
}): string {
  if (input.notApplicable) return 'No open email is recorded in Cove.';
  if (input.checking) return 'No open email is recorded in Cove. Checking the inbox connection.';
  if (input.readinessState === 'not_configured') return 'Email is not set up in Cove.';
  if (input.readinessState === 'waiting') return 'No open email is recorded in Cove. Waiting for the first run.';
  if (input.lastRunOutcome === 'partial') return 'No open email is recorded, but the last inbox review was incomplete.';
  if (input.readinessState === 'ready') return 'No replies or actions were recorded at the last inbox review.';
  return 'No open email is recorded in Cove, but the inbox check is stale or unavailable.';
}

export function emailReviewStatus(email?: CoveReadiness['email']): string {
  if (!email) return 'Checking inbox review status…';
  if (email.state === 'not_configured') return 'Email is not connected';
  if (email.state === 'waiting') return 'Waiting for the first inbox review';
  if (email.state === 'unavailable') return 'Inbox review needs attention';
  if (email.lastRunOutcome === 'partial') return 'Last inbox review was incomplete';
  if (email.state === 'stale') return 'Inbox review is overdue';
  const reviewed = email.lastSuccessAt ? new Date(email.lastSuccessAt) : null;
  if (!reviewed || Number.isNaN(reviewed.getTime())) return 'Last inbox review time is unavailable';
  return `Last inbox review ${reviewed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

export function EmailReviewRow({ item, handled = false, busy = false, disabled = false, onHandle }: {
  item: EmailItem;
  handled?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onHandle?: (id: string) => void;
}) {
  const url = gmailThreadUrl(item);
  const date = handled ? item.actioned_at ?? item.updated_at : item.received_at;
  const warning = item.workflow_state === 'failed'
    ? 'Cove could not finish preparing this email. Review it in Gmail.'
    : item.recommended_action?.startsWith('Cove withheld the reply draft:') ||
        item.recommended_action?.startsWith('Review the existing Gmail draft')
      ? item.recommended_action : undefined;
  return (
    <li className={`email-review-row ${handled ? 'is-handled' : ''}`}>
      <div className="email-review-row-meta">
        <span className="email-review-sender">{senderLabel(item)}</span>
        {date && <time dateTime={date}>{shortRelativeTime(date)}</time>}
      </div>
      <h4 className="email-review-subject">{item.subject || '(No subject)'}</h4>
      {item.summary && <p className="email-review-summary">{item.summary}</p>}
      {warning && <p className="email-review-warning">{warning}</p>}
      <div className="email-review-row-actions">
        {url && <a href={url} target="_blank" rel="noopener noreferrer">Open in Gmail <span aria-hidden="true">↗</span></a>}
        {!handled && onHandle && (
          <button type="button" disabled={disabled} onClick={() => onHandle(item.id)}
            aria-label={`Mark handled and archive in Gmail: ${item.subject || senderLabel(item)}`}>
            <span aria-hidden="true">✓</span> {busy ? 'Archiving…' : 'Mark handled'}
          </button>
        )}
      </div>
    </li>
  );
}

export default function EmailCardDetail({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<EmailItem[] | null>(null);
  const [handledItems, setHandledItems] = useState<EmailItem[]>([]);
  const [handledError, setHandledError] = useState<string>();
  const [showAllHandled, setShowAllHandled] = useState(false);
  const [showAllFiled, setShowAllFiled] = useState(false);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failureNote, setFailureNote] = useState<string>();
  const requestVersion = useRef(0);
  const { readiness, error: readinessError, checking: readinessChecking,
    notApplicable: readinessNotApplicable, retry: retryReadiness } = useCoveReadiness();

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const pending = await listEmailItems('pending');
      if (version !== requestVersion.current) return;
      setItems(pending);
      setError(undefined);
    } catch (loadError) {
      if (version !== requestVersion.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
    try {
      const handled = await listHandledEmailItems({ days: 7, limit: 200 });
      if (version !== requestVersion.current) return;
      setHandledItems(handled);
      setHandledError(undefined);
    } catch {
      if (version !== requestVersion.current) return;
      setHandledError('Could not refresh recent email history.');
    }
  }, []);

  useDataChanged(['email_items', 'drafts'], () => void load());
  useEffect(() => {
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { requestVersion.current += 1; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);

  async function markHandled(id: string) {
    if (busyId) return;
    setBusyId(id);
    setFailureNote(undefined);
    try {
      await archiveEmailItemFromCard(id);
      // Remove only after confirmation. A failed archive cannot erase another row.
      requestVersion.current += 1;
      setItems(current => current?.filter(item => item.id !== id) ?? current);
      emitDataChanged(['email_items']);
    } catch (archiveError) {
      setFailureNote(`Gmail did not confirm the archive, so this email is still open. ${archiveError instanceof Error ? archiveError.message : 'Try again.'}`);
    } finally { setBusyId(null); }
  }

  const reply = (items ?? []).filter(item => bucketOf(item) === 'reply');
  const action = (items ?? []).filter(item => bucketOf(item) === 'action');
  const updates = handledItems.filter(item => item.bucket !== 'noise');
  const filed = handledItems.filter(item => item.bucket === 'noise');
  const visibleUpdates = showAllHandled ? updates : updates.slice(0, 12);
  const visibleFiled = showAllFiled ? filed : filed.slice(0, 12);
  const statusNeedsAttention = Boolean(readinessError) || readiness?.email.lastRunOutcome === 'partial' ||
    (readiness?.email.state !== undefined && readiness.email.state !== 'ready');
  const jumpTo = (section: string) => document.getElementById(section)?.scrollIntoView({ block: 'start' });

  return (
    <div className="email-review-body">
      <div className="email-review-toolbar">
        <nav aria-label="Email sections" className="email-review-sections">
          <button type="button" onClick={() => jumpTo('email-replies')}>Replies <span>{reply.length}</span></button>
          <button type="button" onClick={() => jumpTo('email-actions')}>Actions <span>{action.length}</span></button>
          <button type="button" onClick={() => jumpTo('email-updates')}>Updates <span>{updates.length}</span></button>
        </nav>
        <p className={`email-review-freshness ${statusNeedsAttention ? 'needs-attention' : ''}`}>
          {readinessError ? 'Inbox review status unavailable' : emailReviewStatus(readiness?.email)}
          {statusNeedsAttention && <button type="button" onClick={() => void retryReadiness()}>Check status</button>}
        </p>
      </div>
      <div className="email-review-scroll">
        {failureNote && <p role="alert" className="email-review-notice">{failureNote}</p>}
        {error && <div role="alert" className="email-review-notice"><p>Could not refresh email. {error}</p><button type="button" onClick={() => void load()}>Retry</button></div>}
        {items === null ? (!error && <p className="email-review-empty">Loading email…</p>) : (
          <>
            {items.length === 0 && <p className="email-review-empty">{emailEmptyStateMessage({ readinessState: readiness?.email.state, checking: readinessChecking, notApplicable: readinessNotApplicable, lastRunOutcome: readiness?.email.lastRunOutcome })}</p>}
            <Section id="email-replies" title="Replies" count={reply.length} description="Continue the conversation in Gmail.">
              {reply.length ? <ul>{reply.map(item => <EmailReviewRow key={item.id} item={item} busy={busyId === item.id} disabled={Boolean(busyId)} onHandle={id => void markHandled(id)} />)}</ul> : <p className="email-review-section-empty">No replies waiting in Cove.</p>}
            </Section>
            <Section id="email-actions" title="Actions & review" count={action.length} description="The decisions and follow-through that need you.">
              {action.length ? <ul>{action.map(item => <EmailReviewRow key={item.id} item={item} busy={busyId === item.id} disabled={Boolean(busyId)} onHandle={id => void markHandled(id)} />)}</ul> : <p className="email-review-section-empty">No actions waiting in Cove.</p>}
            </Section>
            <Section id="email-updates" title="Things you should know" count={updates.length} description="Useful updates from the last seven days, already filed in Gmail.">
              {handledError && <p role="status" className="email-review-warning">{handledError}</p>}
              {visibleUpdates.length ? <ul>{visibleUpdates.map(item => <EmailReviewRow key={item.id} item={item} handled />)}</ul> : !handledError && <p className="email-review-section-empty">No informational updates recorded in the last seven days.</p>}
              {updates.length > 12 && <button type="button" className="email-review-more" aria-expanded={showAllHandled} onClick={() => setShowAllHandled(v => !v)}>{showAllHandled ? 'Show fewer' : `Show all updates (${updates.length})`}</button>}
            </Section>
            <details className="email-review-filed">
              <summary>Automatically filed <span>{filed.length}</span><small>Newsletters, receipts and routine mail</small></summary>
              {filed.length ? <ul>{visibleFiled.map(item => <EmailReviewRow key={item.id} item={item} handled />)}</ul> : <p className="email-review-section-empty">{handledError ? 'Recent email history is unavailable.' : 'No routine mail recorded in the last seven days.'}</p>}
              {filed.length > 12 && <button type="button" className="email-review-more" aria-expanded={showAllFiled} onClick={() => setShowAllFiled(v => !v)}>{showAllFiled ? 'Show fewer' : `Show all filed (${filed.length})`}</button>}
            </details>
            {handledItems.length >= 200 && <p className="email-review-section-empty">Showing the most recent 200 handled emails.</p>}
          </>
        )}
      </div>
      <footer className="email-review-footer"><p>Mark handled archives the email in Gmail.</p><button type="button" onClick={onClose}>Done</button></footer>
    </div>
  );
}

function Section({ id, title, count, description, children }: {
  id: string; title: string; count: number; description: string; children: React.ReactNode;
}) {
  return <section id={id} className="email-review-section" aria-labelledby={`${id}-heading`}>
    <header><h3 id={`${id}-heading`}>{title} <span>{count}</span></h3><p>{description}</p></header>
    {children}
  </section>;
}
