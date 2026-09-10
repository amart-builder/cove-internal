import type Database from 'better-sqlite3';
export function scheduleNotificationReminder(dataDir: string, taskId: string, now?: Date): string;
export function drainNotificationReminders(input: {db: Database.Database; dataDir: string; now?: Date; notify: (task: {id:string;title:string;source_type:string|null}) => void; onFailure: (failure:{id:string;title:string;error:string})=>void}): void;
