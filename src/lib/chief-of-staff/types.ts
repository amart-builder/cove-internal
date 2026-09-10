export const CHIEF_OF_STAFF_JOB_TYPE = "chief-of-staff-wake";

export const CHIEF_OF_STAFF_REASONS = [
  "brief",
  "triage",
  "meeting",
  "sweep",
  "nightly",
  "manual",
  "follow_through",
] as const;

export type ChiefOfStaffReason = (typeof CHIEF_OF_STAFF_REASONS)[number];

export type ChiefOfStaffWakePayload = {
  reason: ChiefOfStaffReason;
  note?: string;
  payload: Record<string, unknown>;
};

export type ChiefOfStaffAction = {
  action_id: string;
  kind: string;
  why: string;
  [key: string]: unknown;
};

export type ChiefOfStaffOutput = {
  journal: string[];
  watching: string[];
  actions: ChiefOfStaffAction[];
};

const SECRET_LOOKING_TEXT = /(?:\b[a-f0-9]{40,}\b|(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{40,}(?![A-Za-z0-9+/_=-])|\bya29\.|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN\b|\bBearer\s+\S+)/i;

const ACTION_TEXT_LIMITS: Record<string, number> = {
  action_id: 120,
  kind: 80,
  why: 200,
  title: 500,
  details: 5_000,
  due_at: 40,
  remind_at: 40,
  project: 200,
  status: 20,
  task_id: 200,
  contact_id: 200,
  channel: 20,
  summary: 5_000,
  next_action: 500,
  next_follow_up_at: 10,
  notes: 5_000,
  stage: 40,
  content: 5_000,
  suggestion_kind: 40,
  description: 5_000,
  reason: 2_000,
  due_date: 10,
  claim_key: 300,
  ref_kind: 20,
  ref_id: 200,
  level: 20,
  expected_version: 40,
  owner: 160,
  next_check_at: 40,
  planned_for: 40,
  plan_state: 20,
  blocker: 1000,
  goal: 1000,
  completion_criterion: 1000,
};

export const CHIEF_OF_STAFF_ACTION_FIELDS: Record<string, readonly string[]> = {
  task_create: ["title", "details", "due_at", "remind_at", "priority", "project", "status"],
  task_update: ["expected_version", "task_id", "title", "details", "due_at", "remind_at", "priority", "status"],
  plan_update: ["ref_kind", "ref_id", "expected_version", "expected_revision", "next_action", "owner", "plan_state", "next_check_at", "planned_for", "estimate_minutes", "blocker", "goal", "completion_criterion"],
  prepare: ["ref_kind", "ref_id", "expected_version", "title", "content"],
  pipeline_add: ["contact_id", "stage", "next_action", "next_follow_up_at", "notes"],
  pipeline_log_touch: ["contact_id", "channel", "summary", "next_action", "next_follow_up_at"],
  pipeline_update: ["contact_id", "next_action", "next_follow_up_at", "notes"],
  pipeline_move: ["contact_id", "stage"],
  crm_note: ["contact_id", "title", "content"],
  suggest: ["suggestion_kind", "title", "description", "reason", "priority", "due_date", "claim_key"],
  notify: ["ref_kind", "ref_id", "level", "reason"],
  phone_reminder: ["task_id", "expected_version", "remind_at", "level", "reason", "next_action"],
};

export function scrubModelText(value: string, maximum: number): string {
  const scrubbed = value.split(/\r?\n/).map((line) =>
    SECRET_LOOKING_TEXT.test(line) ? "[redacted]" : line
  ).join("\n");
  return scrubbed.slice(0, Math.max(0, maximum));
}

export function scrubChiefOfStaffAction(action: ChiefOfStaffAction): ChiefOfStaffAction {
  return Object.fromEntries(Object.entries(action).map(([field, value]) => [
    field,
    typeof value === "string"
      ? scrubModelText(value, ACTION_TEXT_LIMITS[field] ?? 5_000)
      : value,
  ])) as ChiefOfStaffAction;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} lines.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.trim().length > 240) {
      throw new Error(`${label}[${index}] must be 1 to 240 characters.`);
    }
    return scrubModelText(item.trim(), 240);
  });
}

export function validateChiefOfStaffOutput(value: unknown): ChiefOfStaffOutput {
  const input = record(value, "Chief-of-staff output");
  for (const key of Object.keys(input)) {
    if (!["journal", "watching", "actions"].includes(key)) {
      throw new Error(`Unknown chief-of-staff output field: ${key}.`);
    }
  }
  const journal = stringArray(input.journal, "journal", 2, 6);
  const watching = stringArray(input.watching, "watching", 0, 8);
  if (!Array.isArray(input.actions) || input.actions.length > 25) {
    throw new Error("actions must contain 0 to 25 items.");
  }
  const seen = new Set<string>();
  const actions = input.actions.map((value, index) => {
    const action = record(value, `actions[${index}]`);
    const ownFields = new Set([
      "action_id",
      "kind",
      "why",
      ...(typeof action.kind === "string"
        ? CHIEF_OF_STAFF_ACTION_FIELDS[action.kind] ?? []
        : []),
    ]);
    for (const [field, fieldValue] of Object.entries(action)) {
      if (!ownFields.has(field)) continue;
      if (typeof fieldValue !== "string") continue;
      const maximum = ACTION_TEXT_LIMITS[field] ?? 5_000;
      if (fieldValue.trim().length > maximum) {
        throw new Error(`actions[${index}].${field} is too long.`);
      }
    }
    const actionId = action.action_id;
    const kind = action.kind;
    const why = action.why;
    if (typeof actionId !== "string" || !actionId.trim() || actionId.trim().length > 120) {
      throw new Error(`actions[${index}].action_id is invalid.`);
    }
    if (seen.has(actionId.trim())) {
      throw new Error(`Duplicate action_id: ${actionId.trim()}.`);
    }
    seen.add(actionId.trim());
    if (typeof kind !== "string" || !kind.trim() || kind.trim().length > 80) {
      throw new Error(`actions[${index}].kind is invalid.`);
    }
    if (typeof why !== "string" || !why.trim() || why.trim().length > 200) {
      throw new Error(`actions[${index}].why must be 1 to 200 characters.`);
    }
    return scrubChiefOfStaffAction({
      ...action,
      action_id: actionId.trim(),
      kind: kind.trim(),
      why: why.trim(),
    });
  });
  if (actions.filter((action) => action.kind === "notify").length > 4) {
    throw new Error("actions may contain at most 4 notify items.");
  }
  if (actions.filter(action => action.kind === "prepare").length > 1) throw new Error("A wake may prepare at most one draft.");
  return { journal, watching, actions };
}

export function stripStoredText(value: unknown, maximum: number): string {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function requiredActionText(
  action: Record<string, unknown>,
  field: string,
  maximum: number,
): string {
  const value = action[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long.`);
  return text;
}

export function optionalActionText(
  action: Record<string, unknown>,
  field: string,
  maximum: number,
): string | undefined {
  if (!Object.hasOwn(action, field) || action[field] === null) return undefined;
  const value = action[field];
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long.`);
  return text;
}
