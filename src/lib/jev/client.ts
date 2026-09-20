/**
 * Minimal typed transport for TypeSafe's System One endpoint (the Jev model).
 *
 * Jev answers small, closed questions about meaning in roughly a third of a
 * second. Cove supplies evidence and named questions; Jev returns a label or a
 * probability; code decides what that is allowed to affect. Nothing here writes
 * to the database, decides policy, or knows what a commitment is.
 *
 * Cove talks to the endpoint directly rather than through @typesafe-ai/sdk so
 * the timeout, retry, redirect and size behaviour stays visible in this file
 * instead of arriving as an SDK default that changes on upgrade.
 *
 * The published contract this file pins (docs.typesafe.ai, read 2026-09-18):
 * - POST https://api.typesafe.ai/v1/systemone, bearer authentication.
 * - Request: { model, state, questions }. State is text only: a string, a JSON
 *   object, or an array of text values.
 * - Response: { model, answers, usage }, where usage carries input_tokens and
 *   output_tokens.
 * - A Choice answer has type, choice, probabilities and confidence. A Noul
 *   answer has type and noul, and deliberately carries no confidence field.
 * - 401 unauthorized, 422 contract fault, 429 rate limited, 529 overloaded.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * Pinned rather than `jev-latest`. An alias moves when a new model ships, which
 * would silently change recorded shadow answers and invalidate the frozen
 * evaluation labels they are being compared against.
 */
export const JEV_PINNED_MODEL = "jev-1.13.0";

/** One HTTP attempt. Jev's documented median is well under a second. */
export const JEV_ATTEMPT_TIMEOUT_MS = 3_000;

/** Total budget across attempts, so a parent job never waits on Jev. */
export const JEV_TOTAL_TIMEOUT_MS = 6_000;

/**
 * Cove sends small, purpose-built state. The published request ceiling is far
 * larger (64k tokens); this bound exists to keep Cove honest about sending the
 * minimum evidence, because Jev's accuracy degrades when state carries
 * irrelevant detail.
 */
export const JEV_MAX_REQUEST_BYTES = 24 * 1024;
export const JEV_MAX_RESPONSE_BYTES = 64 * 1024;
export const JEV_MAX_QUESTIONS = 32;

/** Choice questions accept at most 255 options. */
export const JEV_MAX_CHOICE_OPTIONS = 255;

export type JevFailureCode =
  | "jev_not_configured"
  | "jev_unauthorized"
  | "jev_contract"
  | "jev_rate_limited"
  | "jev_overloaded"
  | "jev_transient"
  | "jev_timeout"
  | "jev_invalid_response"
  | "jev_request_too_large"
  | "jev_response_too_large";

export type JevFailure = {
  code: JevFailureCode;
  message: string;
  status?: number;
  /** False for a contract or credential fault, which retrying cannot fix. */
  retryable: boolean;
};

/** Text-only state: a string, an array of strings, or a shallow JSON object. */
export type JevState = string | readonly string[] | Record<string, unknown>;

/**
 * Instructions and option descriptions may be a plain string or a structured
 * object or array. Structure is worth using: named keys such as question,
 * inspect and focus, and what, not_for and examples on each option, let the
 * model compare options field by field instead of parsing a paragraph. Because
 * Jev reads instructions literally, saying what an option is NOT for is often
 * what decides the boundary cases.
 */
export type JevDescription = string | Record<string, unknown> | readonly unknown[];

export type JevChoiceQuestion = {
  type: "choice";
  instructions: JevDescription;
  /** Option name to a description of when that option applies. */
  criteria: Record<string, JevDescription>;
};

export type JevNoulQuestion = {
  type: "noul";
  instructions: JevDescription;
  /** Optional true/false descriptions. Jev reads instructions literally, so
   *  spelling out both sides is how boundary cases get decided on purpose. */
  criteria?: { true: JevDescription; false: JevDescription };
};

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** Concentration of the distribution, not a claim about truth. */
  confidence: number;
};

/** Noul answers carry no confidence field. A noul near 0.5 is uncertainty
 *  between yes and no, never "medium" anything. */
export type JevNoulAnswer = {
  type: "noul";
  noul: number;
};

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export type JevUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type JevRequest = {
  state: JevState;
  questions: Record<string, JevQuestion>;
  model?: string;
};

export type JevResult =
  | {
    ok: true;
    model: string;
    answers: Record<string, JevAnswer>;
    usage: JevUsage;
    latencyMs: number;
  }
  | { ok: false; error: JevFailure; latencyMs: number };

export type JevFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type JevClientOptions = {
  apiKey: string;
  fetchImpl?: JevFetch;
  now?: () => number;
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
  endpoint?: string;
};

function failure(
  code: JevFailureCode,
  message: string,
  options: { status?: number; retryable?: boolean } = {},
): JevFailure {
  return {
    code,
    message: message.slice(0, 500),
    ...(options.status === undefined ? {} : { status: options.status }),
    retryable: options.retryable ?? false,
  };
}

/**
 * A bearer token must never reach a log line, a failure-inbox row, a receipt or
 * an export. Error text from fetch and from the service is scrubbed before it
 * leaves this module.
 */
export function redactSecret(text: string, apiKey: string): string {
  if (!apiKey) return text;
  const withoutKey = text.split(apiKey).join("[redacted]");
  return withoutKey.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [redacted]");
}

/** A usable description: a non-empty string, or any non-empty object or array. */
function describes(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value) && typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length > 0;
}

export function validateJevQuestions(
  questions: Record<string, JevQuestion>,
): string | undefined {
  const keys = Object.keys(questions);
  if (keys.length === 0) return "A Jev request needs at least one question.";
  if (keys.length > JEV_MAX_QUESTIONS) {
    return `A Jev request may carry at most ${JEV_MAX_QUESTIONS} questions.`;
  }
  for (const key of keys) {
    const question = questions[key];
    if (!question || typeof question !== "object") {
      return `Question ${key} is not an object.`;
    }
    if (!describes(question.instructions)) {
      return `Question ${key} has no instructions.`;
    }
    if (question.type === "choice") {
      const options = Object.keys(question.criteria ?? {});
      if (options.length < 2) {
        return `Choice question ${key} needs at least two options.`;
      }
      if (options.length > JEV_MAX_CHOICE_OPTIONS) {
        return `Choice question ${key} has more than ${JEV_MAX_CHOICE_OPTIONS} options.`;
      }
      for (const option of options) {
        if (!describes(question.criteria[option])) {
          return `Choice question ${key} option ${option} has no description.`;
        }
      }
    } else if (question.type === "noul") {
      if (question.criteria) {
        if (!describes(question.criteria.true) || !describes(question.criteria.false)) {
          return `Noul question ${key} needs both true and false descriptions.`;
        }
      }
    } else {
      return `Question ${key} has an unsupported type.`;
    }
  }
  return undefined;
}

function decodeAnswers(
  value: unknown,
  questions: Record<string, JevQuestion>,
): { ok: true; answers: Record<string, JevAnswer> } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "answers is not an object" };
  }
  const row = value as Record<string, unknown>;
  const answers: Record<string, JevAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const raw = row[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: `answer ${key} is missing` };
    }
    const answer = raw as Record<string, unknown>;
    if (answer.type !== question.type) {
      return { ok: false, reason: `answer ${key} is not a ${question.type}` };
    }
    if (question.type === "noul") {
      const noul = answer.noul;
      if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
        return { ok: false, reason: `answer ${key} has an out-of-range noul` };
      }
      answers[key] = { type: "noul", noul };
      continue;
    }
    const choice = answer.choice;
    const confidence = answer.confidence;
    const probabilities = answer.probabilities;
    if (typeof choice !== "string" || !(choice in question.criteria)) {
      return { ok: false, reason: `answer ${key} chose an option that was not offered` };
    }
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return { ok: false, reason: `answer ${key} has an out-of-range confidence` };
    }
    if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
      return { ok: false, reason: `answer ${key} has no probability distribution` };
    }
    const distribution: Record<string, number> = {};
    for (const [option, weight] of Object.entries(probabilities as Record<string, unknown>)) {
      if (!(option in question.criteria)) {
        return { ok: false, reason: `answer ${key} scored an option that was not offered` };
      }
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) {
        return { ok: false, reason: `answer ${key} has an out-of-range probability` };
      }
      distribution[option] = weight;
    }
    answers[key] = { type: "choice", choice, probabilities: distribution, confidence };
  }
  return { ok: true, answers };
}

function decodeUsage(value: unknown): JevUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const input = row.input_tokens;
  const output = row.output_tokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) return undefined;
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
  return { inputTokens: Math.round(input), outputTokens: Math.round(output) };
}

function classifyStatus(status: number): JevFailure {
  if (status === 401 || status === 403) {
    // A bad credential stays broken until configuration changes, so the caller
    // disables the lane rather than burning attempts against it.
    return failure("jev_unauthorized", `TypeSafe rejected the credential (${status}).`, {
      status,
      retryable: false,
    });
  }
  if (status === 422) {
    return failure("jev_contract", "TypeSafe rejected the request shape (422).", {
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    return failure("jev_rate_limited", "TypeSafe rate limit reached (429).", {
      status,
      retryable: true,
    });
  }
  if (status === 529) {
    return failure("jev_overloaded", "TypeSafe is overloaded (529).", {
      status,
      retryable: true,
    });
  }
  return failure("jev_transient", `TypeSafe returned ${status}.`, {
    status,
    retryable: status >= 500,
  });
}

/**
 * One System One request. Retries only the failures a retry can fix, and only
 * while the total budget allows it, so a slow or flapping service costs the
 * parent job a bounded wait and never an unbounded one.
 */
export async function askJev(
  request: JevRequest,
  options: JevClientOptions,
): Promise<JevResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => now() - startedAt;

  if (!options.apiKey) {
    return {
      ok: false,
      latencyMs: elapsed(),
      error: failure("jev_not_configured", "No TypeSafe credential is configured."),
    };
  }

  const questionFault = validateJevQuestions(request.questions);
  if (questionFault) {
    return {
      ok: false,
      latencyMs: elapsed(),
      error: failure("jev_contract", questionFault),
    };
  }

  const body = JSON.stringify({
    model: request.model ?? JEV_PINNED_MODEL,
    state: request.state,
    questions: request.questions,
  });
  if (Buffer.byteLength(body, "utf8") > JEV_MAX_REQUEST_BYTES) {
    return {
      ok: false,
      latencyMs: elapsed(),
      error: failure(
        "jev_request_too_large",
        `The Jev request exceeds ${JEV_MAX_REQUEST_BYTES} bytes. Send less state.`,
      ),
    };
  }

  const fetchImpl = (options.fetchImpl ?? (globalThis.fetch as unknown as JevFetch));
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? JEV_ATTEMPT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? JEV_TOTAL_TIMEOUT_MS;
  const scrub = (text: string): string => redactSecret(text, options.apiKey);

  let lastError = failure("jev_transient", "The Jev request did not complete.", {
    retryable: true,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0 && elapsed() >= totalTimeoutMs) break;
    const controller = new AbortController();
    const budget = Math.min(attemptTimeoutMs, Math.max(0, totalTimeoutMs - elapsed()));
    if (budget <= 0) break;
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          // The credential appears here and nowhere else.
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
        // A moved endpoint is a configuration change, never something to follow
        // automatically with a bearer token attached.
        redirect: "error",
      });
      if (!response.ok) {
        lastError = classifyStatus(response.status);
        if (!lastError.retryable) {
          return { ok: false, latencyMs: elapsed(), error: lastError };
        }
        continue;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > JEV_MAX_RESPONSE_BYTES) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: failure("jev_response_too_large", "The Jev response was too large to read."),
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: failure("jev_invalid_response", "The Jev response was not valid JSON."),
        };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: failure("jev_invalid_response", "The Jev response was not an object."),
        };
      }
      const row = parsed as Record<string, unknown>;
      const decoded = decodeAnswers(row.answers, request.questions);
      if (!decoded.ok) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: failure("jev_invalid_response", `The Jev response ${decoded.reason}.`),
        };
      }
      const usage = decodeUsage(row.usage);
      if (!usage) {
        return {
          ok: false,
          latencyMs: elapsed(),
          error: failure("jev_invalid_response", "The Jev response carried no usage."),
        };
      }
      return {
        ok: true,
        // The served version, which is what gets recorded. It can differ from
        // the requested id when an alias is used.
        model: typeof row.model === "string" && row.model.trim()
          ? row.model.trim().slice(0, 80)
          : (request.model ?? JEV_PINNED_MODEL),
        answers: decoded.answers,
        usage,
        latencyMs: elapsed(),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted;
      lastError = aborted
        ? failure("jev_timeout", "The Jev request timed out.", { retryable: true })
        : failure("jev_transient", scrub(`The Jev request failed: ${detail}`), {
          retryable: true,
        });
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, latencyMs: elapsed(), error: { ...lastError, message: scrub(lastError.message) } };
}
