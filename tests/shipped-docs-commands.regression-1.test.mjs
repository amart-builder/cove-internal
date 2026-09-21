import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const exporter = readFileSync(path.join(root, 'scripts/export-cove-client.mjs'), 'utf8');

// The docs the exporter ships, read out of its own allowlist so a doc added
// there is covered the day it is added.
function shippedDocs() {
  const block = exporter.match(/const rootFiles = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(block, 'export-cove-client.mjs no longer declares rootFiles');
  const files = [...block[1].matchAll(/"([^"]+\.md)"/g)].map((match) => match[1]);
  assert.ok(files.length >= 8, `expected the exporter to ship docs, saw ${files.length}`);
  return files;
}

function excludedPaths() {
  const block = exporter.match(/const excludedPaths = \[([\s\S]*?)\];/);
  assert.ok(block, 'export-cove-client.mjs no longer declares excludedPaths');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

// A command in these documents is an instruction to a person, or to the agent
// setting Cove up for them, on a machine nobody is sitting at. One that names a
// file the export does not carry stops the install where it stands, and the
// error is a shell's "No such file", which says nothing about why.
test('every script the shipped docs name is a file the client gets', () => {
  const excluded = excludedPaths();
  const problems = [];
  for (const doc of shippedDocs()) {
    const text = readFileSync(path.join(root, doc), 'utf8');
    for (const match of text.matchAll(/(scripts\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:sh|mjs|ts|js))/g)) {
      const target = match[1];
      if (!existsSync(path.join(root, target))) problems.push(`${doc} names ${target}, which does not exist`);
      else if (excluded.some((prefix) => target.startsWith(prefix))) {
        problems.push(`${doc} names ${target}, which the export deliberately leaves out`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every npm command the shipped docs name is a real package script', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const problems = [];
  for (const doc of shippedDocs()) {
    const text = readFileSync(path.join(root, doc), 'utf8');
    for (const match of text.matchAll(/npm run ([a-z0-9:-]+)/g)) {
      if (!(match[1] in packageJson.scripts)) problems.push(`${doc} names npm run ${match[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});
