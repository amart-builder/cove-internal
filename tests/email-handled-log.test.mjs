import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listHandledEmailItems } from '../src/lib/data/email.ts';

test('listHandledEmailItems sends the bounded seven-day REST query', {
  concurrency: false,
}, async (t) => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = { setTimeout, clearTimeout };
  let requestUrl;
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });

  const before = Date.now() - 7 * 24 * 60 * 60_000;
  await listHandledEmailItems({ days: 7 });
  const after = Date.now() - 7 * 24 * 60 * 60_000;
  const url = new URL(requestUrl, 'http://cove.local');

  assert.equal(url.pathname, '/api/cove-rest/email_items');
  assert.equal(url.searchParams.get('select'), '*');
  assert.equal(url.searchParams.get('status'), 'in.(actioned,archived,reviewed)');
  assert.equal(url.searchParams.get('bucket'), 'in.(fyi,noise)');
  assert.equal(url.searchParams.get('order'), 'actioned_at.desc');
  assert.equal(url.searchParams.get('limit'), '200');
  const cutoff = url.searchParams.get('actioned_at');
  assert.match(cutoff, /^gte\./);
  const cutoffTime = Date.parse(cutoff.slice(4));
  assert.ok(cutoffTime >= before && cutoffTime <= after);
  assert.equal(url.searchParams.has('updated_at'), false);
  assert.equal(url.searchParams.has('or'), false);
});

test('EmailCardDetail renders the handled section and its empty state', () => {
  const source = readFileSync(path.join(
    process.cwd(),
    'src/components/tasks/EmailCardDetail.tsx',
  ), 'utf8');

  assert.match(source, /listHandledEmailItems\(\{ days: 7, limit: 200 \}\)/);
  assert.match(source, /<Section title="Things you should know" count=\{handledItems\.length\}>/);
  assert.match(source, /handledItems\.slice\(0, 12\)/);
  assert.match(source, /`Show all \(\$\{handledItems\.length\}\)`/);
  assert.match(source, /Showing the most recent 200\./);
  assert.match(source, /const \[handledError, setHandledError\] = useState<string>\(\)/);
  assert.match(source, /setHandledItems\(\[\]\);[\s\S]*setHandledError\('Could not load this list\.'\)/);
  assert.doesNotMatch(source, /Promise\.all/);
  assert.match(source, /calendarDays >= 2 && calendarDays <= 5/);
  assert.match(source, /month: 'short', day: 'numeric'/);
  assert.match(source, /Could not load this list\./);
  assert.match(source, /Nothing else happened in email in the last 7 days\./);
});
