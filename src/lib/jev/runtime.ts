/**
 * The one entry point features use: `assessWithJev`. It checks settings and
 * the key, looks for an exact reusable answer, reserves budget and a slot,
 * makes one bounded call outside any database transaction, settles the
 * ledger, and returns a typed outcome. It never throws for an expected
 * unavailability; the caller's deterministic work continues either way.
 *
 * A returned answer is evidence for the caller's policy, not permission to
 * act. v1 callers may only annotate, ask or route; nothing here suppresses,
 * closes, merges or reranks anything.
 */
import type Database from "better-sqlite3";
import { callJev, JevError, serializeJevRequest, JEV_MODEL, type JevAnswer, type JevQuestion, type JevRequest, type JevTransport } from "./client";
import { canonicalJson, findReusableJevAnswer, reserveJevAttempt, settleJevAttempt, sha256, JEV_POLICY_VERSION } from "./ledger";
import { jevApiKey, jevAvailability, jevCredentialRevision, readJevSettings, type JevFeature, type JevFeatureMode, type JevSettings } from "./settings";
import type { CoveEnvironment } from "../env";

export type JevAssessmentInput = {
  db: Database.Database;
  feature: JevFeature;
  lane: string;
  parentRef?: string;
  subject?: { kind: string; id: string; version?: string };
  /** Named, scoped evidence only. The caller is responsible for sending no
   * more than the approved source scope for this feature. */
  state: JevRequest["state"];
  questions: Record<string, JevQuestion>;
  /** Pass only for judgments that stay valid while every semantic input is
   * unchanged (identity, commitment meaning). Never for urgency. */
  reuse?: { scopeVersion: number; freshnessMs?: number };
  settings?: JevSettings;
  env?: CoveEnvironment;
  fetchImpl?: JevTransport;
  signal?: AbortSignal;
  now?: () => number;
  dataDir?: string;
};

export type JevAssessment =
  | { status: "answered"; mode: Exclude<JevFeatureMode, "off">; answers: Record<string, JevAnswer>; attemptId: string; reused: boolean; latencyMs?: number }
  | { status: "skipped"; reason: "disabled" | "feature_off" | "no_key" }
  | { status: "deferred"; retryAt: number; attemptId?: string }
  | { status: "unavailable"; reason: "busy" | "cooldown" | "auth_blocked" | "auth" | "rate_limited" | "transient" | "aborted"; retryAt?: number; attemptId?: string }
  | { status: "invalid"; reason: "request_invalid" | "contract"; attemptId?: string };

export async function assessWithJev(input: JevAssessmentInput): Promise<JevAssessment> {
  const env = input.env ?? process.env;
  const settings = input.settings ?? readJevSettings(input.dataDir, env);
  const availability = jevAvailability(input.feature, settings, env);
  if (!availability.available) return { status: "skipped", reason: availability.reason };
  const clock = input.now ?? Date.now;
  const now = clock();
  const request: JevRequest = { model: JEV_MODEL, state: input.state, questions: input.questions };
  let body: string;
  try {
    body = serializeJevRequest(request, settings.limits);
  } catch (error) {
    if (error instanceof JevError) return { status: "invalid", reason: "request_invalid" };
    throw error;
  }
  const evidenceHash = sha256(canonicalJson(input.state));
  const questionHash = sha256(canonicalJson(input.questions));
  const reuseKey = input.reuse
    ? sha256(canonicalJson({ feature: input.feature, subject: input.subject ?? null, evidenceHash, questionHash, model: JEV_MODEL, policy: JEV_POLICY_VERSION, scope: input.reuse.scopeVersion }))
    : undefined;
  if (reuseKey) {
    const hit = findReusableJevAnswer(input.db, reuseKey, now, input.reuse?.freshnessMs);
    if (hit) return { status: "answered", mode: availability.mode, answers: hit.answers, attemptId: hit.id, reused: true };
  }
  const credentialRevision = jevCredentialRevision(env) ?? "";
  const reserved = reserveJevAttempt(input.db, {
    feature: input.feature, mode: availability.mode, lane: input.lane, parentRef: input.parentRef, subject: input.subject,
    evidenceHash, questionHash, reuseKey, requestBytes: Buffer.byteLength(body), requestedModel: JEV_MODEL,
    limits: settings.limits, credentialRevision, now,
  });
  if (!reserved.ok) {
    if (reserved.status === "budget_deferred") return { status: "deferred", retryAt: reserved.retryAt };
    return { status: "unavailable", reason: reserved.reason, retryAt: reserved.retryAt };
  }
  const apiKey = jevApiKey(env)!;
  try {
    const result = await callJev({ request, apiKey, limits: settings.limits, fetchImpl: input.fetchImpl, signal: input.signal, now: clock });
    settleJevAttempt(input.db, reserved.id, {
      status: "answered", answers: result.response.answers, resolvedModel: result.response.model, latencyMs: result.latencyMs,
      responseBytes: result.responseBytes, requestId: result.requestId, inputTokens: result.response.usage.input_tokens, outputTokens: result.response.usage.output_tokens,
    }, clock());
    return { status: "answered", mode: availability.mode, answers: result.response.answers, attemptId: reserved.id, reused: false, latencyMs: result.latencyMs };
  } catch (error) {
    const finished = clock();
    if (!(error instanceof JevError)) {
      settleJevAttempt(input.db, reserved.id, { status: "unavailable", reason: "transient" }, finished);
      throw error;
    }
    const invalid = error.code === "request_invalid" || error.code === "contract";
    settleJevAttempt(input.db, reserved.id, {
      status: invalid ? "invalid" : "unavailable", reason: error.code, httpStatus: error.httpStatus, requestId: error.requestId,
      latencyMs: finished - now, retryAfterMs: error.retryAfterMs, credentialRevision,
    }, finished);
    if (invalid) return { status: "invalid", reason: error.code, attemptId: reserved.id };
    return { status: "unavailable", reason: error.code, retryAt: error.retryAfterMs ? finished + error.retryAfterMs : undefined, attemptId: reserved.id };
  }
}
