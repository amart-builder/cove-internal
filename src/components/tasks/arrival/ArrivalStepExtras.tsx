'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import type { PublicMorningBrief } from '@/lib/day-plan/brief';
import type { MorningArrivalProps } from '../MorningArrival';
import OwnerChip, { type OwnerChipEscapeHandler } from './OwnerChip';

const DRAFT_KIND_LABELS: Record<string, string> = {
  full: 'Draft ready',
  beats_only: 'Talking points',
  pointer: 'Pointer',
  blocked: 'Blocked',
};

export default function ArrivalStepExtras({
  brief,
  onSalesAction,
  onAddSuggestion,
  busy,
  editingIndex,
  setEditingIndex,
  editDraft,
  setEditDraft,
  addedSuggestionIndexes,
  onOwnerChoiceOpen,
  onOwnerChoiceClose,
}: {
  brief?: PublicMorningBrief;
  onSalesAction?: MorningArrivalProps['onSalesAction'];
  onAddSuggestion?: MorningArrivalProps['onAddSuggestion'];
  busy: boolean;
  editingIndex: number | null;
  setEditingIndex: Dispatch<SetStateAction<number | null>>;
  editDraft: string;
  setEditDraft: Dispatch<SetStateAction<string>>;
  addedSuggestionIndexes: ReadonlySet<number>;
  onOwnerChoiceOpen: (handler: OwnerChipEscapeHandler) => void;
  onOwnerChoiceClose: (itemId: string) => void;
}) {
  const [addingIndex, setAddingIndex] = useState<number | null>(null);

  return (
    <section className="mx-auto w-full max-w-[60rem] space-y-8 px-6 py-8 sm:px-10" aria-label="Anything else">
      {brief && brief.salesActions.length > 0 && onSalesAction && (
        <section aria-labelledby="arrival-sales-heading">
          <h2 id="arrival-sales-heading" className="text-sm font-semibold text-foreground">
            Today&apos;s sales cadence
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Approve marks a message ready for you to send. Forge never sends anything itself.
          </p>
          <ul className="mt-4 divide-y divide-border">
            {brief.salesActions.map((action, index) => {
              const editing = editingIndex === index;
              return (
                <li key={index} className="py-5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{action.contact}</span>
                    <span className="text-xs text-muted-foreground">{action.channel}</span>
                    <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                      {DRAFT_KIND_LABELS[action.draftKind] ?? action.draftKind}
                    </span>
                    {action.state && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium capitalize text-foreground">
                        {action.state}
                      </span>
                    )}
                  </div>
                  {editing ? (
                    <textarea
                      value={editDraft}
                      rows={3}
                      maxLength={2400}
                      aria-label={`Edit the message for ${action.contact}`}
                      className="mt-3 w-full resize-y rounded-xl border bg-background p-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-accent-blue/40"
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                  ) : (
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                      {action.editedText ?? action.draftOrBeats}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          disabled={!editDraft.trim()}
                          className="press-scale min-h-9 rounded-lg border px-3 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-40"
                          onClick={() => {
                            void onSalesAction(index, 'edited', editDraft.trim());
                            setEditingIndex(null);
                          }}
                        >
                          Save edit
                        </button>
                        <button
                          type="button"
                          className="press-scale min-h-9 px-1 text-xs text-muted-foreground hover:underline hover:underline-offset-2"
                          onClick={() => setEditingIndex(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="press-scale min-h-9 rounded-lg border px-3 text-xs font-medium text-foreground hover:bg-muted"
                          onClick={() => void onSalesAction(index, 'approved', action.editedText)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="press-scale min-h-9 px-1 text-xs text-muted-foreground hover:underline hover:underline-offset-2"
                          onClick={() => {
                            setEditingIndex(index);
                            setEditDraft(action.editedText ?? action.draftOrBeats);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="press-scale min-h-9 px-1 text-xs text-muted-foreground hover:underline hover:underline-offset-2"
                          onClick={() => void onSalesAction(index, 'skipped', action.editedText)}
                        >
                          Skip
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {brief && brief.suggestedAdditions.length > 0 && (
        <section aria-labelledby="arrival-additions-heading">
          <h2 id="arrival-additions-heading" className="text-sm font-semibold text-foreground">
            Claude suggests adding
          </h2>
          <ul className="mt-3 divide-y divide-border">
            {brief.suggestedAdditions.map((addition, index) => (
              <li key={index} className="flex flex-wrap items-start justify-between gap-3 py-4 first:pt-0 last:pb-0">
                <span className="min-w-0 flex-1 text-sm leading-relaxed">
                  <span className="font-medium text-foreground">{addition.title}.</span>{' '}
                  <span className="text-muted-foreground">{addition.why}</span>
                </span>
                {addedSuggestionIndexes.has(index) ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                    Added
                  </span>
                ) : onAddSuggestion ? (
                  <OwnerChip
                    itemId={`suggestion-add-${index}`}
                    owner={addition.suggestedOwner}
                    disabled={busy || addingIndex === index}
                    triggerLabel={addingIndex === index ? 'Adding…' : 'Add to today'}
                    closeOnArrow
                    onOwnerChange={async (owner) => {
                      setAddingIndex(index);
                      try {
                        await onAddSuggestion(addition, owner);
                      } finally {
                        setAddingIndex(null);
                      }
                    }}
                    onOpen={onOwnerChoiceOpen}
                    onClose={onOwnerChoiceClose}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {onAddSuggestion && (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Additions go straight onto today&apos;s list. You can dismiss them any time.
            </p>
          )}
        </section>
      )}

    </section>
  );
}
