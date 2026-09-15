import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coveEnvTrimmed } from '../../src/lib/env-runtime.mjs';
import { loadCoveRuntimePaths } from './cove-runtime-paths.mjs';

// Installation explicitly pairs a selected local database with its web server.
// Merely selecting a scratch data directory never grants that pairing at runtime.
export function resolveInstallRuntime(repoDir, env = process.env) {
  const settings = { ...env };
  const paths = loadCoveRuntimePaths(repoDir, settings);
  let value = coveEnvTrimmed('BRIEF_WEB_BASE', settings);
  // Preserve the older explicit meeting endpoint when adopting the shared setting.
  const workspacePath = path.join(paths.dataDir, 'cove-workspace.json');
  if (!value && existsSync(workspacePath)) {
    const legacy = JSON.parse(readFileSync(workspacePath, 'utf8')).cove_url;
    if (typeof legacy === 'string' && legacy.trim()) value = legacy.trim();
  }
  value ??= 'http://127.0.0.1:3200';
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('COVE_BRIEF_WEB_BASE must be an HTTP loopback origin without a path, credentials, query or fragment.');
  }
  return { ...paths, webBase: url.origin, host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || '80' };
}

export function persistInstallRuntime(repoDir, runtime) {
  const file = path.join(repoDir, '.env.local');
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const values = { COVE_DATA_DIR: runtime.dataDir, COVE_DB_PATH: runtime.dbPath, COVE_BRIEF_WEB_BASE: runtime.webBase };
  const quote = value => {
    if (/[\r\n]/.test(value)) throw new Error('Installed runtime paths cannot contain newlines.');
    if (!value.includes("'")) return `'${value}'`;
    if (!/["\\]/.test(value)) return `"${value}"`;
    throw new Error('Installed runtime path cannot be represented safely in .env.local.');
  };
  const remaining = new Set(Object.keys(values));
  const lines = original.split(/\r?\n/).map(line => {
    const key = /^\s*(COVE_DATA_DIR|COVE_DB_PATH|COVE_BRIEF_WEB_BASE)\s*=/.exec(line)?.[1];
    if (!key) return line;
    remaining.delete(key);
    return `${key}=${quote(values[key])}`;
  });
  for (const key of remaining) lines.push(`${key}=${quote(values[key])}`);
  const text = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  if (text === original) return;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repoDir, field] = process.argv.slice(2);
  if (!repoDir || !['dataDir', 'dbPath', 'backupDir', 'webBase', 'host', 'port', '--save'].includes(field)) {
    throw new Error('Usage: cove-install-runtime.mjs <repo> dataDir|dbPath|backupDir|webBase|host|port|--save');
  }
  const runtime = resolveInstallRuntime(repoDir);
  if (field === '--save') persistInstallRuntime(repoDir, runtime);
  else process.stdout.write(runtime[field]);
}
