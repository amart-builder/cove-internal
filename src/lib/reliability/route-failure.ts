import { localDatabasePath } from "@/lib/local/database";
import { diagnosticCause } from "./job-failure-copy";

// A 500 with an empty body is the one answer a screen cannot use: the client
// parses before it checks the status, so the person reads "Unexpected end of
// JSON input" where the page should be. Routes whose body a screen renders
// build it here -- product copy in `error`, and for whoever is helping from a
// distance, the raw text plus the database this install is actually using,
// which is the shape /api/health already answers with. Loopback only, and the
// guide already shows the person that folder.
export function routeFailureBody(
  impact: string,
  error: unknown,
): { error: string; detail?: string; dbPath?: string } {
  const diagnostic = error instanceof Error ? error.message : String(error);
  const { cause, remedy } = diagnosticCause(diagnostic);
  let dbPath: string | undefined;
  try {
    dbPath = localDatabasePath();
  } catch {
    dbPath = undefined;
  }
  return {
    error: impact + cause + remedy,
    ...(diagnostic ? { detail: diagnostic } : {}),
    ...(dbPath ? { dbPath } : {}),
  };
}
