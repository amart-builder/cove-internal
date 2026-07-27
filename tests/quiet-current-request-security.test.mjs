import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getForgeAllowedHosts,
  isTrustedRequestOrigin,
} from '../src/lib/request-security.ts';

test('accepts the browser host when Next uses a different bind hostname', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'http://127.0.0.1:3411',
      host: '127.0.0.1:3411',
      requestProtocol: 'http:',
      allowedHosts: ['127.0.0.1'],
    }),
    true,
  );
});

test('accepts a public proxy host and protocol', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'https://forge.example.com',
      host: 'localhost:3200',
      forwardedHost: 'forge.example.com',
      forwardedProto: 'https',
      requestProtocol: 'http:',
      allowedHosts: ['forge.example.com'],
      trustProxy: true,
    }),
    true,
  );
});

test('ignores forwarded host and protocol unless proxy trust is explicit', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'https://forge.example.com',
      host: 'localhost:3200',
      forwardedHost: 'forge.example.com',
      forwardedProto: 'https',
      requestProtocol: 'http:',
      allowedHosts: ['forge.example.com'],
    }),
    false,
  );
});

test('rejects cross-origin, invalid, and protocol-mismatched requests', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'https://evil.example',
      host: 'forge.example.com',
      requestProtocol: 'https:',
      allowedHosts: ['forge.example.com'],
    }),
    false,
  );
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'not a URL',
      host: 'forge.example.com',
      requestProtocol: 'https:',
      allowedHosts: ['forge.example.com'],
    }),
    false,
  );
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'http://forge.example.com',
      forwardedHost: 'forge.example.com',
      forwardedProto: 'https',
      allowedHosts: ['forge.example.com'],
      trustProxy: true,
    }),
    false,
  );
});

test('allows non-browser clients only on a trusted host', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: null,
      host: 'forge.example.com',
      requestProtocol: 'https:',
      allowedHosts: ['forge.example.com'],
    }),
    true,
  );
  assert.equal(
    isTrustedRequestOrigin({
      origin: null,
      host: 'evil.example',
      requestProtocol: 'https:',
      allowedHosts: ['forge.example.com'],
    }),
    false,
  );
});

test('rejects DNS rebinding and literal null origins', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'http://evil.example:3200',
      host: 'evil.example:3200',
      requestProtocol: 'http:',
      allowedHosts: ['localhost', '127.0.0.1'],
    }),
    false,
  );
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'null',
      host: 'forge.example.com',
      requestProtocol: 'https:',
      allowedHosts: ['forge.example.com'],
    }),
    false,
  );
});

test('configured ports stay exact while loopback names accept any port', () => {
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'https://forge.example.com:444',
      host: 'forge.example.com:444',
      requestProtocol: 'https:',
      allowedHosts: ['forge.example.com:443'],
    }),
    false,
  );
  assert.equal(
    isTrustedRequestOrigin({
      origin: 'http://localhost:3411',
      host: 'localhost:3411',
      requestProtocol: 'http:',
      allowedHosts: ['localhost'],
    }),
    true,
  );
});

test('builds the server allowlist from existing Forge setup variables', () => {
  assert.deepEqual(
    getForgeAllowedHosts({
      FORGE_PUBLIC_URL: 'https://forge.example.com:443/tasks',
      FORGE_TAILSCALE_TRUSTED_HOSTS: 'mini.example.ts.net, backup.example.ts.net:3200',
    }),
    [
      'localhost',
      '127.0.0.1',
      '[::1]',
      'https://forge.example.com:443/tasks',
      'mini.example.ts.net',
      'backup.example.ts.net:3200',
    ],
  );
});
