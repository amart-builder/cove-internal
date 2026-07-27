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
  triggerLabel,
  closeOnArrow = false,
  onOwnerChange,
  onOpen,
  onClose,
}: {
  itemId: string;
  owner: DayPlanOwner;
  disabled: boolean;
  triggerLabel?: string;
  closeOnArrow?: boolean;
  onOwnerChange: (owner: DayPlanOwner) => void | Promise<void>;
  onOpen: (handler: OwnerChipEscapeHandler) => void;
  onClose: (itemId: string) => void;
}) {
  const groupId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const choiceRefs = useRef(new Map<number, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, OWNERS.indexOf(owner)));
  const [optimisticOwner, setOptimisticOwner] = useState(owner);

  useEffect(() => {
    if (!open) return;
    choiceRefs.current.get(focusIndex)?.focus();
  }, [focusIndex, open]);

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

  function handleChoiceKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      (event.nativeEvent as KeyboardEvent).stopImmediatePropagation();
      closeAndFocus();
      return;
    }

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
    <div className="flex min-h-9 flex-wrap items-center gap-1" data-card-control>
      <button
        ref={triggerRef}
        type="button"
        className="press-scale min-h-9 rounded-full border px-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50"
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
          className="panel-pop-in flex flex-wrap items-center gap-1 [animation-duration:150ms]"
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
              className={`press-scale min-h-9 rounded-full border px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50 ${
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
