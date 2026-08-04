import type { DayPlanItem } from './types';

export const ARRIVAL_ADDITION_OUTCOME_KEY_PREFIX = 'arrival-addition:';

type ArrivalAdditionIdentity = {
  title: string;
  outcome: string;
  why: string;
};

export function arrivalAdditionOutcomeKey(addition: ArrivalAdditionIdentity): string {
  const parts = [addition.title, addition.outcome, addition.why]
    .map((part) => part.trim());
  return `${ARRIVAL_ADDITION_OUTCOME_KEY_PREFIX}${JSON.stringify(parts)}`;
}

export function matchesArrivalAddition(
  item: DayPlanItem,
  addition: ArrivalAdditionIdentity,
): boolean {
  return (
    item.title === addition.title.trim() &&
    item.outcomeKey === arrivalAdditionOutcomeKey(addition)
  );
}
