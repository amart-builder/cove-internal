/**
 * Jev is off until someone turns it on, and off is the shape a fresh install
 * ships in. Reading these settings never enables anything by itself: a lane
 * runs only when the mode allows it, the feature is named, and a credential is
 * present in the environment.
 *
 * The credential is read from the environment and nowhere else. It is never
 * written to cove-jev.json, never returned by a settings reader that something
 * might log, and never passed into a Claude or Codex child process.
 */
import { readFileSync } from "node:fs";
import { coveConfigPath, coveEnvTrimmed, type CoveEnvironment } from "../env";

/**
 * off     nothing calls TypeSafe.
 * shadow  Jev is asked and its answer is recorded, and it changes nothing the
 *         operator sees. This is the evidence that decides whether a feature
 *         ever earns the right to act.
 * assist  a promoted feature may annotate work that an existing owner already
 *         controls. It still may not create, complete, defer or retire
 *         anything.
 */
export type JevMode = "off" | "shadow" | "assist";

/**
 * emailTriage      the bucket, urgency, charge and reply judgments that ride
 *                  inside Cove's one frontier classification call today.
 * commitmentAudit  whether a quote Cove already grounded in the source text
 *                  actually states an obligation, and whose it is.
 * meetingAudit     whether the tasks and waiting-on rows the meeting analyst
 *                  wrote are supported by the notes, still outstanding, agreed
 *                  rather than floated, and owed by who the analyst says.
 *
 * The first two read the same email, so both ride in one request. Jev evaluates
 * every question in a batch against the same state in parallel, and only input
 * tokens are billed, so the second feature costs a rounding error on top of the
 * first. The third reads a meeting instead and rides in its own request, once
 * per analysed meeting rather than once per item.
 */
export type JevFeature = "emailTriage" | "commitmentAudit" | "meetingAudit";

export const JEV_FEATURES: readonly JevFeature[] = [
  "emailTriage",
  "commitmentAudit",
  "meetingAudit",
];

export type JevLimits = {
  attemptsPerHour: number;
  attemptsPerDay: number;
  /**
   * An operational ceiling Cove enforces on its own reserved estimate, not a
   * promise about what TypeSafe will invoice.
   */
  dailySpendUsd: number;
  maxConcurrent: number;
};

export type JevSettings = {
  mode: JevMode;
  features: Record<JevFeature, boolean>;
  model: string;
  limits: JevLimits;
  /** Days of per-assessment detail to keep before pruning to counts only. */
  assessmentRetentionDays: number;
  /** Days of usage and outcome metadata to keep. */
  usageRetentionDays: number;
};

export const DEFAULT_JEV_LIMITS: JevLimits = {
  attemptsPerHour: 120,
  attemptsPerDay: 800,
  dailySpendUsd: 1,
  maxConcurrent: 2,
};

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  mode: "off",
  features: { emailTriage: false, commitmentAudit: false, meetingAudit: false },
  model: "jev-1.13.0",
  limits: DEFAULT_JEV_LIMITS,
  assessmentRetentionDays: 30,
  usageRetentionDays: 90,
};

/** Published input rate, $0.042 per million tokens. Output is not billed. */
export const JEV_INPUT_USD_PER_MILLION_TOKENS = 0.042;

export function estimateJevCostUsd(inputTokens: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return 0;
  return (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MILLION_TOKENS;
}

function isMode(value: unknown): value is JevMode {
  return value === "off" || value === "shadow" || value === "assist";
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function positiveNumber(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function fileSettings(dataDir: string): JevSettings {
  try {
    const value = JSON.parse(
      readFileSync(coveConfigPath(dataDir, "jev.json"), "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return DEFAULT_JEV_SETTINGS;
    }
    const row = value as Record<string, unknown>;
    const features = row.features && typeof row.features === "object" &&
        !Array.isArray(row.features)
      ? row.features as Record<string, unknown>
      : {};
    const limits = row.limits && typeof row.limits === "object" && !Array.isArray(row.limits)
      ? row.limits as Record<string, unknown>
      : {};
    return {
      mode: isMode(row.mode) ? row.mode : DEFAULT_JEV_SETTINGS.mode,
      features: {
        // Anything not written as exactly true stays off.
        emailTriage: features.emailTriage === true,
        commitmentAudit: features.commitmentAudit === true,
        meetingAudit: features.meetingAudit === true,
      },
      model: typeof row.model === "string" && row.model.trim()
        ? row.model.trim().slice(0, 80)
        : DEFAULT_JEV_SETTINGS.model,
      limits: {
        attemptsPerHour: positiveInteger(
          limits.attemptsPerHour,
          DEFAULT_JEV_LIMITS.attemptsPerHour,
          10_000,
        ),
        attemptsPerDay: positiveInteger(
          limits.attemptsPerDay,
          DEFAULT_JEV_LIMITS.attemptsPerDay,
          100_000,
        ),
        dailySpendUsd: positiveNumber(
          limits.dailySpendUsd,
          DEFAULT_JEV_LIMITS.dailySpendUsd,
          100,
        ),
        maxConcurrent: positiveInteger(
          limits.maxConcurrent,
          DEFAULT_JEV_LIMITS.maxConcurrent,
          16,
        ),
      },
      assessmentRetentionDays: positiveInteger(
        row.assessmentRetentionDays,
        DEFAULT_JEV_SETTINGS.assessmentRetentionDays,
        365,
      ),
      usageRetentionDays: positiveInteger(
        row.usageRetentionDays,
        DEFAULT_JEV_SETTINGS.usageRetentionDays,
        365,
      ),
    };
  } catch {
    return DEFAULT_JEV_SETTINGS;
  }
}

export function readJevSettings(options: {
  dataDir: string;
  env?: CoveEnvironment;
}): JevSettings {
  const env = options.env ?? process.env;
  const stored = fileSettings(options.dataDir);
  const modeOverride = coveEnvTrimmed("JEV_MODE", env);
  const triageOverride = coveEnvTrimmed("JEV_EMAIL_TRIAGE", env);
  const auditOverride = coveEnvTrimmed("JEV_COMMITMENT_AUDIT", env);
  const meetingOverride = coveEnvTrimmed("JEV_MEETING_AUDIT", env);
  return {
    ...stored,
    mode: isMode(modeOverride) ? modeOverride : stored.mode,
    features: {
      emailTriage: triageOverride === undefined
        ? stored.features.emailTriage
        : triageOverride === "1",
      commitmentAudit: auditOverride === undefined
        ? stored.features.commitmentAudit
        : auditOverride === "1",
      meetingAudit: meetingOverride === undefined
        ? stored.features.meetingAudit
        : meetingOverride === "1",
    },
  };
}

/**
 * The credential, or undefined. Callers treat undefined as "this lane does not
 * run", never as an error worth surfacing to the operator, because not having
 * configured Jev is the normal state of a Cove install.
 */
export function readJevCredential(env: CoveEnvironment = process.env): string | undefined {
  return coveEnvTrimmed("TYPESAFE_API_KEY", env);
}

export function jevFeatureEnabled(
  settings: JevSettings,
  feature: JevFeature,
  env: CoveEnvironment = process.env,
): boolean {
  if (settings.mode === "off") return false;
  if (!settings.features[feature]) return false;
  return Boolean(readJevCredential(env));
}
