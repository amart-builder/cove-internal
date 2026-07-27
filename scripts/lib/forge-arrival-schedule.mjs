const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = new Map([
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
  ["Sun", 7],
]);
const ARRIVAL_STATES = new Set([
  "not_due",
  "due",
  "opened",
  "snoozed",
  "skipped",
  "confirmed",
  "bypassed",
  "failed",
]);

function requireRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function canonicalTimezone(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("timezone must be a valid IANA timezone.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value.trim(),
    }).resolvedOptions().timeZone;
  } catch {
    throw new Error("timezone must be a valid IANA timezone.");
  }
}

function isRealDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Validate and normalize the on-device spike configuration. */
export function validateArrivalConfig(value) {
  const input = requireRecord(value, "config");
  const timezone = canonicalTimezone(input.timezone);

  if (typeof input.arrival_time !== "string" || !TIME_PATTERN.test(input.arrival_time)) {
    throw new Error("arrival_time must use 24-hour HH:MM format.");
  }
  if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
    throw new Error("weekdays must be a non-empty array of ISO weekday numbers.");
  }
  if (
    input.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(input.weekdays).size !== input.weekdays.length
  ) {
    throw new Error("weekdays must contain unique integers from 1 (Monday) to 7 (Sunday).");
  }

  const quietDates = input.quiet_dates ?? [];
  if (
    !Array.isArray(quietDates) ||
    quietDates.some((date) => !isRealDate(date)) ||
    new Set(quietDates).size !== quietDates.length
  ) {
    throw new Error("quiet_dates must contain unique YYYY-MM-DD calendar dates.");
  }

  if (typeof input.forge_url !== "string" || !input.forge_url.trim()) {
    throw new Error("forge_url must be an http or https URL.");
  }
  let forgeUrl;
  try {
    forgeUrl = new URL(input.forge_url.trim());
  } catch {
    throw new Error("forge_url must be an http or https URL.");
  }
  if (
    !["http:", "https:"].includes(forgeUrl.protocol) ||
    forgeUrl.username ||
    forgeUrl.password
  ) {
    throw new Error("forge_url must use http or https and cannot contain credentials.");
  }

  return {
    forge_url: forgeUrl.origin,
    tasks_url: new URL("/tasks", forgeUrl.origin).toString(),
    day_plan_url: new URL("/api/day-plan", forgeUrl.origin).toString(),
    timezone,
    arrival_time: input.arrival_time,
    weekdays: [...input.weekdays],
    quiet_dates: [...quietDates],
  };
}

export function parseArrivalConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Arrival config is not valid JSON.");
  }
  return validateArrivalConfig(parsed);
}

/** Return Gregorian wall-clock parts without converting through the host timezone. */
export function localScheduleParts(now, timezone) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) throw new Error("now must be a valid instant.");
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: canonicalTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  const weekday = WEEKDAYS.get(part("weekday"));
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("Could not resolve the configured local time.");
  }
  return {
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    weekday,
    minuteOfDay: (hour === 24 ? 0 : hour) * 60 + minute,
  };
}

function noDelivery(result, localDate) {
  return { shouldOpen: false, result, localDate };
}

function delivery(eventKey, result, localDate) {
  return { shouldOpen: true, eventKey, result, localDate };
}

function hasReceipt(receiptKeys, key) {
  if (receiptKeys instanceof Set) return receiptKeys.has(key);
  return Array.isArray(receiptKeys) && receiptKeys.includes(key);
}

function validatedPlanKey(plan, suffix) {
  if (typeof plan.id !== "string" || !plan.id || !Number.isInteger(plan.version) || plan.version < 1) {
    return undefined;
  }
  return `plan:${plan.id}:v${plan.version}:${suffix}`;
}

/**
 * Pure, state-authoritative delivery policy. It never infers that an arrival is
 * due from wall-clock time when the server has a current plan in another state.
 */
export function decideArrivalDelivery({ now, config, readModel, receiptKeys = new Set() }) {
  const normalized = validateArrivalConfig(config);
  const local = localScheduleParts(now, normalized.timezone);
  const configuredMinute =
    Number(normalized.arrival_time.slice(0, 2)) * 60 +
    Number(normalized.arrival_time.slice(3, 5));

  if (!normalized.weekdays.includes(local.weekday)) {
    return noDelivery("non_workday", local.localDate);
  }
  if (normalized.quiet_dates.includes(local.localDate)) {
    return noDelivery("quiet_date", local.localDate);
  }
  if (local.minuteOfDay < configuredMinute) {
    return noDelivery("before_time", local.localDate);
  }
  if (!readModel || typeof readModel !== "object" || Array.isArray(readModel)) {
    return noDelivery("invalid_server_state", local.localDate);
  }

  const plan = readModel.currentPlan;
  if (plan === undefined || plan === null) {
    if (readModel.latestSnapshot?.localDate === local.localDate) {
      return noDelivery("settled", local.localDate);
    }
    const eventKey = `date:${local.localDate}:initial`;
    return hasReceipt(receiptKeys, eventKey)
      ? noDelivery("receipt_dedupe", local.localDate)
      : delivery(eventKey, "no_plan_due", local.localDate);
  }
  if (typeof plan !== "object" || Array.isArray(plan)) {
    return noDelivery("invalid_server_state", local.localDate);
  }
  if (plan.state === "settled" || plan.settlementState === "settled") {
    return noDelivery("settled", local.localDate);
  }
  if (!isRealDate(plan.localDate)) {
    return noDelivery("invalid_server_state", local.localDate);
  }
  let planTimezone;
  try {
    planTimezone = canonicalTimezone(plan.timezone);
  } catch {
    return noDelivery("invalid_server_state", local.localDate);
  }
  if (!ARRIVAL_STATES.has(plan.arrivalState)) {
    return noDelivery("invalid_server_state", local.localDate);
  }
  if (plan.localDate !== local.localDate) {
    const eventKey = validatedPlanKey(plan, "stale-settlement");
    if (!eventKey) return noDelivery("invalid_server_state", local.localDate);
    return hasReceipt(receiptKeys, eventKey)
      ? noDelivery("receipt_dedupe", local.localDate)
      : delivery(eventKey, "stale_plan", local.localDate);
  }
  if (planTimezone !== normalized.timezone) {
    return noDelivery("invalid_server_state", local.localDate);
  }

  if (["opened", "skipped", "bypassed", "confirmed"].includes(plan.arrivalState)) {
    return noDelivery(plan.arrivalState, local.localDate);
  }
  if (plan.arrivalState === "not_due") {
    return noDelivery("not_due", local.localDate);
  }
  if (plan.arrivalState === "snoozed") {
    const snoozedUntil = new Date(plan.snoozedUntil);
    if (Number.isNaN(snoozedUntil.getTime())) {
      return noDelivery("invalid_server_state", local.localDate);
    }
    const instant = now instanceof Date ? now : new Date(now);
    if (instant < snoozedUntil) return noDelivery("snooze_pending", local.localDate);
    const eventKey = validatedPlanKey(plan, "snoozed");
    if (!eventKey) return noDelivery("invalid_server_state", local.localDate);
    return hasReceipt(receiptKeys, eventKey)
      ? noDelivery("receipt_dedupe", local.localDate)
      : delivery(eventKey, "snooze_elapsed", local.localDate);
  }

  const suffix = plan.arrivalState === "failed" ? "failed" : "due";
  const eventKey = validatedPlanKey(plan, suffix);
  if (!eventKey) return noDelivery("invalid_server_state", local.localDate);
  if (hasReceipt(receiptKeys, eventKey)) {
    return noDelivery("receipt_dedupe", local.localDate);
  }
  // An initial no-plan open is the delivery for a due plan created by that page
  // load. A later version (for example after Snooze) gets its own event key.
  if (suffix === "due" && hasReceipt(receiptKeys, `date:${local.localDate}:initial`)) {
    return noDelivery("receipt_dedupe", local.localDate);
  }
  return delivery(eventKey, suffix, local.localDate);
}
