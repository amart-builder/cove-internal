export const PIPELINE_STAGES = [
  { id: "reach_out", label: "Reach out" },
  { id: "keep_warm", label: "Keep warm" },
  { id: "interested", label: "Interested" },
  { id: "call_scheduled", label: "Call scheduled" },
  { id: "pitched", label: "Pitched, deciding" },
  { id: "discovery_ready", label: "Discovery: ready to book" },
  { id: "discovery_booked", label: "Discovery: booked" },
  { id: "proposal", label: "Proposal out" },
  { id: "client", label: "Client" },
  { id: "lost", label: "Lost" },
  { id: "parked", label: "Parked" },
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number]["id"];
export type FollowUpStatus = "overdue" | "today" | "soon" | "later" | "none";

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> =
  Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage.id, stage.label])) as
    Record<PipelineStage, string>;

const CLOSED_STAGES = new Set<PipelineStage>(["client", "lost", "parked"]);

export type PipelineDeal = {
  id: string;
  contact_id: string;
  stage: PipelineStage;
  monthly_value: number | null;
  discovery_price: number | null;
  next_action: string;
  next_follow_up_at: string | null;
  source: string;
  notes: string;
  last_touch_at: string | null;
  stage_changed_at: string;
  created_at: string;
  updated_at: string;
};

export type PipelineDealWithContact = PipelineDeal & {
  name: string;
  company: string;
  email: string | null;
  phone: string | null;
  last_interaction_at: string | null;
};

export type PipelineSummary = {
  mrr: number;
  openCount: number;
  overdueCount: number;
  dueSoonCount: number;
};

export type PipelineAttentionReason =
  | "overdue"
  | "missing_action"
  | "missing_date";

export type PipelineAttentionItem = {
  deal: PipelineDealWithContact;
  reason: PipelineAttentionReason;
  reasons: PipelineAttentionReason[];
};

export type PipelineDealPatch = {
  monthlyValue?: number | null;
  discoveryPrice?: number | null;
  nextAction?: string;
  nextFollowUpAt?: string | null;
  source?: string;
  notes?: string;
};

export type CreatePipelineDealInput = PipelineDealPatch & {
  contactId: string;
  stage: PipelineStage;
};

export type PipelineTouchType = "call" | "email" | "text" | "meeting" | "note";

export type LogPipelineTouchInput = {
  activityType: PipelineTouchType;
  title: string;
  content?: string;
  direction?: "inbound" | "outbound" | "internal";
  nextAction?: string;
  nextFollowUpAt?: string | null;
  stage?: PipelineStage;
};

export class PipelineValidationError extends Error {
  readonly name = "PipelineValidationError";
}

export function isValidStage(value: unknown): value is PipelineStage {
  return PIPELINE_STAGES.some((stage) => stage.id === value);
}

export function isOpenPipelineStage(stage: PipelineStage): boolean {
  return !CLOSED_STAGES.has(stage);
}

export function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setHours(12, 0, 0, 0);
  parsed.setFullYear(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function calendarDayNumber(value: string): number | null {
  const parsed = parseCalendarDate(value);
  if (!parsed) return null;
  return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) /
    86_400_000;
}

export function followUpStatus(
  deal: Pick<PipelineDeal, "next_follow_up_at">,
  today: string,
): FollowUpStatus {
  if (!deal.next_follow_up_at) return "none";
  const followUpDay = calendarDayNumber(deal.next_follow_up_at);
  const todayDay = calendarDayNumber(today);
  if (followUpDay === null || todayDay === null) return "none";
  const difference = followUpDay - todayDay;
  if (difference < 0) return "overdue";
  if (difference === 0) return "today";
  if (difference <= 7) return "soon";
  return "later";
}

export function pipelineSummary(
  deals: PipelineDealWithContact[],
  today: string,
): PipelineSummary {
  const open = deals.filter((deal) => isOpenPipelineStage(deal.stage));
  return {
    mrr: deals.reduce(
      (total, deal) => total + (deal.stage === "client" ? deal.monthly_value ?? 0 : 0),
      0,
    ),
    openCount: open.length,
    overdueCount: open.filter((deal) => followUpStatus(deal, today) === "overdue").length,
    dueSoonCount: open.filter((deal) => {
      const status = followUpStatus(deal, today);
      return status === "today" || status === "soon";
    }).length,
  };
}

export function attentionItems(
  deals: PipelineDealWithContact[],
  today: string,
): PipelineAttentionItem[] {
  const items: PipelineAttentionItem[] = [];
  for (const deal of deals) {
    if (!isOpenPipelineStage(deal.stage)) continue;
    const reasons: PipelineAttentionReason[] = [];
    if (followUpStatus(deal, today) === "overdue") {
      reasons.push("overdue");
    }
    if (!deal.next_action.trim()) {
      reasons.push("missing_action");
    }
    if (!deal.next_follow_up_at) {
      reasons.push("missing_date");
    }
    if (reasons.length > 0) {
      items.push({ deal, reason: reasons[0], reasons });
    }
  }
  const priority: Record<PipelineAttentionReason, number> = {
    overdue: 0,
    missing_action: 1,
    missing_date: 2,
  };
  return items.sort((left, right) =>
    priority[left.reason] - priority[right.reason] ||
    (left.deal.next_follow_up_at ?? "9999-99-99").localeCompare(
      right.deal.next_follow_up_at ?? "9999-99-99",
    ) ||
    left.deal.name.localeCompare(right.deal.name)
  );
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PipelineValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function trimmedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new PipelineValidationError(`${field} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) {
    throw new PipelineValidationError(`${field} must be ${maximum} characters or fewer.`);
  }
  return trimmed;
}

function nullableAmount(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new PipelineValidationError(`${field} must be a whole number of dollars or null.`);
  }
  return Number(value);
}

function nullableCalendarDate(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !parseCalendarDate(value)) {
    throw new PipelineValidationError(`${field} must be a calendar date in YYYY-MM-DD format or null.`);
  }
  return value;
}

const PATCH_KEYS = new Set([
  "monthlyValue",
  "monthly_value",
  "discoveryPrice",
  "discovery_price",
  "nextAction",
  "next_action",
  "nextFollowUpAt",
  "next_follow_up_at",
  "source",
  "notes",
]);

function aliasedField(
  input: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
  label: string,
): { present: boolean; value?: unknown } {
  const hasCamel = Object.hasOwn(input, camelKey);
  const hasSnake = Object.hasOwn(input, snakeKey);
  if (hasCamel && hasSnake) {
    throw new PipelineValidationError(
      `${label} must use either ${camelKey} or ${snakeKey}, not both.`,
    );
  }
  if (hasCamel) return { present: true, value: input[camelKey] };
  if (hasSnake) return { present: true, value: input[snakeKey] };
  return { present: false };
}

export function validatePipelinePatch(value: unknown): PipelineDealPatch {
  const input = inputRecord(value, "Pipeline patch");
  for (const key of Object.keys(input)) {
    if (key === "stage") {
      throw new PipelineValidationError("Stage changes must use the pipeline move action.");
    }
    if (!PATCH_KEYS.has(key)) {
      throw new PipelineValidationError(`Unknown pipeline patch field: ${key}.`);
    }
  }
  const patch: PipelineDealPatch = {};
  const monthlyValue = aliasedField(
    input,
    "monthlyValue",
    "monthly_value",
    "Monthly value",
  );
  if (monthlyValue.present) {
    patch.monthlyValue = nullableAmount(monthlyValue.value, "Monthly value");
  }
  const discoveryPrice = aliasedField(
    input,
    "discoveryPrice",
    "discovery_price",
    "Discovery price",
  );
  if (discoveryPrice.present) {
    patch.discoveryPrice = nullableAmount(discoveryPrice.value, "Discovery price");
  }
  const nextAction = aliasedField(input, "nextAction", "next_action", "Next action");
  if (nextAction.present) {
    patch.nextAction = trimmedString(nextAction.value, "Next action", 500);
  }
  const nextFollowUpAt = aliasedField(
    input,
    "nextFollowUpAt",
    "next_follow_up_at",
    "Next follow-up date",
  );
  if (nextFollowUpAt.present) {
    patch.nextFollowUpAt = nullableCalendarDate(
      nextFollowUpAt.value,
      "Next follow-up date",
    );
  }
  if (Object.hasOwn(input, "source")) {
    patch.source = trimmedString(input.source, "Source", 200);
  }
  if (Object.hasOwn(input, "notes")) {
    patch.notes = trimmedString(input.notes, "Notes", 5_000);
  }
  return patch;
}

export function validatePipelineStage(value: unknown): PipelineStage {
  if (!isValidStage(value)) {
    throw new PipelineValidationError("Pipeline stage is invalid.");
  }
  return value;
}

export function validatePipelineNote(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return trimmedString(value, "Stage note", 5_000);
}

export function validateLogPipelineTouch(value: unknown): LogPipelineTouchInput {
  const input = inputRecord(value, "Pipeline touch");
  const allowed = new Set([
    "activityType",
    "activity_type",
    "title",
    "content",
    "direction",
    "nextAction",
    "next_action",
    "nextFollowUpAt",
    "next_follow_up_at",
    "stage",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new PipelineValidationError(`Unknown pipeline touch field: ${key}.`);
    }
  }
  const activityType = aliasedField(
    input,
    "activityType",
    "activity_type",
    "Activity type",
  );
  if (!activityType.present || !(
    ["call", "email", "text", "meeting", "note"] as unknown[]
  ).includes(activityType.value)) {
    throw new PipelineValidationError("Pipeline touch type is invalid.");
  }
  const title = trimmedString(input.title, "Touch title", 500);
  if (!title) throw new PipelineValidationError("Touch title is required.");
  const result: LogPipelineTouchInput = {
    activityType: activityType.value as PipelineTouchType,
    title,
  };
  if (Object.hasOwn(input, "content")) {
    result.content = trimmedString(input.content, "Touch details", 5_000);
  }
  if (Object.hasOwn(input, "direction")) {
    if (!(["inbound", "outbound", "internal"] as unknown[]).includes(input.direction)) {
      throw new PipelineValidationError("Touch direction is invalid.");
    }
    result.direction = input.direction as LogPipelineTouchInput["direction"];
  }
  const nextAction = aliasedField(input, "nextAction", "next_action", "Next action");
  if (nextAction.present) {
    result.nextAction = trimmedString(nextAction.value, "Next action", 500);
  }
  const nextFollowUpAt = aliasedField(
    input,
    "nextFollowUpAt",
    "next_follow_up_at",
    "Next follow-up date",
  );
  if (nextFollowUpAt.present) {
    result.nextFollowUpAt = nullableCalendarDate(
      nextFollowUpAt.value,
      "Next follow-up date",
    );
  }
  if (Object.hasOwn(input, "stage")) {
    result.stage = validatePipelineStage(input.stage);
  }
  return result;
}
