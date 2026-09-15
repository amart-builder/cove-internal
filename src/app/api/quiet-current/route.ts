import { NextRequest, NextResponse } from "next/server";
import {
  acceptWorkSuggestion,
  undoWorkSuggestionAcceptance,
  createWorkSuggestion,
  getQuietCurrentCsrfToken,
  getQuietCurrentSnapshot,
  recordDecisionEvent,
  reopenWorkSuggestion,
  resolveWorkSuggestion,
  type SuggestionKind,
  type SuggestionPriority,
  type SuggestionState,
} from "@/lib/quiet-current/store";
import { isTrustedCoveRequest } from "@/lib/request-security";
import { consumeProgressSuggestionRelays } from "@/lib/progress/relay";
import { coveEnv } from "../../../lib/env";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<SuggestionKind>([
  "create_task",
  "returned_work",
  "observed_progress",
  "stale_task",
  "attention_nudge",
]);
const PRIORITIES = new Set<SuggestionPriority>(["low", "medium", "high"]);
const RESOLUTION_STATES = new Set<SuggestionState>([
  "refined",
  "accepted",
  "deferred",
  "dismissed",
]);

function stringValue(
  value: unknown,
  name: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const trimmed = value.trim();
  if (options.required && !trimmed) throw new Error(`${name} is required.`);
  if (trimmed.length > (options.max ?? 4000)) {
    throw new Error(`${name} is too long.`);
  }
  return trimmed;
}

function ingestProgressSuggestionRelays(): void {
  if (coveEnv("PROGRESS_RELAY_CONSUMER") !== "1") return;
  consumeProgressSuggestionRelays({
    log: (message) => console.error(message),
  });
}

export async function GET(request: NextRequest) {
  try {
    if (!isTrustedCoveRequest(request)) {
      return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
    }
    ingestProgressSuggestionRelays();
    const snapshot = getQuietCurrentSnapshot();
    return NextResponse.json({
      ...snapshot,
      suggestions: getRuntimeMode() === "local"
        ? snapshot.suggestions
        : snapshot.suggestions.filter((suggestion) =>
            suggestion.kind !== "stale_task"
          ),
      csrfToken: getQuietCurrentCsrfToken(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Today could not load." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isTrustedCoveRequest(request)) {
      return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
    }
    ingestProgressSuggestionRelays();
    const body = (await request.json()) as Record<string, unknown>;
    const action = stringValue(body.action, "action", { required: true, max: 40 });

    if (action !== "suggest") {
      const suppliedToken = request.headers.get("x-cove-csrf");
      if (!suppliedToken || suppliedToken !== getQuietCurrentCsrfToken()) {
        return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
      }
    }

    if (action === "accept") {
      const id = stringValue(body.id, "id", { required: true, max: 200 })!;
      if (body.source !== "explicit_accept" && body.source !== "focus") throw new Error("Unknown acceptance action.");
      return NextResponse.json(acceptWorkSuggestion(id, {source:body.source, expectedUpdatedAt:stringValue(body.expectedUpdatedAt,"expectedUpdatedAt",{max:80})}));
    }
    if (action === "undo_accept") {
      return NextResponse.json(undoWorkSuggestionAcceptance(
        stringValue(body.id,"id",{required:true,max:200})!,
        stringValue(body.acceptanceId,"acceptanceId",{required:true,max:200})!,
      ));
    }
    if (action === "suggest") {
      const kind = (stringValue(body.kind, "kind", { max: 40 }) ??
        "create_task") as SuggestionKind;
      const priority = (stringValue(body.priority, "priority", { max: 20 }) ??
        "medium") as SuggestionPriority;
      if (!KINDS.has(kind)) throw new Error("Unknown suggestion kind.");
      if (kind === "stale_task" && getRuntimeMode() !== "local") {
        throw new Error("Unknown suggestion kind.");
      }
      if (!PRIORITIES.has(priority)) throw new Error("Unknown priority.");

      const suggestion = createWorkSuggestion({
        kind,
        title: stringValue(body.title, "title", { required: true, max: 240 })!,
        description: stringValue(body.description, "description", { max: 4000 }),
        reason: stringValue(body.reason, "reason", { required: true, max: 600 })!,
        source: stringValue(body.source, "source", { required: true, max: 240 })!,
        priority,
        dueDate: stringValue(body.dueDate, "dueDate", { max: 40 }),
        targetTaskId: stringValue(body.targetTaskId, "targetTaskId", { max: 200 }),
        reviewMaterial: stringValue(body.reviewMaterial, "reviewMaterial", {
          max: 20000,
        }),
        claimKey: stringValue(body.claimKey, "claimKey", { max: 300 }),
        expiresAt: stringValue(body.expiresAt, "expiresAt", { max: 80 }),
      });
      return NextResponse.json(suggestion, { status: 201 });
    }

    if (action === "resolve") {
      const id = stringValue(body.id, "id", { required: true, max: 200 })!;
      const state = stringValue(body.state, "state", {
        required: true,
        max: 30,
      }) as SuggestionState;
      if (!RESOLUTION_STATES.has(state)) {
        throw new Error("Unknown resolution state.");
      }
      const priorityText = stringValue(body.priority, "priority", { max: 20 });
      const priority = priorityText as SuggestionPriority | undefined;
      if (priority && !PRIORITIES.has(priority)) throw new Error("Unknown priority.");

      return NextResponse.json(
        resolveWorkSuggestion(id, {
          state: state as Exclude<SuggestionState, "proposed" | "expired">,
          title: stringValue(body.title, "title", { max: 240 }),
          description: stringValue(body.description, "description", { max: 4000 }),
          dueDate: stringValue(body.dueDate, "dueDate", { max: 40 }),
          priority,
          dismissReason: stringValue(body.dismissReason, "dismissReason", {
            max: 80,
          }),
          resolvedTaskId: stringValue(body.resolvedTaskId, "resolvedTaskId", {
            max: 200,
          }),
          source: stringValue(body.source, "source", { max: 120 }),
        }),
      );
    }

    if (action === "reopen") {
      const id = stringValue(body.id, "id", { required: true, max: 200 })!;
      const targetState = stringValue(body.state, "state", { max: 30 });
      if (targetState && targetState !== "proposed" && targetState !== "refined") {
        throw new Error("A reopened suggestion must return to pencil.");
      }
      return NextResponse.json(
        reopenWorkSuggestion(id, (targetState as "proposed" | "refined") ?? "proposed"),
      );
    }

    if (action === "event") {
      const eventPayloadBytes = Buffer.byteLength(
        JSON.stringify({ before: body.before, after: body.after }),
        "utf8",
      );
      if (eventPayloadBytes > 8192) {
        throw new Error("Decision event payload is too large.");
      }
      const event = recordDecisionEvent({
        eventType: stringValue(body.eventType, "eventType", {
          required: true,
          max: 100,
        })!,
        entityId: stringValue(body.entityId, "entityId", { max: 200 }),
        before: body.before,
        after: body.after,
        reason: stringValue(body.reason, "reason", { max: 600 }),
        source: stringValue(body.source, "source", { max: 120 }) ?? "human",
      });
      return NextResponse.json(event, { status: 201 });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Today could not load.";
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
