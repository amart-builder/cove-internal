/** Preserve ambiguous source dates rather than guessing a deadline. */
export function responsibilityDate(value: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if ((!dateOnly && !timestamp) || !Number.isFinite(+date) ||
      (dateOnly && date.toISOString().slice(0, 10) !== value)) {
    return `${value} (date needs confirmation)`;
  }
  return dateOnly ? date.toLocaleDateString(undefined, {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }) : date.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function capacityEstimate(count: number, knownMinutes: number, unknown: number): string {
  if (!count) return "Your accepted daily focus and proposed work times will appear here.";
  if (unknown >= count) return `${count} planned items. Time estimates are not set.`;
  if (unknown) return `${count} planned items. At least ${knownMinutes} minutes estimated; ${unknown} still need estimates.`;
  return `${count} planned items. ${knownMinutes} minutes estimated.`;
}
