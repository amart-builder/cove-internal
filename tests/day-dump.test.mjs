import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import {
  buildDayDumpCommand,
  buildDayDumpPrompt,
  DAY_DUMP_JSON_SCHEMA,
  validateDayDump,
} from '../src/lib/claude-execution/dump-commands.ts';
import { runOneDayDump } from '../src/lib/claude-execution/worker.ts';
import { readDumpRelay } from '../src/lib/day-plan/brief-relay.ts';

const CLOCK = '2026-07-18T02:00:00.000Z';
const RAW_DUMP = 'I promised Maya I would send the deck Tuesday. Idea: make a client FAQ.';
const VALID_WIRE = {
  items: [
    {
      kind: 'promise',
      title: 'Send Maya the deck',
      details: null,
      counterparty: 'Maya',
      source_quote: 'I promised Maya I would send the deck Tuesday.',
      due_at: '2026-07-21T09:00:00-07:00',
      review_at: null,
      confidence: 'high',
      status: 'open',
    },
    {
      kind: 'idea',
      title: 'Make a client FAQ',
      details: null,
      counterparty: null,
      source_quote: 'Idea: make a client FAQ.',
      due_at: null,
      review_at: '2026-07-20T09:00:00-07:00',
      confidence: 'high',
      status: 'open',
    },
  ],
  skipped_duplicates: [],
  nothing_found: false,
};

const RESOLUTION_DUMP = 'Morgan confirmed Tuesday 2pm. The launch moved to Friday. Casey\'s checklist should be handled.';

function resolutionWire(overrides = {}) {
  return {
    items: [],
    skipped_duplicates: [],
    nothing_found: false,
    resolutions: [{
      commitment_id: 'commitment-a',
      action: 'done',
      quote: 'Morgan confirmed Tuesday 2pm.',
      note: 'Morgan confirmed the time.',
      due_at: null,
      confidence: 'high',
      ...overrides,
    }],
  };
}

function fixture(t) {
  const dir = path.join(os.tmpdir(), `forge-day-dump-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const store = createDayPlanStore({
    dbPath: path.join(dir, 'forge.db'),
    now: () => new Date(CLOCK),
  });
  writeFileSync(path.join(dir, 'empty-mcp.json'), '{"mcpServers":{}}');
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

function mutate(store, plan, action, patch = {}) {
  return store.mutateDayPlan({
    planId: plan.id,
    mutationId: `${action}:${plan.version}:${Math.random()}`,
    expectedVersion: plan.version,
    action,
    ...patch,
  }).plan;
}

function settleWithDump(store, rawText = RAW_DUMP) {
  const candidates = buildDayPlanCandidates({
    localDate: '2026-07-17',
    timezone: 'America/Los_Angeles',
    tasks: [{
      id: 'task-a',
      title: 'Finish the client deck',
      priority: 'high',
      position: 0,
      column: 'today',
      status: 'open',
      updatedAt: '2026-07-17T18:00:00.000Z',
      refreshedAt: '2026-07-17T18:00:00.000Z',
    }],
  });
  let plan = store.ensureDayPlan({
    localDate: '2026-07-17',
    timezone: 'America/Los_Angeles',
    mutationId: `ensure:${Math.random()}`,
    candidates,
  }).plan;
  plan = mutate(store, plan, 'arrival_open');
  plan = mutate(store, plan, 'start_day');
  plan = mutate(store, plan, 'settlement_start');
  plan = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: ['task-a'],
    nextDayNote: rawText,
  });
  return plan;
}

function fakeCodex(dir, outputs) {
  const executable = path.join(dir, `fake-codex-${Math.random()}`);
  const capture = path.join(dir, `codex-capture-${Math.random()}.jsonl`);
  const state = path.join(dir, `codex-state-${Math.random()}`);
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let index = 0;
  try { index = Number(fs.readFileSync(${JSON.stringify(state)}, 'utf8')); } catch {}
  fs.writeFileSync(${JSON.stringify(state)}, String(index + 1));
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, input, cwd: process.cwd() }) + '\\n');
  const outputPath = args[args.indexOf('--output-last-message') + 1];
  fs.writeFileSync(outputPath, ${JSON.stringify(outputs)}[index] ?? '');
});
`);
  chmodSync(executable, 0o700);
  return { executable, capture };
}

function fakeClaude(dir, output) {
  const executable = path.join(dir, `fake-claude-${Math.random()}`);
  writeFileSync(executable, `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output)}));
`);
  chmodSync(executable, 0o700);
  return executable;
}

function workerOptions(dir, store, overrides = {}) {
  return {
    store,
    claudePath: path.join(dir, 'claude-must-not-run'),
    emptyMcpConfigPath: path.join(dir, 'empty-mcp.json'),
    logDir: path.join(dir, 'logs'),
    fallbackCwd: dir,
    now: () => new Date(CLOCK),
    dumpTimeoutMs: 5_000,
    dumpFetchTimeoutMs: 5_000,
    webBaseUrl: 'http://forge.test',
    // Scopes the dump relay write to the fixture. Without it the write falls
    // back to the ambient data dir and the suite overwrites the real relay
    // file in data/, which is exactly what happened the first time.
    relay: { dataDir: dir },
    ...overrides,
  };
}

function fakeForgeFetch(insertStatuses = [201, 201], posts = [], options = {}) {
  let insertIndex = 0;
  const patches = options.patches ?? [];
  const rows = options.commitments ?? [];
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/forge-rest/commitments') && !init.method) {
      const id = new URL(value).searchParams.get('id')?.replace(/^eq\./, '');
      return new Response(JSON.stringify(id ? rows.filter((row) => row.id === id) : rows), { status: 200 });
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 });
    }
    if (value.endsWith('/api/forge-rest/commitments') && init.method === 'POST') {
      posts.push({ body: JSON.parse(init.body), headers: init.headers });
      const status = insertStatuses[insertIndex++] ?? 201;
      return new Response(status === 201 ? '[]' : 'failed', { status });
    }
    if (value.includes('/api/forge-rest/commitments?') && init.method === 'PATCH') {
      const params = new URL(value).searchParams;
      const id = params.get('id')?.replace(/^eq\./, '');
      patches.push({
        id,
        status: params.get('status'),
        evidence: params.get('evidence'),
        body: JSON.parse(init.body),
        headers: init.headers,
      });
      const status = options.patchStatuses?.[id] ?? 200;
      const matched = options.patchMatches?.[id] ?? true;
      return new Response(status === 200 ? JSON.stringify(matched ? [{ id }] : []) : 'failed', { status });
    }
    throw new Error(`unexpected request: ${value}`);
  };
}

test('settlement stores the note and enqueues one append-only dump row', (t) => {
  const { store } = fixture(t);
  const plan = settleWithDump(store);
  assert.equal(plan.nextDayNote, RAW_DUMP);
  const dumps = store.listDayDumps('2026-07-17');
  assert.equal(dumps.length, 1);
  assert.equal(dumps[0].rawText, RAW_DUMP);
  assert.equal(dumps[0].status, 'queued');
  assert.equal(store.getPlanForDate('2026-07-17').items[0].title, 'Finish the client deck');
});

test('dump prompt and validator enforce the bounded grounded contract', () => {
  const prompt = buildDayDumpPrompt({
    rawDump: RAW_DUMP,
    targetLocalDate: '2026-07-17',
    planItems: [{ id: 'item-a', title: 'Finish the client deck' }],
    openCommitments: [],
  });
  assert.match(prompt, /DUMP_TIMEZONE=America\/Los_Angeles/);
  assert.match(prompt, /DEFAULT_REVIEW_AT=2026-07-20T09:00:00-07:00/);
  assert.match(prompt, /CONTEXT TODAY_PLAN_ITEMS=\[{"id":"item-a","title":"Finish the client deck"}\]/);
  const command = buildDayDumpCommand({
    claudePath: '/fake/claude',
    emptyMcpConfigPath: '/fake/empty.json',
    prompt,
    modelAlias: 'opus',
    effort: 'high',
    budgetUsd: 1.5,
  });
  assert.deepEqual(command.args, [
    '-p', '--no-session-persistence', '--permission-mode', 'plan', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '/fake/empty.json',
    '--model', 'claude-opus-5', '--effort', 'high', '--output-format', 'json',
    '--json-schema', DAY_DUMP_JSON_SCHEMA, '--max-budget-usd', '1.5',
  ]);
  assert.deepEqual(validateDayDump(VALID_WIRE, RAW_DUMP), { ...VALID_WIRE, resolutions: [] });
  assert.throws(
    () => validateDayDump({
      ...VALID_WIRE,
      items: [{ ...VALID_WIRE.items[0], source_quote: 'Maya needs a deck.' }],
    }, RAW_DUMP),
    /source_quote_not_verbatim/,
  );
  assert.throws(
    () => validateDayDump({
      ...VALID_WIRE,
      items: [{ ...VALID_WIRE.items[0], due_at: 'Tuesday' }],
    }, RAW_DUMP),
    /due_at_iso/,
  );
  assert.throws(
    () => validateDayDump({ ...VALID_WIRE, items: Array.from({ length: 21 }, () => VALID_WIRE.items[0]) }, RAW_DUMP),
    /items_bounds/,
  );
});

test('dump resolution validation rejects ungrounded, ambiguous, and oversized resolution payloads', () => {
  const ids = new Set(['commitment-a']);
  assert.deepEqual(
    validateDayDump(resolutionWire(), RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    resolutionWire(),
  );
  assert.throws(
    () => validateDayDump(resolutionWire({ commitment_id: 'unknown' }), RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    /resolution_0_commitment_id_unknown/,
  );
  assert.throws(
    () => validateDayDump({
      ...resolutionWire(),
      resolutions: [resolutionWire().resolutions[0], resolutionWire().resolutions[0]],
    }, RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    /resolution_commitment_id_repeated/,
  );
  assert.throws(
    () => validateDayDump(resolutionWire({ quote: 'Morgan probably replied.' }), RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    /quote_not_verbatim/,
  );
  assert.throws(
    () => validateDayDump(resolutionWire({ action: 'update', note: null, due_at: null }), RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    /update_empty/,
  );
  assert.throws(
    () => validateDayDump(resolutionWire({ action: 'update', due_at: 'Friday' }), RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    /due_at_iso/,
  );
  assert.throws(
    () => validateDayDump({
      ...resolutionWire(),
      resolutions: Array.from({ length: 21 }, (_, index) => ({
        ...resolutionWire().resolutions[0],
        commitment_id: `commitment-${index}`,
      })),
    }, RESOLUTION_DUMP),
    /resolutions_bounds/,
  );
  assert.throws(
    () => validateDayDump(resolutionWire({ confidence: 'certain' }), RESOLUTION_DUMP, { existingCommitmentIds: ids }),
    /confidence/,
  );
});

test('Codex retries one invalid extraction, inserts grounded commitments, and stores a receipt', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store);
  const invalid = { ...VALID_WIRE, items: [{ ...VALID_WIRE.items[0], source_quote: 'not in dump' }] };
  const fake = fakeCodex(dir, [
    JSON.stringify(invalid),
    `\`\`\`json\n${JSON.stringify(VALID_WIRE)}\n\`\`\``,
  ]);
  const posts = [];
  assert.equal(await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'codex',
    codexPath: fake.executable,
    fetchImpl: fakeForgeFetch([201, 201], posts),
  })), true);

  const dump = store.listDayDumps()[0];
  assert.equal(dump.status, 'succeeded');

  // A succeeded dump publishes the relay, which is the only way the dump
  // reaches the machine that writes the 7:30 brief.
  const relayed = readDumpRelay({ dataDir: dir, now: new Date(CLOCK) });
  assert.equal(relayed.content, dump.rawText.trim());
  assert.equal(relayed.targetLocalDate, dump.targetLocalDate);

  const receipt = JSON.parse(dump.resultJson);
  assert.deepEqual(receipt.counts, {
    extracted: 2,
    created: 2,
    skipped_duplicates: 0,
    failed: 0,
    resolved: 0,
    updated: 0,
    needs_confirmation: 0,
  });
  assert.deepEqual(receipt.resolved, []);
  assert.deepEqual(receipt.updated, []);
  assert.deepEqual(receipt.needs_confirmation, []);
  assert.deepEqual(receipt.resolution_failures, []);
  assert.equal(receipt.created.length, 2);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.source_kind, 'brain_dump');
  assert.equal(posts[0].body.source_ref, dump.id);
  assert.equal(posts[0].body.confirmed, false);
  assert.equal(posts[0].headers['X-Forge-CSRF'], 'csrf-token');
  const captures = readFileSync(fake.capture, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(captures.length, 2);
  assert.equal(captures[0].cwd.includes('forge-day-dump-'), true);
  assert.match(captures[1].input, /previous output failed validation/);
  assert.deepEqual(captures[0].args.slice(0, 9), [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
    '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high',
    '--output-last-message',
  ]);
});

test('partial commitment insert failures stay honest without failing the dump row', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store);
  const posts = [];
  const claudePath = fakeClaude(dir, JSON.stringify(VALID_WIRE));
  await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'claude',
    claudePath,
    fetchImpl: fakeForgeFetch([500, 201], posts),
  }));
  const dump = store.listDayDumps()[0];
  const receipt = JSON.parse(dump.resultJson);
  assert.equal(dump.status, 'succeeded');
  assert.equal(receipt.created.length, 1);
  assert.equal(receipt.failed.length, 1);
  assert.deepEqual(receipt.counts, {
    extracted: 2,
    created: 1,
    skipped_duplicates: 0,
    failed: 1,
    resolved: 0,
    updated: 0,
    needs_confirmation: 0,
  });
});

test('dump resolutions apply high-confidence changes, preserve evidence, and leave proposals non-destructive', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store, RESOLUTION_DUMP);
  const rows = [
    { id: 'commitment-a', kind: 'follow_up', title: 'Get the jam time', evidence: JSON.stringify({ owner: 'Jordan Rivers' }), status: 'open', due_at: null },
    { id: 'commitment-b', kind: 'promise', title: 'Ship the launch', evidence: 'legacy evidence text', status: 'open', due_at: null },
    { id: 'commitment-c', kind: 'waiting_on', title: 'Casey checklist', evidence: null, status: 'open', due_at: null },
  ];
  const wire = {
    items: [],
    skipped_duplicates: ['commitment-a'],
    nothing_found: false,
    resolutions: [
      resolutionWire().resolutions[0],
      {
        commitment_id: 'commitment-b',
        action: 'update',
        quote: 'The launch moved to Friday.',
        note: 'The launch date moved.',
        due_at: '2026-07-24T09:00:00-07:00',
        confidence: 'high',
      },
      {
        commitment_id: 'commitment-c',
        action: 'done',
        quote: "Casey's checklist should be handled.",
        note: 'The checklist may be handled.',
        due_at: null,
        confidence: 'medium',
      },
    ],
  };
  const patches = [];
  await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'claude',
    claudePath: fakeClaude(dir, JSON.stringify(wire)),
    fetchImpl: fakeForgeFetch([], [], { commitments: rows, patches }),
  }));

  assert.equal(patches.length, 3);
  assert.equal(patches[0].id, 'commitment-a');
  assert.equal(patches[0].status, 'eq.open');
  assert.equal(patches[0].body.status, 'done');
  assert.deepEqual(JSON.parse(patches[0].body.evidence).owner, 'Jordan Rivers');
  assert.equal(JSON.parse(patches[0].body.evidence).resolved_by, 'day_dump');
  assert.equal(patches[1].body.status, undefined);
  assert.equal(patches[1].body.due_at, '2026-07-24T09:00:00-07:00');
  assert.equal(JSON.parse(patches[1].body.evidence).prior_evidence, 'legacy evidence text');
  assert.equal(JSON.parse(patches[1].body.evidence).updated_by, 'day_dump');
  assert.deepEqual(Object.keys(patches[2].body), ['evidence']);
  assert.equal(JSON.parse(patches[2].body.evidence).proposed_resolution.confidence, 'medium');

  const dump = store.listDayDumps()[0];
  const receipt = JSON.parse(dump.resultJson);
  assert.equal(dump.status, 'succeeded');
  assert.deepEqual(receipt.resolved, [{ id: 'commitment-a', title: 'Get the jam time' }]);
  assert.deepEqual(receipt.updated, [{ id: 'commitment-b', title: 'Ship the launch' }]);
  assert.deepEqual(receipt.needs_confirmation, [{ id: 'commitment-c', title: 'Casey checklist' }]);
  assert.deepEqual(receipt.resolution_failures, []);
  assert.deepEqual(receipt.counts, {
    extracted: 0,
    created: 0,
    skipped_duplicates: 1,
    failed: 0,
    resolved: 1,
    updated: 1,
    needs_confirmation: 1,
  });
});

test('one failed resolution is isolated and empty evidence still applies to later resolutions', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store, 'Morgan confirmed Tuesday 2pm. The launch moved to Friday.');
  const rows = [
    { id: 'commitment-a', kind: 'follow_up', title: 'Get the jam time', evidence: '', status: 'open' },
    { id: 'commitment-b', kind: 'promise', title: 'Ship the launch', evidence: null, status: 'open' },
  ];
  const wire = {
    items: [],
    skipped_duplicates: [],
    nothing_found: false,
    resolutions: [
      resolutionWire().resolutions[0],
      {
        commitment_id: 'commitment-b',
        action: 'update',
        quote: 'The launch moved to Friday.',
        note: 'The launch date moved.',
        due_at: '2026-07-24T09:00:00-07:00',
        confidence: 'high',
      },
    ],
  };
  const patches = [];
  await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'claude',
    claudePath: fakeClaude(dir, JSON.stringify(wire)),
    fetchImpl: fakeForgeFetch([], [], {
      commitments: rows,
      patches,
      patchStatuses: { 'commitment-a': 500 },
    }),
  }));
  const receipt = JSON.parse(store.listDayDumps()[0].resultJson);
  assert.equal(patches.length, 2);
  assert.deepEqual(receipt.updated, [{ id: 'commitment-b', title: 'Ship the launch' }]);
  assert.equal(receipt.resolution_failures.length, 1);
  assert.equal(receipt.resolution_failures[0].id, 'commitment-a');
  assert.equal(JSON.parse(patches[1].body.evidence).updated_by, 'day_dump');
});

test('a commitment that closes during extraction is not overwritten and later resolutions still apply', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store, 'Morgan confirmed Tuesday 2pm. The launch moved to Friday.');
  const rows = [
    { id: 'commitment-a', kind: 'follow_up', title: 'Get the jam time', evidence: null, status: 'open' },
    { id: 'commitment-b', kind: 'promise', title: 'Ship the launch', evidence: null, status: 'open' },
  ];
  const wire = {
    items: [],
    skipped_duplicates: [],
    nothing_found: false,
    resolutions: [
      resolutionWire().resolutions[0],
      {
        commitment_id: 'commitment-b',
        action: 'update',
        quote: 'The launch moved to Friday.',
        note: 'The launch date moved.',
        due_at: '2026-07-24T09:00:00-07:00',
        confidence: 'high',
      },
    ],
  };
  const patches = [];
  await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'claude',
    claudePath: fakeClaude(dir, JSON.stringify(wire)),
    fetchImpl: fakeForgeFetch([], [], {
      commitments: rows,
      patches,
      patchMatches: { 'commitment-a': false },
    }),
  }));

  const receipt = JSON.parse(store.listDayDumps()[0].resultJson);
  assert.equal(patches.every((patch) => patch.status === 'eq.open'), true);
  assert.equal(patches.every((patch) => patch.evidence === 'is.null'), true);
  assert.deepEqual(receipt.resolved, []);
  assert.deepEqual(receipt.updated, [{ id: 'commitment-b', title: 'Ship the launch' }]);
  assert.deepEqual(receipt.resolution_failures, [{
    id: 'commitment-a',
    error: 'commitment_resolution_no_longer_open',
  }]);
});

test('a concurrent evidence write fails the resolution compare-and-swap instead of being lost', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store, 'Morgan confirmed Tuesday 2pm.');
  const priorEvidence = JSON.stringify({ note: 'written by another flow' });
  const patches = [];
  await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'claude',
    claudePath: fakeClaude(dir, JSON.stringify(resolutionWire())),
    fetchImpl: fakeForgeFetch([], [], {
      commitments: [{
        id: 'commitment-a',
        kind: 'follow_up',
        title: 'Get the jam time',
        evidence: priorEvidence,
        status: 'open',
      }],
      patches,
      patchMatches: { 'commitment-a': false },
    }),
  }));

  assert.equal(patches.length, 1);
  assert.equal(patches[0].evidence, `eq.${priorEvidence}`);
  const receipt = JSON.parse(store.listDayDumps()[0].resultJson);
  assert.deepEqual(receipt.resolved, []);
  assert.deepEqual(receipt.resolution_failures, [{
    id: 'commitment-a',
    error: 'commitment_resolution_no_longer_open',
  }]);
});

test('the dump row fails only when every extracted commitment insert fails', async (t) => {
  const { dir, store } = fixture(t);
  settleWithDump(store);
  const claudePath = fakeClaude(dir, JSON.stringify(VALID_WIRE));
  await runOneDayDump(workerOptions(dir, store, {
    dumpWriter: 'claude',
    claudePath,
    fetchImpl: fakeForgeFetch([500, 500]),
  }));
  const dump = store.listDayDumps()[0];
  const receipt = JSON.parse(dump.resultJson);
  assert.equal(dump.status, 'failed');
  assert.equal(dump.errorCode, 'commitment_insert_failed');
  assert.equal(receipt.counts.failed, 2);
  assert.equal(receipt.counts.created, 0);
});
