function pick(value, fallback = null) {
  return value === undefined || value === "" ? fallback : value;
}

export async function resolveLocalEmailContact(
  email,
  { crmRequest, recordFailure },
) {
  const senderEmail = pick(email.sender_email ?? email.senderEmail);
  if (!senderEmail) return null;
  const failureContext = {
    senderEmail,
    messageId: pick(email.message_id ?? email.messageId),
    threadId: pick(email.thread_id ?? email.threadId),
  };

  try {
    const { resolution } = await crmRequest("resolve", {
      name: pick(email.sender_name ?? email.senderName, ""),
      email: senderEmail,
      tier: "C",
      tags: ["email-triage"],
      source: "email",
    });
    if (resolution.status === "ambiguous") {
      try {
        await recordFailure({
          ...failureContext,
          error: new Error("Contact identity is ambiguous."),
          candidates: resolution.candidates,
        });
      } catch {
        // Failure recording is best-effort. Ambiguity must not stop the run.
      }
      return null;
    }
    return resolution.contact;
  } catch (error) {
    try {
      await recordFailure({
        ...failureContext,
        error,
      });
    } catch {
      // Failure recording is best-effort. A CRM outage must not stop the
      // remaining inbox items from being triaged unlinked.
    }
    return null;
  }
}
