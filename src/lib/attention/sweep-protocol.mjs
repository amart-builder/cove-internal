export const ATTENTION_SWEEP_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["nudges"],
  properties: {
    nudges: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref_kind", "ref_id", "reason", "level"],
        properties: {
          ref_kind: { enum: ["task", "commitment"] },
          ref_id: { type: "string", maxLength: 500 },
          reason: { type: "string", maxLength: 600 },
          level: { enum: ["text", "banner", "board"] },
        },
      },
    },
  },
});

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("attention_sweep_invalid_shape");
  }
  return value;
}

export function validateAttentionSweepOutput(value, snapshot) {
  const input = record(value);
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "nudges" || !Array.isArray(input.nudges)) {
    throw new Error("attention_sweep_invalid_fields");
  }
  if (input.nudges.length > 12) throw new Error("attention_sweep_too_many_nudges");
  const taskIds = new Set(snapshot.tasks.map((item) => item.id));
  const commitmentIds = new Set(snapshot.commitments.map((item) => item.id));
  const seen = new Set();
  return {
    nudges: input.nudges.map((value) => {
      const nudge = record(value);
      const expected = new Set(["ref_kind", "ref_id", "reason", "level"]);
      if (
        Object.keys(nudge).length !== expected.size ||
        Object.keys(nudge).some((key) => !expected.has(key))
      ) {
        throw new Error("attention_sweep_nudge_invalid_fields");
      }
      if (nudge.ref_kind !== "task" && nudge.ref_kind !== "commitment") {
        throw new Error("attention_sweep_ref_kind_invalid");
      }
      if (typeof nudge.ref_id !== "string" || !nudge.ref_id.trim()) {
        throw new Error("attention_sweep_ref_id_invalid");
      }
      const refId = nudge.ref_id.trim();
      const inSnapshot = nudge.ref_kind === "task"
        ? taskIds.has(refId)
        : commitmentIds.has(refId);
      if (!inSnapshot) throw new Error("attention_sweep_ref_outside_snapshot");
      if (!["text", "banner", "board"].includes(nudge.level)) {
        throw new Error("attention_sweep_level_invalid");
      }
      if (typeof nudge.reason !== "string" || !nudge.reason.trim()) {
        throw new Error("attention_sweep_reason_invalid");
      }
      const reason = nudge.reason.replace(/[\u2013\u2014]/g, ":").replace(/\s+/g, " ").trim();
      if (reason.length > 600) throw new Error("attention_sweep_reason_too_long");
      const key = `${nudge.ref_kind}:${refId}`;
      if (seen.has(key)) throw new Error("attention_sweep_duplicate_ref");
      seen.add(key);
      return {
        refKind: nudge.ref_kind,
        refId,
        reason,
        level: nudge.level,
      };
    }),
  };
}
