/**
 * Whether a provider CLI's own output says its sign-in has lapsed.
 *
 * Two readers with two different tolerances, which is why they are two
 * functions rather than one shared pattern:
 *
 * - Buddy matches loosely, against the text of a turn the person is watching.
 *   A false positive there shows a sign-in card beside an answer they can see,
 *   and they can ignore it.
 * - The scheduler matches strictly, against the output of a job that failed
 *   while nobody was looking. A false positive there is an Issues row telling
 *   the person to sign back in to a provider that is signed in, which is the
 *   wrong-cause failure Issues copy exists to avoid.
 *
 * The .mjs lives here because model-runner-runtime.mjs is plain node and cannot
 * import a .ts module; src/lib/buddy/errors.ts re-exports the loose pair so
 * there is one set of markers rather than a copy that drifts.
 */

const NOT_SIGNED_IN_MARKERS = [
  "not logged in",
  "please run /login",
  "failed to authenticate",
  "oauth session expired",
  "could not be refreshed",
  "authentication_error",
];

export function isClaudeNotSignedIn(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase();
  return NOT_SIGNED_IN_MARKERS.some((marker) => normalized.includes(marker));
}

const CODEX_NOT_SIGNED_IN = /sign in|login|authentication|unauthorized/i;

export function isProviderNotSignedIn(provider, text) {
  if (!text) return false;
  return provider === "codex" ? CODEX_NOT_SIGNED_IN.test(String(text)) : isClaudeNotSignedIn(text);
}

/**
 * The strict reading, for a scheduled job that failed with nobody watching.
 *
 * Every alternative names a failure rather than a subject: a brief that
 * mentions "log in to the bank" or a task called "sign in to payroll" must not
 * put a sign-in row on the Issues screen. `login` on its own is deliberately
 * absent for that reason; `codex login` and `/login` are the instructions a
 * CLI prints, and they are here.
 */
const SIGNED_OUT_IN_JOB_OUTPUT = new RegExp([
  "not (?:signed|logged) in",
  "(?:codex|claude)\\s+login",
  "please run /login",
  "run `?codex login`?",
  "failed to authenticate",
  "authentication (?:error|failed|required)",
  "authentication_error",
  "unauthorized",
  "401 unauthorized",
  "(?:oauth )?session (?:has )?expired",
  "could not be refreshed",
  "credentials? (?:are )?(?:expired|invalid|missing)",
  "no (?:stored )?credentials found",
  "reauthenticate",
].join("|"), "i");

export function jobOutputSaysSignedOut(text) {
  return Boolean(text) && SIGNED_OUT_IN_JOB_OUTPUT.test(String(text));
}

/** The one sentence the scheduler stores, so Issues has something stable to read. */
export function signedOutDiagnostic(provider) {
  return `${provider === "codex" ? "Codex" : "Claude"} is signed out.`;
}
