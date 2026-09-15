'use client';

import { useRef, useState } from 'react';
import type { WorkSuggestion } from '@/lib/data/quiet-current';
import ModalScrim from './arrival/ModalScrim';

type Props = {
  suggestions: WorkSuggestion[];
  loading: boolean;
  error?: string;
  onRetry: () => Promise<void>;
  onAccept: (suggestion: WorkSuggestion, source: 'explicit_accept' | 'began_work') => Promise<void | boolean>;
  onDefer: (suggestion: WorkSuggestion) => Promise<void | boolean>;
  onDismiss: (suggestion: WorkSuggestion, reason: string) => Promise<void | boolean>;
  onRefine: (suggestion: WorkSuggestion, title: string, description: string) => Promise<void>;
};

/** A reachable review surface for inferred work. Opening it never accepts work. */
export default function QuietCurrentInbox(props: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<{ id: string; title: string; description: string }>();
  async function run(action: () => Promise<void | boolean>, closeOnSuccess = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await action();
      if (closeOnSuccess && saved !== false) setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Cove couldn't save that decision. Try again.");
    } finally { busyRef.current = false; setBusy(false); }
  }
  return <>
    <button id="quiet-current-review-trigger" ref={triggerRef} type="button" className="quiet-pencil-action mt-2" onClick={() => setOpen(true)}>
      Review suggestions{props.suggestions.length ? ` (${props.suggestions.length})` : ''}
    </button>
    {open && <ModalScrim labelledBy="quiet-current-inbox-title" returnFocus={triggerRef.current}
      onClose={() => setOpen(false)} panelClassName="max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl">
      <div className="flex items-center justify-between gap-4">
        <h2 id="quiet-current-inbox-title" className="text-xl font-semibold">Suggestions for you</h2>
        <button type="button" className="quiet-pencil-action" onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Accepted suggestions go to All Work. Your selected daily priorities stay as they are.</p>
      {(error || props.error) && <p role="alert" className="mt-3 text-sm">{error || props.error}</p>}
      {props.loading ? <p role="status" className="mt-4">Loading suggestions…</p> : props.suggestions.length === 0 && <p className="mt-4">No suggestions to review.</p>}
      <button type="button" disabled={busy} onClick={() => void run(props.onRetry)} className="quiet-pencil-action mt-3">Refresh suggestions</button>
      <div className="mt-4 space-y-5">
        {props.suggestions.map(suggestion => <article key={suggestion.id} className="border-t border-border pt-4">
          {draft?.id === suggestion.id ? <form onSubmit={event => {
            event.preventDefault();
            void run(async () => { await props.onRefine(suggestion, draft.title, draft.description); setDraft(undefined); });
          }} className="space-y-3">
            <label className="block text-sm">Proposal title<input className="quiet-pencil-input mt-1" value={draft.title} required disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
            <label className="block text-sm">Description<textarea className="quiet-pencil-input mt-1" value={draft.description} rows={4} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
            <button className="quiet-pencil-action is-primary" disabled={busy || !draft.title.trim()} type="submit">Save wording</button>
            <button className="quiet-pencil-action" disabled={busy} type="button" onClick={() => setDraft(undefined)}>Cancel</button>
          </form> : <>
            <h3 className="font-semibold">{suggestion.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{suggestion.reason}</p>
            {suggestion.description && <p className="mt-2 whitespace-pre-wrap text-sm">{suggestion.description}</p>}
            {suggestion.kind === 'returned_work' && suggestion.reviewMaterial && <details className="mt-2"><summary>Read Cove&apos;s work</summary><pre className="whitespace-pre-wrap text-sm">{suggestion.reviewMaterial}</pre></details>}
            <p className="mt-2 text-xs text-muted-foreground">Source: {suggestion.source}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestion.kind === 'attention_nudge' ? <button className="quiet-pencil-action is-primary" disabled={busy} onClick={() => void run(() => props.onDismiss(suggestion, 'acknowledged'), true)}>Seen</button> : <>
                <button className="quiet-pencil-action is-primary" disabled={busy} onClick={() => void run(() => props.onAccept(suggestion, 'explicit_accept'), true)}>{suggestion.kind === 'observed_progress' ? 'Mark done' : suggestion.kind === 'stale_task' ? 'Keep it' : 'Accept'}</button>
                <button className="quiet-pencil-action" disabled={busy} onClick={() => void run(() => props.onAccept(suggestion, 'began_work'), true)}>{suggestion.kind === 'observed_progress' || suggestion.kind === 'stale_task' ? 'Open task' : 'Begin'}</button>
                <button className="quiet-pencil-action" disabled={busy} onClick={() => setDraft({ id: suggestion.id, title: suggestion.title, description: suggestion.description })}>Edit</button>
                {!suggestion.resurfacedFromDeferredAt && <button className="quiet-pencil-action" disabled={busy} onClick={() => void run(() => props.onDefer(suggestion), true)}>Later</button>}
                <label className="text-sm">Dismiss
                  <select aria-label={`Dismiss ${suggestion.title}`} disabled={busy} value="" onChange={event => { const reason = event.target.value; if (reason) void run(() => props.onDismiss(suggestion, reason), true); }} className="ml-2 rounded border border-border bg-background p-1">
                    <option value="">Choose reason</option><option value="not_mine">Not mine</option><option value="already_done">Already done</option><option value="not_real_work">Not real work</option><option value="wrong_time">Wrong time</option>
                  </select>
                </label>
              </>}
            </div>
          </>}
        </article>)}
      </div>
    </ModalScrim>}
  </>;
}
