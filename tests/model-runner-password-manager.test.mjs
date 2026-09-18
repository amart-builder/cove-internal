import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexPasswordManagerOverrides, createCodexJobAttempt } from '../src/lib/model-runner-runtime.mjs';

const missing = "Error: No MCP server named '1password' found.\n";

test('absent password manager stays absent, including CLI startup warnings', () => {
  for (const stderr of [missing, `WARNING: PATH aliases unavailable\n${missing}`]) {
    assert.deepEqual(codexPasswordManagerOverrides({ executable: 'codex', probe: () => ({ status: 1, stderr }) }), []);
  }
});

test('configured password manager is disabled using the same environment and workspace', () => {
  const env = { HOME: '/operator', CODEX_HOME: '/isolated', PATH: '/bin', COVE_PRIVATE: 'not-for-child' };
  const actual = codexPasswordManagerOverrides({ executable: 'codex', cwd: '/private-workspace', env,
    probe: (executable, args, options) => {
      assert.equal(executable, 'codex');
      assert.deepEqual(args, ['mcp', 'get', '1password', '--json']);
      assert.equal(options.cwd, '/private-workspace');
      assert.equal(options.env.CODEX_HOME, '/isolated');
      assert.equal(options.env.HOME, '/operator');
      assert.equal(options.env.COVE_PRIVATE, undefined);
      assert.equal(options.timeout, 5000);
      return { status: 0, stdout: JSON.stringify({ name: '1password', env: { SECRET: 'private-value' } }) };
    },
  });
  assert.deepEqual(actual, ['-c', 'mcp_servers.1password.enabled=false']);
});

test('configuration errors fail closed, redact diagnostics and clean temporary workspace', () => {
  for (const result of [
    { status: 1, stderr: 'invalid config private-value' },
    { status: null, error: new Error('timed out private-value'), stderr: missing },
    { status: 0, stdout: 'private-value' },
    { status: 0, stdout: '{"name":"other"}' },
  ]) {
    let cwd;
    assert.throws(() => createCodexJobAttempt({ executable: process.execPath, prompt: 'synthetic',
      codexConfigProbe: (_executable, _args, options) => { cwd = options.cwd; return result; },
    }), error => {
      assert.match(error.message, /could not verify/);
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
    assert.equal(existsSync(cwd), false);
  }
});

test('installed Codex accepts absent, stdio and HTTP configs without modifying them', {
  skip: !process.env.COVE_TEST_CODEX_BIN && 'Set COVE_TEST_CODEX_BIN for the offline CLI integration check',
}, t => {
  const executable = process.env.COVE_TEST_CODEX_BIN;
  for (const config of ['',
    '[mcp_servers.1password]\ncommand="/usr/bin/false"\n',
    '[mcp_servers."1password"]\nurl="https://example.invalid/mcp"\n',
  ]) {
    const home = mkdtempSync(path.join(os.tmpdir(), 'cove-password-config-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const configPath = path.join(home, 'config.toml');
    const saved = config + '\n[mcp_servers.unrelated]\ncommand="/usr/bin/false"\nenabled=false\n';
    writeFileSync(configPath, saved);
    const env = { HOME: home, CODEX_HOME: home, PATH: process.env.PATH };
    const attempt = createCodexJobAttempt({ executable, env, prompt: 'synthetic' });
    try {
      const index = attempt.command.args.indexOf('mcp_servers.1password.enabled=false');
      const overrides = index < 0 ? [] : attempt.command.args.slice(index - 1, index + 1);
      const result = spawnSync(executable, [...overrides, 'mcp', 'list', '--json'], {
        cwd: attempt.command.cwd, env, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      const servers = JSON.parse(result.stdout);
      const password = servers.find(server => server.name === '1password');
      if (config) assert.equal(password.enabled, false);
      else { assert.equal(password, undefined); assert.equal(index, -1); }
      assert.ok(servers.some(server => server.name === 'unrelated'));
      assert.equal(readFileSync(configPath, 'utf8'), saved);
    } finally { attempt.cleanup(); }
  }
});
