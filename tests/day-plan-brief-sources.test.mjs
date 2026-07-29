import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assembleMorningBriefContext,
  validateMorningBrief,
} from '../src/lib/day-plan/brief.ts';
import {
  briefCheckpointSources,
  collectMorningBriefSources,
  emailQueueSource,
  recentBriefsSource,
  resolveBriefFileSourcePolicy,
} from '../src/lib/day-plan/brief-sources.ts';
import {
  verifySourceCheckpoint,
  writeSourceCheckpoint,
} from '../src/lib/day-plan/brief-relay.ts';
import { writeProgressDigestRelay } from '../src/lib/progress/relay.ts';

const NOW = new Date('2026-07-16T12:00:00.000Z');
const MACHINE_ID = '12345678-1234-4234-8234-123456789abc';
const MACHINE = { id: MACHINE_ID, hostname: 'brief-test-mac.local' };

function fixture(t) {
  const dir = path.join(os.tmpdir(), `forge-brief-sources-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'goals.md'), 'Grow Edge AI.');
  writeFileSync(path.join(dir, 'operator-profile.md'), 'Jordan Rivers runs three operating lanes.');
  writeFileSync(path.join(dir, 'leadup.md'), 'This week started with client delivery.');
  writeFileSync(path.join(dir, 'memo.md'), 'Ship the current sprint.');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    options: {
      store: { listRecentSnapshots: () => [] },
      goalsPath: path.join(dir, 'goals.md'),
      operatorProfilePath: path.join(dir, 'operator-profile.md'),
      leadupPath: path.join(dir, 'leadup.md'),
      sprintMemoPath: path.join(dir, 'memo.md'),
      dataDir: dir,
      webBaseUrl: 'http://forge.test',
      targetLocalDate: '2026-07-16',
      targetTimezone: 'America/Los_Angeles',
      now: NOW,
      machineIdentity: MACHINE,
    },
  };
}

function setEnv(t, changes) {
  const previous = new Map();
  for (const [name, value] of Object.entries(changes)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function disableExternalSources(t, dir, overrides = {}) {
  setEnv(t, {
    COVE_BRIEF_COMPOSIO_KEY: '',
    COVE_BRIEF_COMPOSIO_KEY_PATH: path.join(dir, 'missing-composio-key'),
    ATTIO_API_KEY: '',
    ATTIO_TOKEN: '',
    COVE_BRIEF_MEMORY_PATH: '',
    COVE_BRIEF_JARVIS_TOKEN_PATH: path.join(dir, 'missing-jarvis-token'),
    COVE_BRIEF_JARVIS_URL: '',
    // Nothing here may read the installed operator profile: a fresh clone has
    // a different one, or none, and these tests must mean the same thing there.
    COVE_PROFILE_PATH: path.join(dir, 'missing-profile.json'),
    ...overrides,
  });
}

// The profile is runtime wiring for the memory hub and the own-record CRM
// filter, so tests that exercise either one supply their own.
function writeOperatorProfile(t, dir, profile) {
  const profilePath = path.join(dir, 'operator-profile.json');
  writeFileSync(profilePath, JSON.stringify(profile));
  setEnv(t, { COVE_PROFILE_PATH: profilePath });
  return profilePath;
}

function forgeRowsResponse(url) {
  if (!String(url).startsWith('http://forge.test/api/forge-rest/')) return undefined;
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function calendarSse(items) {
  const toolText = JSON.stringify({ data: { results: [{ response: { data: { items } } }] } });
  const message = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { content: [{ type: 'text', text: toolText }] },
  });
  return `event: message\ndata: {"progress":true}\n\nevent: message\ndata: ${message}\n\nevent: ping\ndata: {"keepalive":true}\n\n`;
}

function recentBriefArtifact({
  id,
  date,
  headline,
  candidates,
  finishedAt,
  lensNarrative,
}) {
  const brief = validateMorningBrief({
    headline: typeof headline === 'string' && headline ? headline : 'Temporary headline.',
    narrative_paragraphs: ['The first paragraph.', 'The second paragraph.'],
    existing_task_candidates: [],
    suggested_additions: [],
    watch_items: [],
    sales_actions: [],
  }).brief;
  brief.headline = headline;
  if (lensNarrative !== undefined) brief.lensNarrative = lensNarrative;
  // Stored artifacts are parsed fail-open and may predate current generation
  // limits, so the receipt test deliberately includes duplicates and overflow.
  brief.existingTaskCandidates = candidates.map((candidate) => ({
    taskId: candidate,
    whyToday: `${candidate} matters today.`,
    suggestedOwner: 'me',
    whatClaudeCanStart: '',
    evidenceRefs: ['goals'],
  }));
  return {
    id,
    targetLocalDate: date,
    status: 'succeeded',
    briefJson: JSON.stringify(brief),
    finishedAt,
  };
}

test('brief file policy treats empty env values as unset and prefers env, client goals, then legacy', (t) => {
  const dir = path.join(os.tmpdir(), `forge-source-policy-${process.pid}-${Date.now()}-${Math.random()}`);
  const homeDir = path.join(dir, 'home');
  const dataDir = path.join(dir, 'data');
  const legacyGoals = path.join(homeDir, 'Atlas', 'brain', 'GOALS.md');
  const clientGoals = path.join(dataDir, 'brief', 'goals.md');
  const envGoals = path.join(dir, 'configured-goals.md');
  mkdirSync(path.dirname(legacyGoals), { recursive: true });
  mkdirSync(path.dirname(clientGoals), { recursive: true });
  writeFileSync(legacyGoals, 'Legacy goals.');
  writeFileSync(clientGoals, 'Client goals.');
  writeFileSync(envGoals, 'Configured goals.');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setEnv(t, {
    COVE_BRIEF_GOALS_PATH: '   ',
    COVE_BRIEF_SPRINT_MEMO_PATH: '',
    COVE_BRIEF_OPERATOR_PROFILE_PATH: '',
    COVE_BRIEF_LEADUP_PATH: '',
    COVE_PROFILE_PATH: undefined,
  });

  assert.equal(
    resolveBriefFileSourcePolicy({ dataDir, homeDir }).goals.path,
    clientGoals,
  );
  process.env.COVE_BRIEF_GOALS_PATH = `  ${envGoals}  `;
  assert.equal(
    resolveBriefFileSourcePolicy({ dataDir, homeDir }).goals.path,
    envGoals,
  );
  process.env.COVE_BRIEF_GOALS_PATH = '';
  rmSync(clientGoals);
  assert.equal(
    resolveBriefFileSourcePolicy({ dataDir, homeDir }).goals.path,
    legacyGoals,
  );
});

test('an absent default sprint memo is optional in collection and checkpoint verification', async (t) => {
  const dir = path.join(os.tmpdir(), `forge-optional-sprint-${process.pid}-${Date.now()}-${Math.random()}`);
  const homeDir = path.join(dir, 'home');
  const dataDir = path.join(dir, 'data');
  const clientGoals = path.join(dataDir, 'brief', 'goals.md');
  mkdirSync(path.dirname(clientGoals), { recursive: true });
  writeFileSync(clientGoals, 'Client goals.');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  disableExternalSources(t, dataDir, {
    COVE_BRIEF_GOALS_PATH: '',
    COVE_BRIEF_SPRINT_MEMO_PATH: '',
    COVE_BRIEF_OPERATOR_PROFILE_PATH: '',
    COVE_BRIEF_LEADUP_PATH: '',
    COVE_PROFILE_PATH: path.join(dataDir, 'cove-profile.json'),
    COVE_SUPERNOVA_DIR: path.join(dir, 'missing-beacon'),
  });

  const collected = await collectMorningBriefSources({
    store: { listRecentSnapshots: () => [] },
    homeDir,
    dataDir,
    webBaseUrl: 'http://forge.test',
    targetLocalDate: '2026-07-16',
    targetTimezone: 'America/Los_Angeles',
    now: NOW,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  const sprint = collected.sources.find((source) => source.id === 'sprint_memo');
  assert.equal(sprint.required, false);
  assert.equal(sprint.content, undefined);

  const checkpointSources = briefCheckpointSources({ dataDir, homeDir });
  assert.equal(checkpointSources.sprint_memo.required, false);
  assert.equal(writeSourceCheckpoint({ sources: checkpointSources, dataDir, now: NOW }), true);
  assert.deepEqual(
    verifySourceCheckpoint({ sources: checkpointSources, dataDir, now: NOW }),
    { ok: true },
  );
});

test('operator profile falls back to a bounded readable JSON whitelist', async (t) => {
  const dir = path.join(os.tmpdir(), `forge-json-profile-${process.pid}-${Date.now()}-${Math.random()}`);
  const homeDir = path.join(dir, 'home');
  const dataDir = path.join(dir, 'data');
  mkdirSync(path.join(dataDir, 'brief'), { recursive: true });
  writeFileSync(path.join(dataDir, 'brief', 'goals.md'), 'Client goals.');
  writeFileSync(path.join(dataDir, 'cove-profile.json'), JSON.stringify({
    name: 'Jordan',
    timezone: 'America/New_York',
    workday: { starts: '08:30', ends: '17:30' },
    responsibilities: ['Client delivery', 'Sales'],
    ninety_day_outcomes: ['Reach a durable revenue target'],
    communication_style: 'Direct and concise',
    key_people: [{ name: 'Taylor', role: 'Client sponsor' }],
    money: { monthly_target: '$50k' },
    authoritative_source: 'A private task system',
    api_token: 'must-not-appear',
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  disableExternalSources(t, dataDir, {
    COVE_BRIEF_GOALS_PATH: '',
    COVE_BRIEF_SPRINT_MEMO_PATH: '',
    COVE_BRIEF_OPERATOR_PROFILE_PATH: '',
    COVE_BRIEF_LEADUP_PATH: '',
    COVE_PROFILE_PATH: path.join(dataDir, 'cove-profile.json'),
    COVE_SUPERNOVA_DIR: path.join(dir, 'missing-beacon'),
  });
  const collected = await collectMorningBriefSources({
    store: { listRecentSnapshots: () => [] },
    homeDir,
    dataDir,
    webBaseUrl: 'http://forge.test',
    targetLocalDate: '2026-07-16',
    targetTimezone: 'America/New_York',
    now: NOW,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  const profile = collected.sources.find((source) => source.id === 'operator_profile');
  assert.match(profile.content, /^Name: Jordan/m);
  assert.match(profile.content, /Responsibilities:\n- Client delivery\n- Sales/);
  assert.match(profile.content, /Key People:/);
  assert.match(profile.content, /Monthly Target: \$50k/);
  assert.equal(profile.content.includes('api_token'), false);
  assert.equal(profile.content.includes('must-not-appear'), false);
  assert.equal(profile.content.includes('authoritative_source'), false);
  assert.equal(profile.content.includes('private task system'), false);
  assert.ok(profile.content.length <= profile.maxChars);
});

test('calendar fetches MCP SSE, derives DST-aware bounds, and formats visible events', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir, { COVE_BRIEF_COMPOSIO_KEY: 'composio-test-key' });
  const requests = [];
  let initializeResponse;
  const items = [
    {
      summary: 'Strategy call',
      start: { dateTime: '2026-11-01T09:00:00-08:00' },
      end: { dateTime: '2026-11-01T09:30:00-08:00' },
      attendees: [
        { email: 'jordan@example.com', self: true, responseStatus: 'accepted' },
        { email: 'one@example.com' },
        { email: 'two@example.com' },
        { email: 'three@example.com' },
        { email: 'four@example.com' },
      ],
      hangoutLink: 'https://meet.google.com/example',
    },
    { summary: 'Planning day', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } },
    {
      summary: 'Malformed time',
      start: { dateTime: 'not-a-date' },
      end: { dateTime: '2026-11-01T10:30:00-08:00' },
    },
    {
      summary: 'Prep session',
      start: { dateTime: '2026-11-03T14:00:00-08:00' },
      end: { dateTime: '2026-11-03T15:00:00-08:00' },
    },
    {
      summary: 'Declined event',
      start: { dateTime: '2026-11-01T11:00:00-08:00' },
      end: { dateTime: '2026-11-01T12:00:00-08:00' },
      attendees: [{ email: 'jordan@example.com', self: true, responseStatus: 'declined' }],
    },
  ];
  const fetchImpl = async (url, init = {}) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    requests.push(JSON.parse(init.body));
    assert.ok(init.signal instanceof AbortSignal);
    if (requests.length === 1) {
      initializeResponse = new Response('{"initialized":true}', {
        status: 200,
        headers: { 'mcp-session-id': 'session-1' },
      });
      return initializeResponse;
    }
    return new Response(calendarSse(items), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const collected = await collectMorningBriefSources({
    ...options,
    targetLocalDate: '2026-11-01',
    now: new Date('2026-11-01T16:00:00.000Z'),
    fetchImpl,
  });
  const calendar = collected.sources.find((source) => source.id === 'calendar');
  assert.equal(
    calendar.content,
    'Window: 2026-11-01 to 2026-11-07 (7 days). 4 events.\n\n' +
      'Sunday, Nov 1\n' +
      'all day: Planning day\n' +
      '9:00am-9:30am: Strategy call (with one@example.com, two@example.com, three@example.com) [Meet]\n' +
      'time unknown: Malformed time\n\n' +
      'Tuesday, Nov 3\n' +
      '2:00pm-3:00pm: Prep session',
  );
  assert.equal(initializeResponse.bodyUsed, true);
  assert.equal(calendar.priority, 7);
  assert.equal(calendar.label, 'CALENDAR');
  assert.equal(calendar.maxChars, 5000);
  const toolArguments = requests[1].params.arguments.tools[0].arguments;
  assert.equal(toolArguments.timeMin, '2026-11-01T00:00:00-07:00');
  assert.equal(toolArguments.timeMax, '2026-11-08T00:00:00-08:00');
});

test('completed_recently keeps only done tasks from the previous 48 hours', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const recent = new Date(NOW.getTime() - 47 * 60 * 60 * 1000).toISOString();
  const old = new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString();
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/api/forge-rest/tasks')) {
        return new Response(JSON.stringify([
          { id: 'recent', title: 'Shipped client handoff', project: 'client', status: 'done', updated_at: recent },
          { id: 'old', title: 'Old completed task', project: 'internal', status: 'done', updated_at: old },
          { id: 'open', title: 'Still open', project: 'client', status: 'open', updated_at: NOW.toISOString() },
        ]), { status: 200 });
      }
      return forgeRowsResponse(url);
    },
  });
  const completed = collected.sources.find((source) => source.id === 'completed_recently');
  assert.equal(
    completed.content,
    `- "Shipped client handoff" project=client updated=${recent}`,
  );
  assert.equal(completed.asOf, recent);
  assert.equal(completed.required, false);
  assert.equal(completed.maxChars, 3000);
  assert.equal(completed.priority, 6);
});

test('completed_recently states when no task was finished in the window', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.equal(
    collected.sources.find((source) => source.id === 'completed_recently').content,
    'Nothing marked done in the last two days.',
  );
});

test('completed_recently caps the list at 15 tasks and reports the remainder', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const rows = Array.from({ length: 17 }, (_, index) => ({
    id: `done-${index}`,
    title: `Completed task ${String(index).padStart(2, '0')}`,
    project: 'forge',
    status: 'done',
    updated_at: new Date(NOW.getTime() - index * 60_000).toISOString(),
  }));
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/forge-rest/tasks')) {
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      return forgeRowsResponse(url);
    },
  });
  const lines = collected.sources
    .find((source) => source.id === 'completed_recently')
    .content
    .split('\n');
  assert.equal(lines.length, 16);
  assert.match(lines[0], /^- "Completed task 00" project=forge updated=/);
  assert.match(lines[14], /^- "Completed task 14" project=forge updated=/);
  assert.equal(lines[15], '+2 more');
});

test('calendar reports not_configured for a missing key file', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const collected = await collectMorningBriefSources({ ...options, fetchImpl: async (url) => forgeRowsResponse(url) });
  const calendar = collected.sources.find((source) => source.id === 'calendar');
  assert.equal(calendar.content, undefined);
  assert.equal(calendar.note, 'not_configured');
});

test('calendar fetch failures stay optional and leave the other sources available', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir, { COVE_BRIEF_COMPOSIO_KEY: 'composio-test-key' });
  const fetchImpl = async (url) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    throw new Error('gateway unavailable');
  };
  const collected = await collectMorningBriefSources({ ...options, fetchImpl });
  assert.match(collected.sources.find((source) => source.id === 'calendar').note, /^error:gateway unavailable/);
  assert.equal(collected.sources.find((source) => source.id === 'goals').content, 'Grow Edge AI.');
  assert.ok(collected.sources.find((source) => source.id === 'task_snapshot').content);
});

test('CRM handles Attio value variants and formats recent and quiet contacts', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir, { ATTIO_API_KEY: 'attio-test-key' });
  writeOperatorProfile(t, dir, { self_emails: ['operator@example.com'] });
  const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const records = [
    {
      values: {
        name: [{ full_name: 'Alice Adams' }],
        last_email_interaction: [{ interacted_at: daysAgo(2), interaction_type: 'email' }],
        // Email wins even though the general interaction is newer.
        last_interaction: [{ interacted_at: daysAgo(1), interaction_type: 'meeting' }],
      },
    },
    {
      values: {
        name: [{ first_name: 'Bob', last_name: 'Baker' }],
        last_email_interaction: [{ value: { interacted_at: daysAgo(20), interaction_type: 'email' } }],
      },
    },
    {
      values: {
        name: [{ full_name: 'Cara Cole' }],
        last_email_interaction: [],
        last_interaction: [{ interacted_at: daysAgo(3), interaction_type: 'call' }],
      },
    },
    {
      values: {
        name: [{ full_name: 'Timezone Tina' }],
        last_interaction: [{ interacted_at: '2026-07-14T02:00:00.000Z', interaction_type: 'meeting' }],
      },
    },
    {
      values: {
        name: [],
        email_addresses: [{ value: { email_address: 'fallback@example.com' } }],
        last_interaction: [{ interacted_at: daysAgo(4), interaction_type: 'email' }],
      },
    },
    {
      values: {
        name: [],
        email_addresses: [],
        last_interaction: [{ interacted_at: daysAgo(5), interaction_type: 'call' }],
      },
    },
    {
      values: {
        name: [{ full_name: 'Riley Operator' }],
        email_addresses: [
          { email_address: 'other@example.com' },
          // Case-insensitive match against the profile's self_emails.
          { value: { email_address: 'Operator@Example.com' } },
        ],
        last_interaction: [{ interacted_at: daysAgo(1), interaction_type: 'email' }],
      },
    },
    {
      values: {
        name: [{ full_name: 'Dormant Dana' }],
        last_email_interaction: [{ interacted_at: daysAgo(121) }],
      },
    },
    { values: { name: [{ full_name: 'No History' }], last_email_interaction: [], last_interaction: [] } },
  ];
  const fetchImpl = async (url, init = {}) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    assert.equal(String(url), 'https://api.attio.com/v2/objects/people/records/query');
    assert.deepEqual(JSON.parse(init.body), {
      limit: 250,
      sorts: [{ attribute: 'last_interaction', field: 'interacted_at', direction: 'desc' }],
    });
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ data: { data: records } }), { status: 200 });
  };
  const collected = await collectMorningBriefSources({ ...options, fetchImpl });
  const crm = collected.sources.find((source) => source.id === 'crm_last_touch');
  assert.equal(
    crm.content,
    'Recent touches:\nAlice Adams: last touch 2d ago (2026-07-14, email)\nTimezone Tina: last touch 2d ago (2026-07-13, meeting)\nCara Cole: last touch 3d ago (2026-07-13, call)\nfallback@example.com: last touch 4d ago (2026-07-12, email)\nBob Baker: last touch 20d ago (2026-06-26, email)\nDormant Dana: last touch 121d ago (2026-03-17)\n\nGone quiet (>14d): Bob Baker',
  );
  assert.equal(crm.content.includes('fallback@example.com: last touch 4d ago'), true);
  assert.equal(crm.content.includes('Riley Operator'), false);
  assert.equal(crm.priority, 10);
});

test('the own-record CRM filter comes from the profile and defaults to filtering nothing', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir, { ATTIO_API_KEY: 'attio-test-key' });
  const records = [{
    values: {
      name: [{ full_name: 'Riley Operator' }],
      email_addresses: [{ value: { email_address: 'Operator@Example.com' } }],
      last_interaction: [{ interacted_at: new Date(NOW.getTime() - 86_400_000).toISOString(), interaction_type: 'email' }],
    },
  }];
  const fetchImpl = async (url) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    return new Response(JSON.stringify({ data: { data: records } }), { status: 200 });
  };
  const withoutProfile = await collectMorningBriefSources({ ...options, fetchImpl });
  assert.equal(
    withoutProfile.sources.find((source) => source.id === 'crm_last_touch').content.includes('Riley Operator'),
    true,
  );

  writeOperatorProfile(t, dir, { self_emails: ['  OPERATOR@example.com  ', '', 7] });
  const withProfile = await collectMorningBriefSources({ ...options, fetchImpl });
  assert.equal(
    withProfile.sources.find((source) => source.id === 'crm_last_touch').content.includes('Riley Operator'),
    false,
  );
});

test('.env.local strips unquoted inline comments but preserves hashes inside quotes', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir, { ATTIO_API_KEY: undefined });
  const previousCwd = process.cwd();
  const authorizations = [];
  const fetchImpl = async (url, init = {}) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    assert.equal(String(url), 'https://api.attio.com/v2/objects/people/records/query');
    authorizations.push(init.headers.Authorization);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  try {
    process.chdir(dir);
    writeFileSync(path.join(dir, '.env.local'), 'ATTIO_API_KEY=unquoted-secret # operator note\n');
    await collectMorningBriefSources({ ...options, fetchImpl });
    writeFileSync(path.join(dir, '.env.local'), 'ATTIO_API_KEY="quoted # secret"\n');
    await collectMorningBriefSources({ ...options, fetchImpl });
  } finally {
    process.chdir(previousCwd);
  }
  assert.deepEqual(authorizations, [
    'Bearer unquoted-secret',
    'Bearer quoted # secret',
  ]);
});

test('CRM reports not_configured when neither Attio credential is present', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const collected = await collectMorningBriefSources({ ...options, fetchImpl: async (url) => forgeRowsResponse(url) });
  assert.equal(collected.sources.find((source) => source.id === 'crm_last_touch').note, 'not_configured');
});

test('memory decisions prefer decision-tagged Jarvis results and bound each line', async (t) => {
  const { dir, options } = fixture(t);
  setEnv(t, { COVE_OPERATOR_NAME: 'Jordan Rivers' });
  const tokenPath = path.join(dir, 'jarvis-token');
  writeFileSync(tokenPath, 'jarvis-test-token\n');
  disableExternalSources(t, dir, {
    COVE_BRIEF_JARVIS_TOKEN_PATH: tokenPath,
    // The trailing slash also pins the normalization.
    COVE_BRIEF_JARVIS_URL: 'http://memory.test/',
  });
  const longDecision = `[DECISION] ${'x'.repeat(450)}`;
  const requests = [];
  const resultsByQuery = new Map([
    ['recent decisions, commitments, and direction changes', [
      { uuid: 'long', score: 0.9, content: longDecision },
      { uuid: 'background', score: 0.4, content: 'Background context that should be filtered out.' },
      { uuid: 'forge', score: 0.8, content: '[DECISION] Keep Cove as the command center.' },
    ]],
    ['what Jordan Rivers worked on in Claude sessions the last three days', [
      { uuid: 'forge', score: 0.95, content: '[DECISION] Keep Cove as the source of truth.' },
      { uuid: 'route', score: 0.7, content: '[DECISION] Route from the latest saved state.' },
    ]],
    ["current state of the operator's active projects and business lines", [
      { uuid: 'jarvis', score: 0.6, content: '[DECISION] Keep Pilot Pro moving.' },
    ]],
  ]);
  const fetchImpl = async (url, init = {}) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    assert.equal(String(url), 'http://memory.test/api/v2/scored_search');
    const body = JSON.parse(init.body);
    requests.push(body.query);
    assert.equal(body.limit, 12);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ results: resultsByQuery.get(body.query) }), { status: 200 });
  };
  const collected = await collectMorningBriefSources({ ...options, fetchImpl });
  const memory = collected.sources.find((source) => source.id === 'memory_decisions');
  const lines = memory.content.split('\n');
  assert.deepEqual(requests, [...resultsByQuery.keys()]);
  assert.equal(lines.length, 4);
  assert.equal(lines[1].length, 402);
  assert.equal(lines.filter((line) => line.includes('Keep Cove')).length, 1);
  assert.equal(memory.content.includes('Background context'), false);
  assert.equal(memory.priority, 11);
});

test('memory decisions preserve file-path mode without calling Jarvis', async (t) => {
  const { dir, options } = fixture(t);
  const memoryPath = path.join(dir, 'decisions.md');
  writeFileSync(memoryPath, '[DECISION] Preserve the file fallback.\n');
  disableExternalSources(t, dir);
  const fetchImpl = async (url) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    throw new Error(`unexpected network call: ${url}`);
  };
  const collected = await collectMorningBriefSources({ ...options, memoryDecisionsPath: memoryPath, fetchImpl });
  const memory = collected.sources.find((source) => source.id === 'memory_decisions');
  assert.equal(memory.content, '[DECISION] Preserve the file fallback.\n');
  assert.equal(memory.note, memoryPath);
});

test('memory decisions resolve the hub from env, then the profile, and otherwise degrade', async (t) => {
  const { dir, options } = fixture(t);
  const tokenPath = path.join(dir, 'jarvis-token');
  writeFileSync(tokenPath, 'jarvis-test-token');
  disableExternalSources(t, dir, { COVE_BRIEF_JARVIS_TOKEN_PATH: tokenPath });
  const requested = [];
  const fetchImpl = async (url) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    requested.push(String(url));
    return new Response(JSON.stringify({ results: [{ uuid: 'a', score: 1, content: '[DECISION] Configured.' }] }), { status: 200 });
  };

  // No hub anywhere: a missing optional source, and nothing is dialed.
  const unconfigured = await collectMorningBriefSources({ ...options, fetchImpl });
  const missing = unconfigured.sources.find((source) => source.id === 'memory_decisions');
  assert.equal(missing.note, 'not_configured');
  assert.equal(missing.content, undefined);
  assert.equal(missing.required, false);
  assert.deepEqual(requested, []);

  // The profile supplies the address when the env does not.
  writeOperatorProfile(t, dir, { memory_hub_url: 'http://profile-hub.test' });
  const fromProfile = await collectMorningBriefSources({ ...options, fetchImpl });
  assert.match(fromProfile.sources.find((source) => source.id === 'memory_decisions').content, /Configured\./);
  assert.deepEqual([...new Set(requested)], ['http://profile-hub.test/api/v2/scored_search']);

  // An explicit env value outranks the profile.
  requested.length = 0;
  setEnv(t, { COVE_BRIEF_JARVIS_URL: 'http://env-hub.test' });
  await collectMorningBriefSources({ ...options, fetchImpl });
  assert.deepEqual([...new Set(requested)], ['http://env-hub.test/api/v2/scored_search']);
});

test('memory decisions report not_configured when the hub token file is missing', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const collected = await collectMorningBriefSources({ ...options, fetchImpl: async (url) => forgeRowsResponse(url) });
  assert.equal(collected.sources.find((source) => source.id === 'memory_decisions').note, 'not_configured');
});

test('memory decisions stop after the first Jarvis search fails', async (t) => {
  const { dir, options } = fixture(t);
  const tokenPath = path.join(dir, 'jarvis-token');
  writeFileSync(tokenPath, 'jarvis-test-token');
  disableExternalSources(t, dir, {
    COVE_BRIEF_JARVIS_TOKEN_PATH: tokenPath,
    COVE_BRIEF_JARVIS_URL: 'http://memory.test',
  });
  let searches = 0;
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      const forge = forgeRowsResponse(url);
      if (forge) return forge;
      searches += 1;
      throw new Error('Jarvis unavailable');
    },
  });
  const memory = collected.sources.find((source) => source.id === 'memory_decisions');
  assert.equal(searches, 1);
  assert.match(memory.note, /^error:Jarvis unavailable/);
});

test('untriaged inbound is prominent, counts spool lines, and treats Waiting as in flight', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  mkdirSync(path.join(dir, 'intake'), { recursive: true });
  writeFileSync(
    path.join(dir, 'intake', 'spool-test.jsonl'),
    `${JSON.stringify({ source: 'chat', sourceId: 'spooled', rawText: 'spooled', createdAt: NOW.toISOString() })}\n`,
  );
  writeFileSync(
    path.join(dir, 'intake', 'heartbeats.json'),
    JSON.stringify({
      version: 2,
      machines: {
        [MACHINE_ID]: {
          hostname: MACHINE.hostname,
          meeting_watch: {
            last_run_at: '2026-07-16T11:40:00.000Z',
            examined: 3,
            matched: 1,
            processed: 1,
            errors: 0,
            dead_letters: 0,
            disabled: false,
            operator_unconfigured: true,
          },
        },
      },
    }),
  );
  const inbound = [
    {
      id: 'inbound-1',
      source: 'email',
      source_id: 'thread-1',
      raw_text: 'First line\nSecond line',
      state: 'pending',
      attempts: 0,
      created_at: '2026-07-16T10:30:00.000Z',
    },
    {
      id: 'inbound-2',
      source: 'meeting',
      source_id: 'meeting-1',
      raw_text: 'Client escalation',
      state: 'failed',
      attempts: 5,
      created_at: '2026-07-14T12:00:00.000Z',
    },
    {
      id: 'resolved',
      source: 'chat',
      source_id: 'done',
      raw_text: 'Do not show this.',
      state: 'triaged',
      attempts: 1,
      created_at: NOW.toISOString(),
    },
  ];
  let inboundUrl = '';
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/api/forge-rest/inbound_events')) {
        inboundUrl = value;
        return new Response(JSON.stringify(inbound), { status: 200 });
      }
      if (value.includes('/api/forge-rest/tasks')) {
        return new Response(JSON.stringify([
          {
            id: 'waiting-1',
            column_id: 'waiting',
            title: 'Waiting on signed scope',
            project: 'client-delivery',
            status: 'open',
            priority: 'medium',
            tags: [],
          },
          {
            id: 'backlog-1',
            column_id: 'backlog',
            title: 'Backlog item stays visible',
            project: 'forge',
            status: 'open',
            priority: 'low',
            tags: [],
          },
        ]), { status: 200 });
      }
      if (value.includes('/api/forge-rest/task_columns')) {
        return new Response(JSON.stringify([
          { id: 'waiting', name: 'Waiting' },
          { id: 'backlog', name: 'Backlog' },
        ]), { status: 200 });
      }
      return forgeRowsResponse(url);
    },
  });
  const source = collected.sources.find((entry) => entry.id === 'untriaged_inbound');
  assert.equal(source.label, 'UNTRIAGED_INBOUND');
  assert.equal(source.priority, 0);
  assert.match(
    inboundUrl,
    /select=source,raw_text,state,created_at&state=in\.\(pending,failed\)&order=created_at\.asc&limit=50$/,
  );
  assert.match(source.content, /\[pending\] source=email age=1h text="First line\\nSecond line"/);
  assert.match(source.content, /\[failed\] source=meeting age=2d text="Client escalation"/);
  assert.doesNotMatch(source.content, /Do not show this/);
  assert.match(source.content, /Spool lines waiting: 1\./);
  assert.match(
    source.content,
    /Meeting watcher heartbeat: age=20m examined=3 matched=1 processed=1 errors=0 dead_letters=0\./,
  );
  assert.match(
    source.content,
    /Set your name in Setup so meeting follow-ups route to you\./,
  );
  const tasks = collected.sources.find((entry) => entry.id === 'task_snapshot');
  assert.match(
    tasks.content,
    /\[in_flight\] id=waiting-1 "Waiting on signed scope" priority=medium project=client-delivery candidate_ok/,
  );
  assert.match(
    tasks.content,
    /\[not_started\] id=backlog-1 "Backlog item stays visible" priority=low project=forge/,
  );

  const warning = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/forge-rest/inbound_events')) {
        return new Response('table missing', { status: 404 });
      }
      return forgeRowsResponse(url);
    },
  });
  const warningSource = warning.sources.find((entry) => entry.id === 'untriaged_inbound');
  assert.match(warningSource.content, /^WARNING: inbound inbox unavailable/);
  assert.match(warningSource.content, /Spool lines waiting: 1\./);

  writeFileSync(
    path.join(dir, 'intake', 'heartbeats.json'),
    JSON.stringify({
      version: 2,
      machines: {
        [MACHINE_ID]: {
          hostname: MACHINE.hostname,
          meeting_watch: {
            last_run_at: '2026-07-16T10:00:00.000Z',
            examined: 0,
            matched: 0,
            processed: 0,
            errors: 1,
          },
        },
      },
    }),
  );
  const stale = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    stale.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /WARNING: meeting watcher heartbeat is stale \(age=2h/,
  );

  writeFileSync(
    path.join(dir, 'intake', 'heartbeats.json'),
    JSON.stringify({
      version: 2,
      machines: {
        [MACHINE_ID]: {
          hostname: MACHINE.hostname,
          meeting_watch: {
            last_run_at: NOW.toISOString(),
            examined: 0,
            matched: 0,
            processed: 0,
            errors: 0,
            dead_letters: 2,
            disabled: false,
          },
        },
      },
    }),
  );
  const deadLetters = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    deadLetters.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /WARNING: meeting watcher has 2 dead letters/,
  );

  writeFileSync(
    path.join(dir, 'intake', 'heartbeats.json'),
    JSON.stringify({
      version: 2,
      machines: {
        [MACHINE_ID]: {
          hostname: MACHINE.hostname,
          meeting_watch: {
            last_run_at: NOW.toISOString(),
            disabled: true,
          },
        },
      },
    }),
  );
  const disabled = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    disabled.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /WARNING: meeting watcher DISABLED\./,
  );
});

test('missing background heartbeats warn only after their lanes were installed', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const beforeInstall = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    beforeInstall.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /Meeting watcher is not installed on this Mac\./,
  );
  assert.doesNotMatch(
    beforeInstall.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /WARNING: meeting watcher/,
  );
  assert.match(
    beforeInstall.sources.find((entry) => entry.id === 'project_progress').content,
    /Progress reconciler is not installed on this Mac\./,
  );
  assert.doesNotMatch(
    beforeInstall.sources.find((entry) => entry.id === 'project_progress').content,
    /WARNING: progress reconciler/,
  );

  mkdirSync(path.join(dir, 'intake'), { recursive: true });
  writeFileSync(
    path.join(dir, 'intake', 'installed-lanes.json'),
    JSON.stringify({
      version: 3,
      machines: {
        '87654321-4321-4321-8321-cba987654321': {
          hostname: 'some-other-mac.local',
          meeting_watch: { installed_at: NOW.toISOString() },
          progress_reconcile: { installed_at: NOW.toISOString() },
        },
      },
    }),
  );
  const otherMachineOnly = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.doesNotMatch(
    otherMachineOnly.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /WARNING: meeting watcher/,
  );
  assert.doesNotMatch(
    otherMachineOnly.sources.find((entry) => entry.id === 'project_progress').content,
    /WARNING: progress reconciler/,
  );

  writeFileSync(
    path.join(dir, 'intake', 'installed-lanes.json'),
    JSON.stringify({
      version: 3,
      machines: {
        [MACHINE_ID]: {
          hostname: MACHINE.hostname,
          meeting_watch: { installed_at: NOW.toISOString() },
          progress_reconcile: { installed_at: NOW.toISOString() },
        },
      },
    }),
  );
  const afterInstall = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    afterInstall.sources.find((entry) => entry.id === 'untriaged_inbound').content,
    /WARNING: meeting watcher heartbeat unavailable/,
  );
  assert.match(
    afterInstall.sources.find((entry) => entry.id === 'project_progress').content,
    /WARNING: progress reconciler heartbeat unavailable/,
  );
});

test('brief reads owner health without letting a local stand-down marker hide warnings', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const ownerId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  mkdirSync(path.join(dir, 'intake'), { recursive: true });
  writeFileSync(path.join(dir, 'cove-lane-owners.json'), JSON.stringify({
    version: 2,
    lanes: {
      meeting_watch: {
        id: ownerId,
        hostname_at_claim: 'mini.local',
        claimed_at: NOW.toISOString(),
      },
      progress: {
        id: ownerId,
        hostname_at_claim: 'mini.local',
        claimed_at: NOW.toISOString(),
      },
    },
  }));
  writeFileSync(path.join(dir, 'intake', 'heartbeats.json'), JSON.stringify({
    version: 2,
    machines: {
      [ownerId]: {
        hostname: 'mini.lan',
        meeting_watch: {
          last_run_at: NOW.toISOString(),
          examined: 5,
          matched: 2,
          processed: 1,
          errors: 1,
          dead_letters: 2,
        },
        progress_reconcile: {
          last_run_at: '2026-07-16T09:00:00.000Z',
          projects_active: 2,
          digests_written: 1,
          suggestions_filed: 0,
          skipped_no_new_evidence: 0,
          malformed_ping_lines: 0,
          errors: 0,
        },
      },
      [MACHINE_ID]: {
        hostname: MACHINE.hostname,
        meeting_watch: {
          standing_down: true,
          owner_id: ownerId,
          owner_hostname_at_claim: 'mini.local',
          observed_at: NOW.toISOString(),
        },
        progress_reconcile: {
          standing_down: true,
          owner_id: ownerId,
          owner_hostname_at_claim: 'mini.local',
          observed_at: NOW.toISOString(),
        },
      },
    },
  }));

  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  const inbound = collected.sources.find(
    (source) => source.id === 'untriaged_inbound',
  );
  const progress = collected.sources.find(
    (source) => source.id === 'project_progress',
  );
  assert.match(inbound.content, /WARNING: meeting watcher has 2 dead letters/);
  assert.match(
    inbound.content,
    /Local Mac standing down: mini\.local owns this lane\./,
  );
  assert.match(
    progress.content,
    /WARNING: progress reconciler heartbeat is stale/,
  );
  assert.match(
    progress.content,
    /Local Mac standing down: mini\.local owns this lane\./,
  );
});

test('brief keeps reading the local owner heartbeat after its hostname changes', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  mkdirSync(path.join(dir, 'intake'), { recursive: true });
  writeFileSync(path.join(dir, 'cove-lane-owners.json'), JSON.stringify({
    version: 2,
    lanes: {
      meeting_watch: {
        id: MACHINE_ID,
        hostname_at_claim: 'brief-test-mac.local',
        claimed_at: NOW.toISOString(),
      },
      progress: {
        id: MACHINE_ID,
        hostname_at_claim: 'brief-test-mac.local',
        claimed_at: NOW.toISOString(),
      },
    },
  }));
  writeFileSync(path.join(dir, 'intake', 'heartbeats.json'), JSON.stringify({
    version: 2,
    machines: {
      [MACHINE_ID]: {
        hostname: 'brief-test-mac.lan',
        meeting_watch: {
          last_run_at: NOW.toISOString(),
          examined: 1,
          matched: 1,
          processed: 1,
          errors: 0,
          dead_letters: 0,
        },
        progress_reconcile: {
          last_run_at: NOW.toISOString(),
          projects_active: 1,
          digests_written: 1,
          suggestions_filed: 0,
          skipped_no_new_evidence: 0,
          malformed_ping_lines: 0,
          errors: 0,
        },
      },
    },
  }));
  const collected = await collectMorningBriefSources({
    ...options,
    machineIdentity: {
      id: MACHINE_ID,
      hostname: 'brief-test-mac.lan',
    },
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    collected.sources.find((source) => source.id === 'untriaged_inbound').content,
    /Meeting watcher heartbeat:/,
  );
  assert.match(
    collected.sources.find((source) => source.id === 'project_progress').content,
    /Progress reconciler heartbeat:/,
  );
  assert.doesNotMatch(
    collected.sources.find((source) => source.id === 'untriaged_inbound').content,
    /standing down/,
  );
});

test('computed commitments source exposes open loops, clarification, and factual content gaps', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const engineDir = path.join(dir, 'beacon-engine');
  const queueDir = path.join(engineDir, 'pipeline', 'queue');
  const postedDir = path.join(engineDir, 'pipeline', 'posted');
  mkdirSync(queueDir, { recursive: true });
  mkdirSync(postedDir, { recursive: true });
  writeFileSync(path.join(queueDir, 'scheduled.md'), [
    '---',
    'status: scheduled',
    'scheduled_for: 2026-07-16T15:00:00Z',
    '---',
  ].join('\n'));
  writeFileSync(path.join(queueDir, 'review.md'), [
    '---',
    'status: review',
    '---',
  ].join('\n'));
  writeFileSync(path.join(postedDir, 'posted.md'), [
    '---',
    'status: scheduled',
    'posted_at: 2026-07-16T18:00:00Z',
    '---',
  ].join('\n'));
  setEnv(t, {
    COVE_SUPERNOVA_DIR: engineDir,
    COVE_CONTENT_QUOTA_POSTS: '3',
  });
  const commitments = [
    {
      id: 'follow-1',
      kind: 'follow_up',
      title: 'Send Maya the proposal',
      counterparty: 'Maya',
      source_kind: 'brain_dump',
      source_quote: 'I promised Maya the proposal.',
      due_at: '2026-07-16T17:00:00-07:00',
      review_at: null,
      confidence: 'low',
      confirmed: false,
      status: 'open',
      created_at: '2026-07-01T12:00:00.000Z',
      updated_at: '2026-07-01T12:00:00.000Z',
    },
    {
      id: 'overnight-1',
      kind: 'overnight_request',
      title: 'Draft the FAQ overnight',
      source_kind: 'brain_dump',
      source_quote: 'Draft the FAQ overnight.',
      due_at: null,
      review_at: '2026-07-19T09:00:00-07:00',
      confidence: 'high',
      confirmed: false,
      status: 'open',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  ];
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/forge-rest/commitments')) {
      return new Response(JSON.stringify(commitments), { status: 200 });
    }
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    throw new Error(`unexpected network call: ${url}`);
  };
  const collected = await collectMorningBriefSources({ ...options, fetchImpl });
  const source = collected.sources.find((entry) => entry.id === 'commitments');
  assert.equal(source.label, 'OPEN_COMMITMENTS_AND_GAPS');
  assert.equal(source.required, false);
  assert.equal(source.maxChars, 9000);
  assert.equal(source.priority, 5);
  assert.equal(source.freshness, 'current');
  assert.match(source.content, /FOLLOW_UP:\n- Send Maya the proposal \| counterparty=Maya/);
  assert.match(source.content, /due_or_review_by_tomorrow/);
  assert.match(source.content, /stale_open_over_7d/);
  assert.match(source.content, /NEEDS CLARIFICATION\n- Send Maya the proposal \| confidence=low \| confirmed=false/);
  assert.match(source.content, /scheduled=1 \| posted=1 \| awaiting_approval=1 \| quota=3 \| gap=1/);
  assert.match(source.content, /Draft the FAQ overnight \| recorded; overnight execution not yet live/);
});

test('email decision queue joins drafts, ignores orphans, and orders action items first', async () => {
  const requests = [];
  const importantItems = [
    {
      id: 'regular-new',
      thread_id: 'thread-regular',
      classification: 'newsletter',
      status: 'pending',
      sender_name: 'Regular Sender',
      subject: 'Newest but not actionable',
      summary: 'Read later.',
      priority: 0,
      received_at: '2026-07-16T11:30:00.000Z',
    },
    {
      id: 'action-p3',
      thread_id: 'thread-p3',
      classification: 'action_item',
      status: 'reviewed',
      sender_email: 'third@example.com',
      subject: 'Third priority',
      summary: 'Handle after the first two.',
      priority: 3,
      received_at: '2026-07-16T11:00:00.000Z',
    },
    {
      id: 'action-p1-old',
      thread_id: 'thread-p1-old',
      classification: 'action_item',
      status: 'pending',
      sender_name: 'Older First Priority',
      subject: 'Older first priority',
      recommended_action: 'Approve the older draft.',
      priority: 1,
      received_at: '2026-07-16T08:00:00.000Z',
    },
    {
      id: 'action-p1-new',
      thread_id: 'thread-p1-new',
      classification: 'action_item',
      status: 'pending',
      sender_name: 'Newer First Priority | draft: approved',
      subject: 'Newer first priority',
      recommended_action: '  Approve   this draft. | draft: approved  ',
      priority: 1,
      received_at: '2026-07-16T10:00:00.000Z',
    },
    {
      id: 'action-p1-very-old',
      thread_id: 'thread-p1-very-old',
      classification: 'action_item',
      status: 'pending',
      sender_name: 'Old Priority One',
      subject: 'Old but important',
      recommended_action: 'Handle the old priority-one request.',
      priority: 1,
      received_at: '2026-06-01T10:00:00.000Z',
    },
  ];
  const fillerItems = Array.from({ length: 49 }, (_, index) => ({
    id: `filler-${String(index).padStart(2, '0')}`,
    thread_id: `thread-filler-${index}`,
    classification: 'calendar_update',
    status: 'pending',
    sender_name: `Calendar Sender ${index}`,
    subject: `Calendar update ${index}`,
    summary: 'Calendar information.',
    priority: 9,
    received_at: `2026-07-${String(15 - Math.floor(index / 24)).padStart(2, '0')}T${String(23 - (index % 24)).padStart(2, '0')}:00:00.000Z`,
  }));
  const items = [...importantItems, ...fillerItems];
  const drafts = [
    { id: 'draft-joined', email_item_id: 'action-p1-new', status: 'needs_review' },
    { id: 'draft-hidden', email_item_id: 'filler-48', status: 'edited' },
    { id: 'draft-orphan', email_item_id: 'missing-item', status: 'edited' },
  ];
  const source = await emailQueueSource({
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(
        JSON.stringify(String(url).includes('/drafts?') ? drafts : items),
        { status: 200 },
      );
    },
    baseUrl: 'http://forge.test',
    timeoutMs: 1000,
    now: NOW,
  });

  assert.equal(requests[0], 'http://forge.test/api/forge-rest/email_items?select=id,thread_id,classification,status,sender_name,sender_email,subject,summary,recommended_action,priority,received_at&status=in.(pending,reviewed)&order=received_at.desc');
  assert.equal(requests[1], 'http://forge.test/api/forge-rest/drafts?select=id,email_item_id,status&status=in.(needs_review,approved,edited)&order=updated_at.desc');
  assert.match(source.content, /^showing 25 of 54 open items \(2 with a draft waiting\)\./);
  const lines = source.content.split('\n').slice(1);
  assert.equal(lines.length, 25);
  assert.match(
    lines[0],
    /"Newer First Priority \| draft: approved" "Newer first priority" \| ask: "Approve this draft\. \| draft: approved" \| draft: needs_review \| age: 2h/,
  );
  assert.match(lines[1], /Older First Priority" "Older first priority"/);
  assert.match(lines[2], /Old Priority One" "Old but important"/);
  assert.match(lines[3], /third@example\.com" "Third priority"/);
  assert.match(lines[4], /Regular Sender" "Newest but not actionable"/);
  assert.equal(source.content.includes('Calendar update 48'), false);
  assert.equal(source.content.includes('draft-orphan'), false);
  assert.equal(source.maxChars, 12000);
  assert.equal(source.priority, 7);
});

test('email decision queue reports empty state and fails open on fetch errors', async () => {
  const empty = await emailQueueSource({
    fetchImpl: async () => new Response('[]', { status: 200 }),
    baseUrl: 'http://forge.test',
    timeoutMs: 1000,
    now: NOW,
  });
  assert.equal(empty.content, 'No open email items.');

  const failed = await emailQueueSource({
    fetchImpl: async (url) => {
      if (String(url).includes('/email_items?')) throw new Error('email items unavailable');
      return new Response('[]', { status: 200 });
    },
    baseUrl: 'http://forge.test',
    timeoutMs: 1000,
    now: NOW,
  });
  assert.equal(failed.content, undefined);
  assert.equal(failed.note, 'error:email items unavailable');
});

test('recent brief receipts distinguish decisions, settlements, and sales states', () => {
  const artifacts = {
    '2026-07-28': [
      recentBriefArtifact({
        id: 'brief-tue',
        date: '2026-07-28',
        headline: 'Finish the install preparation.',
        candidates: [
          'task-gary',
          'task-zac',
          'task-done',
          'task-preselected',
          'task-later',
          'task-missing',
          'task-gary',
        ],
        finishedAt: '2026-07-28T14:00:00.000Z',
      }),
      recentBriefArtifact({
        id: 'brief-tue-newer',
        date: '2026-07-28',
        headline: 'This newer brief was never attached.',
        candidates: ['task-wrong-artifact'],
        finishedAt: '2026-07-28T15:00:00.000Z',
      }),
    ],
    '2026-07-27': [
      recentBriefArtifact({
        id: 'brief-mon',
        date: '2026-07-27',
        headline: 'Send the client plan.',
        candidates: ['task-plan'],
        finishedAt: '2026-07-27T14:00:00.000Z',
      }),
    ],
    '2026-07-24': [
      recentBriefArtifact({
        id: 'brief-fri',
        date: '2026-07-24',
        headline: 'Use Friday to clear the launch block.',
        candidates: ['task-no-plan'],
        finishedAt: '2026-07-24T14:00:00.000Z',
      }),
    ],
    '2026-07-23': [
      recentBriefArtifact({
        id: 'brief-thu-legacy',
        date: '2026-07-23',
        headline: null,
        lensNarrative: 'Legacy first sentence. Legacy second sentence.',
        candidates: [],
        finishedAt: '2026-07-23T14:00:00.000Z',
      }),
    ],
    '2026-07-22': [
      recentBriefArtifact({
        id: 'brief-wed-empty',
        date: '2026-07-22',
        headline: null,
        lensNarrative: '   ',
        candidates: [],
        finishedAt: '2026-07-22T14:00:00.000Z',
      }),
    ],
  };
  const plans = {
    '2026-07-28': {
      id: 'plan-tue',
      briefId: 'brief-tue',
      items: [
        { taskId: 'task-gary', title: 'Gary install prep', decision: 'accepted' },
        { taskId: 'task-zac', title: 'Zac call plan', decision: 'dismissed' },
        { taskId: 'task-done', title: 'Send final scope', decision: 'completed' },
        { taskId: 'task-preselected', title: 'Unopened arrival item', decision: 'preselected' },
        { taskId: 'task-later', title: 'Review next week', decision: 'later' },
      ],
    },
    '2026-07-27': {
      id: 'plan-mon',
      briefId: 'brief-mon',
      items: [
        { taskId: 'task-plan', title: 'Client delivery plan', decision: 'accepted' },
      ],
    },
    '2026-07-23': {
      id: 'plan-thu',
      items: [],
    },
    '2026-07-24': {
      id: 'plan-fri',
      briefId: 'brief-fri-missing',
      items: [],
    },
  };
  const source = recentBriefsSource({
    store: {
      listMorningBriefs: (date) => artifacts[date] ?? [],
      getPlanForDate: (date) => plans[date],
      getSnapshot: (planId) => planId === 'plan-tue'
        ? {
            body: {
              completedHumanTaskIds: ['task-done'],
              unresolvedItems: [
                { taskId: 'task-gary', disposition: 'carry' },
              ],
            },
          }
        : undefined,
      listMorningBriefSalesActionStates: (briefId) => briefId === 'brief-tue'
        ? [
            { state: 'skipped' },
            { state: 'skipped' },
            { state: 'skipped' },
            { state: 'skipped' },
            { state: 'future_state' },
          ]
        : [{ state: 'approved' }, { state: 'edited' }],
    },
    targetLocalDate: '2026-07-29',
    now: new Date('2026-07-29T14:00:00.000Z'),
  });

  assert.equal(source.maxChars, 8000);
  assert.match(source.content, /not evidence/i);
  assert.match(source.content, /work never decided/);
  assert.match(source.content, /2026-07-28: Finish the install preparation\./);
  assert.equal(source.content.includes('This newer brief was never attached.'), false);
  assert.match(
    source.content,
    /candidates: 'Gary install prep' accepted then carry; 'Zac call plan' dismissed then not_settled; 'Send final scope' accepted then done; 'Unopened arrival item' not_decided then not_settled; 'Review next week' set_aside then not_settled; taskId=task-missing dropped_before_arrival \| sales: 4 skipped/,
  );
  assert.equal(source.content.includes("'task-missing'"), false);
  assert.equal(source.content.match(/Gary install prep/g)?.length, 1);
  assert.match(
    source.content,
    /candidates: 'Client delivery plan' accepted then not_settled \| sales: 1 approved, 1 edited/,
  );
  const lines = source.content.split('\n');
  const fridayIndex = lines.findIndex((line) => line.includes('2026-07-24:'));
  assert.ok(fridayIndex >= 0);
  assert.match(lines[fridayIndex], /Use Friday to clear the launch block\./);
  assert.match(lines[fridayIndex], /\(not the brief attached to the plan\)$/);
  assert.equal(lines[fridayIndex + 1]?.startsWith('  candidates:') ?? false, false);
  assert.match(
    source.content,
    /2026-07-23: Legacy first sentence\. \(not the brief attached to the plan\)/,
  );
  assert.equal(source.content.includes('2026-07-22:'), false);
});

test('project progress source shows yesterday and today digests and heartbeat warnings', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  mkdirSync(path.join(dir, 'intake'), { recursive: true });
  writeFileSync(path.join(dir, 'intake', 'heartbeats.json'), JSON.stringify({
    version: 2,
    machines: {
      [MACHINE_ID]: {
        hostname: MACHINE.hostname,
        progress_reconcile: {
          last_run_at: '2026-07-16T11:30:00.000Z',
          projects_active: 1,
          digests_written: 1,
          suggestions_filed: 1,
          errors: 0,
        },
      },
    },
  }));
  const store = {
    listRecentSnapshots: () => [],
    listSessionDigests: () => [{
      id: 'digest-1',
      runAt: '2026-07-16T11:00:00.000Z',
      project: 'catalyst',
      summary: 'The launch path moved forward.',
      perTask: [{
        task_id: 'task-1',
        progress: 'likely_done',
        evidence_quote: 'abc123 Finish launch route',
        note: 'The launch route appears complete.',
        scope_changed: false,
      }],
      evidence: {},
      createdAt: '2026-07-16T11:00:00.000Z',
    }],
  };
  const collected = await collectMorningBriefSources({
    ...options,
    store,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  const progress = collected.sources.find((source) => source.id === 'project_progress');
  assert.equal(progress.label, 'PROJECT_PROGRESS');
  assert.match(progress.content, /PROJECT SUMMARIES\n- catalyst: The launch path moved forward\./);
  assert.match(progress.content, /task_id=task-1 progress=likely_done/);
  assert.match(progress.content, /evidence="abc123 Finish launch route"/);
  assert.match(progress.content, /Progress reconciler heartbeat: age=30m/);

  writeFileSync(path.join(dir, 'intake', 'heartbeats.json'), JSON.stringify({
    version: 2,
    machines: {
      [MACHINE_ID]: {
        hostname: MACHINE.hostname,
        progress_reconcile: {
          last_run_at: '2026-07-16T09:00:00.000Z',
          projects_active: 0,
          digests_written: 0,
          suggestions_filed: 0,
          errors: 0,
        },
      },
    },
  }));
  const stale = await collectMorningBriefSources({
    ...options,
    store,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    stale.sources.find((source) => source.id === 'project_progress').content,
    /WARNING: progress reconciler heartbeat is stale \(age=3h/,
  );
});

test('a due autonomy check-in is included in collected brief sources', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  writeFileSync(path.join(dir, 'cove-autonomy.json'), JSON.stringify({
    level: 'groundwork',
    first_groundwork_at: '2026-07-02T12:00:00.000Z',
    checkin_answered: false,
    checkin_presented_count: 0,
  }));
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  const checkin = collected.sources.find(
    (source) => source.id === 'autonomy_checkin',
  );
  assert.equal(checkin.label, 'AUTONOMY_CHECK_IN');
  assert.match(checkin.content, /Groundwork has been running for two weeks/);
});

test('project progress falls back to the immutable Mini digest relay', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  mkdirSync(path.join(dir, 'intake'), { recursive: true });
  writeFileSync(path.join(dir, 'intake', 'heartbeats.json'), JSON.stringify({
    version: 2,
    machines: {
      [MACHINE_ID]: {
        hostname: MACHINE.hostname,
        progress_reconcile: {
          last_run_at: NOW.toISOString(),
          projects_active: 1,
          digests_written: 1,
          suggestions_filed: 0,
          skipped_no_new_evidence: 0,
          malformed_ping_lines: 0,
          errors: 0,
        },
      },
    },
  }));
  writeProgressDigestRelay({
    dataDir: dir,
    digest: {
      id: 'progress-0123456789abcdef0123456789abcdef',
      runAt: '2026-07-16T11:00:00.000Z',
      project: 'forge',
      summary: 'Relayed progress reached the MacBook brief.',
      perTask: [],
      evidence: { fingerprint: 'one' },
    },
  });
  const collected = await collectMorningBriefSources({
    ...options,
    store: {
      listRecentSnapshots: () => [],
      listSessionDigests: () => [],
    },
    fetchImpl: async (url) => forgeRowsResponse(url),
  });
  assert.match(
    collected.sources.find((source) => source.id === 'project_progress').content,
    /forge: Relayed progress reached the MacBook brief\./,
  );
});

test('commitments source surfaces recent note resolutions and updates in the required section order', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  const recent = new Date(NOW.getTime() - 35 * 60 * 60 * 1000).toISOString();
  const expired = new Date(NOW.getTime() - 37 * 60 * 60 * 1000).toISOString();
  const open = [
    {
      id: 'updated-1',
      kind: 'promise',
      title: 'Meet Morgan',
      source_kind: 'brain_dump',
      source_quote: 'Get the meeting time.',
      confidence: 'high',
      confirmed: true,
      status: 'open',
      evidence: JSON.stringify({
        updated_by: 'day_dump',
        updated_at: recent,
        quote: 'Morgan confirmed Tuesday 2pm.',
      }),
      created_at: recent,
      updated_at: recent,
    },
    {
      id: 'proposed-1',
      kind: 'follow_up',
      title: 'Casey checklist',
      source_kind: 'brain_dump',
      source_quote: 'Check on Casey.',
      confidence: 'medium',
      confirmed: false,
      status: 'open',
      evidence: JSON.stringify({
        proposed_resolution: {
          action: 'done',
          quote: "Casey's checklist should be handled.",
          confidence: 'medium',
        },
      }),
      created_at: recent,
      updated_at: recent,
    },
  ];
  const done = [
    {
      id: 'resolved-1',
      title: 'Get the Harbor AI jam time',
      status: 'done',
      evidence: JSON.stringify({
        resolved_by: 'day_dump',
        resolved_at: recent,
        quote: `Morgan confirmed Tuesday 2pm ${'x'.repeat(180)}`,
      }),
      updated_at: recent,
    },
    {
      id: 'resolved-old',
      title: 'Old resolution',
      status: 'done',
      evidence: JSON.stringify({
        resolved_by: 'day_dump',
        resolved_at: expired,
        quote: 'This is outside the cutoff.',
      }),
      updated_at: expired,
    },
  ];
  const collected = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/api/forge-rest/commitments')) {
        return new Response(JSON.stringify(value.includes('status=eq.done') ? done : open), { status: 200 });
      }
      return forgeRowsResponse(url);
    },
  });
  const content = collected.sources.find((entry) => entry.id === 'commitments').content;
  assert.match(content, /Meet Morgan.*updated_from_your_notes/);
  assert.match(content, /Casey checklist \| you said: "Casey's checklist should be handled\." \| proposed: close/);
  assert.match(content, /RESOLVED FROM YOUR NOTES\n- Get the Harbor AI jam time \| you said: "Morgan confirmed Tuesday 2pm x+/);
  assert.equal(content.includes('Old resolution'), false);
  assert.equal(content.match(/Morgan confirmed Tuesday 2pm x+/)[0].length < 180, true);
  const headings = [
    'OPEN COMMITMENTS',
    'NEEDS CLARIFICATION',
    'RESOLVED FROM YOUR NOTES',
    'CONTENT QUOTA',
    'OVERNIGHT REQUESTS',
  ];
  assert.deepEqual([...headings].sort((left, right) => content.indexOf(left) - content.indexOf(right)), headings);

  const empty = await collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/forge-rest/')) {
        return new Response('[]', { status: 200 });
      }
      return forgeRowsResponse(url);
    },
  });
  assert.equal(
    empty.sources.find((entry) => entry.id === 'commitments').content.includes('RESOLVED FROM YOUR NOTES'),
    false,
  );
});

test('commitments source marks either partial fetch failure without asserting false emptiness', async (t) => {
  const { dir, options } = fixture(t);
  disableExternalSources(t, dir);
  setEnv(t, { COVE_SUPERNOVA_DIR: path.join(dir, 'missing-engine') });
  const recent = new Date(NOW.getTime() - 60_000).toISOString();
  const open = [{
    id: 'open-1',
    kind: 'follow_up',
    title: 'Send the follow-up',
    source_kind: 'manual',
    source_quote: 'Send the follow-up.',
    confidence: 'high',
    confirmed: true,
    status: 'open',
    created_at: recent,
    updated_at: recent,
  }];
  const done = [{
    id: 'done-1',
    title: 'Confirm the meeting time',
    status: 'done',
    evidence: JSON.stringify({
      resolved_by: 'day_dump',
      resolved_at: recent,
      quote: 'The meeting time is confirmed.',
    }),
    updated_at: recent,
  }];
  const collect = (failedStatus) => collectMorningBriefSources({
    ...options,
    fetchImpl: async (url) => {
      const value = String(url);
      if (value.includes('/api/forge-rest/commitments')) {
        const status = value.includes('status=eq.done') ? 'done' : 'open';
        if (status === failedStatus) throw new Error(`${status} commitments unavailable`);
        return new Response(JSON.stringify(status === 'done' ? done : open), { status: 200 });
      }
      return forgeRowsResponse(url);
    },
  });

  const openFailed = (await collect('open')).sources.find((entry) => entry.id === 'commitments');
  assert.match(openFailed.content, /^OPEN COMMITMENTS\nUnavailable \(fetch failed\)\./);
  assert.equal(openFailed.content.includes('OPEN COMMITMENTS\nNone.'), false);
  assert.match(openFailed.content, /RESOLVED FROM YOUR NOTES\n- Confirm the meeting time/);
  assert.equal(
    openFailed.note,
    'error:open commitments unavailable;content_engine_unavailable',
    'the partial fetch note composes with the independent quota-source note',
  );

  const doneFailed = (await collect('done')).sources.find((entry) => entry.id === 'commitments');
  assert.match(doneFailed.content, /OPEN COMMITMENTS\nFOLLOW_UP:\n- Send the follow-up/);
  assert.equal(doneFailed.content.includes('RESOLVED FROM YOUR NOTES'), false);
  assert.equal(
    doneFailed.note,
    'error:done commitments unavailable;content_engine_unavailable',
  );
});

test('real source ids overwrite coverage fallbacks, while failed fetches remain missing', async (t) => {
  const { dir, options } = fixture(t);
  const tokenPath = path.join(dir, 'jarvis-token');
  writeFileSync(tokenPath, 'jarvis-test-token');
  disableExternalSources(t, dir, {
    COVE_BRIEF_COMPOSIO_KEY: 'composio-test-key',
    ATTIO_API_KEY: 'attio-test-key',
    COVE_BRIEF_JARVIS_TOKEN_PATH: tokenPath,
    COVE_BRIEF_JARVIS_URL: 'http://memory.test',
  });
  const successFetch = async (url, init = {}) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    if (String(url).includes('connect.composio.dev')) {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return new Response('{}', { status: 200, headers: { 'mcp-session-id': 'session-1' } });
      }
      return new Response(calendarSse([]), { status: 200 });
    }
    if (String(url).includes('api.attio.com')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  const included = await collectMorningBriefSources({ ...options, fetchImpl: successFetch });
  assert.deepEqual(
    included.sources.map((source) => [source.id, source.priority]),
    [
      ['day_dump', 0],
      ['recent_dumps', 2],
      ['recent_briefs', 3],
      ['untriaged_inbound', 0],
      ['project_progress', 1],
      ['recent_activity', 4],
      ['recurring_rhythm', 5],
      ['stale_tasks', 5],
      ['goals', 1],
      ['operator_profile', 2],
      ['leadup', 3],
      ['sprint_memo', 4],
      ['commitments', 5],
      ['email_queue', 7],
      ['completed_recently', 6],
      ['task_snapshot', 6],
      ['calendar', 7],
      ['settlement_summary', 8],
      ['email_brief', 9],
      ['crm_last_touch', 10],
      ['memory_decisions', 11],
    ],
  );
  assert.deepEqual(
    included.sources
      .filter((source) => source.id === 'operator_profile' || source.id === 'leadup')
      .map(({ id, label, required, maxChars }) => ({ id, label, required, maxChars })),
    [
      { id: 'operator_profile', label: 'OPERATOR_PROFILE', required: false, maxChars: 6000 },
      { id: 'leadup', label: 'LEADUP', required: false, maxChars: 9000 },
    ],
  );
  assert.equal(included.sources.find((source) => source.id === 'goals').maxChars, 20000);
  const includedCoverage = assembleMorningBriefContext(included.sources, { now: NOW }).manifest.coverage;
  assert.equal(includedCoverage.calendar, 'included');
  assert.equal(includedCoverage.crm_last_touch, 'included');
  assert.equal(includedCoverage.memory_decisions, 'included');

  const failedFetch = async (url) => {
    const forge = forgeRowsResponse(url);
    if (forge) return forge;
    throw new Error('network down');
  };
  const failed = await collectMorningBriefSources({ ...options, fetchImpl: failedFetch });
  const failedCoverage = assembleMorningBriefContext(failed.sources, { now: NOW }).manifest.coverage;
  assert.equal(failedCoverage.calendar, 'missing');
  assert.equal(failedCoverage.crm_last_touch, 'missing');
});

test('a tight budget drops the lowest-ranked sources and keeps the highest intact', () => {
  // Trimming runs from the highest priority number down, so what he set as his
  // goals survives a budget that erases last night's settlement recap.
  const sources = [
    { id: 'goals', label: 'GOALS', required: true, maxChars: 9000, priority: 1, content: 'A'.repeat(300) },
    { id: 'settlement_summary', label: 'RECENT_SETTLEMENTS', required: false, maxChars: 4000, priority: 8, content: 'B'.repeat(3000) },
    { id: 'leadup', label: 'LEADUP', required: false, maxChars: 9000, priority: 3, content: 'C'.repeat(3000) },
  ];
  const assembled = assembleMorningBriefContext(sources, { now: NOW, totalMaxChars: 3200 });
  const report = (id) => assembled.manifest.sources.find((source) => source.id === id);
  assert.equal(report('goals').chars, 300);
  assert.equal(report('goals').trimmed, false);
  assert.equal(report('settlement_summary').chars, 0);
  assert.equal(
    assembled.sections.find((section) => section.id === 'goals').text,
    'A'.repeat(300),
  );
});
