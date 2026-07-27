import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExecutionPostBody } from '../src/app/api/day-plan/execution/route.ts';

test('execution route accepts configure and kickoff enums without paths or CLI flags', () => {
  const configured = parseExecutionPostBody({
    action: 'configure',
    planId: 'plan-a',
    itemId: 'item-a',
    expectedVersion: 3,
    mutationId: 'configure:item-a',
    mode: 'plan_review',
    modelAlias: 'fable',
  });
  assert.equal(configured.action, 'configure');
  assert.equal(configured.input.workspaceId, undefined);
  assert.equal(configured.input.modelAlias, 'fable');

  const kickoff = parseExecutionPostBody({
    action: 'kickoff',
    planId: 'plan-a',
    itemId: 'item-a',
    expectedVersion: 3,
    mutationId: 'kickoff:item-a',
    cwd: '/tmp/untrusted',
    permissionMode: 'bypassPermissions',
  });
  assert.deepEqual(kickoff, {
    action: 'kickoff',
    input: {
      planId: 'plan-a',
      itemId: 'item-a',
      expectedVersion: 3,
      mutationId: 'kickoff:item-a',
    },
  });
  assert.throws(
    () => parseExecutionPostBody({
      action: 'configure',
      planId: 'plan-a',
      itemId: 'item-a',
      expectedVersion: 3,
      mutationId: 'configure:item-a:auto',
      mode: 'bypassPermissions',
      modelAlias: 'sonnet',
    }),
    /Unknown execution mode/,
  );
});

test('execution route accepts only a bounded run ID for cancellation', () => {
  assert.deepEqual(parseExecutionPostBody({ action: 'cancel', runId: 'run-123' }), {
    action: 'cancel',
    runId: 'run-123',
  });
  assert.throws(() => parseExecutionPostBody({ action: 'cancel' }), /runId is required/);
});
