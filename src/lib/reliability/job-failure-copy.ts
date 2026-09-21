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

// Issues supplies a safe cause and recovery step. Keep raw diagnostics in the
// stored details for investigation, never interpolate them into product copy.
export function jobFailureDetail(type: string, diagnostic: string, retrying = false): string {
  const impact = jobFailureCopy(type).body.split(". ")[0];
  let cause = "";
  if (/timed? out|timeout|time limit/i.test(diagnostic)) {
    cause = " The check reached its time limit.";
  // Bounded on purpose. Unanchored with bare dots, "Please try again later"
  // (a rate-limited provider) read as a stopped worker and "redesign in
  // progress" sent the person to re-authenticate a working account. A wrong
  // cause is worse than none: it is what they act on. The boundary is a
  // letter rather than \b, because \b does not fall between a word and an
  // underscore, and authentication_error is exactly what a CLI prints.
  } else if (/background_usage|usage[_.]denied|(?<![a-z])(?:budget|allowance)(?![a-z])/i.test(diagnostic)) {
    cause = " Cove had used up its allowance for background work.";
  } else if (/invalid_grant|needs to be connected again|Google Workspace is not connected|did not allow the requested Workspace access/i.test(diagnostic)) {
    // Google's refresh tokens are the connection most likely to lapse, and an
    // OAuth client still in Testing publishing status expires them after seven
    // days -- so this is the first failure a new install is likely to file.
    // Every shape it arrives in (the gateway's own safeMessage, a bare
    // invalid_grant, a refused scope) carries none of the words the branch
    // below looks for, so all of them produced no cause at all and ended on
    // "ask your Cove setup agent to diagnose the failure" -- for something the
    // person could have named in one sentence. This sits above the sign-in
    // branch because both describe a lapsed credential and this one says
    // which. It needs no anchoring: every alternative here is a phrase or an
    // underscored provider code, not a word that hides inside other words.
    cause = " The Google Workspace connection needs renewing.";
  // The alternation carries the strings the Claude and Codex CLIs actually
  // print when a sign-in lapses; src/lib/buddy/errors.ts matches the same set
  // for Buddy's sign-in card. An expired sign-in is the likeliest reason a
  // scheduled job stops, and without these the person is told only that some
  // background work did not finish, which names nothing they can act on.
  } else if (/(?<![a-z])(?:unauthorized|authentication|not logged in|sign[-\s]?in|login|could not be refreshed|session expired)(?![a-z])/i.test(diagnostic)) {
    cause = " The connected account needs its sign-in checked.";
  } else if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETDOWN|ENETUNREACH|socket hang up|connection error|network error|offline/i.test(diagnostic)) {
    // A laptop that was asleep, on a hotel network, or simply off wifi is the
    // most common reason an overnight lane fails, and the only one the person
    // can fix without help. Unnamed, it fell to the default wording and ended
    // on "ask your Cove setup agent to diagnose the failure" — a phone call
    // about a wifi drop. It stays above the worker branch: a network error
    // usually carries "please try again later", and "lease" is inside
    // "Please". The anchors below now catch that too, and the order is the
    // cheaper of the two guards.
    cause = " Cove could not reach the internet when it ran.";
  } else if (/\blease\b/i.test(diagnostic)) {
    cause = " The background worker stopped before finishing.";
  }
  if (retrying) return impact + "." + cause + " Cove will try again automatically.";
  const immediate = type === "chief-of-staff-wake"
    ? " Review Today for time-sensitive commitments."
    : ["gmail-operation", "email-classify", "email-artifacts"].includes(type)
      ? " Check Gmail for anything urgent."
      : type === "backup"
        ? " A fresh backup has not been confirmed."
        : type === "morning-brief" ? " Open Today to write it now." : "";
  return impact + "." + cause + " This check has stopped retrying." + immediate
    + " Ask your Cove setup agent to diagnose the failure and restore this check.";
}
