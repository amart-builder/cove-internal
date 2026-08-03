export function realTimeLabel(dueAt: string | undefined): string | undefined {
  if (!dueAt) return undefined;
  // A date-only task has no clock time. Parsing YYYY-MM-DD as UTC makes it look
  // like 5 PM on the previous day in Los Angeles, which is fabricated precision.
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return undefined;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return undefined;

  const encodedClock = dueAt.match(/T(\d{2}):(\d{2})/);
  const encodedMidnight = encodedClock?.[1] === '00' && encodedClock[2] === '00';
  const localMidnight = due.getHours() === 0 && due.getMinutes() === 0;
  if (encodedMidnight || localMidnight) return undefined;

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(due);
}
