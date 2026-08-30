import { readFileSync } from "node:fs";
import { coveConfigPath, coveEnvTrimmed, type CoveEnvironment } from "../env";

export type CoveEmailSettings = {
  voiceFingerprintPath: string | null;
  voiceReview: {
    enabled: boolean;
    judgeEnabled: boolean;
  };
};

export const DEFAULT_EMAIL_SETTINGS: CoveEmailSettings = {
  voiceFingerprintPath: null,
  voiceReview: {
    enabled: false,
    judgeEnabled: false,
  },
};

function fileSettings(dataDir: string): CoveEmailSettings {
  try {
    const value = JSON.parse(
      readFileSync(coveConfigPath(dataDir, "email.json"), "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return DEFAULT_EMAIL_SETTINGS;
    }
    const row = value as Record<string, unknown>;
    const review = row.voiceReview &&
        typeof row.voiceReview === "object" &&
        !Array.isArray(row.voiceReview)
      ? row.voiceReview as Record<string, unknown>
      : {};
    return {
      voiceFingerprintPath:
        typeof row.voiceFingerprintPath === "string" && row.voiceFingerprintPath.trim()
          ? row.voiceFingerprintPath.trim()
          : null,
      voiceReview: {
        enabled: review.enabled === true,
        judgeEnabled: review.judgeEnabled === true,
      },
    };
  } catch {
    return DEFAULT_EMAIL_SETTINGS;
  }
}

export function readCoveEmailSettings(options: {
  dataDir: string;
  env?: CoveEnvironment;
}): CoveEmailSettings {
  const env = options.env ?? process.env;
  const stored = fileSettings(options.dataDir);
  const fingerprintOverride = coveEnvTrimmed("VOICE_FINGERPRINT_PATH", env);
  const reviewOverride = coveEnvTrimmed("VOICE_REVIEW", env);
  const judgeOverride = coveEnvTrimmed("VOICE_JUDGE", env);
  return {
    voiceFingerprintPath: fingerprintOverride ?? stored.voiceFingerprintPath,
    voiceReview: {
      enabled: reviewOverride === undefined
        ? stored.voiceReview.enabled
        : reviewOverride === "1",
      judgeEnabled: judgeOverride === undefined
        ? stored.voiceReview.judgeEnabled
        : judgeOverride === "1",
    },
  };
}
