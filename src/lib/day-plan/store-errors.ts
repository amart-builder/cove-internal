import type { DayPlan } from "./types";

export class DayPlanVersionConflict extends Error {
  constructor(public readonly currentPlan: DayPlan) {
    super("The day plan changed before this action was saved.");
    this.name = "DayPlanVersionConflict";
  }
}

export class DayPlanNotFound extends Error {
  constructor() {
    super("Day plan not found.");
    this.name = "DayPlanNotFound";
  }
}

export class DayPlanInvalidTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayPlanInvalidTransition";
  }
}
