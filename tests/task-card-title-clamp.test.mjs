import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './helpers/component-hooks.mjs';

// A board card's description has clamped to one line since it was written. Its
// title never clamped at all, so one long title grew its card until it pushed
// the rest of its column off the board: with a 1845-character title the Not
// Started column held ten tasks and showed three. Measured in a browser, the
// tallest card went from taller than the viewport back to 151px, which is what
// the seeded cards are.

const harness = componentHarness('src/components/tasks/TaskCard.tsx', {
  exportName: 'default',
  mocks: {
    '@dnd-kit/sortable': { useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef() {}, transform: null, transition: null, isDragging: false }) },
    '@dnd-kit/utilities': { CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } },
  },
});

const task = (title) => ({
  _id: 't1', columnId: 'c1', title, description: 'Some description', priority: 'medium',
  tags: [], blocked: false, position: 0, createdAt: 0, updatedAt: 0,
});

const find = (node, test) => !node || typeof node !== 'object' ? null
  : (test(node) ? node : [node.props?.children].flat(Infinity).reduce((hit, child) => hit || find(child, test), null));

function card(title) {
  return harness.render({ task: task(title), onOpenDetail() {}, onCompleteTask() {} });
}

const LONG = 'A task title that just keeps going ' + 'and going '.repeat(180) + 'and stops.';

test("a card's title is held to three lines", () => {
  const title = find(card(LONG), n => typeof n.props?.className === 'string' && n.props.className.includes('water-card-title'));
  assert.ok(title, 'the card no longer has a .water-card-title');
  assert.match(title.props.className, /\bline-clamp-3\b/,
    'the title is unclamped again; one long one grows its card until the column is unusable');
});

test('the whole title is still on the element, so nothing is lost', () => {
  const title = find(card(LONG), n => typeof n.props?.className === 'string' && n.props.className.includes('water-card-title'));
  assert.equal(title.props.title, LONG, 'the full title is no longer available on hover');
  assert.equal([title.props.children].flat(Infinity).join(''), LONG, 'the title is being cut in JavaScript rather than by CSS');
});

test("the description's own clamp is untouched", () => {
  const rendered = card('Short title');
  const description = find(rendered, n => typeof n.props?.className === 'string' && n.props.className.includes('line-clamp-1'));
  assert.ok(description, 'the description line no longer clamps to one line');
});

test('a short title is not touched', () => {
  const short = 'Prep Thursday’s ops review';
  const title = find(card(short), n => typeof n.props?.className === 'string' && n.props.className.includes('water-card-title'));
  assert.equal([title.props.children].flat(Infinity).join(''), short);
});
