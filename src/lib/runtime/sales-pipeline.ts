export function isSalesPipelineEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COVE_SALES_PIPELINE === "1";
}
