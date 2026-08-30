import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoveEnvironment } from "../env";
import { readCoveEmailSettings } from "./settings";

export const VOICE_GUIDE_MAX_CHARS = 12_000;
export const VOICE_FINGERPRINT_SEPARATOR =
  "Measured voice fingerprint (overrides generic style advice):";

function optionalText(file: string | null | undefined): string {
  if (!file) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function readVoiceFingerprint(
  file: string | null | undefined,
  maxChars = VOICE_GUIDE_MAX_CHARS,
): string {
  return optionalText(file).slice(0, maxChars);
}

export function readEmailVoiceGuide(options: {
  dataDir: string;
  baseGuidePath?: string;
  env?: CoveEnvironment;
}): string {
  const base = optionalText(
    options.baseGuidePath ?? path.join(os.homedir(), ".claude", "voice.md"),
  ).slice(0, VOICE_GUIDE_MAX_CHARS);
  const settings = readCoveEmailSettings({
    dataDir: options.dataDir,
    env: options.env,
  });
  const fingerprint = readVoiceFingerprint(settings.voiceFingerprintPath);
  if (!fingerprint || base.length >= VOICE_GUIDE_MAX_CHARS) return base;
  const prefix = `${base ? "\n\n" : ""}${VOICE_FINGERPRINT_SEPARATOR}\n`;
  const remaining = VOICE_GUIDE_MAX_CHARS - base.length;
  if (prefix.length >= remaining) return base;
  return `${base}${prefix}${fingerprint.slice(0, remaining - prefix.length)}`;
}
