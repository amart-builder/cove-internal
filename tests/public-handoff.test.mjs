import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every Markdown file the exporter ships, read out of the exporter's own
// allowlist rather than copied here. Listing four of them by hand left the
// rest -- OPERATIONS.md, DATA.md, SECURITY_AND_INTEGRATIONS.md and the others
// -- unguarded, so a home path or a developer name added to one of those
// would have reached a client checkout unnoticed. Deriving the list means a
// doc added to the allowlist is covered the day it is added.
function exportedMarkdownFiles() {
  const exporter = readFileSync(
    path.join(root, 'scripts/export-cove-client.mjs'),
    'utf8',
  );
  const block = exporter.match(/const rootFiles = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'export-cove-client.mjs no longer declares rootFiles');
  const files = [...block[1].matchAll(/"([^"]+\.md)"/g)].map(match => match[1]);
  assert.ok(files.length >= 8, `expected the exporter to ship docs, saw ${files.length}`);
  return files;
}

const handoffFiles = [...exportedMarkdownFiles(), 'scripts/install-cove-local.sh'];

test('the public agent handoff contains no developer identity or absolute home path', () => {
  for (const relativePath of handoffFiles) {
    const text = readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(text, /\/Users\/[A-Za-z0-9._-]+/i, relativePath);
    assert.doesNotMatch(text, /alexanderjmartin|alex(?:ander)? martin/i, relativePath);
    assert.doesNotMatch(text, /amart-builder\/cove-internal/i, relativePath);
  }
});

test('the public setup checks real release commands and keeps judgment shadowed', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const setup = readFileSync(path.join(root, 'SETUP.md'), 'utf8');
  const installer = readFileSync(path.join(root, 'scripts/install-cove-local.sh'), 'utf8');
  const verifyScript = readFileSync(path.join(root, 'scripts/cove-verify.mjs'), 'utf8');

  assert.equal(packageJson.scripts.verify, 'node scripts/cove-verify.mjs');
  assert.equal(
    packageJson.scripts['check:brief-writer'],
    'node scripts/cove-check-brief-writer.mjs',
  );
  assert.match(setup, /npm run verify/);
  assert.match(
    setup,
    /npm run check:brief-writer -- --expect-configured --expect-local-sources/,
  );
  assert.match(verifyScript, /process\.execPath/);
  assert.match(verifyScript, /path\.dirname\(process\.execPath\)/);
  assert.match(verifyScript, /"build", "--webpack"/);
  assert.doesNotMatch(verifyScript, /\["npx", \["tsx"/);
  assert.match(
    installer,
    /printf '%s\\n' '\{"shadow":true,"email_shadow":true\}' > "\$ATTENTION_CONFIG"/,
  );
});

test('the release gate runs the suite in the zone its fixtures were written in', () => {
  const verifyScript = readFileSync(path.join(root, 'scripts/cove-verify.mjs'), 'utf8');
  // SETUP.md Step 1 runs this gate and tells the setup agent not to start Cove
  // if it fails. Cove's wall-clock rules are asserted against fixed instants
  // written with a Pacific offset, so without a pinned zone eight tests in six
  // files fail on a Mac set to New York and a healthy install is stopped.
  // Both halves are pinned: the test step has to carry a zone, and the runner
  // has to pass a step's env through, since either alone does nothing.
  const testStep = verifyScript.match(
    /\[\s*process\.execPath,\s*\["--import", "tsx", "--test"[\s\S]*?\],\s*(\{[\s\S]*?\}),\s*\]/,
  );
  assert.ok(testStep, 'cove-verify.mjs no longer passes an environment to its test step');
  assert.match(
    testStep[1],
    /TZ: process\.env\.COVE_VERIFY_TZ \?\? "America\/Los_Angeles"/,
  );
  assert.match(verifyScript, /for \(const \[command, args, stepEnv\] of steps\)/);
  // The rule is that `stepEnv` comes last, not the exact shape of the object:
  // the runner also pins Next's telemetry off, and a later addition should not
  // fail this test as long as a step's own env still wins.
  assert.match(verifyScript, /env: \{ \.\.\.process\.env, PATH: childPath,[^}]*\.\.\.stepEnv \}/);
});

test('the public agent notes keep the client on the supported local runtime', () => {
  const contract = readFileSync(path.join(root, 'AGENT_CONTRACT.md'), 'utf8');
  assert.match(contract, /supported runtime is one local server and one local SQLite database/);
  assert.doesNotMatch(contract, /In a Supabase or Convex setup/);
});

// Cove has no uninstaller, so OPERATIONS.md's removal list is the only
// instruction for taking it off a Mac -- a client machine handed back, or a
// reinstall from clean. It was written once and then fell behind the
// installer: three of the places the installer writes outside the checkout
// were missing from it, including the hook it copies into ~/.claude/hooks and
// the per-lane logs. Each row below pins one location in both directions, so
// the list cannot quietly stop matching what an install leaves behind. A new
// location added to the installer needs a row here and a line there.
const REMOVAL_LOCATIONS = [
  {
    what: 'the LaunchAgent plists',
    installer: /LA_DIR="\$HOME\/Library\/LaunchAgents"/,
    doc: /~\/Library\/LaunchAgents\/com\.cove\.\*\.plist/,
  },
  {
    what: 'the per-lane logs',
    installer: /LOG_DIR="\$HOME\/Library\/Logs"/,
    doc: /~\/Library\/Logs\/cove\*\.log/,
  },
  {
    what: 'the notification app',
    installer: /NOTIFICATION_APP="\$HOME\/Applications\/Cove Notifications\.app"/,
    doc: /~\/Applications\/Cove Notifications\.app/,
  },
  {
    what: 'the agent skill folders',
    installer: /"\$HOME\/\.claude\/skills"/,
    doc: /~\/\.claude\/skills\/cove-\*/,
  },
  {
    what: 'the SessionStart hook script',
    installer: /HOOK_DIR="\$HOME\/\.claude\/hooks"/,
    doc: /~\/\.claude\/hooks\/cove-orchestrator\.sh/,
  },
  {
    what: 'the SessionStart settings entry',
    installer: /CLAUDE_SETTINGS="\$HOME\/\.claude\/settings\.json"/,
    doc: /~\/\.claude\/settings\.json/,
  },
  {
    what: 'the orchestrator session marker',
    installer: null,
    source: {
      file: 'scripts/hooks/cove-orchestrator.sh',
      pattern: /marker_file=\$\{HOME\}\/\.cove\/orchestrator-sessions/,
    },
    doc: /~\/\.cove\/orchestrator-sessions/,
  },
];

test('the removal instructions name every place Cove writes outside the checkout', () => {
  const operations = readFileSync(path.join(root, 'OPERATIONS.md'), 'utf8');
  const installer = readFileSync(
    path.join(root, 'scripts/install-cove-local.sh'),
    'utf8',
  );

  const removal = operations.match(/There is no uninstaller:[\s\S]*?Keychain and are removed there\./);
  assert.ok(removal, 'OPERATIONS.md no longer has a removal section to check');

  for (const location of REMOVAL_LOCATIONS) {
    if (location.installer) {
      assert.match(installer, location.installer, `installer no longer writes ${location.what}`);
    }
    if (location.source) {
      const text = readFileSync(path.join(root, location.source.file), 'utf8');
      assert.match(text, location.source.pattern, `${location.source.file} no longer writes ${location.what}`);
    }
    assert.match(removal[0], location.doc, `removal instructions omit ${location.what}`);
  }
});

test('the removal instructions send someone to the disabled-service list', () => {
  const operations = readFileSync(path.join(root, 'OPERATIONS.md'), 'utf8');
  const stop = readFileSync(path.join(root, 'scripts/cove-stop.sh'), 'utf8');

  // A disable override is stored against the user account, not the plist, so
  // it is the one leftover nothing else surfaces: the lane never runs and so
  // never files a failure. cove-stop.sh --status reads the same list.
  assert.match(stop, /launchctl print-disabled/);
  assert.match(operations, /launchctl print-disabled gui\/\$\(id -u\) \| grep com\.cove/);
});
