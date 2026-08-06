import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const readSource = (file) => readFileSync(path.join(root, file), 'utf8');

test('warm workspace overrides keep their reviewed dark and responsive guards', () => {
  const css = readSource('src/app/globals.css');
  const workspaceLayer = css.indexOf('/* Warm paper language shared by the local All Work and People workspaces. */');
  const unlayeredOverrides = css.indexOf('/* Unlayered workspace overrides intentionally outrank Tailwind utilities. */');

  assert.ok(workspaceLayer >= 0, 'warm workspace component layer is missing');
  assert.ok(unlayeredOverrides > workspaceLayer, 'unlayered workspace overrides are missing');
  assert.match(
    css,
    /\.dark \.water-secondary-button:hover:not\(:disabled\),\s*\.dark \.water-text-button:hover:not\(:disabled\)/,
  );

  const layeredCss = css.slice(workspaceLayer, unlayeredOverrides);
  assert.doesNotMatch(layeredCss, /@media \(max-width: 799px\)/);
  assert.doesNotMatch(layeredCss, /@media \(max-width: 720px\)/);

  const unlayeredCss = css.slice(unlayeredOverrides);
  assert.match(unlayeredCss, /@media \(max-width: 799px\)[\s\S]*\.people-surface\.is-detail-open \.people-list-pane\s*{\s*display: none;/);
  assert.match(unlayeredCss, /@media \(max-width: 720px\)[\s\S]*\.all-work-toolbar-row > \.relative\.ml-4/);
});

test('Buddy owns focus and Escape while it is open over a ritual', () => {
  const dock = readSource('src/components/buddy/BuddyDock.tsx');
  const panel = readSource('src/components/buddy/BuddyPanel.tsx');
  const ritual = readSource('src/components/tasks/DayRitualLayer.tsx');

  assert.match(dock, /data-buddy-root/);
  assert.match(ritual, /closest\('\[data-buddy-root\]'\)/);
  assert.match(panel, /document\.addEventListener\('keydown', onKeyDown, \{ capture: true \}\)/);
  assert.match(panel, /event\.stopImmediatePropagation\(\)/);
});

test('demo seed guards the real SQLite sidecars and configuration files', () => {
  const seed = readSource('scripts/cove-demo-seed.ts');

  assert.match(seed, /cove\.db-wal/);
  assert.match(seed, /cove\.db-shm/);
  assert.match(seed, /cove-profile\.json/);
  assert.match(seed, /cove-task-settings\.json/);
  assert.match(seed, /cove-workspace\.json/);
});
