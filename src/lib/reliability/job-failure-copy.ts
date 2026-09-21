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
  // Anchored on purpose. These ran unanchored with bare dots, so "Please try
  // again later" (a rate-limited provider) was read as a stopped worker, and
  // "redesign in progress" sent the person to re-authenticate a working
  // account. A wrong cause is worse than none: it is what they act on.
  } else if (/background_usage|usage[_.]denied|\bbudget\b|\ballowance\b/i.test(diagnostic)) {
    cause = " Cove had used up its allowance for background work.";
  } else if (/\bunauthorized\b|\bauthentication\b|\bnot logged in\b|\bsign[-\s]?in\b/i.test(diagnostic)) {
    cause = " The connected account needs its sign-in checked.";
  } else if (/\blease\b/i.test(diagnostic)) {
    cause = " The background worker stopped before finishing.";
  }
  if (retrying) return impact + "." + cause + " Cove will try again automatically.";
  const immediate = type === "chief-of-staff-wake"
    ? " Review Today for time-sensitive commitments."
    : ["gmail-operation", "email-classify", "email-artifacts"].includes(type)
      ? " Check Gmail for anything urgent."
      : type === "backup" ? " A fresh backup has not been confirmed." : "";
  return impact + "." + cause + " This check has stopped retrying." + immediate
    + " Ask your Cove setup agent to diagnose the failure and restore this check.";
}
