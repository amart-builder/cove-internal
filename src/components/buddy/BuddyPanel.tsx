'use client';

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import BuddyMessage from './BuddyMessage';
import { BuddyGlyph } from './BuddyLauncher';
import { useBuddy, useBuddyStream } from './BuddyProvider';

type OverrideChoice = 'auto' | 'fast' | 'deep';

export default function BuddyPanel() {
  const {
    open, setOpen, turns, send, resetConversation, sessionInfo,
  } = useBuddy();
  const { streamingTurn, thinking } = useBuddyStream();
  const [draft, setDraft] = useState('');
  const [override, setOverride] = useState<OverrideChoice>('auto');
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const wasOpenRef = useRef(false);
  const streamingTurnId = streamingTurn?.id;
  const historyWithoutStreaming = useMemo(
    () => streamingTurnId ? turns.filter((turn) => turn.id !== streamingTurnId) : turns,
    [streamingTurnId, turns],
  );
  const visibleTurns = streamingTurn
    ? [...historyWithoutStreaming, streamingTurn]
    : historyWithoutStreaming;
  const boundaryIndex = sessionInfo?.createdAt
    ? visibleTurns.findIndex((turn) => turn.started_at >= sessionInfo.createdAt)
    : -1;
  const hasPreviousConversation = Boolean(sessionInfo?.createdAt) && visibleTurns.some(
    (turn) => turn.started_at < sessionInfo!.createdAt,
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const shouldScroll = open && (!wasOpenRef.current || nearBottomRef.current);
    wasOpenRef.current = open;
    if (scroller && shouldScroll) {
      scroller.scrollTop = scroller.scrollHeight;
      nearBottomRef.current = true;
    }
  }, [visibleTurns.length, streamingTurn?.assistant_text, thinking, open]);

  async function submitText(text: string) {
    if (!text.trim() || streamingTurn) return;
    setError(undefined);
    try {
      await send(text, override === 'auto' ? undefined : override);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Buddy couldn't send that.");
    }
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void submitText(text);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    sendDraft();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendDraft();
    }
  }

  async function reset() {
    if (!window.confirm('Start a new Buddy conversation? Your turn history will stay visible.')) return;
    setError(undefined);
    try {
      await resetConversation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Buddy could not reset.');
    }
  }

  return (
    <section
      aria-label="Buddy chat"
      aria-hidden={!open}
      inert={!open}
      className={`fixed bottom-[5.5rem] right-4 z-[120] flex max-h-[calc(100dvh-7.5rem)] w-[26rem] max-w-[calc(100vw-2rem)] origin-bottom-right flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl transition-[opacity,transform] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transform-none ${
        open
          ? 'scale-100 translate-y-0 opacity-100 duration-200'
          : 'pointer-events-none scale-[0.96] translate-y-2 opacity-0 duration-150'
      }`}
    >
      <header className="border-b bg-card/95 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BuddyGlyph className="h-7 w-6 shrink-0" />
            <h2 className="truncate text-sm font-semibold">Buddy</h2>
          </div>
          <div
            className="flex shrink-0 rounded-lg bg-muted p-0.5"
            role="group"
            aria-label="Buddy response depth"
          >
            {(['auto', 'fast', 'deep'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={override === choice}
                className={`min-h-7 rounded-md px-2.5 text-[11px] font-medium capitalize transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transform-none ${
                  override === choice ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setOverride(choice)}
              >
                {choice}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Start a new Buddy conversation"
            title="New conversation"
            disabled={Boolean(streamingTurn)}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-lg text-muted-foreground transition-transform duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.97] motion-reduce:transform-none disabled:opacity-40"
            onClick={() => void reset()}
          >
            ↻
          </button>
          <button
            type="button"
            aria-label="Close Buddy chat"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-xl leading-none text-muted-foreground transition-transform duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.97] motion-reduce:transform-none"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="h-[min(65dvh,36rem)] min-h-28 flex-1 space-y-4 overflow-y-auto overscroll-contain scroll-smooth px-4 py-4 motion-reduce:scroll-auto"
        onScroll={(event) => {
          const target = event.currentTarget;
          nearBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 80;
        }}
      >
        {visibleTurns.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Ask me about anything in Forge.
          </div>
        ) : visibleTurns.map((turn, index) => (
          <Fragment key={turn.id}>
            {hasPreviousConversation && index === boundaryIndex && (
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground" role="separator">
                <span className="h-px flex-1 bg-border" />
                <span>new conversation</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <BuddyMessage
              turn={turn}
              thinking={turn.id === streamingTurn?.id && thinking}
              hostname={sessionInfo?.hostname}
              deepLinksEnabled={sessionInfo?.deepLinksEnabled}
              onRetry={(text) => void submitText(text)}
            />
          </Fragment>
        ))}
        {hasPreviousConversation && boundaryIndex === -1 && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground" role="separator">
            <span className="h-px flex-1 bg-border" />
            <span>new conversation</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
      </div>

      <form className="border-t bg-card p-3" onSubmit={onSubmit}>
        {error && <p className="mb-2 text-xs text-accent-red" role="alert">{error}</p>}
        <div className="flex items-end gap-2">
          <label className="sr-only" htmlFor="buddy-prompt">Message Buddy</label>
          <textarea
            ref={textareaRef}
            id="buddy-prompt"
            value={draft}
            maxLength={4000}
            rows={2}
            disabled={Boolean(streamingTurn)}
            className="max-h-[7.5rem] min-h-11 min-w-0 flex-1 resize-none overflow-y-auto rounded-xl border bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none focus:ring-2 focus:ring-accent-blue/40 disabled:opacity-60"
            placeholder={streamingTurn ? 'Buddy is working…' : 'Ask Buddy…'}
            onKeyDown={onComposerKeyDown}
            onChange={(event) => {
              setDraft(event.target.value);
              event.currentTarget.style.height = 'auto';
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 120)}px`;
            }}
          />
          <button
            type="submit"
            aria-label="Send to Buddy"
            disabled={!draft.trim() || Boolean(streamingTurn)}
            className="min-h-11 min-w-16 rounded-xl border px-3 text-sm font-semibold text-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted active:scale-[0.97] motion-reduce:transform-none disabled:text-muted-foreground disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
