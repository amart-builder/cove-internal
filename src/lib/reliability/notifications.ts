export function notifyHardFailure(input: {
  source: string;
  message: string;
  details?: unknown;
}): void {
  console.error("Cove hard failure:", {
    source: input.source,
    message: input.message,
    details: input.details,
  });
}
