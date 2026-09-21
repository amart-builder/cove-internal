import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { retargetSkillBaseUrl, SKILL_DEFAULT_BASE } from "../scripts/lib/retarget-skill-base.mjs";
import { renderBuddyInstructionDoc } from "../src/lib/buddy/commands.ts";

const ROOT = process.cwd();
const SKILLS_SRC = path.join(ROOT, "skills");

function installedSkills(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-agent-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Exactly what install-cove-local.sh lays down: every cove-* skill copied
  // verbatim, plus the bundled humanizer.
  for (const entry of readdirSync(SKILLS_SRC)) {
    cpSync(path.join(SKILLS_SRC, entry), path.join(dir, entry), { recursive: true });
  }
  return dir;
}

// Counted, never hardcoded. The shipped client leaves out cove-pipeline, so a
// fixed threshold passed in the repository and failed in the tree Gary
// installs -- finding 48's shape again, a test encoding its own environment.
function filesNamingDefault(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (readFileSync(file, "utf8").includes(SKILL_DEFAULT_BASE)) count += 1;
  }
  return count;
}

function skillText(dir) {
  return readdirSync(dir)
    .filter((entry) => entry.startsWith("cove-"))
    .map((entry) => readFileSync(path.join(dir, entry, "SKILL.md"), "utf8"))
    .join("\n");
}

test("an install that took another port gets skills that point at it", (t) => {
  const dir = installedSkills(t);
  assert.match(skillText(dir), /http:\/\/localhost:3200/, "the repository copy names the default port");
  const naming = filesNamingDefault(dir);

  const result = retargetSkillBaseUrl(dir, "http://127.0.0.1:3201");

  const text = skillText(dir);
  assert.doesNotMatch(text, /http:\/\/localhost:3200/, "no curl may still be aimed at the default port");
  assert.match(text, /http:\/\/127\.0\.0\.1:3201\/api\/cove-rest\/tasks/);
  assert.match(text, /http:\/\/127\.0\.0\.1:3201\/api\/crm/);
  assert.match(text, /http:\/\/127\.0\.0\.1:3201\/api\/quiet-current/);
  assert.equal(
    result.files,
    naming,
    `every file naming the default port should be retargeted; ${result.files} of ${naming} were`,
  );
  assert.ok(
    result.replacements >= result.files,
    `${result.replacements} replacements across ${result.files} files`,
  );
});

test("only the Cove skills are rewritten, and an ordinary install is untouched", (t) => {
  const dir = installedSkills(t);
  mkdirSync(path.join(dir, "personal-notes"), { recursive: true });
  const personal = path.join(dir, "personal-notes", "SKILL.md");
  writeFileSync(personal, `Ask ${SKILL_DEFAULT_BASE}/api/cove-rest/tasks for my own reasons.\n`);
  const humanizer = path.join(dir, "humanizer", "SKILL.md");
  const humanizerBefore = readFileSync(humanizer, "utf8");
  const defaultText = skillText(dir);

  retargetSkillBaseUrl(dir, "http://localhost:3202");

  assert.equal(readFileSync(personal, "utf8"), `Ask ${SKILL_DEFAULT_BASE}/api/cove-rest/tasks for my own reasons.\n`);
  assert.equal(readFileSync(humanizer, "utf8"), humanizerBefore);

  const again = installedSkills(t);
  retargetSkillBaseUrl(again, SKILL_DEFAULT_BASE);
  assert.equal(skillText(again), defaultText, "the default install is left byte for byte as shipped");
});

test("a base URL that is not a loopback origin is refused rather than written in", (t) => {
  const dir = installedSkills(t);
  for (const bad of [
    "https://cove.example.com",
    "http://cove.example.com:3200",
    "http://127.0.0.1:3200/tasks",
    "http://user:pass@127.0.0.1:3200",
  ]) {
    assert.throws(() => retargetSkillBaseUrl(dir, bad), /loopback origin/);
  }
  assert.match(skillText(dir), /http:\/\/localhost:3200/);
});

test("the installer retargets the skills it just copied", () => {
  const installer = readFileSync(path.join(ROOT, "scripts", "install-cove-local.sh"), "utf8");
  assert.match(
    installer,
    /cp -R "\$skill_dir" "\$agent_skills\/"[\s\S]{0,600}retarget-skill-base\.mjs" "\$agent_skills" "\$COVE_BRIEF_WEB_BASE"/,
    "the copy step must be followed by the retarget, using the port this install resolved",
  );
});

test("Buddy tells the operator the address this install actually serves", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-buddy-doc-"));
  const prior = process.env.COVE_BRIEF_WEB_BASE;
  t.after(() => {
    if (prior === undefined) delete process.env.COVE_BRIEF_WEB_BASE;
    else process.env.COVE_BRIEF_WEB_BASE = prior;
    rmSync(dir, { recursive: true, force: true });
  });

  process.env.COVE_BRIEF_WEB_BASE = "http://127.0.0.1:3201";
  const home = renderBuddyInstructionDoc({ dataDir: dir, workspaceRoot: null });
  const rendered = readFileSync(path.join(home, "CLAUDE.md"), "utf8");
  assert.match(rendered, /command center at http:\/\/127\.0\.0\.1:3201\./);
  // 32000 is the max-chars ceiling a few paragraphs down, so match the port itself.
  assert.doesNotMatch(rendered, /:3200(?!\d)/);

  // The rendered doc is cached by a hash of its inputs, so the address has to be
  // one of them or a reinstall on a new port keeps serving the old sentence.
  delete process.env.COVE_BRIEF_WEB_BASE;
  const second = readFileSync(
    path.join(renderBuddyInstructionDoc({ dataDir: dir, workspaceRoot: null }), "CLAUDE.md"),
    "utf8",
  );
  assert.match(second, /command center at http:\/\/localhost:3200\./);
});
