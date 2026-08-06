'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ownerLabel } from '@/lib/day-plan/presentation';
import type { DayPlanOwner } from '@/lib/day-plan/types';
import type { MorningArrivalBoardTask, MorningArrivalItem, MorningArrivalProps } from '../MorningArrival';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const OWNERS: DayPlanOwner[] = ['me', 'claude', 'together'];

export function ModalScrim({
  labelledBy,
  describedBy,
  returnFocus,
  onClose,
  panelClassName,
  children,
}: {
  labelledBy: string;
  describedBy?: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  panelClassName: string;
  children: ReactNode;
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

  function handleKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      (event.nativeEvent as KeyboardEvent).stopImmediatePropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    (event.nativeEvent as KeyboardEvent).stopImmediatePropagation();

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const outside = !dialogRef.current?.contains(active);
    if (event.shiftKey && (active === first || active === dialogRef.current || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm dark:bg-black/55"
      onKeyDownCapture={handleKeyDownCapture}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
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

type TodaySheetDetail = {
  kind: 'today';
  view: MorningArrivalItem;
  focusNumber?: number;
};

type BenchSheetDetail = {
  kind: 'bench';
  task: MorningArrivalBoardTask;
};

export type TaskSheetDetail = TodaySheetDetail | BenchSheetDetail;

export default function TaskSheet({
  detail,
  busy,
  returnFocus,
  onClose,
  onOwnerChange,
  onRemove,
  onComplete,
  onAdd,
}: {
  detail: TaskSheetDetail;
  busy: boolean;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
  onRemove: MorningArrivalProps['onRemove'];
  onComplete: MorningArrivalProps['onComplete'];
  onAdd: (task: MorningArrivalBoardTask) => boolean | Promise<boolean>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [addMessage, setAddMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [pendingAction, setPendingAction] = useState<'remove' | 'complete' | 'add'>();
  const today = detail.kind === 'today' ? detail.view : undefined;
  const task = detail.kind === 'bench' ? detail.task : undefined;
  const title = today?.title ?? task?.title ?? '';
  const description = today
    ? today.whyToday?.trim() || today.summary?.trim() || today.description?.trim()
    : task?.description?.trim();
  const project = today?.project ?? task?.project;
  const due = today?.deadline ?? task?.due;
  const actionBusy = busy || pendingAction !== undefined;

  async function runTodayAction(
    action: 'remove' | 'complete',
    mutation: () => void | Promise<void>,
  ) {
    setActionError('');
    setPendingAction(action);
    try {
      await mutation();
      setPendingAction(undefined);
      onClose();
    } catch {
      setActionError(
        action === 'remove'
          ? "Cove couldn't move this task out of today. Try again."
          : "Cove couldn't mark this task done. Try again.",
      );
      setPendingAction(undefined);
    }
  }

  async function addBenchTask() {
    if (!task) return;
    setAddMessage('');
    setActionError('');
    setPendingAction('add');
    try {
      const added = await onAdd(task);
      setPendingAction(undefined);
      if (added) onClose();
      else setAddMessage('Today is full at 10. Move one task down before adding another.');
    } catch {
      setActionError("Cove couldn't add this task to today. Try again.");
      setPendingAction(undefined);
    }
  }

  return (
    <ModalScrim
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      returnFocus={returnFocus}
      onClose={onClose}
      panelClassName="panel-pop-in w-full max-w-[520px] rounded-[22px] border bg-card px-7 py-7 text-foreground shadow-2xl outline-none sm:px-9 sm:pb-7 sm:pt-8 dark:border-white/10"
    >
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        {detail.kind === 'today'
          ? (detail.focusNumber ? `Focus ${detail.focusNumber}` : 'Today')
          : 'Not today'}
      </p>
      <h2 id={titleId} className="mt-2.5 text-xl font-semibold leading-[1.32] tracking-[-0.015em] text-foreground">
        {title}
      </h2>
      {description && (
        <p id={descriptionId} className="mt-3.5 whitespace-pre-wrap text-[13.5px] leading-[1.55] text-muted-foreground">
          {description}
        </p>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        {project ?? 'No project'} <span aria-hidden="true">·</span> {due ? `due ${due}` : 'no due date'}
      </p>

      {today && (
        <OwnerControl
          itemId={today.item.id}
          owner={today.item.owner}
          disabled={actionBusy}
          onOwnerChange={onOwnerChange}
        />
      )}

      {addMessage && (
        <p role="status" className="mt-4 text-xs text-muted-foreground">
          {addMessage}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-4 text-xs text-accent-red">
          {actionError}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-5">
        {today ? (
          <>
            <div className="flex items-center gap-5">
              <button
                type="button"
                disabled={actionBusy}
                className="press-scale min-h-9 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40"
                onClick={() => void runTodayAction('remove', () => onRemove(
                    today.item.id,
                    today.title,
                    today.item.sourceRefs.some(
                      (source) => source.sourceType === 'task' && source.recordId === today.item.taskId,
                    ),
                  ))}
              >
                {pendingAction === 'remove' ? 'Moving…' : 'Not today'}
              </button>
              <button
                type="button"
                disabled={actionBusy}
                className="press-scale min-h-9 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40"
                onClick={() => void runTodayAction(
                  'complete',
                  () => onComplete(today.item.id, today.title),
                )}
              >
                {pendingAction === 'complete' ? 'Completing…' : 'Already done'}
              </button>
            </div>
            <button
              type="button"
              data-modal-initial-focus
              disabled={actionBusy}
              className="press-scale min-h-10 rounded-xl border bg-card px-4 text-[13.5px] font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40"
              onClick={onClose}
            >
              {detail.kind === 'today' && detail.focusNumber ? 'Keep in focus' : 'Keep for today'}
            </button>
          </>
        ) : task ? (
          <>
            <button
              type="button"
              className="press-scale min-h-10 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40"
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              data-modal-initial-focus
              disabled={actionBusy}
              className="press-scale min-h-10 rounded-xl border bg-foreground px-4 text-[13.5px] font-medium text-background outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40"
              onClick={() => void addBenchTask()}
            >
              {pendingAction === 'add' ? 'Adding…' : 'Add to today'}
            </button>
          </>
        ) : null}
      </div>
    </ModalScrim>
  );
}

function OwnerControl({
  itemId,
  owner,
  disabled,
  onOwnerChange,
}: {
  itemId: string;
  owner: DayPlanOwner;
  disabled: boolean;
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
}) {
  const [selected, setSelected] = useState(owner);
  const radioRefs = useRef(new Map<number, HTMLButtonElement>());

  function choose(nextOwner: DayPlanOwner, focus = false) {
    const previous = selected;
    const index = OWNERS.indexOf(nextOwner);
    setSelected(nextOwner);
    if (focus) window.requestAnimationFrame(() => radioRefs.current.get(index)?.focus());
    void Promise.resolve(onOwnerChange(itemId, nextOwner)).catch(() => setSelected(previous));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % OWNERS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + OWNERS.length) % OWNERS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = OWNERS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    choose(OWNERS[nextIndex], true);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Owner"
      aria-orientation="horizontal"
      className="mt-5 flex rounded-xl border bg-muted p-[3px]"
    >
      {OWNERS.map((choice, index) => (
        <button
          key={choice}
          ref={(node) => {
            if (node) radioRefs.current.set(index, node);
            else radioRefs.current.delete(index);
          }}
          type="button"
          role="radio"
          aria-checked={selected === choice}
          tabIndex={selected === choice ? 0 : -1}
          disabled={disabled}
          className={`min-h-9 flex-1 rounded-[9px] text-[13px] font-medium outline-none transition-[color,background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40 ${
            selected === choice
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]'
          }`}
          onClick={() => choose(choice)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {ownerLabel(choice)}
        </button>
      ))}
    </div>
  );
}
