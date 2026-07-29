import assert from 'node:assert/strict';
import test from 'node:test';
import { guideCopyForRuntime } from '../src/app/guide/page.tsx';

test('the guide advertises local-only features only in local mode', () => {
  const local = guideCopyForRuntime('local');
  assert.match(local.moments.map((moment) => moment.text).join(' '), /reshuffle my afternoon/);
  assert.equal(local.showFeedback, true);
  assert.equal(local.words.some(([word]) => word === 'Recent activity'), true);

  const supabase = guideCopyForRuntime('supabase');
  assert.doesNotMatch(
    supabase.moments.map((moment) => moment.text).join(' '),
    /reshuffle my afternoon/,
  );
  assert.equal(supabase.showFeedback, false);
  assert.equal(supabase.words.some(([word]) => word === 'Recent activity'), false);
});
