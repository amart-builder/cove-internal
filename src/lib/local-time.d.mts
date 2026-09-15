export function localDateKey(date: Date, timeZone: string): string;
export function localHour(date: Date, timeZone: string): number;
export function localDayBounds(date: Date, timeZone: string): { start: string; end: string };
export function nextLocalMorning(date: Date, timeZone: string): Date;
