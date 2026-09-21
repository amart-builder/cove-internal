/**
 * A hand-edited meeting config that will not parse must say so in words the
 * person can act on.
 *
 * Every other message this loader raises is product copy. The parse was
 * unguarded, so a trailing comma raised `Unexpected token }` and the meeting
 * lane recorded that, alongside sentences written for a person.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { loadMeetingDetectionConfig } = require("../src/lib/intake/meeting-detection.ts");

function configFile(t, contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "cove-meeting-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cove-meetings.json");
  writeFileSync(file, contents);
  return file;
}

test("a config with a trailing comma is reported in the loader's own voice", (t) => {
  const file = configFile(t, '{\n  "enabled": true,\n  "active_tools": ["granola"],\n}\n');
  let thrown;
  try {
    loadMeetingDetectionConfig(file);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "the config is still refused");
  assert.match(thrown.message, /cove-meetings\.json could not be read as JSON/);
  assert.match(thrown.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(/Unexpected token|JSON\.parse|is not valid JSON/.test(thrown.message), false);
});

test("a config that parses is still checked for what it must contain", (t) => {
  const missing = configFile(t, JSON.stringify({
    active_tools: ["granola"],
    window: "newer_than:4d",
    processed_label: "Cove/Meeting-Processed",
  }));
  assert.throws(
    () => loadMeetingDetectionConfig(missing),
    /cove-meetings\.json is missing enabled\./,
  );
  const valid = configFile(t, JSON.stringify({
    enabled: true,
    active_tools: ["granola"],
    window: "newer_than:4d",
    processed_label: "Cove/Meeting-Processed",
  }));
  assert.equal(loadMeetingDetectionConfig(valid).enabled, true);
});
