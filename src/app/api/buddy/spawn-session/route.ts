import { randomUUID } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import { NextRequest, NextResponse } from "next/server";
import {
  AtlasDirectoryError,
  listAtlasProjectFolderNames,
  resolveAtlasDirectory,
  resolveProjectDirectory,
} from "@/lib/atlas-projects";
import { getBuddyStore, type BuddyStore } from "@/lib/buddy/store";
import { seedBuddySession } from "@/lib/buddy/spawn-session";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { markCoveOrchestratorSession } from "@/lib/claude-execution/orchestrator-session";
import { workspaceRoot } from "@/lib/operator";
import { coveEnv } from "../../../../lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 16 * 1024;

type SpawnRouteDependencies = {
  store?: BuddyStore;
  homeDir?: string;
  workspaceRoot?: string | null;
  resolveWorkspaceRoot?: () => string | null;
  randomId?: () => string;
  realpath?: typeof realpathSync;
  stat?: typeof statSync;
  readdir?: typeof readdirSync;
  resolveProject?: (hint: string) => string | null;
  listProjects?: () => string[];
  seed?: typeof seedBuddySession;
  markSession?: typeof markCoveOrchestratorSession;
};

class SpawnRequestError extends Error {}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new SpawnRequestError(`${name} is invalid.`);
  }
  return value.trim();
}

export function resolveBuddySpawnDirectory(rawDir: string, dependencies: SpawnRouteDependencies = {}): string {
  try {
    return resolveAtlasDirectory(rawDir, dependencies);
  } catch (error) {
    if (error instanceof AtlasDirectoryError) throw new SpawnRequestError(error.message);
    throw error;
  }
}

function denied(request: NextRequest, csrf: boolean): NextResponse | undefined {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (csrf && request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
  }
}

function publicSession(session: NonNullable<ReturnType<BuddyStore["getSpawnedSession"]>>) {
  return {
    sessionId: session.session_id,
    dir: session.dir,
    title: session.title,
    state: session.state,
    error: session.error,
    createdAt: session.created_at,
    hostname: os.hostname(),
    deepLinksEnabled: coveEnv("BUDDY_DEEPLINKS") !== "0",
  };
}

export async function handleSpawnSessionPost(
  request: NextRequest,
  dependencies: SpawnRouteDependencies = {},
) {
  const accessError = denied(request, true);
  if (accessError) return accessError;
  const configuredRoot = dependencies.resolveWorkspaceRoot
    ? dependencies.resolveWorkspaceRoot()
    : Object.prototype.hasOwnProperty.call(dependencies, "workspaceRoot")
      ? dependencies.workspaceRoot ?? null
      : workspaceRoot();
  if (!configuredRoot) {
    return NextResponse.json(
      { error: "No coding workspace is configured on this machine." },
      { status: 400 },
    );
  }
  const scopedDependencies = { ...dependencies, workspaceRoot: configuredRoot };
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new SpawnRequestError("Spawn request is too large.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SpawnRequestError("Spawn request is invalid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SpawnRequestError("Spawn request is invalid.");
    }
    const body = parsed as Record<string, unknown>;
    const rawDir = body.dir === undefined ? undefined : requiredText(body.dir, "dir", 2_000);
    const project = body.project === undefined
      ? undefined
      : requiredText(body.project, "project", 120);
    if (Boolean(rawDir) === Boolean(project)) {
      throw new SpawnRequestError("Provide exactly one of dir or project.");
    }
    const prompt = requiredText(body.prompt, "prompt", 8_000);
    const title = body.title === undefined
      ? "Buddy session"
      : requiredText(body.title, "title", 120);
    let dir: string;
    if (rawDir) {
      dir = resolveBuddySpawnDirectory(rawDir, scopedDependencies);
    } else {
      const resolver = dependencies.resolveProject ?? ((hint: string) =>
        resolveProjectDirectory(hint, scopedDependencies));
      const resolved = resolver(project!);
      if (!resolved) {
        const names = (dependencies.listProjects ?? (() =>
          listAtlasProjectFolderNames(scopedDependencies)))();
        throw new SpawnRequestError(
          `Project '${project}' did not match exactly one project folder. Available projects: ${names.join(", ") || "(none)"}.`,
        );
      }
      dir = resolveBuddySpawnDirectory(resolved, scopedDependencies);
    }
    const sessionId = (dependencies.randomId ?? randomUUID)();
    const store = dependencies.store ?? getBuddyStore();
    store.createSpawnedSession({ sessionId, dir, title });
    (dependencies.seed ?? seedBuddySession)({ store, sessionId, dir, prompt, title });
    const seededState = store.getSpawnedSession(sessionId)?.state;
    if (seededState && ["started", "ready", "incomplete"].includes(seededState)) {
      (dependencies.markSession ?? markCoveOrchestratorSession)(sessionId);
    }
    return NextResponse.json({ sessionId, state: "seeding", dir });
  } catch (error) {
    if (!(error instanceof SpawnRequestError)) {
      console.error("Buddy session spawn failed.", error);
    }
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not start the Claude session.",
    }, { status: error instanceof SpawnRequestError ? 400 : 500 });
  }
}

export async function handleSpawnSessionGet(
  request: NextRequest,
  dependencies: SpawnRouteDependencies = {},
) {
  const accessError = denied(request, false);
  if (accessError) return accessError;
  const sessionId = request.nextUrl.searchParams.get("id")?.trim();
  if (!sessionId || sessionId.length > 200) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }
  const session = (dependencies.store ?? getBuddyStore()).getSpawnedSession(sessionId);
  return session
    ? NextResponse.json(publicSession(session))
    : NextResponse.json({ error: "Spawned session not found." }, { status: 404 });
}

export function POST(request: NextRequest) {
  return handleSpawnSessionPost(request);
}

export function GET(request: NextRequest) {
  return handleSpawnSessionGet(request);
}
