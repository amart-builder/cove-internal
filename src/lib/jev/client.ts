/**
 * Minimal Jev transport: one POST to a fixed endpoint, validated both ways.
 * No retry subsystem (the durable job owner decides whether to try again
 * later), no configurable base URL, redirects rejected, bounded request and
 * response sizes, and a strict check of the response against the questions
 * that were asked. Errors carry a safe code and never the key or the body.
 *
 * Wire contract frozen from live captures in fixtures/jev/wire/ (2026-09-20).
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
const PROBABILITY_TOLERANCE = 0.02;
const QUESTION_ID = /^[a-z][a-z0-9_]{0,63}$/;

export type JevCriteriaText = string | Record<string, unknown> | unknown[];
export type JevChoiceQuestion = { type: "choice"; instructions: JevCriteriaText; criteria: Record<string, JevCriteriaText | null> };
export type JevNoulQuestion = { type: "noul"; instructions: JevCriteriaText; criteria?: { true?: JevCriteriaText; false?: JevCriteriaText } };
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export type JevRequest = { model: typeof JEV_MODEL; state: string | Record<string, unknown> | unknown[]; questions: Record<string, JevQuestion> };

export type JevChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;
export type JevResponse = { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number } };

export type JevErrorCode =
  | "request_invalid"      // Cove built a bad request; fix the code, do not retry.
  | "auth"                 // 401/403: disabled until the credential changes.
  | "contract"             // 422 or an unexpected response shape: contract fault.
  | "rate_limited"         // 429/529: transient, honor retryAfterMs.
  | "transient"            // 5xx, network, timeout, oversized body.
  | "aborted";             // Parent cancelled.

export class JevError extends Error {
  readonly code: JevErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  constructor(code: JevErrorCode, safeMessage: string, extra: { httpStatus?: number; retryAfterMs?: number; requestId?: string; cause?: unknown } = {}) {
    super(safeMessage, { cause: extra.cause });
    this.name = "JevError";
    this.code = code;
    this.httpStatus = extra.httpStatus;
    this.retryAfterMs = extra.retryAfterMs;
    this.requestId = extra.requestId;
    this.retryable = code === "rate_limited" || code === "transient";
  }
}

export type JevCallLimits = { attemptTimeoutMs: number; maxRequestBytes: number; maxQuestions: number; maxResponseBytes: number };

/** Serialize and check a request before anything touches the network. Returns
 * the exact bytes that will be sent so the ledger can hash and size them. */
export function serializeJevRequest(request: JevRequest, limits: Pick<JevCallLimits, "maxRequestBytes" | "maxQuestions">): string {
  if (request.model !== JEV_MODEL) throw new JevError("request_invalid", "Jev request names an unpinned model.");
  const ids = Object.keys(request.questions);
  if (!ids.length) throw new JevError("request_invalid", "Jev request has no questions.");
  if (ids.length > limits.maxQuestions) throw new JevError("request_invalid", `Jev request exceeds ${limits.maxQuestions} questions.`);
  for (const id of ids) {
    if (!QUESTION_ID.test(id)) throw new JevError("request_invalid", "Jev question id must be a short snake_case identifier.");
    const q = request.questions[id];
    if (q.type === "choice") {
      const labels = Object.keys(q.criteria ?? {});
      if (labels.length < 2 || labels.length > 255) throw new JevError("request_invalid", "Jev choice needs between 2 and 255 criteria.");
    } else if (q.type !== "noul") {
      throw new JevError("request_invalid", "Jev question type must be choice or noul.");
    }
    if (q.instructions === undefined || q.instructions === null || q.instructions === "") throw new JevError("request_invalid", "Jev question needs instructions.");
  }
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > limits.maxRequestBytes) {
    throw new JevError("request_invalid", `Jev request exceeds ${limits.maxRequestBytes} bytes; trim the evidence or split the call.`);
  }
  return body;
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate a decoded response against the questions actually asked. */
export function validateJevResponse(value: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const fault = (detail: string) => new JevError("contract", `Jev response did not match the contract: ${detail}.`);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fault("not an object");
  const raw = value as Record<string, unknown>;
  if (raw.model !== JEV_MODEL) throw fault("resolved model differs from the pinned model");
  const answers = raw.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw fault("answers missing");
  const got = answers as Record<string, unknown>;
  const ids = Object.keys(questions);
  if (Object.keys(got).length !== ids.length) throw fault("answer count differs from question count");
  const checked: Record<string, JevAnswer> = {};
  for (const id of ids) {
    const answer = got[id];
    if (!answer || typeof answer !== "object") throw fault(`no answer for ${id}`);
    const a = answer as Record<string, unknown>;
    const question = questions[id];
    if (a.type !== question.type) throw fault(`answer type mismatch for ${id}`);
    if (question.type === "noul") {
      if (!finiteUnit(a.noul)) throw fault(`noul out of range for ${id}`);
      checked[id] = { type: "noul", noul: a.noul };
      continue;
    }
    const labels = Object.keys(question.criteria);
    const probabilities = a.probabilities;
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) throw fault(`probabilities missing for ${id}`);
    const p = probabilities as Record<string, unknown>;
    const keys = Object.keys(p);
    if (keys.length !== labels.length || keys.some((k) => !labels.includes(k))) throw fault(`probability labels differ from criteria for ${id}`);
    let sum = 0;
    const clean: Record<string, number> = {};
    for (const label of labels) {
      const v = p[label];
      if (!finiteUnit(v)) throw fault(`probability out of range for ${id}`);
      clean[label] = v; sum += v;
    }
    if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) throw fault(`probabilities do not sum to one for ${id}`);
    if (typeof a.choice !== "string" || !labels.includes(a.choice)) throw fault(`choice is not a permitted label for ${id}`);
    if (!finiteUnit(a.confidence)) throw fault(`confidence out of range for ${id}`);
    checked[id] = { type: "choice", choice: a.choice, probabilities: clean, confidence: a.confidence };
  }
  const usage = raw.usage as Record<string, unknown> | undefined;
  const count = (v: unknown) => (Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined);
  const input = count(usage?.input_tokens), output = count(usage?.output_tokens);
  if (input === undefined || output === undefined) throw fault("usage missing");
  return { model: JEV_MODEL, answers: checked, usage: { input_tokens: input, output_tokens: output } };
}

export type JevTransport = typeof fetch;

export type JevCallResult = { response: JevResponse; latencyMs: number; requestId?: string; requestBytes: number; responseBytes: number };

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Read at most `limit` bytes; anything more is a transient failure, not a
 * truncated parse. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new JevError("transient", "Jev response exceeded the size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new JevError("transient", "Jev response exceeded the size limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One attempt. The caller has already reserved budget and holds a lease. */
export async function callJev(input: {
  request: JevRequest;
  apiKey: string;
  limits: JevCallLimits;
  fetchImpl?: JevTransport;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<JevCallResult> {
  const body = serializeJevRequest(input.request, input.limits);
  const transport = input.fetchImpl ?? fetch;
  const clock = input.now ?? Date.now;
  const started = clock();
  const signals = [AbortSignal.timeout(input.limits.attemptTimeoutMs), ...(input.signal ? [input.signal] : [])];
  let response: Response;
  try {
    response = await transport(JEV_ENDPOINT, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json", accept: "application/json" },
      body,
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new JevError("aborted", "Jev call cancelled by its parent job.", { cause: error });
    const name = (error as { name?: string })?.name;
    throw new JevError("transient", name === "TimeoutError" ? "Jev did not answer within the attempt timeout." : "Jev could not be reached.", { cause: error });
  }
  const requestId = response.headers.get("x-typesafe-request-id") ?? undefined;
  const status = response.status;
  let text: string;
  try {
    text = await readBounded(response, input.limits.maxResponseBytes);
  } catch (error) {
    if (error instanceof JevError) throw error;
    if (input.signal?.aborted) throw new JevError("aborted", "Jev call cancelled by its parent job.", { cause: error });
    throw new JevError("transient", "Jev response body could not be read.", { httpStatus: status, requestId, cause: error });
  }
  const latencyMs = clock() - started;
  if (status === 401 || status === 403) throw new JevError("auth", "Jev rejected the credential. Jev stays off until the key is changed.", { httpStatus: status, requestId });
  if (status === 422) throw new JevError("contract", "Jev rejected the request shape (422). This is a Cove contract fault, not a retry case.", { httpStatus: status, requestId });
  if (status === 429 || status === 529) throw new JevError("rate_limited", `Jev is rate limited or overloaded (${status}).`, { httpStatus: status, requestId, retryAfterMs: retryAfterMs(response.headers) });
  if (status !== 200) throw new JevError("transient", `Jev returned HTTP ${status}.`, { httpStatus: status, requestId, retryAfterMs: retryAfterMs(response.headers) });
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch (error) { throw new JevError("contract", "Jev returned a body that is not JSON.", { httpStatus: status, requestId, cause: error }); }
  const checked = validateJevResponse(decoded, input.request.questions);
  return { response: checked, latencyMs, requestId, requestBytes: Buffer.byteLength(body), responseBytes: Buffer.byteLength(text) };
}
