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
