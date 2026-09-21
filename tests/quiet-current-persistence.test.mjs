import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { pathToFileURL } from 'node:url';
import { transactQuietCurrent } from '../src/lib/quiet-current/persistence.ts';
import { createWorkSuggestion, getQuietCurrentSnapshot, setQuietCurrentStorePathForTests } from '../src/lib/quiet-current/store.ts';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-qc-persistence-'));
  const file = path.join(dir, 'quiet-current.json');
  setQuietCurrentStorePathForTests(file);
  t.after(() => {
    setQuietCurrentStorePathForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, database: `${file}.sqlite` };
}

const empty = () => ({ version: 1, suggestions: [], decisionEvents: [] });

test('legacy import preserves exact bytes, imports once, and detects older writers', (t) => {
  const { dir, file } = fixture(t);
  const original = JSON.stringify(empty(), null, 2) + '\n';
  writeFileSync(file, original);
  const item = createWorkSuggestion({ title: 'Follow up', reason: 'A promise', source: 'test' });
  assert.equal(getQuietCurrentSnapshot().suggestions[0].id, item.id);
  assert.equal(readFileSync(file, 'utf8'), original);
  const backups = readdirSync(dir).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(dir, backups[0]), 'utf8'), original);
  writeFileSync(file, original + '\n');
  assert.throws(() => getQuietCurrentSnapshot(), /legacy file changed after migration/);
  writeFileSync(file, original);
  assert.equal(getQuietCurrentSnapshot().suggestions[0].id, item.id);
});

test('malformed legacy data fails without overwriting it and can be repaired', (t) => {
  const { dir, file } = fixture(t);
  const invalid = JSON.stringify({ version: 1, suggestions: [{ id: 'broken' }], decisionEvents: [] });
  writeFileSync(file, invalid);
  assert.throws(() => getQuietCurrentSnapshot(), /unsupported shape/);
  assert.equal(readFileSync(file, 'utf8'), invalid);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.bak')).length, 0);
  writeFileSync(file, JSON.stringify(empty()));
  assert.equal(getQuietCurrentSnapshot().suggestions.length, 0);
});

test('a failed operation rolls back state and its decision events together', (t) => {
  const { file, database } = fixture(t);
  getQuietCurrentSnapshot();
  assert.throws(() => transactQuietCurrent(database, file, empty, state => {
    state.decisionEvents.push({ id: 'should-not-survive', eventType: 'test', createdAt: new Date().toISOString() });
    throw new Error('interrupted');
  }), /interrupted/);
  assert.deepEqual(getQuietCurrentSnapshot(), empty());
});

test('separate processes retain every suggestion and deduplicate a shared claim', async (t) => {
  const { file } = fixture(t);
  const moduleUrl = pathToFileURL(path.resolve('src/lib/quiet-current/store.ts')).href;
  // Start on a fresh database: this also exercises concurrent migration.
  await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
    // package.json has no "type": "module", so tsx hands a .ts module to a bare
    // --input-type=module eval as CommonJS and a static named import of a real
    // export fails with "does not provide an export named". Import dynamically
    // and accept either shape; this test is about concurrent writers, not interop.
    const source = `const store = await import(${JSON.stringify(moduleUrl)});
      const { createWorkSuggestion, setQuietCurrentStorePathForTests } = store.default ?? store;
      setQuietCurrentStorePathForTests(${JSON.stringify(file)});
      for(let i=0;i<20;i++) createWorkSuggestion({id:${JSON.stringify(`worker-${worker}-`)}+i,title:'Follow up '+i,reason:'Promise',source:'test'});
      createWorkSuggestion({title:'Shared promise',reason:'Promise',source:'test',claimKey:'shared'});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const snapshot = getQuietCurrentSnapshot();
  assert.equal(snapshot.suggestions.length, 81);
  assert.equal(snapshot.decisionEvents.length, 81);
  assert.equal(snapshot.suggestions.filter(item => item.claimKey === 'shared').length, 1);
});


test('a migrated database remains usable after a database-only restore', (t) => {
  const { file } = fixture(t);
  writeFileSync(file, JSON.stringify(empty()));
  const suggestion = createWorkSuggestion({title: 'Retained promise', reason: 'test', source: 'test'});
  rmSync(file);
  assert.equal(getQuietCurrentSnapshot().suggestions[0].id, suggestion.id);
  createWorkSuggestion({title: 'New promise', reason: 'test', source: 'test'});
  assert.equal(getQuietCurrentSnapshot().suggestions.length, 2);
});

test('explicit data directory uses the existing pre-rename database', (t) => {
  const { dir } = fixture(t);
  setQuietCurrentStorePathForTests(undefined);
  const previous = process.env.COVE_DB_PATH;
  delete process.env.COVE_DB_PATH;
  t.after(() => {
    if (previous !== undefined) process.env.COVE_DB_PATH = previous;
  });
  const db = openLocalDatabase(path.join(dir, 'forge.db'));
  t.after(() => db.close());
  createWorkSuggestion({title: 'Legacy install', reason: 'test', source: 'test', dataDir: dir});
  const row = db.prepare('SELECT state_json FROM cove_quiet_current').get();
  assert.equal(JSON.parse(row.state_json).suggestions[0].title, 'Legacy install');
});
