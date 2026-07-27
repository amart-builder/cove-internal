'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { resolveRitualContentSwap } from '@/lib/day-plan/presentation';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface DayRitualLayerProps {
  labelledBy: string;
  describedBy?: string;
  announcement?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  inertTargetRef?: RefObject<HTMLElement | null>;
  width?: 'default' | 'wide';
  onEscape: () => void;
  children: ReactNode;
}

export default function DayRitualLayer({
  labelledBy,
  describedBy,
  announcement,
  initialFocusRef,
  inertTargetRef,
  width = 'default',
  onEscape,
  children,
}: DayRitualLayerProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const escapeHandlerRef = useRef(onEscape);

  useEffect(() => {
    escapeHandlerRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const inertTarget = inertTargetRef?.current;
    const wasInert = inertTarget?.hasAttribute('inert') ?? false;
    if (inertTarget) inertTarget.setAttribute('inert', '');

    const focusDialog = window.requestAnimationFrame(() => {
      (initialFocusRef?.current ?? dialogRef.current)?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        escapeHandlerRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
      ).filter(
        (element) =>
          !element.hasAttribute('disabled') &&
          element.offsetParent !== null &&
          // A fading swap overlay is inert: visible but not focusable, so the trap
          // must not count its controls as tab stops.
          !element.closest('[inert]'),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      const focusIsOutside = !dialogRef.current?.contains(activeElement);
      if (
        event.shiftKey &&
        (activeElement === first || activeElement === dialogRef.current || focusIsOutside)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusDialog);
      document.removeEventListener('keydown', handleKeyDown);
      if (inertTarget && !wasInert) inertTarget.removeAttribute('inert');
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
  }, [inertTargetRef, initialFocusRef]);

  return (
    <div
      className="absolute inset-0 z-[100] overflow-y-auto overscroll-contain bg-background/70 p-3 backdrop-blur-md sm:p-6"
      data-day-ritual-layer
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`mx-auto flex min-h-full w-full flex-col justify-center outline-none ${
          width === 'wide' ? 'max-w-7xl' : 'max-w-3xl'
        }`}
      >
        {children}
      </section>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </div>
  );
}

interface DayRitualContentSwapProps {
  // Identifies the ritual view being shown. Changing it mounts the incoming content
  // right away (with the arrive motion) while a snapshot of the outgoing content
  // fades on top of it.
  viewKey: string;
  // Element id of the incoming view's heading (tabIndex={-1}); focused on swap so the
  // dialog's name, Escape routing, and the focus trap all follow the new view at once.
  focusTargetId?: string;
  children: ReactNode;
}

const SWAP_OUT_MS = 120;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

type RitualSnapshot = { key: string; content: ReactNode };

// Swaps ritual content inside the one mounted DayRitualLayer, so consecutive ritual
// views (arrival -> started, started -> settlement, ...) feel continuous instead of the
// whole layer vanishing and replaying its entrance. The incoming view is live and owns
// the dialog immediately; the outgoing snapshot is a short-lived inert visual overlay.
export function DayRitualContentSwap({
  viewKey,
  focusTargetId,
  children,
}: DayRitualContentSwapProps) {
  // Mirror of the last committed view, held in a ref so parent re-renders while a
  // ritual is open never re-reconcile it. Only read at swap time.
  const previousRef = useRef<RitualSnapshot>({ key: viewKey, content: children });
  const [outgoing, setOutgoing] = useState<RitualSnapshot | null>(null);

  // Swap detection runs before paint so the overlay and focus move land in the same
  // frame the incoming view appears. Initial mount is not a swap: previousRef starts
  // on the current key.
  useLayoutEffect(() => {
    const previous = previousRef.current;
    if (previous.key === viewKey) return;
    const decision = resolveRitualContentSwap({
      displayedKey: previous.key,
      nextKey: viewKey,
      reducedMotion: window.matchMedia(REDUCED_MOTION_QUERY).matches,
    });
    if (decision === 'crossfade') setOutgoing(previous);
    if (focusTargetId) document.getElementById(focusTargetId)?.focus();
  }, [viewKey, focusTargetId]);

  // Keep the mirror fresh after every commit. Declared after the swap effect so at
  // swap time previousRef still holds the outgoing view's content.
  useLayoutEffect(() => {
    previousRef.current = { key: viewKey, content: children };
  });

  // Unmount the overlay once its fade finishes.
  useEffect(() => {
    if (!outgoing) return;
    const timeout = window.setTimeout(() => setOutgoing(null), SWAP_OUT_MS);
    return () => window.clearTimeout(timeout);
  }, [outgoing]);

  return (
    <div className="day-ritual-swap">
      <div key={viewKey} className="day-ritual-swap-in">
        {children}
      </div>
      {outgoing && (
        <div key={outgoing.key} className="day-ritual-swap-overlay" inert aria-hidden="true">
          {outgoing.content}
        </div>
      )}
    </div>
  );
}

export type { DayRitualLayerProps, DayRitualContentSwapProps };
