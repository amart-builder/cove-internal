import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createBuddyEventParser, isBuddyContextOverflow } from '../src/lib/buddy/stream.ts';

test('captured Claude stream maps chat events and ignores unknown events', () => {
  const parser = createBuddyEventParser();
  const raw = readFileSync(new URL('./fixtures/buddy-stream.ndjson', import.meta.url), 'utf8');
  const events = raw.split(/\r?\n/).flatMap(parser);
  assert.ok(events.some((event) => event.kind === 'started' && event.sessionId));
  assert.ok(events.some((event) => event.kind === 'thinking'));
  assert.equal(events.filter((event) => event.kind === 'delta').map((event) => event.text).join(''), '1\n2\n3\n4\n5');
  assert.deepEqual(events.at(-1), {
    kind: 'done', resultText: '1\n2\n3\n4\n5',
    sessionId: '11111111-1111-4111-8111-111111111111',
    costUsd: 0.001, isError: false,
  });
  assert.deepEqual(parser('{"type":"future_event","value":1}'), []);
  assert.deepEqual(parser('not json'), []);
});

test('tool blocks produce one-line summaries and deduplicate repeated assistant messages', () => {
  const parser = createBuddyEventParser();
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a\nfile' } },
  ] } });
  assert.deepEqual(parser(line), [{ kind: 'tool', name: 'Read', inputSummary: '/tmp/a file' }]);
  assert.deepEqual(parser(line), []);
});

test('Buddy data Bash results surface authoritative RECEIPT and ERROR lines once', () => {
  const parser = createBuddyEventParser();
  const toolUse = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tool-data', name: 'Bash', input: {
      command: 'npx tsx /repo/scripts/cove-buddy-data.ts delete contacts --id c1 --confirm-token token',
    } },
  ] } });
  parser(toolUse);
  const result = JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-data', content: [
      { type: 'text', text: 'noise\nRECEIPT {"table":"contacts","action":"delete","id":"c1","summary":"Deleted Jane"}\nERROR {"message":"later warning"}' },
    ] },
  ] } });
  assert.deepEqual(parser(result), [{
    kind: 'data-result',
    changes: [{ table: 'contacts', action: 'delete', id: 'c1', summary: 'Deleted Jane' }],
    sessions: [],
    errors: ['{"message":"later warning"}'],
  }]);
  assert.deepEqual(parser(result), []);
});

test('context overflow detection is narrow to errored context-limit results', () => {
  const base = { kind: 'done', sessionId: 's1', costUsd: 0, isError: true };
  assert.equal(isBuddyContextOverflow({ ...base, resultText: '', errorSubtype: 'context_length_exceeded' }), true);
  assert.equal(isBuddyContextOverflow({ ...base, resultText: 'Prompt is too long for the context window' }), true);
  assert.equal(isBuddyContextOverflow({ ...base, resultText: 'Budget exceeded', errorSubtype: 'budget_exceeded' }), false);
  assert.equal(isBuddyContextOverflow({ ...base, resultText: 'context window exceeded', isError: false }), false);
});

test('schema-checked result events preserve their structured output', () => {
  const parser = createBuddyEventParser({ expectsStructuredOutput: true });
  const [done] = parser(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'session-structured',
    result: '',
    structured_output: {
      assistantText: 'Here is the preview.',
      needsClarification: false,
      operations: [],
    },
    total_cost_usd: 0.01,
    is_error: false,
  }));
  assert.equal(done.kind, 'done');
  assert.deepEqual(JSON.parse(done.resultText), {
    structured_output: {
      assistantText: 'Here is the preview.',
      needsClarification: false,
      operations: [],
    },
  });
});

test('non-schema result events ignore structured_output and keep the plain result text', () => {
  const parser = createBuddyEventParser();
  const [done] = parser(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'session-plain',
    result: 'The plain Buddy answer.',
    structured_output: {
      operations: [{ operation: 'complete_item', itemId: 'private-item' }],
    },
    total_cost_usd: 0.01,
    is_error: false,
  }));
  assert.equal(done.kind, 'done');
  assert.equal(done.resultText, 'The plain Buddy answer.');
});
