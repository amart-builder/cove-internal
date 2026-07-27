import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectDirectory } from '../src/lib/atlas-projects.ts';

test('Atlas project resolver handles exact, unique fuzzy, ambiguous, missing, and traversal hints', (t) => {
  const fixture = path.join(os.tmpdir(), `forge-atlas-projects-${process.pid}-${Date.now()}`);
  const home = path.join(fixture, 'home');
  const projectsRoot = path.join(home, 'Atlas', 'Projects');
  for (const name of ['AI', 'Jarvis Memory', 'Jarvis Pro', 'Supernova-Engine']) {
    mkdirSync(path.join(projectsRoot, name), { recursive: true });
  }
  const outside = path.join(fixture, 'outside-atlas');
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, path.join(projectsRoot, 'Escaped Project'));
  writeFileSync(path.join(projectsRoot, 'Not A Project'), 'file fixture');
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const realHome = realpathSync(home);
  const realProjectsRoot = realpathSync(projectsRoot);
  const dependencies = { homeDir: realHome, projectsRoot: realProjectsRoot, cacheMs: 0 };

  assert.equal(
    resolveProjectDirectory('supernova engine', dependencies),
    realpathSync(path.join(realProjectsRoot, 'Supernova-Engine')),
  );
  assert.equal(
    resolveProjectDirectory('supernova', dependencies),
    realpathSync(path.join(realProjectsRoot, 'Supernova-Engine')),
  );
  assert.equal(
    resolveProjectDirectory('the Supernova Engine launch', dependencies),
    realpathSync(path.join(realProjectsRoot, 'Supernova-Engine')),
  );
  assert.equal(resolveProjectDirectory('jarvis', dependencies), null);
  assert.equal(
    resolveProjectDirectory('AI', dependencies),
    realpathSync(path.join(realProjectsRoot, 'AI')),
  );
  assert.equal(resolveProjectDirectory('AI roadmap', dependencies), null);
  assert.equal(resolveProjectDirectory('unknown project', dependencies), null);
  assert.equal(resolveProjectDirectory('Not A Project', dependencies), null);
  assert.equal(resolveProjectDirectory('../Supernova-Engine', dependencies), null);
  assert.equal(resolveProjectDirectory('Escaped Project', dependencies), null);
});
