import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { guideCopyForRuntime } from '../src/app/guide/content.tsx';

// The guide is the only orientation a person gets, and its glossary is where
// they look up a word they saw on Today. Two labels sit on Today before any
// setup at all -- the Second Current card and the Rhythms pill inside it -- so
// they are the first words a new person can fail to look up.
const FIRST_SCREEN_WORDS = ['Second Current', 'Rhythms'];

test('the glossary defines the words Today shows before any setup', () => {
  for (const mode of ['local', 'supabase']) {
    const { words } = guideCopyForRuntime(mode);
    for (const word of FIRST_SCREEN_WORDS) {
      const entry = words.find(([name]) => name === word);
      assert.ok(entry, `${mode} guide never defines "${word}"`);
      assert.ok(entry[1].trim().length > 20, `"${word}" has no real meaning in ${mode} mode`);
    }
  }
});

test('the glossary points Rhythms at the panel that holds them', () => {
  const { words } = guideCopyForRuntime('local');
  const rhythms = words.find(([name]) => name === 'Rhythms')[1];
  assert.match(rhythms, /Second Current/);
});

test('Today still paints those labels, so the glossary still matches the screen', () => {
  const stage = readFileSync(
    new URL('../src/components/tasks/TodayRiverStageV2.tsx', import.meta.url),
    'utf8',
  );
  assert.match(stage, /<span>Second Current<\/span>/);
  const manager = readFileSync(
    new URL('../src/components/tasks/RhythmManager.tsx', import.meta.url),
    'utf8',
  );
  assert.match(manager, />\s*Rhythms\s*</);
});
