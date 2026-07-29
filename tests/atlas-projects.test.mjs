import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectDirectory } from '../src/lib/atlas-projects.ts';

test('Atlas project resolver handles exact, unique fuzzy, ambiguous, missing, and traversal hints', (t) => {
  const fixture = path.join(os.tmpdir(), `cove-atlas-projects-${process.pid}-${Date.now()}`);
  const home = path.join(fixture, 'home');
  const projectsRoot = path.join(home, 'Atlas', 'Projects');
  for (const name of ['AI', 'Pilot Memory', 'Pilot Pro', 'Beacon-Engine']) {
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
    resolveProjectDirectory('beacon engine', dependencies),
    realpathSync(path.join(realProjectsRoot, 'Beacon-Engine')),
  );
  assert.equal(
    resolveProjectDirectory('beacon', dependencies),
    realpathSync(path.join(realProjectsRoot, 'Beacon-Engine')),
  );
  assert.equal(
    resolveProjectDirectory('the Beacon Engine launch', dependencies),
    realpathSync(path.join(realProjectsRoot, 'Beacon-Engine')),
  );
  assert.equal(resolveProjectDirectory('pilot', dependencies), null);
  assert.equal(
    resolveProjectDirectory('AI', dependencies),
    realpathSync(path.join(realProjectsRoot, 'AI')),
  );
  assert.equal(resolveProjectDirectory('AI roadmap', dependencies), null);
  assert.equal(resolveProjectDirectory('unknown project', dependencies), null);
  assert.equal(resolveProjectDirectory('Not A Project', dependencies), null);
  assert.equal(resolveProjectDirectory('../Beacon-Engine', dependencies), null);
  assert.equal(resolveProjectDirectory('Escaped Project', dependencies), null);
});
