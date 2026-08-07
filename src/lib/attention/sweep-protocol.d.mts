export type AttentionSweepSnapshot = {
  tasks: Array<{ id: string; [key: string]: unknown }>;
  commitments: Array<{ id: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
export const ATTENTION_SWEEP_JSON_SCHEMA: string;
export function validateAttentionSweepOutput(value: unknown, snapshot: AttentionSweepSnapshot): {
  nudges: Array<{
    refKind: "task" | "commitment";
    refId: string;
    reason: string;
    level: "text" | "banner" | "board";
  }>;
};
