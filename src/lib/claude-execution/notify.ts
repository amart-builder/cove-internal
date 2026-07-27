import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { DayPlanExecutionRunStatus } from "../day-plan/types";

const TERMINAL_NOTIFIER = "/opt/homebrew/bin/terminal-notifier";
const OSASCRIPT = "/usr/bin/osascript";
const FORGE_BOARD_URL = "http://127.0.0.1:3200/tasks";
const DELIVERY_TIMEOUT_MS = 3_000;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000);
export const MAX_NOTIFICATION_DEDUPE_ENTRIES = 500;

const NEEDS_YOU_STATES = new Set<DayPlanExecutionRunStatus>([
  "plan_ready",
  "ready_to_join",
  "awaiting_review",
  "failed",
]);

export type ExecutionNotificationInput = {
  runId: string;
  state: DayPlanExecutionRunStatus;
  itemTitle: string;
  claudeSessionId?: string;
  transitionedAt: string;
};

type SpawnNotification = (
  executable: string,
  args: readonly string[],
  options: { detached: true; stdio: "ignore"; shell: false },
) => ChildProcess;

export type ExecutionNotifierDependencies = {
  env?: NodeJS.ProcessEnv;
  processStartedAt?: Date;
  spawnImpl?: SpawnNotification;
  exists?: (path: string) => boolean;
  logger?: (line: string) => void;
  deliveredTransitions?: Set<string>;
};

export function rememberNotificationTransition(
  transitions: Set<string>,
  transitionKey: string,
): boolean {
  if (transitions.has(transitionKey)) return false;
  transitions.add(transitionKey);
  if (transitions.size > MAX_NOTIFICATION_DEDUPE_ENTRIES) {
    const oldest = transitions.values().next().value;
    if (oldest !== undefined) transitions.delete(oldest);
  }
  return true;
}

export function sanitizeNotificationText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedBody(prefix: string, itemTitle: string, suffix: string): string {
  const maximumTitleLength = Math.max(1, 100 - prefix.length - suffix.length);
  const boundedTitle = itemTitle.length <= maximumTitleLength
    ? itemTitle
    : `${itemTitle.slice(0, Math.max(1, maximumTitleLength - 1)).trimEnd()}…`;
  return sanitizeNotificationText(`${prefix}${boundedTitle}${suffix}`).slice(0, 100);
}

export function notificationCopy(input: ExecutionNotificationInput): {
  title: string;
  body: string;
} | undefined {
  if (!NEEDS_YOU_STATES.has(input.state)) return undefined;
  const itemTitle = sanitizeNotificationText(input.itemTitle) || "Claude work";
  if (input.state === "failed") {
    return {
      title: "Forge",
      body: boundedBody("Didn't finish: ", itemTitle, ". Open Forge to restart it."),
    };
  }
  return {
    title: "Forge needs you",
    body: boundedBody(
      "Plan ready: ",
      itemTitle,
      ". Claude has questions only you can answer.",
    ),
  };
}

function waitForDelivery(
  child: ChildProcess,
  input: ExecutionNotificationInput,
  logger: (line: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        logger(`${input.runId} ${input.state} ${delivered ? "delivered" : "failed"}`);
      } catch {
        // Logging is diagnostic only and can never escape the notifier.
      }
      resolve();
    };
    const timer = setTimeout(() => finish(false), DELIVERY_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.unref();
  });
}

export function createExecutionNotifier(dependencies: ExecutionNotifierDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const processStartedAt = dependencies.processStartedAt ?? PROCESS_STARTED_AT;
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  const exists = dependencies.exists ?? existsSync;
  const logger = dependencies.logger ?? ((line: string) => console.info(line));
  const deliveredTransitions = dependencies.deliveredTransitions ?? new Set<string>();

  return async function notifyExecutionRun(input: ExecutionNotificationInput): Promise<void> {
    if (env.FORGE_NOTIFY !== "1") return;
    const copy = notificationCopy(input);
    if (!copy) return;
    const transitionedAt = new Date(input.transitionedAt).getTime();
    if (!Number.isFinite(transitionedAt) || transitionedAt < processStartedAt.getTime()) return;

    const transitionKey = `${input.runId}:${input.state}`;
    if (!rememberNotificationTransition(deliveredTransitions, transitionKey)) return;

    const openUrl = input.claudeSessionId
      ? `claude://resume?session=${encodeURIComponent(input.claudeSessionId)}`
      : FORGE_BOARD_URL;
    const useTerminalNotifier = exists(TERMINAL_NOTIFIER);
    const executable = useTerminalNotifier ? TERMINAL_NOTIFIER : OSASCRIPT;
    const args = useTerminalNotifier
      ? [
          "-title", copy.title,
          "-message", copy.body,
          "-group", `forge-${input.runId}`,
          "-open", openUrl,
        ]
      : [
          "-e", "on run argv",
          "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e", "end run",
          "--", copy.title, copy.body,
        ];

    try {
      const child = spawnImpl(executable, args, {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      await waitForDelivery(child, input, logger);
    } catch {
      try {
        logger(`${input.runId} ${input.state} failed`);
      } catch {
        // Logging is diagnostic only and can never escape the notifier.
      }
    }
  };
}

export const notifyExecutionRun = createExecutionNotifier();
