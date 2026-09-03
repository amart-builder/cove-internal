import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isSalesPipelineEnabled } from '../src/lib/runtime/sales-pipeline.ts';
import {
  attentionItems,
  followUpStatus,
  isValidStage,
  parseCalendarDate,
  pipelineSummary,
  PIPELINE_STAGES,
  validateLogPipelineTouch,
  validatePipelinePatch,
} from '../src/lib/crm/pipeline.ts';

function deal(overrides = {}) {
  return {
    id: 'deal-1',
    contact_id: 'contact-1',
    stage: 'interested',
    monthly_value: null,
    discovery_price: null,
    next_action: 'Book a call',
    next_follow_up_at: '2026-09-02',
    source: '',
    notes: '',
    last_touch_at: null,
    stage_changed_at: '2026-09-01T12:00:00.000Z',
    created_at: '2026-09-01T12:00:00.000Z',
    updated_at: '2026-09-01T12:00:00.000Z',
    name: 'Alex Lead',
    company: 'Acme',
    email: null,
    phone: null,
    last_interaction_at: null,
    ...overrides,
  };
}

test('pipeline client switch hides the nav tab and page when disabled', {
  concurrency: false,
}, () => {
  const previous = process.env.NEXT_PUBLIC_COVE_SALES_PIPELINE;
  try {
    delete process.env.NEXT_PUBLIC_COVE_SALES_PIPELINE;
    assert.equal(isSalesPipelineEnabled(), false);
    process.env.NEXT_PUBLIC_COVE_SALES_PIPELINE = '1';
    assert.equal(isSalesPipelineEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_COVE_SALES_PIPELINE;
    else process.env.NEXT_PUBLIC_COVE_SALES_PIPELINE = previous;
  }
  const nav = readFileSync(path.join(process.cwd(), 'src/components/crm/CrmSubNav.tsx'), 'utf8');
  const page = readFileSync(path.join(process.cwd(), 'src/app/crm/pipeline/page.tsx'), 'utf8');
  assert.match(nav, /if \(!isSalesPipelineEnabled\(\)\) return null/);
  assert.match(page, /if \(!salesPipelineEnabled\(\)\) notFound\(\)/);
});

test('pipeline stages have the required order and validation', () => {
  assert.deepEqual(
    PIPELINE_STAGES.map((stage) => stage.id),
    [
      'reach_out',
      'keep_warm',
      'interested',
      'call_scheduled',
      'pitched',
      'discovery_ready',
      'discovery_booked',
      'proposal',
      'client',
      'lost',
      'parked',
    ],
  );
  assert.equal(isValidStage('proposal'), true);
  assert.equal(isValidStage('won'), false);
});

test('calendar dates remain the same day across the Los Angeles UTC boundary', {
  concurrency: false,
}, () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const parsed = parseCalendarDate('2026-09-01');
    assert.ok(parsed);
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth(), 8);
    assert.equal(parsed.getDate(), 1);
    assert.equal(parseCalendarDate('2026-02-29'), null);
    assert.equal(parseCalendarDate('09/01/2026'), null);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('follow-up status treats seven days as soon and keeps date-only math', () => {
  const today = '2026-09-01';
  assert.equal(followUpStatus(deal({ next_follow_up_at: '2026-08-31' }), today), 'overdue');
  assert.equal(followUpStatus(deal({ next_follow_up_at: today }), today), 'today');
  assert.equal(followUpStatus(deal({ next_follow_up_at: '2026-09-08' }), today), 'soon');
  assert.equal(followUpStatus(deal({ next_follow_up_at: '2026-09-09' }), today), 'later');
  assert.equal(followUpStatus(deal({ next_follow_up_at: null }), today), 'none');
});

test('summary counts client MRR, open deals, overdue, and due soon', () => {
  const deals = [
    deal({ id: 'client', contact_id: 'client', stage: 'client', monthly_value: 6000 }),
    deal({ id: 'late', contact_id: 'late', next_follow_up_at: '2026-08-31' }),
    deal({ id: 'today', contact_id: 'today', next_follow_up_at: '2026-09-01' }),
    deal({ id: 'soon', contact_id: 'soon', next_follow_up_at: '2026-09-08' }),
    deal({ id: 'parked', contact_id: 'parked', stage: 'parked', next_follow_up_at: '2026-08-01' }),
  ];
  assert.deepEqual(pipelineSummary(deals, '2026-09-01'), {
    mrr: 6000,
    openCount: 3,
    overdueCount: 1,
    dueSoonCount: 2,
  });
});

test('attention returns one item per open deal with ordered reasons', () => {
  const items = attentionItems([
    deal({ id: 'late', contact_id: 'late', next_action: '', next_follow_up_at: '2026-08-30' }),
    deal({ id: 'missing', contact_id: 'missing', next_action: '', next_follow_up_at: null }),
    deal({ id: 'closed', contact_id: 'closed', stage: 'lost', next_action: '', next_follow_up_at: null }),
  ], '2026-09-01');
  assert.deepEqual(
    items.map((item) => [item.deal.contact_id, item.reason, item.reasons]),
    [
      ['late', 'overdue', ['overdue', 'missing_action']],
      ['missing', 'missing_action', ['missing_action', 'missing_date']],
    ],
  );
});

test('patch and touch validation trim bounded values and reject unknown keys', () => {
  assert.deepEqual(validatePipelinePatch({
    monthlyValue: 2500,
    discoveryPrice: null,
    nextAction: '  Send scope  ',
    nextFollowUpAt: '2026-09-03',
    source: '  Zac  ',
  }), {
    monthlyValue: 2500,
    discoveryPrice: null,
    nextAction: 'Send scope',
    nextFollowUpAt: '2026-09-03',
    source: 'Zac',
  });
  assert.throws(() => validatePipelinePatch({ stage: 'client' }), /move action/);
  assert.throws(() => validatePipelinePatch({ unknown: true }), /Unknown pipeline patch field/);
  assert.throws(() => validatePipelinePatch({ monthlyValue: 1.5 }), /whole number/);
  assert.throws(() => validatePipelinePatch({ nextFollowUpAt: '2026-02-30' }), /calendar date/);
  assert.equal(
    validateLogPipelineTouch({ activityType: 'call', title: '  Good call  ' }).title,
    'Good call',
  );
  assert.throws(
    () => validateLogPipelineTouch({ activityType: 'voice', title: 'Call' }),
    /type is invalid/,
  );
});

test('patch and touch validation accept snake case aliases and reject duplicates', () => {
  assert.deepEqual(validatePipelinePatch({
    monthly_value: 4200,
    discovery_price: 900,
    next_action: '  Send recap  ',
    next_follow_up_at: '2026-09-06',
  }), {
    monthlyValue: 4200,
    discoveryPrice: 900,
    nextAction: 'Send recap',
    nextFollowUpAt: '2026-09-06',
  });
  assert.deepEqual(validateLogPipelineTouch({
    activity_type: 'email',
    title: '  Follow-up email  ',
    next_action: 'Book call',
    next_follow_up_at: '2026-09-07',
  }), {
    activityType: 'email',
    title: 'Follow-up email',
    nextAction: 'Book call',
    nextFollowUpAt: '2026-09-07',
  });
  assert.throws(
    () => validatePipelinePatch({ monthlyValue: 1000, monthly_value: 1000 }),
    /not both/,
  );
  assert.throws(
    () => validateLogPipelineTouch({
      activityType: 'call',
      activity_type: 'call',
      title: 'Call',
    }),
    /not both/,
  );
  assert.throws(
    () => validateLogPipelineTouch({
      activity_type: 'call',
      title: 'Call',
      nextAction: 'Send scope',
      next_action: 'Send scope',
    }),
    /not both/,
  );
});
