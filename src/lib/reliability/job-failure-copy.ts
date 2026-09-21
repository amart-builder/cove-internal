// Product wording for scheduler failures. Never copy provider diagnostics,
// internal job names or retry counters onto a person's screen.
export function jobFailureCopy(type: string, retrying = false): { title: string; body: string } {
  const retry = " Cove will try again automatically.";
  switch (type) {
    case "chief-of-staff-wake":
      return {
        title: "Follow-through needs attention",
        body: "Cove couldn't finish reviewing your open commitments." + (retrying
          ? retry
          : " Check Today for time-sensitive work. Open Issues for details."),
      };
    case "backup":
      return {
        title: "Your Cove backup needs attention",
        body: "Cove couldn't create a fresh backup." + (retrying ? retry : " Open Issues before relying on today's backup."),
      };
    case "gmail-operation":
    case "email-classify":
    case "email-artifacts":
      return {
        title: "Your inbox check needs attention",
        body: "Cove couldn't finish processing part of your inbox." + (retrying ? retry : " Check Gmail for anything urgent. Open Issues for details."),
      };
    case "morning-brief":
      return {
        title: "Your morning brief needs attention",
        body: "Cove couldn't write your brief." + (retrying
          ? retry
          : " Open Today to write it now, or Issues for details."),
      };
    case "health-collector":
      return {
        title: "Cove couldn't check its services",
        body: "The latest service check did not finish." + (retrying ? retry : " Open Issues to see which checks need attention."),
      };
    default:
      return {
        title: "Cove needs attention",
        body: "Some background work did not finish." + (retrying ? retry : " Open Issues to see what needs attention."),
      };
  }
}

// The cause ladder, shared by the scheduler's Issues copy and by any route that
// has to tell somebody why a request failed. `cause` is a safe sentence naming
// what went wrong; `remedy`, when present, means retrying cannot clear this and
// names what the person has to do instead.
export function diagnosticCause(diagnostic: string): { cause: string; remedy: string } {
  let cause = "";
  // Two failures retrying never clears: every attempt fails the same way until
  // somebody changes something about the Mac. For those, `remedy` replaces the
  // reassurance, which is otherwise technically true and practically wrong --
  // a person reading "Cove will try again automatically" about a full disk
  // waits for a retry that cannot succeed. Both match on the exact strings
  // SQLite and Node emit, not on loose words.
  let remedy = "";
  if (/SQLITE_NOTADB|file is not a database|database disk image is malformed|SQLITE_CORRUPT/i.test(diagnostic)) {
    cause = " Cove's database file could not be read.";
    remedy = " Cove cannot continue until it is restored from a backup.";
  } else if (/database or disk is full|ENOSPC|no space left on device/i.test(diagnostic)) {
    cause = " The disk is full.";
    remedy = " Free up space on this Mac; Cove cannot finish this until then.";
  // Deliberately only the codes an operating system emits. "Permission denied"
  // in plain words is what a Google 403 says too, and sending somebody to
  // chmod their data folder over a revoked Gmail scope is the wrong-cause
  // failure the comment below is about.
  } else if (/EACCES|EPERM|EROFS|SQLITE_READONLY|readonly database|read-only file system/i.test(diagnostic)) {
    cause = " Cove could not write to its own files.";
    remedy = " Check the permissions on Cove's data folder; Cove cannot finish this until then.";
  } else if (/timed? out|timeout|time limit/i.test(diagnostic)) {
    cause = " The check reached its time limit.";
  } else if (/background_usage|usage.denied|budget|allowance/i.test(diagnostic)) {
    cause = " The model call allowance was unavailable.";
  } else if (/invalid_grant|needs to be connected again|Google Workspace is not connected|did not allow the requested Workspace access/i.test(diagnostic)) {
    // Google's refresh tokens are the connection most likely to lapse, and an
    // OAuth client still in Testing publishing status expires them after seven
    // days -- so this is the first failure a new install is likely to file.
    // Every shape it arrives in (the gateway's own safeMessage, a bare
    // invalid_grant, a refused scope) carries none of the words the branch
    // below looks for, so all of them produced no cause at all and ended on
    // "ask your Cove setup agent to diagnose the failure" -- for something the
    // person could have named in one sentence. This sits above the sign-in
    // branch because both describe a lapsed credential and this one says which.
    cause = " The Google Workspace connection needs renewing.";
  } else if (/unauthorized|authentication|not logged in|sign.in|\/login|could not be refreshed|session expired/i.test(diagnostic)) {
    // These are the strings the CLIs actually print when a sign-in lapses;
    // src/lib/buddy/errors.ts matches the same set for Buddy's sign-in card.
    // An expired sign-in is the likeliest reason a scheduled job stops, and
    // without this the person is told only that "some background work did not
    // finish", which names nothing they can act on.
    cause = " The connected account needs its sign-in checked.";
  } else if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETDOWN|ENETUNREACH|socket hang up|connection error|network error|offline/i.test(diagnostic)) {
    // A laptop that was asleep, on a hotel network, or simply off wifi is the
    // most common reason an overnight lane fails, and the only one the person
    // can fix without help. Unnamed, it fell to the default wording and ended
    // on "ask your Cove setup agent to diagnose the failure" — a phone call
    // about a wifi drop. This sits above the worker branch because a network
    // error usually carries "please try again later", and "lease" is inside
    // "Please".
    cause = " Cove could not reach the internet when it ran.";
  } else if (/lease/i.test(diagnostic)) {
    cause = " The background worker stopped before finishing.";
  }
  return { cause, remedy };
}

// A 500 with an empty body is the one answer a screen cannot use: the client
// parses before it checks the status, so the person reads "Unexpected end of
// JSON input" where the page should be. Routes whose body a screen renders
// build it here -- product copy in `error`, the raw text in `detail` for
// whoever is helping, which is the shape /api/health already uses.
export function routeFailureBody(
  impact: string,
  error: unknown,
): { error: string; detail?: string } {
  const diagnostic = error instanceof Error ? error.message : String(error);
  const { cause, remedy } = diagnosticCause(diagnostic);
  return {
    error: impact + cause + remedy,
    ...(diagnostic ? { detail: diagnostic } : {}),
  };
}

// Issues supplies a safe cause and recovery step. Keep raw diagnostics in the
// stored details for investigation, never interpolate them into product copy.
export function jobFailureDetail(type: string, diagnostic: string, retrying = false): string {
  const impact = jobFailureCopy(type).body.split(". ")[0];
  const { cause, remedy } = diagnosticCause(diagnostic);
  if (retrying) return impact + "." + cause + (remedy || " Cove will try again automatically.");
  const immediate = type === "chief-of-staff-wake"
    ? " Review Today for time-sensitive commitments."
    : ["gmail-operation", "email-classify", "email-artifacts"].includes(type)
      ? " Check Gmail for anything urgent."
      : type === "backup"
        ? " A fresh backup has not been confirmed."
        : type === "morning-brief" ? " Open Today to write it now." : "";
  if (remedy) return impact + "." + cause + " This check has stopped retrying." + immediate + remedy;
  return impact + "." + cause + " This check has stopped retrying." + immediate
    + " Ask your Cove setup agent to diagnose the failure and restore this check.";
}
