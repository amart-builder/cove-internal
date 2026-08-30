import { runJob, type RunJobResult } from "../model-runner";

export const VOICE_JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "verdict"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    verdict: { type: "string", maxLength: 300 },
  },
} as const;

export type VoiceJudgeResult = {
  score: number;
  verdict: string;
};

export function buildVoiceJudgePrompt(
  fingerprint: string,
  draftBody: string,
): string {
  return [
    "Act as a fresh forensic reader. You have no conversation history and no other context.",
    "Given only the measured writing fingerprint and the email draft below, judge how likely it is that the person described by the fingerprint wrote the draft.",
    "Return a score from 0 to 100 and a short verdict. In the verdict, name the single most betraying line from the draft.",
    "Do not edit the draft and do not judge its factual content.",
    "",
    "<measured_voice_fingerprint>",
    fingerprint.slice(0, 12_000),
    "</measured_voice_fingerprint>",
    "",
    "<email_draft>",
    draftBody.slice(0, 100_000),
    "</email_draft>",
  ].join("\n");
}

function validJudgeValue(value: unknown): VoiceJudgeResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !Number.isInteger(row.score) ||
    Number(row.score) < 0 ||
    Number(row.score) > 100 ||
    typeof row.verdict !== "string"
  ) return null;
  const verdict = row.verdict.trim().slice(0, 300);
  return verdict ? { score: Number(row.score), verdict } : null;
}

export async function judgeDraftVoice(input: {
  fingerprint: string;
  draftBody: string;
  repoDir?: string;
  runJobImpl?: typeof runJob;
}): Promise<VoiceJudgeResult | null> {
  const abort = AbortSignal.timeout(90_000);
  let result: RunJobResult;
  try {
    result = await (input.runJobImpl ?? runJob)({
      lane: "voice-judge",
      kind: "structured",
      prompt: buildVoiceJudgePrompt(input.fingerprint, input.draftBody),
      schema: VOICE_JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs: 85_000,
      abortSignal: abort,
      cwd: input.repoDir,
      claudeMaxBudgetUsd: "0.50",
    });
  } catch {
    return null;
  }
  return result.ok ? validJudgeValue(result.value) : null;
}
