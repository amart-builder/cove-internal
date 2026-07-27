export const BUDDY_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const BUDDY_COMMAND_TERMINATION_GRACE_MS = 2_000;
export const BUDDY_MAX_TURN_STAGES = 4;
export const BUDDY_MAX_TURN_MS = BUDDY_MAX_TURN_STAGES *
  (BUDDY_COMMAND_TIMEOUT_MS + BUDDY_COMMAND_TERMINATION_GRACE_MS);

// A running turn must outlive the longest legal initial, summary, seed, and retry chain.
export const BUDDY_STALE_TURN_MS = BUDDY_MAX_TURN_MS + 5 * 60_000;
