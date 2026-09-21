import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractMeetingFollowUps,
  parseNextSteps,
  parseNextStepsBlock,
} from '../src/lib/intake/meeting-followups.mjs';

// Granola and Gemini summaries bracket the lines that have an assignee and
// leave the rest plain, so a real set of notes usually looks like this.
const MIXED = `Next steps:
- [Gary] Send the pricing sheet to Ben
- Follow up with legal on the MSA
- [Ben] Share the security questionnaire
* Book the venue for the offsite
`;

const ALL_OWNED = `Next steps:
- [Gary] Send the pricing sheet to Ben
- [Ben] Share the security questionnaire
`;

const NONE_OWNED = `Next steps:
- Follow up with legal on the MSA
- Book the venue for the offsite
`;

function recordingFallback(items) {
  const calls = [];
  const fallback = (text) => {
    calls.push(text);
    return items;
  };
  return { calls, fallback };
}

test('the parser says when it could not read the whole block', () => {
  assert.equal(parseNextStepsBlock(MIXED).complete, false);
  assert.equal(parseNextStepsBlock(ALL_OWNED).complete, true);
  assert.equal(parseNextStepsBlock('No next steps here.').complete, true);
  // The narrow reading is unchanged: it still only understands [Owner] bullets.
  assert.deepEqual(parseNextSteps(MIXED).map((item) => item.owner), ['Gary', 'Ben']);
});

test('mixed notes go to the model instead of losing the plain bullets', async () => {
  const { calls, fallback } = recordingFallback([
    { owner: 'Gary', title: 'Send the pricing sheet to Ben', detail: '' },
    { owner: 'Gary', title: 'Follow up with legal on the MSA', detail: '' },
    { owner: 'Ben', title: 'Share the security questionnaire', detail: '' },
    { owner: 'Gary', title: 'Book the venue for the offsite', detail: '' },
  ]);
  const items = await extractMeetingFollowUps(MIXED, { fallback });

  assert.equal(calls.length, 1, 'one bracketed bullet used to suppress the model entirely');
  assert.equal(items.length, 4);
  assert.ok(
    items.some((item) => item.title === 'Follow up with legal on the MSA'),
    'the unbracketed follow-up used to vanish with nothing recording it',
  );
});

test('notes the parser can read in full still cost no model call', async () => {
  const { calls, fallback } = recordingFallback([]);
  const items = await extractMeetingFollowUps(ALL_OWNED, { fallback });

  assert.equal(calls.length, 0);
  assert.deepEqual(items.map((item) => item.owner), ['Gary', 'Ben']);
});

test('notes with no owners at all still go to the model, as before', async () => {
  const { calls, fallback } = recordingFallback([
    { owner: 'Gary', title: 'Follow up with legal on the MSA', detail: '' },
  ]);
  const items = await extractMeetingFollowUps(NONE_OWNED, { fallback });

  assert.equal(calls.length, 1);
  assert.equal(items.length, 1);
});

test('a model that fails leaves the partial list rather than the whole meeting', async () => {
  const items = await extractMeetingFollowUps(MIXED, {
    fallback: () => {
      throw new Error('claude_unavailable');
    },
  });

  // Not everything, but the caller treats a throw as a failed meeting job, and
  // two follow-ups on the board beat five retries and a dead job.
  assert.deepEqual(items.map((item) => item.owner), ['Gary', 'Ben']);
});
