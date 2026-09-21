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

/**
 * What to show when a Buddy turn fails with nothing written.
 *
 * A turn that dies before the model produces a single token has no text to
 * render and no text to match on, so the sign-in card above can never catch it.
 * It used to land on "Buddy was interrupted." for every cause, which names
 * nothing and suggests nothing; the Retry beside it then fails the same way.
 * These say which of the known failures happened. The fallback is deliberately
 * vaguer than the named ones rather than wrong about a cause we do not know.
 */
export function buddyFailureMessage(
  errorCode: string | null | undefined,
  provider: "claude" | "codex" = "claude",
): string {
  const agent = provider === "codex" ? "Codex" : "Claude";
  switch (errorCode) {
    case "interrupted":
      return "Buddy stopped before it finished answering.";
    case "timeout":
      return "Buddy took too long and stopped.";
    case "server_restart":
      return "Cove restarted while Buddy was working, so this answer was lost.";
    case "provider_missing":
      // The route reports this when the command is not on the machine at all,
      // which is where a Mac sits until setup installs the CLI.
      return `Cove cannot find the ${agent} command it thinks with. Ask your Cove setup agent to install it.`;
    case "spawn_failed":
      return `Cove could not start ${agent} on this Mac. Check that it is installed and that Cove has its path.`;
    case "persist_failed":
      return "Buddy answered, but Cove could not save it.";
    case "command_failed":
      return "Buddy's answer stopped partway through.";
    default:
      return "Buddy could not finish this answer.";
  }
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
