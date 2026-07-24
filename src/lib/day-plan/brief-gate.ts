import { readDayClosureRelay } from "./brief-relay";

// A morning brief written before the previous day was closed is not a slightly
// worse brief, it is a confident guess: day_snapshots rows only exist after
// settlement_commit, so an unsettled yesterday is simply invisible to the
// brief's sources. The gate stops that brief from being written at all.
//
// There is deliberately no gate that reads THIS machine's day_plans. It would
// read as protection and provide none: `day_plans.open_slot` is UNIQUE and
// ensureDayPlan hands back the open plan whatever date it is asked for, so a
// plan dated today cannot exist while an earlier day is still open. The only
// gate that can actually fire is the cross-machine one below.
export type ScheduledBriefGateVerdict =
  | { blocked: false; reason: "closed" | "no_closure_signal" }
  | { blocked: true; reason: "unclosed_day"; unclosedLocalDate: string };

// The gate for the 7:30 cron, which does not run on the machine Alex rituals on.
// Its own day_plans table is machine-private and stale by design (see the header
// of ./brief-relay), so asking it whether yesterday was closed returns a
// confident answer about the wrong computer. It reads the published closure fact
// instead.
//
// No signal means no opinion, never blocked. A peer that is asleep, unsynced, or
// running an older build must degrade to the old behaviour (one blind brief),
// because the alternative is a morning brief that silently stops forever with
// nothing on either machine explaining why.
export function evaluateScheduledBriefGate(options: {
  targetLocalDate: string;
  dataDir?: string;
  now?: Date;
}): ScheduledBriefGateVerdict {
  let relay;
  try {
    relay = readDayClosureRelay({ dataDir: options.dataDir, now: options.now });
  } catch {
    return { blocked: false, reason: "no_closure_signal" };
  }
  if (!relay) return { blocked: false, reason: "no_closure_signal" };
  // An open plan dated today or later is today's own plan, not unfinished
  // yesterday. Only a day strictly behind the target is unclosed work.
  if (!relay.openLocalDate || relay.openLocalDate >= options.targetLocalDate) {
    return { blocked: false, reason: "closed" };
  }
  return {
    blocked: true,
    reason: "unclosed_day",
    unclosedLocalDate: relay.openLocalDate,
  };
}
