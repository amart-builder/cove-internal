import { coveEnvTrimmed } from "../env";

export function salesPipelineEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return coveEnvTrimmed("SALES_PIPELINE", env) === "1";
}
