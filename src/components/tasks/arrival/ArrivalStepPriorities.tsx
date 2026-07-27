'use client';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import type { MorningArrivalItem, MorningArrivalProps } from '../MorningArrival';
import ArrivalCard from './ArrivalCard';
import type { OwnerChipEscapeHandler } from './OwnerChip';

export default function ArrivalStepPriorities({
  visibleItems,
  expandedItemId,
  busy,
  draggingRef,
  onExpand,
  onOwnerChange,
  onDragReorder,
  onDismiss,
  setDisclosureRef,
  onOwnerChipOpen,
  onOwnerChipClose,
  onAddWhatChanged,
  onOpenAllWork,
}: {
  visibleItems: MorningArrivalItem[];
  expandedItemId?: string | null;
  busy: boolean;
  draggingRef: { current: boolean };
  onExpand: MorningArrivalProps['onExpand'];
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
  onDragReorder: MorningArrivalProps['onDragReorder'];
  onDismiss: MorningArrivalProps['onDismiss'];
  setDisclosureRef: (itemId: string, node: HTMLButtonElement | null) => void;
  onOwnerChipOpen: (handler: OwnerChipEscapeHandler) => void;
  onOwnerChipClose: (itemId: string) => void;
  onAddWhatChanged?: MorningArrivalProps['onAddWhatChanged'];
  onOpenAllWork?: MorningArrivalProps['onOpenAllWork'];
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    draggingRef.current = false;
    if (!event.over || event.active.id === event.over.id) return;
    void onDragReorder(String(event.active.id), String(event.over.id));
  }

  return (
    <section className="mx-auto w-full max-w-[60rem] space-y-8 px-6 py-8 sm:px-10" aria-label="Your priorities">
      {visibleItems.length > 0 ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => {
            draggingRef.current = true;
          }}
          onDragCancel={() => {
            draggingRef.current = false;
          }}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={visibleItems.map((view) => view.item.id)}
            strategy={rectSortingStrategy}
          >
            <ol className="grid gap-4 lg:grid-cols-3" aria-label="Essential outcomes in priority order">
              {visibleItems.map((view, index) => (
                <ArrivalCard
                  key={view.item.id}
                  view={view}
                  index={index}
                  total={visibleItems.length}
                  expanded={expandedItemId === view.item.id}
                  busy={busy}
                  onExpand={onExpand}
                  onOwnerChange={onOwnerChange}
                  onDismiss={onDismiss}
                  setDisclosureRef={setDisclosureRef}
                  onOwnerChipOpen={onOwnerChipOpen}
                  onOwnerChipClose={onOwnerChipClose}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : (
        <section className="rounded-2xl border bg-card p-5" aria-labelledby="arrival-priorities-empty">
          <h2 id="arrival-priorities-empty" className="text-base font-semibold">
            No credible priorities are ready.
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Forge will not invent work to fill the screen. Add what changed, review All Work, or enter Living Current.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {onAddWhatChanged && (
              <button
                type="button"
                className="press-scale min-h-11 rounded-xl border px-4 text-sm"
                onClick={onAddWhatChanged}
              >
                Add what changed
              </button>
            )}
            {onOpenAllWork && (
              <button
                type="button"
                className="press-scale min-h-11 rounded-xl border px-4 text-sm"
                onClick={onOpenAllWork}
              >
                Open All Work
              </button>
            )}
          </div>
        </section>
      )}

    </section>
  );
}
