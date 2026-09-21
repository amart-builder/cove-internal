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
import { readAgentSettings } from "@/lib/agent-settings.mjs";
import { BuddyCodexSetupError, buddyProviderHead, type BuddyAgentSelection } from "@/lib/buddy/codex";
import {
  BUDDY_STALE_TURN_MS,
  getBuddyStore,
  type BuddyStore,
  type BuddyTurn,
} from "@/lib/buddy/store";
import {
  isBuddyContextOverflow,
  isBuddyResumeExecutionFailure,
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
import { coveEnv } from "../../../../lib/env";
import { detectBuddyCommandIntent } from "@/lib/buddy/router";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { getDayPlanStore } from "@/lib/day-plan/store";
import { isProviderMissing, isProviderNotSignedIn } from "@/lib/buddy/errors";
import {
  buildReplanCommand,
  parseReplanProposal,
  previewReplan,
} from "@/lib/buddy/replan";
import {
  buddyFeedbackAssistantText,
  prepareBuddyFeedback,
} from "@/lib/buddy/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 24 * 1024;

function protectedRequest(request: NextRequest): NextResponse | undefined {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
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
  resumeRecovery?: {
    buildFreshCommand: () => ClaudeCommand;
  };
  send: (event: BuddyStreamEvent | Record<string, unknown>) => void;
  close: () => void;
}): Promise<void> {
  const clearActiveTurn = registerActiveBuddyTurn(input.store, input.turn.id);
  let streamedText = "";
  const authoritativeChanges: ReceiptChange[] = [];
  const authoritativeSessions: SpawnedSessionReceipt[] = [];
  // Everything the provider said about why it stopped arrives here as the
  // rejection message -- a spawn ENOENT before the CLI is installed, or the
  // CLI's own stderr behind `missing_result:`. Collapsing all of it to
  // "interrupted" left the person with "Buddy was interrupted." and a Retry
  // that could not work, and left the log with nothing to diagnose from.
  const failExecution = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    const code = detail === "timeout"
      ? "timeout"
      : isProviderNotSignedIn(input.turn.provider, detail)
      ? "not_signed_in"
      : isProviderMissing(detail)
      ? "provider_missing"
      : "interrupted";
    console.error("Buddy turn failed.", {
      turnId: input.turn.id,
      provider: input.turn.provider ?? "claude",
      code,
      error: detail,
    });
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
      if (!input.compaction || !isBuddyContextOverflow(initial)) {
        // A fast, work-free error_during_execution on a healthy resumed session also
        // takes this one-shot fallback and loses continuity for this thread. That is
        // deliberate and bounded to this turn; the normal Retry remains available.
        const resumeRecovery = input.resumeRecovery;
        if (!resumeRecovery || !isBuddyResumeExecutionFailure(initial, streamedText) ||
          authoritativeChanges.length > 0 || authoritativeSessions.length > 0) {
          return initial;
        }
        streamedText = "";
        authoritativeChanges.length = 0;
        authoritativeSessions.length = 0;
        try {
          const retry = await execute(resumeRecovery.buildFreshCommand(), forward);
          const totalCostUsd = initial.costUsd + retry.costUsd;
          if (!retry.isError) {
            return { ...retry, costUsd: totalCostUsd, resumeRecovered: true as const };
          }
          streamedText = "";
          return { ...initial, costUsd: totalCostUsd, preserveHead: true as const };
        } catch (error) {
          streamedText = "";
          throw error;
        }
      }
      // Confirmed effects survive overflow. Repeating the original request can
      // duplicate work, so let the person continue from the saved receipts.
      if (authoritativeChanges.length > 0 || authoritativeSessions.length > 0) {
        return { ...initial, resultText: "Buddy completed some changes before the conversation filled up. Review the saved changes, then ask for the remaining work.", errorSubtype: "context_overflow_after_changes" };
      }
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
          // Stored only as a DB-audit breadcrumb; no Buddy UI consumer reads it.
          const storedReceipts = "resumeRecovered" in done && done.resumeRecovered
            ? {
                ...(receipts ?? { changes: [], pendingDeletes: [] }),
                resumeRecovery: {
                  reason: "error_during_execution",
                  outcome: "fresh_session_succeeded",
                },
              }
            : receipts;
          const finish = "preserveHead" in done && done.preserveHead
            ? input.store.finishTurn
            : input.store.completeTurn;
          finish(input.turn.id, {
            state: done.isError ? "failed" : "succeeded",
            assistant_text: parsed.text,
            receipts_json: storedReceipts ? JSON.stringify(storedReceipts) : null,
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
  } catch (error) {
    const setupError = error instanceof BuddyCodexSetupError ? error : undefined;
    input.store.finishTurn(input.turn.id, {
      state: "failed",
      assistant_text: setupError?.message ?? "",
      error_code: setupError?.code ?? "spawn_failed",
    });
    input.send({ kind: "failed", errorCode: setupError?.code ?? "spawn_failed", ...(setupError ? { resultText: setupError.message } : {}) });
    clearActiveTurn();
    input.close();
    return Promise.resolve();
  }
}

export function attachSpecialBuddyRun(input: {
  store: BuddyStore;
  turn: BuddyTurn;
  run: () => Promise<{
    assistantText: string;
    receipts?: unknown;
    costUsd?: number;
  }>;
  send: (event: BuddyStreamEvent | Record<string, unknown>) => void;
  close: () => void;
}): Promise<void> {
  const clearActiveTurn = registerActiveBuddyTurn(input.store, input.turn.id);
  input.send({ kind: "thinking" });
  return input.run().then((result) => {
    const receipts = normalizeBuddyReceipts(result.receipts);
    input.store.finishTurn(input.turn.id, {
      state: "succeeded",
      assistant_text: result.assistantText,
      receipts_json: receipts ? JSON.stringify(receipts) : null,
      cost_usd: result.costUsd ?? 0,
      error_code: null,
    });
    input.send({
      kind: "done",
      resultText: result.assistantText,
      costUsd: result.costUsd ?? 0,
      isError: false,
      ...(receipts ? { receipts } : {}),
    });
  }).catch((error) => {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 2_000)
      : "Buddy could not finish that command.";
    input.store.finishTurn(input.turn.id, {
      state: "failed",
      assistant_text: message,
      error_code: "command_failed",
    });
    input.send({
      kind: "done",
      resultText: message,
      costUsd: 0,
      isError: true,
      errorSubtype: "command_failed",
    });
  }).finally(() => {
    clearActiveTurn();
    input.close();
  });
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
  const forwardedHost = coveEnv("TRUST_PROXY") === "1"
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const candidateHost = forwardedHost ?? request.headers.get("host")
    ?? request.nextUrl.host;
  try {
    const port = new URL(`http://${candidateHost}`).port;
    if (port) return `http://127.0.0.1:${port}`;
  } catch { /* Fall through to the configured URL. */ }
  return coveEnv("BUDDY_APP_URL") ?? "http://127.0.0.1:3200";
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
    // Freeze the user's selection for this turn, including any recovery calls.
    const selection = readAgentSettings() as BuddyAgentSelection | undefined;
    const provider = selection?.provider ?? "claude";
    const storedHead = store.getBuddyState().headSessionId;
    const headSessionId = buddyProviderHead(storedHead, provider) ? storedHead : null;
    const commandIntent = getRuntimeMode() === "local"
      ? detectBuddyCommandIntent(text)
      : undefined;
    const route = commandIntent?.kind === "replan"
      ? { model: "sonnet" as const, effort: "medium" as const, reason: "Day replan preview" }
      : commandIntent?.kind === "feedback"
        ? { model: "sonnet" as const, effort: "low" as const, reason: "Feedback draft" }
        : routeBuddyTurn(text, body.pageContext, override);
    const turn = store.claimTurn({
      userText: text,
      pageContext: body.pageContext,
      model: route.model,
      effort: selection?.effort ?? route.effort,
      routerReason: selection ? `Selected ${selection.model} (${selection.effort})` : route.reason,
      provider,
      modelId: selection?.model,
      providerChanged: Boolean(storedHead && !headSessionId),
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

    if (commandIntent?.kind === "replan") {
      void attachSpecialBuddyRun({
        store,
        turn,
        run: async () => {
          const plan = getDayPlanStore().getReadModel().currentPlan;
          if (!plan) throw new Error("There is no plan for today yet.");
          if (
            !(
              (plan.state === "proposed" && plan.arrivalState === "opened") ||
              plan.state === "active"
            )
          ) {
            throw new Error("Today's plan cannot change while you are closing the day.");
          }
          const done = await runBuddyCommand(
            buildReplanCommand(plan, text, selection),
            (event) => {
              if (event.kind === "thinking") send(event);
            },
          );
          if (done.isError) {
            throw new Error(
              done.resultText.trim() ||
                "Buddy could not build a safe preview. Try again.",
            );
          }
          const proposal = parseReplanProposal(plan, done.resultText);
          return {
            assistantText: proposal.assistantText,
            costUsd: done.costUsd,
            receipts: {
              changes: [],
              pendingDeletes: [],
              replan: {
                status: "proposed",
                expectedVersion: plan.version,
                assistantText: proposal.assistantText,
                operations: proposal.operations,
                preview: previewReplan(plan, proposal),
              },
            },
          };
        },
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
    }

    if (commandIntent?.kind === "feedback") {
      void attachSpecialBuddyRun({
        store,
        turn,
        run: async () => {
          if (!commandIntent.message) {
            return {
              assistantText: "Tell me what happened or what you would like changed.",
            };
          }
          const feedback = await prepareBuddyFeedback({
            message: commandIntent.message,
            pageContext: body.pageContext,
          });
          return {
            assistantText: buddyFeedbackAssistantText(feedback),
            receipts: {
              changes: [],
              pendingDeletes: [],
              feedback,
            },
          };
        },
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
    }

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
        selection,
      }),
      ...(headSessionId && provider === "claude" ? {
        resumeRecovery: {
          buildFreshCommand: () => buildBuddyTurnCommand({
            headSessionId: null,
            newSessionId: randomUUID(),
            model: route.model,
            effort: route.effort,
            userText: text,
            pageContext: body.pageContext,
            selection,
          }),
        },
      } : {}),
      ...(headSessionId ? {
        compaction: {
          buildSummaryCommand: () => buildBuddyCompactionSummaryCommand(headSessionId, selection),
          buildSeedCommand: (summary: string) => buildBuddyHandoffSeedCommand({
            newSessionId: randomUUID(),
            summary,
            selection,
          }),
          buildRetryCommand: (freshHeadSessionId: string) => buildBuddyTurnCommand({
            headSessionId: freshHeadSessionId,
            newSessionId: randomUUID(),
            model: route.model,
            effort: route.effort,
            userText: text,
            pageContext: body.pageContext,
            selection,
          }),
        },
      } : {}),
      runCommand: (command, onEvent, options) => runBuddyCommand(command, onEvent, {
        ...options,
        env: { COVE_BUDDY_APP_URL: buddyAppUrl(request) },
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
