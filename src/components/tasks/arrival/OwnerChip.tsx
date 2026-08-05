'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { DayPlanOwner } from '@/lib/day-plan/types';
import { ownerLabel } from '@/lib/day-plan/presentation';

const OWNERS: DayPlanOwner[] = ['me', 'claude', 'together'];

export type OwnerChipEscapeHandler = {
  itemId: string;
  closeAndFocus: () => void;
};

export default function OwnerChip({
  itemId,
  owner,
  disabled,
  inverted = false,
  triggerLabel,
  closeOnArrow = false,
  onOwnerChange,
  onOpen,
  onClose,
}: {
  itemId: string;
  owner: DayPlanOwner;
  disabled: boolean;
  inverted?: boolean;
  triggerLabel?: string;
  closeOnArrow?: boolean;
  onOwnerChange: (owner: DayPlanOwner) => void | Promise<void>;
  onOpen: (handler: OwnerChipEscapeHandler) => void;
  onClose: (itemId: string) => void;
}) {
  const groupId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choiceRefs = useRef(new Map<number, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, OWNERS.indexOf(owner)));
  const [optimisticOwner, setOptimisticOwner] = useState(owner);

  useEffect(() => {
    if (!open) return;
    choiceRefs.current.get(focusIndex)?.focus();
  }, [focusIndex, open]);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (containerRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      onClose(itemId);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [itemId, onClose, open]);

  function closeAndFocus() {
    setOpen(false);
    onClose(itemId);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function openChoices() {
    if (disabled) return;
    const nextIndex = Math.max(0, OWNERS.indexOf(owner));
    setOptimisticOwner(owner);
    setFocusIndex(nextIndex);
    setOpen(true);
    onOpen({ itemId, closeAndFocus });
  }

  function choose(nextOwner: DayPlanOwner) {
    setOptimisticOwner(nextOwner);
    void Promise.resolve(onOwnerChange(nextOwner)).catch(() => {
      setOptimisticOwner(owner);
    });
    closeAndFocus();
  }

  function handlePopoverKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      (event.nativeEvent as KeyboardEvent).stopImmediatePropagation();
      closeAndFocus();
    }
  }

  function handleChoiceKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (focusIndex + 1) % OWNERS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (focusIndex - 1 + OWNERS.length) % OWNERS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = OWNERS.length - 1;
    }

    if (nextIndex === undefined) return;
    event.preventDefault();
    setFocusIndex(nextIndex);
    setOptimisticOwner(OWNERS[nextIndex]);
    void Promise.resolve(onOwnerChange(OWNERS[nextIndex])).catch(() => {
      setOptimisticOwner(owner);
    });
    if (closeOnArrow) {
      closeAndFocus();
      return;
    }
    choiceRefs.current.get(nextIndex)?.focus();
  }

  return (
    <div ref={containerRef} className="relative inline-flex shrink-0" data-card-control>
      <button
        ref={triggerRef}
        type="button"
        className={`press-scale h-7 rounded-full border px-2 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50 ${
          inverted
            ? 'border-background/20 text-background/65 hover:text-background focus-visible:text-background'
            : 'border-foreground/10 text-muted-foreground hover:text-foreground focus-visible:text-foreground'
        }`}
        aria-expanded={open}
        aria-controls={groupId}
        disabled={disabled}
        data-card-control
        onClick={() => open ? closeAndFocus() : openChoices()}
      >
        {triggerLabel ?? ownerLabel(owner)}{' '}
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div
          id={groupId}
          role="radiogroup"
          aria-label="Owner"
          aria-orientation="horizontal"
          className="panel-pop-in absolute bottom-[calc(100%+0.375rem)] left-0 z-50 flex items-center gap-1 whitespace-nowrap rounded-xl border bg-background p-1.5 text-foreground shadow-lg [animation-duration:150ms]"
          onKeyDownCapture={handlePopoverKeyDownCapture}
        >
          {OWNERS.map((choice, index) => (
            <button
              key={choice}
              ref={(node) => {
                if (node) choiceRefs.current.set(index, node);
                else choiceRefs.current.delete(index);
              }}
              type="button"
              role="radio"
              aria-checked={optimisticOwner === choice}
              tabIndex={focusIndex === index ? 0 : -1}
              disabled={disabled}
              className={`press-scale h-7 rounded-full border px-2 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50 ${
                optimisticOwner === choice
                  ? 'border-accent-blue text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => choose(choice)}
              onKeyDown={handleChoiceKeyDown}
            >
              {ownerLabel(choice)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
