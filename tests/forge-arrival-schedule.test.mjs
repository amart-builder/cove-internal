import assert from "node:assert/strict";
import test from "node:test";
import {
  decideArrivalDelivery,
  localScheduleParts,
  parseArrivalConfig,
  validateArrivalConfig,
} from "../scripts/lib/forge-arrival-schedule.mjs";

const baseConfig = {
  forge_url: "http://localhost:3200/something?ignored=yes",
  timezone: "America/Los_Angeles",
  arrival_time: "08:00",
  weekdays: [1, 2, 3, 4, 5],
  quiet_dates: [],
};

function plan(arrivalState, overrides = {}) {
  return {
    id: "plan-1",
    version: 3,
    localDate: "2026-07-10",
    timezone: "America/Los_Angeles",
    state: "proposed",
    settlementState: "not_due",
    arrivalState,
    ...overrides,
  };
}

function decide(at, currentPlan, options = {}) {
  return decideArrivalDelivery({
    now: new Date(at),
    config: options.config ?? baseConfig,
    readModel: options.readModel ?? { currentPlan },
    receiptKeys: options.receiptKeys ?? new Set(),
  });
}

test("config validation fixes the polled and opened routes to the Forge origin", () => {
  const config = validateArrivalConfig(baseConfig);
  assert.equal(config.forge_url, "http://localhost:3200");
  assert.equal(config.day_plan_url, "http://localhost:3200/api/day-plan");
  assert.equal(config.tasks_url, "http://localhost:3200/tasks");
});

test("malformed JSON and unsafe config values are rejected", () => {
  assert.throws(() => parseArrivalConfig("{"), /valid JSON/);
  assert.throws(() => validateArrivalConfig({ ...baseConfig, timezone: "Mars/Olympus" }), /timezone/);
  assert.throws(() => validateArrivalConfig({ ...baseConfig, arrival_time: "8:00" }), /HH:MM/);
  assert.throws(() => validateArrivalConfig({ ...baseConfig, weekdays: [0, 1] }), /weekdays/);
  assert.throws(() => validateArrivalConfig({ ...baseConfig, weekdays: [1, 1] }), /weekdays/);
  assert.throws(
    () => validateArrivalConfig({ ...baseConfig, forge_url: "https://user:secret@example.com" }),
    /credentials/,
  );
  assert.throws(() => validateArrivalConfig({ ...baseConfig, forge_url: "file:///tmp/forge" }), /http/);
  assert.throws(() => validateArrivalConfig({ ...baseConfig, quiet_dates: ["2026-02-30"] }), /quiet_dates/);
});

test("a later pulse after wake delivers when an earlier pulse was before time", () => {
  const before = decide("2026-07-10T14:59:00.000Z", plan("due"));
  const after = decide("2026-07-10T15:01:00.000Z", plan("due"));
  assert.deepEqual(before, {
    shouldOpen: false,
    result: "before_time",
    localDate: "2026-07-10",
  });
  assert.equal(after.shouldOpen, true);
  assert.equal(after.eventKey, "plan:plan-1:v3:due");
});

test("weekends and configured quiet dates never deliver", () => {
  assert.equal(decide("2026-07-11T17:00:00.000Z", plan("due", { localDate: "2026-07-11" })).result, "non_workday");
  const quiet = { ...baseConfig, quiet_dates: ["2026-07-10"] };
  assert.equal(decide("2026-07-10T17:00:00.000Z", plan("due"), { config: quiet }).result, "quiet_date");
});

test("wall-clock evaluation follows the configured timezone through DST", () => {
  const newYork = {
    ...baseConfig,
    timezone: "America/New_York",
    arrival_time: "03:00",
    weekdays: [7],
  };
  assert.equal(localScheduleParts("2026-03-08T06:59:00.000Z", newYork.timezone).minuteOfDay, 119);
  assert.equal(localScheduleParts("2026-03-08T07:00:00.000Z", newYork.timezone).minuteOfDay, 180);
  assert.equal(decide("2026-03-08T06:59:00.000Z", undefined, { config: newYork }).result, "before_time");
  assert.equal(decide("2026-03-08T07:00:00.000Z", undefined, { config: newYork }).result, "no_plan_due");
});

test("the same instant can be before time in Los Angeles and due in Tokyo", () => {
  const instant = "2026-07-10T14:30:00.000Z";
  assert.equal(decide(instant, undefined).result, "before_time");
  const tokyo = { ...baseConfig, timezone: "Asia/Tokyo" };
  assert.equal(decide(instant, undefined, { config: tokyo }).result, "no_plan_due");
});

test("no plan gets one initial delivery, but today's settled snapshot suppresses it", () => {
  const first = decide("2026-07-10T17:00:00.000Z", undefined);
  assert.equal(first.eventKey, "date:2026-07-10:initial");
  assert.equal(first.shouldOpen, true);
  assert.equal(
    decide("2026-07-10T17:00:00.000Z", undefined, {
      readModel: { latestSnapshot: { localDate: "2026-07-10" } },
    }).result,
    "settled",
  );
});

test("server arrival state is authoritative for every non-snooze state", () => {
  const expected = new Map([
    ["not_due", [false, "not_due"]],
    ["due", [true, "due"]],
    ["opened", [false, "opened"]],
    ["skipped", [false, "skipped"]],
    ["confirmed", [false, "confirmed"]],
    ["bypassed", [false, "bypassed"]],
    ["failed", [true, "failed"]],
  ]);
  for (const [state, [shouldOpen, result]] of expected) {
    const actual = decide("2026-07-10T17:00:00.000Z", plan(state));
    assert.equal(actual.shouldOpen, shouldOpen, state);
    assert.equal(actual.result, result, state);
  }
  assert.equal(
    decide("2026-07-10T17:00:00.000Z", plan("due", { state: "settled" })).result,
    "settled",
  );
});

test("snooze delivers only after its absolute instant has elapsed", () => {
  const snoozed = plan("snoozed", { snoozedUntil: "2026-07-10T17:15:00.000Z" });
  assert.equal(decide("2026-07-10T17:14:59.000Z", snoozed).result, "snooze_pending");
  const elapsed = decide("2026-07-10T17:15:00.000Z", snoozed);
  assert.equal(elapsed.shouldOpen, true);
  assert.equal(elapsed.eventKey, "plan:plan-1:v3:snoozed");
  assert.equal(decide("2026-07-10T17:15:00.000Z", plan("snoozed")).result, "invalid_server_state");
});

test("receipts dedupe a date or exact plan version without blocking a later version", () => {
  const noPlanReceipt = new Set(["date:2026-07-10:initial"]);
  assert.equal(decide("2026-07-10T17:00:00.000Z", undefined, { receiptKeys: noPlanReceipt }).result, "receipt_dedupe");
  assert.equal(decide("2026-07-10T17:00:00.000Z", plan("due"), { receiptKeys: noPlanReceipt }).result, "receipt_dedupe");

  const planReceipt = new Set(["plan:plan-1:v3:due"]);
  assert.equal(decide("2026-07-10T17:00:00.000Z", plan("due"), { receiptKeys: planReceipt }).result, "receipt_dedupe");
  assert.equal(decide("2026-07-10T17:00:00.000Z", plan("due", { version: 4 }), { receiptKeys: planReceipt }).shouldOpen, true);
});

test("a stale unsettled plan opens once so the app can recover Settlement", () => {
  const stale = decide("2026-07-10T17:00:00.000Z", plan("confirmed", {
    localDate: "2026-07-09",
    state: "active",
  }));
  assert.equal(stale.shouldOpen, true);
  assert.equal(stale.result, "stale_plan");
  assert.equal(stale.eventKey, "plan:plan-1:v3:stale-settlement");
  assert.equal(decide("2026-07-10T17:00:00.000Z", plan("confirmed", {
    localDate: "2026-07-09",
    state: "active",
  }), { receiptKeys: new Set([stale.eventKey]) }).result, "receipt_dedupe");
});

test("cross-timezone, malformed, and unavailable current server state fail closed", () => {
  assert.equal(decide("2026-07-10T17:00:00.000Z", plan("due", { timezone: "America/New_York" })).result, "invalid_server_state");
  assert.equal(decide("2026-07-10T17:00:00.000Z", { nope: true }).result, "invalid_server_state");
  assert.equal(
    decideArrivalDelivery({ now: new Date("2026-07-10T17:00:00.000Z"), config: baseConfig, readModel: null }).result,
    "invalid_server_state",
  );
});
