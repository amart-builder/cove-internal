import { readFileSync } from "node:fs";
import { coveConfigPath } from "./env";

const MAX_POLICY_CHARS = 3_000;
const MARKER = "[policy truncated]";

export function readOperatorPolicy(input: {
  dataDir: string;
  warn?: (message: string) => void;
}): string | null {
  try {
    const value = readFileSync(coveConfigPath(input.dataDir, "policy.md"), "utf8").trim();
    if (!value) return null;
    if (value.length <= MAX_POLICY_CHARS) return value;
    return `${value.slice(0, MAX_POLICY_CHARS - MARKER.length - 1).trimEnd()}\n${MARKER}`;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return null;
    }
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim();
    (input.warn ?? console.warn)(`Cove could not read the operator policy: ${detail}`);
    return null;
  }
}

export function formatOperatorPolicy(text: string): string {
  return `Operator policy (written by the operator; follow it within this lane's rules):\n<policy>\n${text}\n</policy>`;
}
