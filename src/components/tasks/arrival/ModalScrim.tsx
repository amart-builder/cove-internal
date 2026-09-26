'use client';

import {
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Whether a dialog should take the keyboard back.
 *
 * A control that disappears when it is used — "Mark handled" on an email, a
 * row that removes itself — takes focus with it, and the browser drops focus
 * on the document body. The body sits outside this portal, so the Escape and
 * Tab handling below never sees another key and the dialog cannot be closed
 * from the keyboard at all.
 */
export function shouldReclaimFocus(state: {
  dialogConnected: boolean;
  focusInsideDialog: boolean;
  focusInsideAnotherModal: boolean;
  isTopmostModal: boolean;
}): boolean {
  // Unmounting, or already gone: the dialog is on its way out either way.
  if (!state.dialogConnected) return false;
  // Focus only moved from one control to another inside the dialog.
  if (state.focusInsideDialog) return false;
  // A dialog opened on top of this one owns the keyboard now.
  if (state.focusInsideAnotherModal) return false;
  return state.isTopmostModal;
}

export default function ModalScrim({
  labelledBy,
  describedBy,
  returnFocus,
  onClose,
  panelClassName,
  children,
  allowBuddy = false,
}: {
  labelledBy: string;
  describedBy?: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  panelClassName: string;
  children: ReactNode;
  allowBuddy?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>('[data-modal-initial-focus]');
      const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (preferred ?? first ?? dialogRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus();
      });
    };
  }, [returnFocus]);

  const handleKeyDownCapture = useCallback((event: KeyboardEvent) => {
    if (allowBuddy && event.key === 'Escape' && document.querySelector('[data-buddy-surface][aria-hidden="false"]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    event.stopImmediatePropagation();

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    if (allowBuddy) {
      document.querySelectorAll<HTMLElement>('[data-buddy-surface]').forEach(surface => {
        if (surface.hasAttribute('inert')) return;
        if (surface.matches(FOCUSABLE_SELECTOR)) focusable.push(surface);
        focusable.push(...surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      });
    }
    const available = focusable.filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
    if (available.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = available[0];
    const last = available[available.length - 1];
    const active = document.activeElement;
    const outside = !available.includes(active as HTMLElement);
    if (allowBuddy) {
      event.preventDefault();
      const index = available.indexOf(active as HTMLElement);
      available[(index + (event.shiftKey ? -1 : 1) + available.length) % available.length].focus();
      return;
    }
    if (event.shiftKey && (active === first || active === dialogRef.current || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  }, [allowBuddy, onClose]);

  useEffect(() => {
    // Buddy surfaces live outside this portal on purpose, and that path
    // already listens on the document, so it keeps the keyboard either way.
    if (allowBuddy) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const reclaim = () => window.requestAnimationFrame(() => {
      const current = dialogRef.current;
      const active = document.activeElement;
      const modals = document.querySelectorAll('[data-cove-modal]');
      if (!shouldReclaimFocus({
        dialogConnected: Boolean(current?.isConnected),
        focusInsideDialog: Boolean(active && current?.contains(active)),
        focusInsideAnotherModal: Boolean(active instanceof Element && active.closest('[data-cove-modal]')),
        isTopmostModal: modals[modals.length - 1] === current,
      })) return;
      current?.focus();
    });
    dialog.addEventListener('focusout', reclaim);
    return () => dialog.removeEventListener('focusout', reclaim);
  }, [allowBuddy]);

  useEffect(() => {
    if (!allowBuddy) return;
    document.addEventListener('keydown', handleKeyDownCapture, true);
    return () => document.removeEventListener('keydown', handleKeyDownCapture, true);
  }, [allowBuddy, handleKeyDownCapture]);

  return createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm dark:bg-black/55"
      onKeyDownCapture={allowBuddy ? undefined : event => handleKeyDownCapture(event.nativeEvent)}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        data-cove-modal
        role="dialog"
        aria-modal={allowBuddy ? undefined : true}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={panelClassName}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
