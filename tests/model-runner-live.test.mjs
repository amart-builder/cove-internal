import assert from 'node:assert/strict';
import test from 'node:test';

const LIVE = process.env.COVE_MODEL_RUNNER_LIVE === '1';

test('live Codex structured lanes satisfy their real prompt and schema contracts', {
  skip: !LIVE,
  timeout: 40 * 60_000,
}, async (t) => {
  const { runJob } = await import('../src/lib/model-runner.ts');
  const runStructured = async ({ lane, prompt, schema, validate }) => {
    const result = await runJob({
      lane: `live-smoke-${lane}`,
      kind: 'structured',
      prompt,
      schema,
      backend: 'codex-sol-high',
      timeoutMs: 5 * 60_000,
      cwd: process.cwd(),
      validate: (_raw, value) => validate(value),
    });
    assert.equal(
      result.ok,
      true,
      result.ok ? undefined : `${result.error.code}: ${result.error.message}`,
    );
  };

  await t.test('classifier', async () => {
    const {
      buildEmailClassifierPrompt,
      EMAIL_CLASSIFIER_JSON_SCHEMA,
      validateEmailClassification,
    } = await import('../src/lib/email/classifier.ts');
    await runStructured({
      lane: 'email-classifier',
      prompt: buildEmailClassifierPrompt({
        accountEmail: 'alex@example.com',
        sender: 'sam@example.com',
        subject: 'Project note',
        text: 'The draft is attached for context. No reply or action is needed.',
        voice: '',
      }),
      schema: JSON.parse(EMAIL_CLASSIFIER_JSON_SCHEMA),
      validate: validateEmailClassification,
    });
  });

  await t.test('attention sweep', async () => {
    const { buildAttentionSweepPrompt } = await import('../scripts/cove-attention-sweep.mjs');
    const {
      ATTENTION_SWEEP_JSON_SCHEMA,
      validateAttentionSweepOutput,
    } = await import('../src/lib/attention/sweep-protocol.mjs');
    const snapshot = {
      now: '2026-08-28T16:00:00.000Z',
      localDate: '2026-08-28',
      tasks: [],
      commitments: [],
      recentActionLog: [],
      recentPlanEvents: [],
      dayPlan: null,
    };
    await runStructured({
      lane: 'attention-sweep',
      prompt: buildAttentionSweepPrompt(snapshot),
      schema: JSON.parse(ATTENTION_SWEEP_JSON_SCHEMA),
      validate: (value) => validateAttentionSweepOutput(value, snapshot),
    });
  });

  await t.test('progress reconcile', async () => {
    const {
      PROGRESS_JSON_SCHEMA,
      progressPrompt,
      validateProgress,
    } = await import('../scripts/cove-progress-reconcile.mjs');
    const tasks = [];
    const evidenceText = 'No factual work evidence was found.';
    await runStructured({
      lane: 'progress-reconcile',
      prompt: progressPrompt({ project: 'Synthetic smoke project', evidenceText, tasks }),
      schema: PROGRESS_JSON_SCHEMA,
      validate: (value) => validateProgress(value, tasks, evidenceText),
    });
  });

  await t.test('triage', async () => {
    const { buildTriagePrompt } = await import('../src/lib/intake/run.ts');
    const {
      readTriageProtocol,
      TRIAGE_JSON_SCHEMA,
      validateTriageOutput,
    } = await import('../src/lib/triage/protocol.ts');
    await runStructured({
      lane: 'intake-triage',
      prompt: buildTriagePrompt({
        protocol: readTriageProtocol(),
        rawText: 'Review the synthetic project note tomorrow morning.',
        source: 'chat',
        goals: 'Keep the test concise.',
        projects: [],
        board: { tasks: [], columns: [] },
        now: new Date('2026-08-28T16:00:00.000Z'),
      }),
      schema: JSON.parse(TRIAGE_JSON_SCHEMA),
      validate: (value) => validateTriageOutput(value, []),
    });
  });

  await t.test('morning brief', async () => {
    const {
      buildMorningBriefPrompt,
      MORNING_BRIEF_JSON_SCHEMA,
    } = await import('../src/lib/claude-execution/brief-commands.ts');
    const { validateMorningBrief } = await import('../src/lib/day-plan/brief.ts');
    await runStructured({
      lane: 'morning-brief',
      prompt: buildMorningBriefPrompt({
        targetLocalDate: '2026-08-28',
        targetTimezone: 'America/Los_Angeles',
        sections: [],
        manifest: { sources: [], coverage: {} },
      }),
      schema: JSON.parse(MORNING_BRIEF_JSON_SCHEMA),
      validate: (value) => validateMorningBrief(value, {
        knownTaskIds: new Set(),
        sourceIds: new Set(),
      }),
    });
  });

  await t.test('day dump', async () => {
    const {
      buildDayDumpPrompt,
      DAY_DUMP_JSON_SCHEMA,
      validateDayDump,
    } = await import('../src/lib/claude-execution/dump-commands.ts');
    const rawDump = 'Nothing to capture today.';
    await runStructured({
      lane: 'day-dump',
      prompt: buildDayDumpPrompt({
        rawDump,
        targetLocalDate: '2026-08-28',
        planItems: [],
        openCommitments: [],
      }),
      schema: JSON.parse(DAY_DUMP_JSON_SCHEMA),
      validate: (value) => validateDayDump(value, rawDump),
    });
  });

  await t.test('meeting follow-ups fallback', async () => {
    const {
      buildMeetingFollowupsPrompt,
      MEETING_FOLLOWUPS_JSON_SCHEMA,
      validateMeetingFollowUps,
    } = await import('../src/lib/intake/meeting-followups.mjs');
    await runStructured({
      lane: 'meeting-followups',
      prompt: buildMeetingFollowupsPrompt(
        'The meeting ended without any assigned action items.',
        'Alex',
      ),
      schema: MEETING_FOLLOWUPS_JSON_SCHEMA,
      validate: validateMeetingFollowUps,
    });
  });

  await t.test('meeting analyst', async () => {
    const {
      buildMeetingAnalystPrompt,
      MEETING_ANALYST_JSON_SCHEMA,
      validateMeetingAnalystArtifact,
    } = await import('../src/lib/intake/meeting-analysis.ts');
    const timezone = 'America/Los_Angeles';
    await runStructured({
      lane: 'meeting-analyst',
      prompt: buildMeetingAnalystPrompt({
        envelopes: [{
          gmailMessageId: 'synthetic-meeting',
          threadId: 'synthetic-thread',
          tool: 'granola',
          title: 'Tiny synthetic planning call',
          attendees: [{ name: 'Sam Example', email: 'sam@example.com' }],
          durationMinutes: 30,
          body: 'Sam and Alex reviewed progress. No commitments or follow-up work were created.',
          receivedAt: '2026-08-28T16:00:00.000Z',
          fragment: false,
        }],
        contacts: [],
        recentEmailThreads: [],
        goals: 'Do not create busywork.',
        operatorProfile: { name: 'Alex' },
        timezone,
      }),
      schema: MEETING_ANALYST_JSON_SCHEMA,
      validate: (value) => validateMeetingAnalystArtifact(value, timezone),
    });
  });
});
