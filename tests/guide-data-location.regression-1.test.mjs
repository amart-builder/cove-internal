import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as guideRoute from '../src/app/guide/page.tsx';

// tsx hands a .tsx default export back wrapped in its CommonJS interop shape.
const GuideRoute = typeof guideRoute.default === 'function'
  ? guideRoute.default
  : guideRoute.default.default;

// A person who never opens the repository has one screen that can answer
// "where is my work, and what leaves this Mac?" -- the guide. Before this the
// app said neither anywhere, so the only honest answer lived in a Markdown
// file meant for the setup agent.
test('the guide names the folder this install actually opens', () => {
  const previous = process.env.COVE_DATA_DIR;
  process.env.COVE_DATA_DIR = path.join('/tmp', 'guide-location-probe');
  try {
    const element = GuideRoute();
    assert.equal(element.props.dataFolder, path.join('/tmp', 'guide-location-probe'));
  } finally {
    if (previous === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previous;
  }
});

test('a hosted runtime is told nothing about a local folder', () => {
  const previous = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'supabase';
  try {
    assert.equal(GuideRoute().props.dataFolder, undefined);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previous;
  }
});

// A prerendered guide would name the folder the build ran in, not the one the
// install opens, and would look right on the machine that built it.
test('the guide is rendered when it is asked for, not when it was built', () => {
  const route = typeof guideRoute.default === 'function' ? guideRoute : guideRoute.default;
  assert.equal(route.dynamic ?? guideRoute.dynamic, 'force-dynamic');
});

test('the guide says where work is kept and what leaves the Mac', () => {
  const source = readFileSync(new URL('../src/app/guide/content.tsx', import.meta.url), 'utf8');
  assert.match(source, /Where your work is kept/);
  assert.match(source, /\{dataFolder\}/);
  assert.match(source, /no Cove\s+\n?\s*account and no Cove server holding a copy/);
  assert.match(source, /Two things do leave the Mac/);
  assert.match(source, /the model provider you chose/);
  assert.match(source, /Google is sent the requests Cove/);
});

// On a fresh install there is no feedback address and no connected email, so
// the draft the guide promised is the one thing Buddy cannot do.
test('the guide promises the Gmail draft only where Buddy can make one', () => {
  const source = readFileSync(new URL('../src/app/guide/content.tsx', import.meta.url), 'utf8');
  assert.match(source, /hands you the message to copy/);
  assert.doesNotMatch(source, /Buddy makes a Gmail draft\. /);
});
