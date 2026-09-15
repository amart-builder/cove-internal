import assert from 'node:assert/strict';
import test from 'node:test';
import * as presentation from '../src/lib/day-plan/presentation.ts';
import * as briefView from '../src/lib/day-plan/brief-view.ts';
import { componentHarness, findElement, tick } from './helpers/component-hooks.mjs';

test('attached brief without fetched body offers retrieval, never generation', () => {
  for (const state of ['failed', 'deferred', 'succeeded', 'running']) {
    const h = componentHarness('src/components/tasks/arrival/ArrivalStepBrief.tsx', { mocks: {
      '@/lib/day-plan/presentation': presentation,
    } });
    let retries = 0;
    const tree = h.render({ paragraphs: [], watchItems: [], hasBriefContent: false,
      briefWriting: false, briefAttached: true, briefGeneration: { state }, onForceBrief: () => { retries++; } });
    assert.match(JSON.stringify(tree), /Loading your saved brief/);
    assert.doesNotMatch(JSON.stringify(tree), /isn't written|Generate your brief|writing capacity|try again automatically/);
    const button = findElement(tree, 'button');
    assert.equal(button.props.children, 'Retry loading your brief');
    button.props.onClick(); assert.equal(retries, 1);
  }
});

test('saved-brief retry only reads, preserves active Arrival review, and reports failure', async () => {
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const plan = { id: 'day', briefId: 'saved', localDate: today, timezone: 'UTC', state: 'active', arrivalState: 'opened', version: 4, items: [] };
  let reads = 0; let generates = 0; let mutations = 0; let failRead = false; let morningBrief;
  const h = componentHarness('src/components/tasks/useDayRitual.ts', { mocks: {
    '@/lib/day-plan/presentation': presentation,
    '@/lib/runtime/mode': { getRuntimeMode: () => 'local' },
    '@/lib/data/refresh-bus': { useDataChanged() {} },
    '@/lib/day-plan/brief-view': { morningBriefSyncDecision: () => 'keep' },
    '@/lib/data/day-plan': {
      getDayPlanState: async () => { reads++; if (failRead) throw new Error('Loopback unavailable'); return { currentPlan: plan, morningBrief, pendingReconciliations: [], pendingTaskMutations: [] }; },
      forceMorningBrief: async () => { generates++; return {}; },
      mutateDayPlan: async () => { mutations++; throw new Error('Review must not mutate again'); },
    },
  } });
  const props = { enabled: false, candidates: [], candidatesReady: true };
  await h.render(props).openCurrentDayAfterSettlement('2000-01-01');
  let state = h.render(props);
  assert.equal(state.view, 'arrival');
  await state.openArrival(); assert.equal(mutations, 0);
  failRead = true;
  await state.forceBrief(); state = h.render(props);
  assert.equal(reads, 2); assert.equal(generates, 0);
  assert.equal(state.error, "Cove couldn't load your saved brief. Try loading it again.");
  assert.doesNotMatch(state.error, /Loopback unavailable/);
  assert.equal(state.briefGeneration, undefined);
  assert.equal(state.plan.id, 'day');
  failRead = false;
  morningBrief = { id: 'saved', planVersion: 4, narrativeParagraphs: ['The full saved first paragraph.', 'The full saved second paragraph.'] };
  await state.forceBrief(); state = h.render(props);
  assert.equal(reads, 3); assert.equal(generates, 0);
  assert.deepEqual(state.morningBrief.narrativeParagraphs, morningBrief.narrativeParagraphs);
  assert.equal(state.error, undefined);
});

test('local owner descriptions promise chosen-provider manual launch', () => {
  assert.equal(presentation.ownerLabel('claude', 'local'), 'Cove agent');
  for (const owner of ['claude', 'together']) {
    assert.match(presentation.ownerDescription(owner, 'local'), /Today/);
    assert.doesNotMatch(presentation.ownerDescription(owner, 'local'), /Claude|when you start your day|auto-edits/);
  }
  assert.equal(presentation.canStartDayPlanSettlement({ state: 'active', arrivalState: 'opened' }), true);
});


async function briefVersionRace(initialParagraphs = ['Full saved narrative.']) {
  const localDate = new Intl.DateTimeFormat('en-CA').format(new Date());
  const initialPlan = { id: 'current-day', briefId: 'saved-brief', localDate, timezone: 'UTC', state: 'active', arrivalState: 'confirmed', version: 41, items: [] };
  const initialBrief = { id: 'saved-brief', targetLocalDate: localDate, planVersion: 41, narrativeParagraphs: initialParagraphs };
  const pending = [];
  let reads = 0; let mutationVersion = 43; let mutationBriefId = initialPlan.briefId;
  const h = componentHarness('src/components/tasks/useDayRitual.ts', { mocks: {
    '@/lib/day-plan/presentation': presentation,
    '@/lib/runtime/mode': { getRuntimeMode: () => 'local' },
    '@/lib/data/refresh-bus': { useDataChanged() {} },
    '@/lib/day-plan/brief-view': briefView,
    '@/lib/data/day-plan': {
      getDayPlanState: async () => {
        if (++reads === 1) return { currentPlan: initialPlan, morningBrief: initialBrief };
        return new Promise(resolve => pending.push(resolve));
      },
      newDayPlanMutationId: () => 'mutation',
      mutateDayPlan: async () => ({ plan: { ...initialPlan, version: mutationVersion, briefId: mutationBriefId, arrivalState: 'opened' } }),
    },
  } });
  const props = { enabled: false, candidates: [], candidatesReady: true };
  await h.render(props).openCurrentDayAfterSettlement('2000-01-01');
  await h.render(props).openArrival();
  assert.equal(pending.length, 1);
  const bundle = version => ({ currentPlan: { ...initialPlan, version, arrivalState: 'opened' }, morningBrief: { ...initialBrief, planVersion: version } });
  return { h, props, pending, bundle, setMutationVersion: (version, briefId = initialPlan.briefId) => { mutationVersion = version; mutationBriefId = briefId; }, readCount: () => reads };
}

test('post-mutation brief refresh adopts a coherent newer plan and its pinned full narrative', async () => {
  for (const initialParagraphs of [[], ['Full saved narrative.']]) {
  const {h,props,pending,bundle,readCount} = await briefVersionRace(initialParagraphs);
  const response = bundle(50);
  response.currentPlan.items = [{ id: 'still-accepted', decision: 'accepted' }];
  response.morningBrief.narrativeParagraphs = ['First saved paragraph.', 'Second saved paragraph.'];
  pending.shift()(response); await tick();
  const state = h.render(props);
  assert.equal(state.plan.version, 50);
  assert.equal(state.plan.items[0].decision, 'accepted');
  assert.equal(state.view, 'arrival');
  assert.equal(state.morningBrief.planVersion, 50);
  assert.deepEqual(state.morningBrief.narrativeParagraphs, response.morningBrief.narrativeParagraphs);
  assert.equal(readCount(), 2, 'adopting the coherent bundle must not recursively refetch');
  }
});

test('incoherent brief refresh responses never erase held narrative or switch the current day', async () => {
  for (const mismatch of ['plan-id', 'plan-date', 'brief-id', 'brief-date', 'brief-version', 'missing-brief', 'older-plan']) {
    const {h,props,pending,bundle} = await briefVersionRace();
    const response = bundle(50);
    if (mismatch === 'plan-id') response.currentPlan.id = 'another-day';
    if (mismatch === 'plan-date') response.currentPlan.localDate = '2000-01-01';
    if (mismatch === 'brief-id') response.morningBrief.id = 'unattached-brief';
    if (mismatch === 'brief-date') response.morningBrief.targetLocalDate = '2000-01-01';
    if (mismatch === 'brief-version') response.morningBrief.planVersion = 49;
    if (mismatch === 'missing-brief') response.morningBrief = undefined;
    if (mismatch === 'older-plan') response.currentPlan.version = response.morningBrief.planVersion = 42;
    pending.shift()(response); await tick();
    const state = h.render(props);
    assert.equal(state.plan.id, 'current-day', mismatch);
    assert.equal(state.plan.version, 43, mismatch);
    assert.deepEqual(state.morningBrief.narrativeParagraphs, ['Full saved narrative.'], mismatch);
  }
});

test('a pending brief response cannot regress a newer client plan or cross a later day switch', async () => {
  for (const switchDay of [false, true]) {
    const {h,props,pending,bundle,setMutationVersion} = await briefVersionRace();
    const firstResponse = pending.shift();
    if (switchDay) {
      const opening = h.render(props).openCurrentDayAfterSettlement('2000-01-01');
      const nextDay = bundle(1);
      nextDay.currentPlan.id = 'next-day';
      nextDay.currentPlan.localDate = '2099-01-01';
      nextDay.currentPlan.briefId = nextDay.morningBrief.id = 'next-brief';
      nextDay.morningBrief.targetLocalDate = '2099-01-01';
      pending.shift()(nextDay); await opening;
    } else {
      setMutationVersion(54);
      await h.render(props).setOwner('item', 'me');
    }
    firstResponse(bundle(50)); await tick();
    let state = h.render(props);
    assert.equal(state.plan.id, switchDay ? 'next-day' : 'current-day');
    assert.equal(state.plan.version, switchDay ? 1 : 54);
    assert.equal(state.morningBrief.id, switchDay ? 'next-brief' : 'saved-brief');
    if (!switchDay) {
      pending.shift()(bundle(54)); await tick(); state = h.render(props);
      assert.equal(state.morningBrief.planVersion, 54);
    }
  }
});


test('an explicitly changed pinned artifact clears old content and adopts only its own projection', async () => {
  const {h,props,pending,bundle,setMutationVersion} = await briefVersionRace();
  const staleResponse = pending.shift();
  setMutationVersion(54, 'approved-replacement');
  await h.render(props).setOwner('item', 'me');
  assert.equal(h.render(props).morningBrief, undefined, 'previous artifact must not render against the new selection');
  staleResponse(bundle(50)); await tick();
  assert.equal(h.render(props).morningBrief, undefined);
  const replacement = bundle(54);
  replacement.currentPlan.briefId = replacement.morningBrief.id = 'approved-replacement';
  pending.shift()(replacement); await tick();
  assert.equal(h.render(props).morningBrief.id, 'approved-replacement');
});
