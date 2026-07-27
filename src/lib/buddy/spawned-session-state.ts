export type BuddySpawnedSessionState =
  | "seeding"
  | "started"
  | "ready"
  | "incomplete"
  | "failed"
  | "launch_failed";

export function isBuddySpawnedSessionOpenable(state: BuddySpawnedSessionState): boolean {
  return state === "started" || state === "ready" || state === "incomplete" || state === "failed";
}

export function isBuddySpawnedSessionPending(state: BuddySpawnedSessionState): boolean {
  return state === "seeding" || state === "started";
}
