import type Database from "better-sqlite3";

export type AttentionKind = "sweep_nudge" | "floor_nudge" | "urgent_email";
export type AttentionRefKind = "task" | "commitment" | "email";
export type AttentionLevel = "text" | "banner" | "board" | "suppressed" | "shadow";

export type AttentionLedgerRow = {
  id: string;
  kind: AttentionKind;
  refKind: AttentionRefKind;
  refId: string;
  level: AttentionLevel;
  reason: string;
  deliveredAt: string | null;
  suppressedReason: string | null;
  createdAt: string;
};

export const ATTENTION_LIMITS: Readonly<{
  textsPerDay: number;
  bannersPerDay: number;
  modelTextsPerDay: number;
}>;

export function attentionCooldown(db: Database.Database, input: {
  refKind: AttentionRefKind;
  refId: string;
  now: Date | string;
}): { allowed: boolean; priorNudges: number; nextAllowedAt: string | null };

export function dailyAttentionUsage(db: Database.Database, now?: Date): {
  texts: number;
  banners: number;
  modelTexts: number;
};

export function allocateAttention(db: Database.Database, input: {
  kind: AttentionKind;
  refKind: AttentionRefKind;
  refId: string;
  requestedLevel: "text" | "banner" | "board";
  maximumLevel?: "text" | "banner" | "board";
  reason: string;
  shadow?: boolean;
  now?: Date | string;
}): {
  row: AttentionLedgerRow | null;
  suppressionRows: AttentionLedgerRow[];
  cooldown: { allowed: boolean; priorNudges: number; nextAllowedAt: string | null };
  finalLevel: AttentionLevel;
};

export function finalizeAttentionDelivery(db: Database.Database, input: {
  id: string;
  level: AttentionLevel;
  suppressedReason?: string;
  now?: Date | string;
}): void;

export function recordSweepRun(db: Database.Database, input: {
  failed: boolean;
  reason?: string;
  now?: Date | string;
}): { row: AttentionLedgerRow; consecutiveFailures: number };

export function hasAttentionLedger(db: Database.Database): boolean;
