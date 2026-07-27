import {
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { workspaceRoot } from "./operator";

const PROJECT_CACHE_TTL_MS = 30_000;

export type AtlasProjectDependencies = {
  homeDir?: string;
  workspaceRoot?: string | null;
  projectsRoot?: string;
  now?: () => number;
  cacheMs?: number;
  readdir?: typeof readdirSync;
  realpath?: typeof realpathSync;
  stat?: typeof statSync;
};

type ProjectCache = {
  root: string;
  expiresAt: number;
  names: string[];
};

let projectCache: ProjectCache | undefined;

export class AtlasDirectoryError extends Error {}

function atlasRoot(dependencies: AtlasProjectDependencies): string | null {
  if (Object.prototype.hasOwnProperty.call(dependencies, "workspaceRoot")) {
    return dependencies.workspaceRoot ?? null;
  }
  return workspaceRoot({ homeDir: dependencies.homeDir ?? os.homedir() });
}

function normalizedProjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function projectRoot(dependencies: AtlasProjectDependencies): string {
  const root = atlasRoot(dependencies);
  if (!root) throw new AtlasDirectoryError("No coding workspace is configured on this machine.");
  return dependencies.projectsRoot ?? path.join(root, "Projects");
}

export function resolveAtlasDirectory(
  rawDir: string,
  dependencies: AtlasProjectDependencies = {},
): string {
  const home = dependencies.homeDir ?? os.homedir();
  const expanded = rawDir === "~"
    ? home
    : rawDir.startsWith(`~${path.sep}`) ? path.join(home, rawDir.slice(2)) : rawDir;
  const resolved = path.resolve(expanded);
  let real: string;
  try {
    real = (dependencies.realpath ?? realpathSync)(resolved);
  } catch {
    throw new AtlasDirectoryError("Project directory does not exist.");
  }
  let directory: boolean;
  try {
    directory = (dependencies.stat ?? statSync)(real).isDirectory();
  } catch {
    throw new AtlasDirectoryError("Project directory does not exist.");
  }
  if (!directory) throw new AtlasDirectoryError("Project path must be a directory.");
  const root = atlasRoot(dependencies);
  if (!root) throw new AtlasDirectoryError("No coding workspace is configured on this machine.");
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new AtlasDirectoryError(`Project directory must be inside ${root}.`);
  }
  return real;
}

export function listAtlasProjectFolderNames(
  dependencies: AtlasProjectDependencies = {},
): string[] {
  let root: string;
  try {
    root = projectRoot(dependencies);
  } catch (error) {
    if (error instanceof AtlasDirectoryError) return [];
    throw error;
  }
  const now = (dependencies.now ?? Date.now)();
  if (projectCache?.root === root && projectCache.expiresAt > now) {
    return [...projectCache.names];
  }

  let entries: Dirent[];
  try {
    entries = (dependencies.readdir ?? readdirSync)(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return (dependencies.stat ?? statSync)(path.join(root, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const cacheMs = Math.min(
    Math.max(dependencies.cacheMs ?? PROJECT_CACHE_TTL_MS, 0),
    PROJECT_CACHE_TTL_MS,
  );
  projectCache = { root, expiresAt: now + cacheMs, names };
  return [...names];
}

export function resolveProjectDirectory(
  hint: string,
  dependencies: AtlasProjectDependencies = {},
): string | null {
  const trimmed = hint.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) return null;
  const normalizedHint = normalizedProjectName(trimmed);
  if (!normalizedHint) return null;

  const names = listAtlasProjectFolderNames(dependencies);
  const normalized = names
    .map((name) => ({ name, normalized: normalizedProjectName(name) }))
    .filter((candidate) => candidate.normalized.length > 0);
  const exact = normalized.filter((candidate) => candidate.normalized === normalizedHint);
  const matches = exact.length > 0
    ? exact
    : normalized.filter((candidate) =>
        candidate.normalized.length >= 4 && (
          candidate.normalized.includes(normalizedHint) ||
          normalizedHint.includes(candidate.normalized)
        ),
      );
  if (matches.length !== 1) return null;

  try {
    return resolveAtlasDirectory(path.join(projectRoot(dependencies), matches[0].name), dependencies);
  } catch (error) {
    if (error instanceof AtlasDirectoryError) return null;
    throw error;
  }
}
