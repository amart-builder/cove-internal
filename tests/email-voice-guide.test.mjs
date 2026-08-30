import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEmailClassifierPrompt } from "../src/lib/email/classifier.ts";
import { readCoveEmailSettings } from "../src/lib/email/settings.ts";
import {
  readEmailVoiceGuide,
  VOICE_FINGERPRINT_SEPARATOR,
  VOICE_GUIDE_MAX_CHARS,
} from "../src/lib/email/voice-guide.ts";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-email-voice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("voice guide appends the measured fingerprint under the trusted separator", async (t) => {
  const dir = await fixture(t);
  const basePath = path.join(dir, "voice.md");
  const fingerprintPath = path.join(dir, "fingerprint.md");
  await writeFile(basePath, "Write plainly.");
  await writeFile(fingerprintPath, "Median reply: 47 words. Usually opens with Hi.");
  await writeFile(path.join(dir, "cove-email.json"), JSON.stringify({
    voiceFingerprintPath: fingerprintPath,
    voiceReview: { enabled: false, judgeEnabled: false },
  }));

  const guide = readEmailVoiceGuide({ dataDir: dir, baseGuidePath: basePath });
  assert.equal(
    guide,
    `Write plainly.\n\n${VOICE_FINGERPRINT_SEPARATOR}\nMedian reply: 47 words. Usually opens with Hi.`,
  );

  const prompt = buildEmailClassifierPrompt({
    accountEmail: "alex@example.com",
    sender: "Pat <pat@example.com>",
    subject: "Quick question",
    text: "Can you review this?",
    voice: guide,
  });
  assert.match(prompt, /Median reply: 47 words/);
  assert.match(
    prompt,
    /measured habits for length, greeting, and punctuation override any generic style instruction/,
  );
});

test("fingerprint truncation never removes the base guide", async (t) => {
  const dir = await fixture(t);
  const basePath = path.join(dir, "voice.md");
  const fingerprintPath = path.join(dir, "fingerprint.md");
  const base = "b".repeat(11_800);
  await writeFile(basePath, base);
  await writeFile(fingerprintPath, "f".repeat(2_000));
  await writeFile(path.join(dir, "cove-email.json"), JSON.stringify({
    voiceFingerprintPath: fingerprintPath,
  }));

  const guide = readEmailVoiceGuide({ dataDir: dir, baseGuidePath: basePath });
  assert.equal(guide.length, VOICE_GUIDE_MAX_CHARS);
  assert.equal(guide.slice(0, base.length), base);
  assert.ok(guide.includes(VOICE_FINGERPRINT_SEPARATOR));
});

test("an unreadable fingerprint silently falls back to the base guide", async (t) => {
  const dir = await fixture(t);
  const basePath = path.join(dir, "voice.md");
  await writeFile(basePath, "Keep this guide intact.");
  await writeFile(path.join(dir, "cove-email.json"), JSON.stringify({
    voiceFingerprintPath: path.join(dir, "missing-fingerprint.md"),
  }));
  assert.equal(
    readEmailVoiceGuide({ dataDir: dir, baseGuidePath: basePath }),
    "Keep this guide intact.",
  );
});

test("voice environment settings override the private email config", async (t) => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, "cove-email.json"), JSON.stringify({
    voiceFingerprintPath: "/stored/fingerprint.md",
    voiceReview: { enabled: true, judgeEnabled: false },
  }));
  assert.deepEqual(readCoveEmailSettings({
    dataDir: dir,
    env: {
      COVE_VOICE_FINGERPRINT_PATH: " /env/fingerprint.md ",
      COVE_VOICE_REVIEW: "0",
      COVE_VOICE_JUDGE: "1",
    },
  }), {
    voiceFingerprintPath: "/env/fingerprint.md",
    voiceReview: { enabled: false, judgeEnabled: true },
  });
});
