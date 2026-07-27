import { FORGE_REST_TABLES } from "../data/forge-tables";

export const BUDDY_DELETE_TABLES = FORGE_REST_TABLES;
export const BUDDY_DATA_TABLES = [...BUDDY_DELETE_TABLES, "day_plan"] as const;

export type BuddyDataTable = typeof BUDDY_DATA_TABLES[number];
export type BuddyDeleteTable = typeof BUDDY_DELETE_TABLES[number];
export type ReceiptChange = {
  table: BuddyDataTable;
  action: "insert" | "update" | "delete";
  id: string;
  summary: string;
};
export type PendingDelete = {
  table: BuddyDeleteTable;
  id: string;
  label: string;
  disposition?: "confirmed" | "dismissed";
  expiresAt?: string;
};
export type SpawnedSessionReceipt = {
  sessionId: string;
  dir: string;
  title: string;
};
export type BuddyReceipts = {
  changes: ReceiptChange[];
  pendingDeletes: PendingDelete[];
  sessions?: SpawnedSessionReceipt[];
};

const RECEIPTS_BLOCK = /```forge-receipts\s*\r?\n([\s\S]*?)\r?\n```/;
export const MAX_BUDDY_RECEIPT_ITEMS = 50;
export const MAX_BUDDY_RECEIPTS_BYTES = 32 * 1024;
const TABLES = new Set<string>(BUDDY_DATA_TABLES);
const DELETE_TABLES = new Set<string>(BUDDY_DELETE_TABLES);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeChange(raw: unknown): ReceiptChange | undefined {
  const item = object(raw);
  if (!item || !TABLES.has(String(item.table)) ||
    !["insert", "update", "delete"].includes(String(item.action)) ||
    typeof item.id !== "string" || typeof item.summary !== "string") return undefined;
  return {
    table: item.table as BuddyDataTable,
    action: item.action as ReceiptChange["action"],
    id: item.id,
    summary: item.summary,
  };
}

function receiptsBytes(receipts: BuddyReceipts): number {
  return new TextEncoder().encode(JSON.stringify(receipts)).byteLength;
}

function boundReceipts(receipts: BuddyReceipts): BuddyReceipts {
  while (receiptsBytes(receipts) > MAX_BUDDY_RECEIPTS_BYTES) {
    if (receipts.pendingDeletes.length > 0) receipts.pendingDeletes.pop();
    else if (receipts.sessions?.length) receipts.sessions.pop();
    else if (receipts.changes.length > 0) receipts.changes.pop();
    else break;
  }
  return receipts;
}

export function normalizeBuddyReceipts(value: unknown): BuddyReceipts | undefined {
  const root = object(value);
  if (!root) return undefined;
  if (!Array.isArray(root.changes) || !Array.isArray(root.pendingDeletes)) return undefined;
  const changes = root.changes.slice(0, MAX_BUDDY_RECEIPT_ITEMS)
    .flatMap((raw): ReceiptChange[] => {
      const change = normalizeChange(raw);
      return change ? [change] : [];
    });
  const pendingDeletes = root.pendingDeletes.slice(0, MAX_BUDDY_RECEIPT_ITEMS)
    .flatMap((raw): PendingDelete[] => {
      const item = object(raw);
      if (!item || !DELETE_TABLES.has(String(item.table)) ||
        typeof item.id !== "string" || typeof item.label !== "string") return [];
      const disposition = item.disposition === "confirmed" || item.disposition === "dismissed"
        ? item.disposition
        : undefined;
      return [{
        table: item.table as BuddyDeleteTable,
        id: item.id,
        label: item.label,
        ...(disposition ? { disposition } : {}),
        ...(typeof item.expiresAt === "string" ? { expiresAt: item.expiresAt } : {}),
      }];
    });
  const sessions = Array.isArray(root.sessions)
    ? root.sessions.slice(0, MAX_BUDDY_RECEIPT_ITEMS).flatMap((raw): SpawnedSessionReceipt[] => {
      const item = object(raw);
      if (!item || typeof item.sessionId !== "string" || typeof item.dir !== "string" ||
        typeof item.title !== "string") return [];
      return [{ sessionId: item.sessionId, dir: item.dir, title: item.title }];
    })
    : undefined;
  return boundReceipts({ changes, pendingDeletes, ...(sessions ? { sessions } : {}) });
}

export function parseBuddyDataToolOutput(output: string): {
  changes: ReceiptChange[];
  sessions: SpawnedSessionReceipt[];
  errors: string[];
} {
  const changes: ReceiptChange[] = [];
  const sessions: SpawnedSessionReceipt[] = [];
  const errors: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("RECEIPT ")) {
      try {
        const change = normalizeChange(JSON.parse(line.slice("RECEIPT ".length)));
        if (change && changes.length < MAX_BUDDY_RECEIPT_ITEMS) changes.push(change);
      } catch { /* Ignore malformed tool output. */ }
    } else if (line.startsWith("SESSION ") && sessions.length < MAX_BUDDY_RECEIPT_ITEMS) {
      try {
        const value = object(JSON.parse(line.slice("SESSION ".length)));
        if (value && typeof value.sessionId === "string" && typeof value.dir === "string" &&
          typeof value.title === "string") {
          sessions.push({ sessionId: value.sessionId, dir: value.dir, title: value.title });
        }
      } catch { /* Ignore malformed tool output. */ }
    } else if (line.startsWith("ERROR ") && errors.length < MAX_BUDDY_RECEIPT_ITEMS) {
      errors.push(line.slice("ERROR ".length, "ERROR ".length + 2_000));
    }
  }
  const bounded = boundReceipts({ changes, pendingDeletes: [], sessions });
  return { changes: bounded.changes, sessions: bounded.sessions ?? [], errors };
}

export function reconcileBuddyReceipts(
  claimed: BuddyReceipts | undefined,
  authoritativeChanges: ReceiptChange[],
  authoritativeSessions: SpawnedSessionReceipt[] = [],
): BuddyReceipts | undefined {
  const normalizedActual = normalizeBuddyReceipts({
    changes: authoritativeChanges,
    pendingDeletes: [],
  })?.changes ?? [];
  const changes = normalizedActual.map((actual) => {
    const model = claimed?.changes.find((change) =>
      change.table === actual.table && change.action === actual.action && change.id === actual.id);
    return model ? { ...actual, summary: model.summary } : actual;
  });
  const sessions = normalizeBuddyReceipts({
    changes: [],
    pendingDeletes: [],
    sessions: authoritativeSessions,
  })?.sessions ?? [];
  const receipts = normalizeBuddyReceipts({
    changes,
    pendingDeletes: claimed?.pendingDeletes ?? [],
    sessions,
  });
  return receipts && (receipts.changes.length > 0 || receipts.pendingDeletes.length > 0 ||
    Boolean(receipts.sessions?.length))
    ? receipts
    : undefined;
}

export function parseBuddyReceipts(text: string): { text: string; receipts?: BuddyReceipts } {
  const match = RECEIPTS_BLOCK.exec(text);
  if (!match) return { text };
  try {
    const receipts = normalizeBuddyReceipts(JSON.parse(match[1]));
    if (!receipts) return { text };
    const before = text.slice(0, match.index).trimEnd();
    const after = text.slice(match.index + match[0].length).trimStart();
    const stripped = before && after ? `${before}\n${after}` : (before || after);
    return { text: stripped, receipts };
  } catch {
    return { text };
  }
}
