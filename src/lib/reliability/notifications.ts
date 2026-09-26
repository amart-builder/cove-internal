import {
  sanitizeNotificationText,
  spawnNativeNotification,
  type NativeNotificationDependencies,
} from "../claude-execution/notify";
import { coveEnv } from "../env";
import { jobFailureCopy } from "./job-failure-copy";

type HardFailureNotificationDependencies = NativeNotificationDependencies & {
  env?: NodeJS.ProcessEnv;
  logError?: (...values: unknown[]) => void;
};

export function notifyHardFailure(input: {
  source: string;
  message: string;
  details?: unknown;
}, dependencies: HardFailureNotificationDependencies = {}): void {
  const logError = dependencies.logError ?? console.error;
  logError("Cove hard failure:", {
    source: input.source,
    message: input.message,
    details: input.details,
  });
  if (coveEnv("NOTIFY", dependencies.env ?? process.env) !== "1") return;

  const source = sanitizeNotificationText(input.source) || "background work";
  const copy = jobFailureCopy(input.source.startsWith("job:") ? input.source.slice(4) : "");
  try {
    const child = spawnNativeNotification({
      title: copy.title,
      body: copy.body,
      // Follows the port this install actually runs on, as every other link does.
      openUrl: `${(coveEnv("BRIEF_WEB_BASE", dependencies.env ?? process.env) ?? "http://127.0.0.1:3200").replace(/\/$/, "")}/failures`,
      group: `cove-hard-failure-${source}`.slice(0, 120),
    }, dependencies);
    child.once("error", (error) => {
      logError("Cove hard failure notification failed:", error.message);
    });
  } catch (error) {
    logError(
      "Cove hard failure notification failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
