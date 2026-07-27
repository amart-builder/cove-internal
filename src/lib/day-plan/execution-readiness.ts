import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type {
  DayPlanExecutionConfig,
  DayPlanExecutionReadiness,
  DayPlanItem,
  DayPlanReadinessCode,
} from "./types";

export function selectExecutionModel(item: DayPlanItem): DayPlanExecutionConfig["modelAlias"] {
  void item;
  return "fable";
}

export type ForgeExecutionWorkspace = {
  id: string;
  path: string;
  autonomousEnabled: boolean;
  maximumBudgetUsd: number;
};

export type ForgeExecutionEnvironment = {
  autonomousEnabled: boolean;
  workspaces: Map<string, ForgeExecutionWorkspace>;
  now?: () => Date;
};

type ExecutionRegistryFile = {
  workspaces?: Array<{
    id?: unknown;
    path?: unknown;
    autonomous_enabled?: unknown;
    maximum_budget_usd?: unknown;
  }>;
};

function normalizedBrief(item: DayPlanItem) {
  return {
    taskId: item.taskId,
    title: item.title.trim(),
    outcome: item.outcome.trim(),
    definitionOfDone: item.definitionOfDone?.trim() || null,
    whyToday: item.whyToday,
    project: item.project ?? null,
    dueAt: item.dueAt ?? null,
    owner: item.owner,
  };
}

export function dayPlanItemBriefHash(item: DayPlanItem): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedBrief(item)))
    .digest("hex");
}

export function dayPlanExecutionAuthorizationHash(input: {
  briefHash: string;
  mode: DayPlanExecutionConfig["mode"];
  modelAlias: DayPlanExecutionConfig["modelAlias"];
  workspaceId?: string;
  workspacePath?: string;
  budgetUsd?: number;
}): string {
  return createHash("sha256").update(JSON.stringify({
    briefHash: input.briefHash,
    mode: input.mode,
    modelAlias: input.modelAlias,
    workspaceId: input.workspaceId ?? null,
    workspacePath: input.workspacePath ?? null,
    budgetUsd: input.budgetUsd ?? null,
  })).digest("hex");
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function loadForgeExecutionEnvironment(
  options: {
    configPath?: string;
    autonomousEnabled?: boolean;
  } = {},
): ForgeExecutionEnvironment {
  const configPath = options.configPath ??
    process.env.FORGE_EXECUTION_CONFIG ??
    path.join(process.cwd(), "data", "forge-execution.json");
  const workspaces = new Map<string, ForgeExecutionWorkspace>();

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ExecutionRegistryFile;
      for (const candidate of parsed.workspaces ?? []) {
        if (
          typeof candidate.id !== "string" ||
          !candidate.id.trim() ||
          typeof candidate.path !== "string" ||
          !candidate.path.trim() ||
          candidate.autonomous_enabled !== true ||
          !finitePositive(candidate.maximum_budget_usd)
        ) {
          continue;
        }
        const configuredPath = path.resolve(candidate.path);
        workspaces.set(candidate.id, {
          id: candidate.id,
          path: configuredPath,
          autonomousEnabled: true,
          maximumBudgetUsd: candidate.maximum_budget_usd,
        });
      }
    } catch {
      // A malformed optional registry makes autonomous work unready, never permissive.
    }
  }

  return {
    autonomousEnabled:
      options.autonomousEnabled ?? process.env.FORGE_CLAUDE_EXECUTION_ENABLED === "1",
    workspaces,
  };
}

function workspaceFacts(workspace: ForgeExecutionWorkspace): {
  exists: boolean;
  path?: string;
  isGit: boolean;
  clean: boolean;
} {
  if (!existsSync(workspace.path)) return { exists: false, isGit: false, clean: false };
  try {
    if (!statSync(workspace.path).isDirectory()) {
      return { exists: false, isGit: false, clean: false };
    }
    const resolved = realpathSync(workspace.path);
    const inside = execFileSync(
      "/usr/bin/git",
      ["-C", resolved, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 },
    ).trim() === "true";
    if (!inside) return { exists: true, path: resolved, isGit: false, clean: false };
    const status = execFileSync(
      "/usr/bin/git",
      ["-C", resolved, "status", "--porcelain=v1", "--untracked-files=normal"],
      { encoding: "utf8", timeout: 3000, maxBuffer: 256 * 1024 },
    );
    return { exists: true, path: resolved, isGit: true, clean: status.trim() === "" };
  } catch {
    return { exists: true, isGit: false, clean: false };
  }
}

export function assessDayPlanExecutionReadiness(input: {
  item: DayPlanItem;
  config?: DayPlanExecutionConfig;
  environment: ForgeExecutionEnvironment;
}): DayPlanExecutionReadiness {
  const { item, config, environment } = input;
  const codes: DayPlanReadinessCode[] = [];
  let workspacePath: string | undefined;
  let maximumBudgetUsd: number | undefined;

  if (item.owner !== "claude" && item.owner !== "together") {
    codes.push("owner_not_agent");
  }
  if (!config) {
    codes.push("mode_required");
  } else {
    if (config.briefHash !== dayPlanItemBriefHash(item)) codes.push("brief_changed");
    if (item.owner === "together" && config.mode !== "plan_review") {
      codes.push("together_requires_plan_review");
    }

    if (config.mode === "autonomous") {
      if (!environment.autonomousEnabled) codes.push("execution_disabled");
      if (!item.definitionOfDone?.trim()) codes.push("definition_of_done_required");
      if (!config.workspaceId) {
        codes.push("workspace_required");
      } else {
        const workspace = environment.workspaces.get(config.workspaceId);
        if (!workspace) {
          codes.push("workspace_not_allowlisted");
        } else {
          maximumBudgetUsd = workspace.maximumBudgetUsd;
          if (!workspace.autonomousEnabled) codes.push("project_not_opted_in");
          if (!finitePositive(config.budgetUsd)) {
            codes.push("budget_required");
          } else if (config.budgetUsd > workspace.maximumBudgetUsd) {
            codes.push("budget_exceeds_limit");
          }
          const facts = workspaceFacts(workspace);
          workspacePath = facts.path;
          if (!facts.exists) codes.push("workspace_missing");
          else if (!facts.isGit) codes.push("workspace_not_git");
          else if (!facts.clean) codes.push("workspace_dirty");
        }
      }
    }
  }

  const unique = [...new Set(codes)];
  return {
    ready: unique.length === 0,
    codes: unique.length === 0 ? ["ready"] : unique,
    checkedAt: (environment.now?.() ?? new Date()).toISOString(),
    workspacePath,
    maximumBudgetUsd,
  };
}
