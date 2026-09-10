import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmailReviewRow, emailReviewStatus } from '../src/components/tasks/EmailCardDetail.tsx';
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

const item = {
  id: 'email-test', thread_id: 'thread/123', account_email: 'person@example.com',
  sender_name: 'A sender', subject: 'A useful subject', summary: 'A readable summary.',
  bucket: 'reply', gmail_draft_id: 'possibly-stale-id',
};

test('email rows expose the Gmail archive action without claiming a stored draft is still ready', () => {
  const html = renderToStaticMarkup(React.createElement(EmailReviewRow, { item, onHandle() {} }));
  assert.match(html, /A useful subject/);
  assert.match(html, /A readable summary/);
  assert.match(html, /authuser=person%40example.com#all\/thread%2F123/);
  assert.match(html, /Mark handled and archive in Gmail/);
  assert.doesNotMatch(html, /drafts? ready/i);
  const handled = renderToStaticMarkup(React.createElement(EmailReviewRow, { item, handled: true, onHandle() {} }));
  assert.doesNotMatch(handled, /<button/);
  assert.match(handled, /Open in Gmail/);
});

test('email rows surface preparation failures and preserved draft warnings', () => {
  const failed = renderToStaticMarkup(React.createElement(EmailReviewRow, { item: { ...item, workflow_state: 'failed' } }));
  assert.match(failed, /could not finish preparing this email/);
  const preserved = renderToStaticMarkup(React.createElement(EmailReviewRow, { item: { ...item, recommended_action: 'Review the existing Gmail draft before proceeding.' } }));
  assert.match(preserved, /Review the existing Gmail draft/);
});

test('email status does not turn partial or unavailable runs into a successful inbox review', () => {
  assert.equal(emailReviewStatus({ state: 'ready', lastRunOutcome: 'partial' }), 'Last inbox review was incomplete');
  assert.equal(emailReviewStatus({ state: 'unavailable' }), 'Inbox review needs attention');
  assert.equal(emailReviewStatus({ state: 'stale' }), 'Inbox review is overdue');
});
