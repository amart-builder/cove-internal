const NOT_SIGNED_IN_MARKERS = [
  "not logged in",
  "please run /login",
  "failed to authenticate",
  "oauth session expired",
  "could not be refreshed",
  "authentication_error",
];

export function isClaudeNotSignedIn(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return NOT_SIGNED_IN_MARKERS.some((marker) => normalized.includes(marker));
}

const CODEX_NOT_SIGNED_IN = /sign in|login|authentication|unauthorized/i;

/**
 * True when a provider's own output says its sign-in has lapsed. The CLIs word
 * this differently, and the caller knows which one it ran.
 */
export function isProviderNotSignedIn(
  provider: string | null | undefined,
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return provider === "codex" ? CODEX_NOT_SIGNED_IN.test(text) : isClaudeNotSignedIn(text);
}

/**
 * True when the provider command is not on the machine at all -- the state a
 * Mac is in before setup installs the CLI, and the one failure the person can
 * do nothing about without being told which program is missing.
 */
export function isProviderMissing(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bspawn\b.*\bENOENT\b/.test(text);
}
