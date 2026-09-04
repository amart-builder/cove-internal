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
