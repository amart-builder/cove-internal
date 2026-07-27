import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import {
  buildBuddyCompactionSummaryCommand,
  buildBuddyHandoffSeedCommand,
  buildBuddyTurnCommand,
} from "@/lib/buddy/commands";
import { routeBuddyTurn } from "@/lib/buddy/router";
import {
  BUDDY_STALE_TURN_MS,
  getBuddyStore,
  type BuddyStore,
  type BuddyTurn,
} from "@/lib/buddy/store";
import {
  isBuddyContextOverflow,
  registerActiveBuddyTurn,
  runBuddyCommand,
  type BuddyStreamEvent,
} from "@/lib/buddy/stream";
import {
  normalizeBuddyReceipts,
  parseBuddyReceipts,
  reconcileBuddyReceipts,
  type ReceiptChange,
  type SpawnedSessionReceipt,
} from "@/lib/buddy/receipts";
import type { ClaudeCommand } from "@/lib/claude-execution/commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 24 * 1024;

function protectedRequest(request: NextRequest): NextResponse | undefined {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-forge-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Forge request token is missing." }, { status: 403 });
  }
}

export function attachBuddyRun(input: {
  store: BuddyStore;
  turn: BuddyTurn;
  buildCommand: () => ClaudeCommand;
  runCommand?: typeof runBuddyCommand;
  compaction?: {
    buildSummaryCommand: () => ClaudeCommand;
    buildSeedCommand: (summary: string) => ClaudeCommand;
    buildRetryCommand: (headSessionId: string) => ClaudeCommand;
  };
  send: (event: BuddyStreamEvent | Record<string, unknown>) => void;
  close: () => void;
}): Promise<void> {
  const clearActiveTurn = registerActiveBuddyTurn(input.store, input.turn.id);
  let streamedText = "";
  const authoritativeChanges: ReceiptChange[] = [];
  const authoritativeSessions: SpawnedSessionReceipt[] = [];
  const failExecution = (error: unknown) => {
    const code = error instanceof Error && error.message === "timeout" ? "timeout" : "interrupted";
    const receipts = reconcileBuddyReceipts(undefined, authoritativeChanges, authoritativeSessions);
    input.store.finishTurn(input.turn.id, {
      state: "failed",
      assistant_text: streamedText,
      receipts_json: receipts ? JSON.stringify(receipts) : null,
      error_code: code,
    });
    input.send({ kind: "failed", errorCode: code, ...(receipts ? { receipts } : {}) });
  };
  const failPersistence = (error: unknown) => {
    console.error("Buddy turn persistence failed.", {
      turnId: input.turn.id,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      input.store.finishTurn(input.turn.id, {
        state: "failed",
        assistant_text: "",
        error_code: "persist_failed",
      });
    } catch (finishError) {
      console.error("Buddy could not record the persistence failure.", {
        turnId: input.turn.id,
        error: finishError instanceof Error ? finishError.message : String(finishError),
      });
    }
    input.send({ kind: "failed", errorCode: "persist_failed" });
  };
  try {
    const command = input.buildCommand();
    const forward = (event: BuddyStreamEvent) => {
      if (event.kind === "delta") streamedText += event.text;
      if (event.kind === "data-result") {
        authoritativeChanges.push(...event.changes);
        authoritativeSessions.push(...event.sessions);
      }
      if (event.kind !== "done" && event.kind !== "data-result") input.send(event);
    };
    const execute = input.runCommand ?? runBuddyCommand;
    const compactionFailure = (sessionId: string, costUsd: number) => ({
      kind: "done" as const,
      resultText: "Buddy could not compact this conversation. Start a new conversation and try again.",
      sessionId,
      costUsd,
      isError: true,
      errorSubtype: "context_overflow_retry_failed",
    });
    const running = execute(command, forward).then(async (initial) => {
      if (!input.compaction || !isBuddyContextOverflow(initial)) return initial;
      input.send({ kind: "compacting" });
      streamedText = "";
      authoritativeChanges.length = 0;
      authoritativeSessions.length = 0;
      let totalCostUsd = initial.costUsd;
      let latestSessionId = initial.sessionId;
      try {
        const summary = await execute(input.compaction.buildSummaryCommand(), () => {});
        totalCostUsd += summary.costUsd;
        latestSessionId = summary.sessionId || latestSessionId;
        if (summary.isError || !summary.resultText.trim()) {
          return compactionFailure(latestSessionId, totalCostUsd);
        }
        const seed = await execute(input.compaction.buildSeedCommand(summary.resultText.trim()), () => {});
        totalCostUsd += seed.costUsd;
        latestSessionId = seed.sessionId || latestSessionId;
        if (seed.isError) return compactionFailure(latestSessionId, totalCostUsd);
        input.store.setHeadSession(seed.sessionId);
        const retry = await execute(input.compaction.buildRetryCommand(seed.sessionId), forward);
        totalCostUsd += retry.costUsd;
        return retry.isError
          ? compactionFailure(retry.sessionId, totalCostUsd)
          : { ...retry, costUsd: totalCostUsd };
      } catch {
        return compactionFailure(latestSessionId, totalCostUsd);
      }
    });
    return running.then(
      (done) => {
        try {
          const parsed = parseBuddyReceipts(done.resultText || streamedText);
          const receipts = reconcileBuddyReceipts(
            parsed.receipts,
            authoritativeChanges,
            authoritativeSessions,
          );
          input.store.completeTurn(input.turn.id, {
            state: done.isError ? "failed" : "succeeded",
            assistant_text: parsed.text,
            receipts_json: receipts ? JSON.stringify(receipts) : null,
            session_id: done.sessionId,
            cost_usd: done.costUsd,
            error_code: done.isError ? done.errorSubtype ?? "claude_error" : null,
          });
          input.send({ ...done, resultText: parsed.text, ...(receipts ? { receipts } : {}) });
        } catch (error) {
          failPersistence(error);
        }
      },
      failExecution,
    ).finally(() => {
      clearActiveTurn();
      input.close();
    });
  } catch {
    input.store.finishTurn(input.turn.id, {
      state: "failed",
      assistant_text: "",
      error_code: "spawn_failed",
    });
    input.send({ kind: "failed", errorCode: "spawn_failed" });
    clearActiveTurn();
    input.close();
    return Promise.resolve();
  }
}

function publicTurn(turn: BuddyTurn): BuddyTurn & { receipts?: ReturnType<typeof normalizeBuddyReceipts> } {
  if (!turn.receipts_json) return turn;
  try {
    const receipts = normalizeBuddyReceipts(JSON.parse(turn.receipts_json));
    return receipts ? { ...turn, receipts } : turn;
  } catch {
    return turn;
  }
}

export function prepareBuddyRecentTurns(store: BuddyStore, limit: number) {
  store.sweepStaleTurns(BUDDY_STALE_TURN_MS);
  return store.listRecentTurns(limit).reverse().map(publicTurn);
}

function buddyAppUrl(request: NextRequest): string {
  const forwardedHost = process.env.FORGE_TRUST_PROXY === "1"
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const candidateHost = forwardedHost ?? request.headers.get("host")
    ?? request.nextUrl.host;
  try {
    const port = new URL(`http://${candidateHost}`).port;
    if (port) return `http://127.0.0.1:${port}`;
  } catch { /* Fall through to the configured URL. */ }
  return process.env.FORGE_BUDDY_APP_URL ?? "http://127.0.0.1:3200";
}

export async function GET(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  const store = getBuddyStore();
  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    const turn = store.getTurn(id);
    return turn
      ? NextResponse.json({ turn: publicTurn(turn) })
      : NextResponse.json({ error: "Buddy turn not found." }, { status: 404 });
  }
  const rawLimit = request.nextUrl.searchParams.get("recent");
  const parsed = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 50;
  return NextResponse.json({ turns: prepareBuddyRecentTurns(store, limit) });
}

export async function POST(request: NextRequest) {
  const denied = protectedRequest(request);
  if (denied) return denied;
  let claimed: { store: BuddyStore; turn: BuddyTurn } | undefined;
  try {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Buddy request is too large." }, { status: 413 });
    }
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Buddy request is too large." }, { status: 413 });
    }
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
    const body = value as Record<string, unknown>;
    if (typeof body.text !== "string" || !body.text.trim()) throw new Error("text is required.");
    const text = body.text.trim();
    if (text.length > 4000) throw new Error("text is too long.");
    const override = body.override === "fast" || body.override === "deep" ? body.override : undefined;
    if (body.override !== undefined && !override) throw new Error("override is invalid.");
    const contextSize = Buffer.byteLength(JSON.stringify(body.pageContext ?? null), "utf8");
    if (contextSize > 12 * 1024) throw new Error("pageContext is too large.");

    const store = getBuddyStore();
    store.sweepStaleTurns(BUDDY_STALE_TURN_MS);
    const route = routeBuddyTurn(text, body.pageContext, override);
    const turn = store.claimTurn({
      userText: text,
      pageContext: body.pageContext,
      model: route.model,
      effort: route.effort,
      routerReason: route.reason,
    });
    if (!turn) {
      return NextResponse.json({ error: "Buddy is already working on a turn." }, { status: 409 });
    }
    claimed = { store, turn };

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamOpen = true;
    const send = (event: BuddyStreamEvent | Record<string, unknown>) => {
      if (!streamOpen || !controller) return;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        streamOpen = false;
      }
    };
    const close = () => {
      if (!streamOpen || !controller) return;
      try { controller.close(); } catch { /* The browser disconnected. */ }
      streamOpen = false;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
        send({ kind: "claimed", turn });
      },
      cancel() {
        streamOpen = false;
      },
    });

    const headSessionId = store.getBuddyState().headSessionId;
    void attachBuddyRun({
      store,
      turn,
      buildCommand: () => buildBuddyTurnCommand({
        headSessionId,
        newSessionId: randomUUID(),
        model: route.model,
        effort: route.effort,
        userText: text,
        pageContext: body.pageContext,
      }),
      ...(headSessionId ? {
        compaction: {
          buildSummaryCommand: () => buildBuddyCompactionSummaryCommand(headSessionId),
          buildSeedCommand: (summary: string) => buildBuddyHandoffSeedCommand({
            newSessionId: randomUUID(),
            summary,
          }),
          buildRetryCommand: (freshHeadSessionId: string) => buildBuddyTurnCommand({
            headSessionId: freshHeadSessionId,
            newSessionId: randomUUID(),
            model: route.model,
            effort: route.effort,
            userText: text,
            pageContext: body.pageContext,
          }),
        },
      } : {}),
      runCommand: (command, onEvent, options) => runBuddyCommand(command, onEvent, {
        ...options,
        env: { FORGE_BUDDY_APP_URL: buddyAppUrl(request) },
      }),
      send,
      close,
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    claimed?.store.finishTurn(claimed.turn.id, {
      state: "failed",
      assistant_text: "",
      error_code: "spawn_failed",
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Buddy request failed." },
      { status: error instanceof SyntaxError ? 400 : 400 },
    );
  }
}
