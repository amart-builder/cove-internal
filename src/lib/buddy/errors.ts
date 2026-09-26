// The markers live in provider-signin-runtime.mjs because the scheduler reads
// them too and model-runner-runtime.mjs is plain node, which cannot import a
// .ts module. Re-exported rather than copied: a second list would drift, and a
// sanitizer or matcher with a twin in this repository is how findings 47 and 49
// happened.
export { isClaudeNotSignedIn, isProviderNotSignedIn } from "../provider-signin-runtime.mjs";

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

/**
 * True when the provider command is not on the machine at all -- the state a
 * Mac is in before setup installs the CLI, and the one failure the person can
 * do nothing about without being told which program is missing.
 */
export function isProviderMissing(text: string | null | undefined): boolean {
  return typeof text === "string" && /\bspawn\b.*\bENOENT\b/.test(text);
}
