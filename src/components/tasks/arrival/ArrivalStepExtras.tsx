'use client';

import { useState } from 'react';
import type { PublicMorningBrief } from '@/lib/day-plan/brief';
import type { MorningArrivalProps } from '../MorningArrival';
import OwnerChip, { type OwnerChipEscapeHandler } from './OwnerChip';

export default function ArrivalStepExtras({
  brief,
  onAddSuggestion,
  busy,
  addedSuggestionIndexes,
  onOwnerChoiceOpen,
  onOwnerChoiceClose,
}: {
  brief?: PublicMorningBrief;
  onAddSuggestion?: MorningArrivalProps['onAddSuggestion'];
  busy: boolean;
  addedSuggestionIndexes: ReadonlySet<number>;
  onOwnerChoiceOpen: (handler: OwnerChipEscapeHandler) => void;
  onOwnerChoiceClose: (itemId: string) => void;
}) {
  const [addingIndex, setAddingIndex] = useState<number | null>(null);

  return (
    <section className="mx-auto w-full max-w-[60rem] space-y-8 px-6 py-8 sm:px-10" aria-label="Anything else">
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
