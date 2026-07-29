import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReplanCommand,
  parseReplanProposal,
  previewReplan,
  REPLAN_PROPOSAL_JSON_SCHEMA,
} from '../src/lib/buddy/replan.ts';
import { applyAssistantProposal } from '../src/lib/day-plan/assistant-patch.ts';

const plan = {
  id: 'plan-1',
  version: 7,
  state: 'active',
  arrivalState: 'confirmed',
  items: [
    {
      id: 'item-a',
      title: 'Finish the proposal',
      outcome: 'Send a complete proposal for review.',
      owner: 'me',
      position: 0,
      decision: 'accepted',
    },
    {
      id: 'item-b',
      title: 'Review the budget',
      outcome: 'Confirm the final budget.',
      owner: 'me',
      position: 1,
      decision: 'accepted',
    },
  ],
};

test('replan proposal parsing uses the existing validated operation contract', () => {
  const proposal = parseReplanProposal(plan, JSON.stringify({
    structured_output: {
      assistantText: 'I moved the budget review ahead of the proposal.',
      needsClarification: false,
      operations: [{
        operation: 'reorder',
        orderedItemIds: ['item-b', 'item-a'],
      }],
    },
  }));
  assert.deepEqual(previewReplan(plan, proposal), [
    {
      kind: 'move',
      label: 'Review the budget',
      before: 'Priority 2',
      after: 'Priority 1',
    },
    {
      kind: 'move',
      label: 'Finish the proposal',
      before: 'Priority 1',
      after: 'Priority 2',
    },
  ]);
});

test('replan command is bounded, has no tools, and asks only for a preview', () => {
  const command = buildReplanCommand(plan, 'new urgent thing, reshuffle my afternoon');
  assert.deepEqual(
    command.args.slice(command.args.indexOf('--tools'), command.args.indexOf('--tools') + 2),
    ['--tools', ''],
  );
  assert.equal(command.args.includes('--json-schema'), true);
  assert.equal(
    command.args[command.args.indexOf('--json-schema') + 1],
    REPLAN_PROPOSAL_JSON_SCHEMA,
  );
  assert.match(command.stdin, /Do not write anything/);
  assert.match(command.stdin, /Never imply that it is already applied/);
  assert.match(command.stdin, /new urgent thing, reshuffle my afternoon/);
  assert.equal(command.expectsStructuredOutput, true);
});

test('position previews are derived from the actual stable post-apply projection', () => {
  const threeItemPlan = {
    ...structuredClone(plan),
    items: [
      ...structuredClone(plan.items),
      {
        id: 'item-c',
        title: 'Call the client',
        outcome: 'Confirm the launch date.',
        owner: 'me',
        position: 2,
        decision: 'accepted',
      },
    ],
  };
  const proposal = {
    assistantText: 'I moved the client call earlier.',
    needsClarification: false,
    operations: [{
      operation: 'edit_item',
      itemId: 'item-c',
      position: 0,
    }],
  };
  const projected = structuredClone(threeItemPlan);
  applyAssistantProposal(projected, proposal);
  const preview = previewReplan(threeItemPlan, proposal);
  const itemC = projected.items.find((item) => item.id === 'item-c');
  const previewC = preview.find((line) => line.label === 'Call the client');

  assert.equal(itemC.position, 1, 'stable sorting leaves the existing priority-one item first');
  assert.equal(previewC.after, `Priority ${itemC.position + 1}`);
  assert.deepEqual(preview, [
    {
      kind: 'move',
      label: 'Call the client',
      before: 'Priority 3',
      after: 'Priority 2',
    },
    {
      kind: 'move',
      label: 'Review the budget',
      before: 'Priority 2',
      after: 'Priority 3',
    },
  ]);
});
