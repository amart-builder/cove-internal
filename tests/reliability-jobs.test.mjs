import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { listFailures, recordFailure } from '../src/lib/reliability/failures.ts';
import { JobScheduler } from '../src/lib/reliability/jobs.ts';
import { listRecentReceipts } from '../src/lib/reliability/receipts.ts';

function schedulerFixture(t, options = {}) {
  const dbPath = path.join(
    os.tmpdir(),
    `cove-jobs-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  let current = new Date('2026-07-28T12:00:00.000Z');
  const scheduler = new JobScheduler({
    dbPath,
    now: () => current,
    leaseMs: 1_000,
    backoffBaseMs: 1_000,
    maxBackoffMs: 8_000,
    ...options,
  });
  t.after(() => {
    scheduler.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });
  return {
    dbPath,
    scheduler,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

test('jobs drain by priority, dedupe by idempotency key, and record completions', async (t) => {
  const { dbPath, scheduler } = schedulerFixture(t);
  const order = [];
  scheduler.register('work', (job) => {
    order.push(job.payload.name);
  });
  scheduler.enqueue({
    type: 'work',
    payload: { name: 'low' },
    priority: 1,
    idempotencyKey: 'work:low',
  });
  const high = scheduler.enqueue({
    type: 'work',
    payload: { name: 'high' },
    priority: 10,
    idempotencyKey: 'work:high',
  });
  const replay = scheduler.enqueue({
    type: 'work',
    payload: { name: 'different' },
    priority: 99,
    idempotencyKey: 'work:high',
  });

  assert.equal(high.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.job.id, high.job.id);
  assert.deepEqual(await scheduler.runAvailable(), {
    claimed: 2,
    done: 2,
    failed: 0,
    dead: 0,
    recovered: 0,
  });
  assert.deepEqual(order, ['high', 'low']);
  assert.equal(listRecentReceipts({ dbPath, source: 'scheduler' }).length, 2);
});

test('failed jobs use exponential backoff and clear their issue after success', async (t) => {
  const { dbPath, scheduler, advance } = schedulerFixture(t);
  let calls = 0;
  scheduler.register('retry', () => {
    calls += 1;
    if (calls < 3) throw new Error(`attempt ${calls} failed`);
  });
  const { job } = scheduler.enqueue({
    type: 'retry',
    idempotencyKey: 'retry:one',
    maxAttempts: 3,
  });

  assert.equal((await scheduler.runAvailable()).failed, 1);
  assert.equal(scheduler.getJob(job.id).status, 'failed');
  assert.equal(listFailures({ dbPath }).length, 1);
  advance(999);
  assert.equal((await scheduler.runAvailable()).claimed, 0);
  advance(1);
  assert.equal((await scheduler.runAvailable()).failed, 1);
  advance(1_999);
  assert.equal((await scheduler.runAvailable()).claimed, 0);
  advance(1);
  assert.equal((await scheduler.runAvailable()).done, 1);
  assert.equal(scheduler.getJob(job.id).attempts, 3);
  assert.equal(listFailures({ dbPath }).length, 0);
});

test('expired leases are retried and a max-attempt failure becomes dead', async (t) => {
  const { dbPath, scheduler, advance } = schedulerFixture(t);
  scheduler.register('lease', () => undefined);
  const leased = scheduler.enqueue({
    type: 'lease',
    idempotencyKey: 'lease:expired',
  }).job;
  const direct = new Database(dbPath);
  direct.prepare(
    `UPDATE cove_jobs
     SET status = 'leased', attempts = 1, lease_token = 'old-lease',
         lease_until = '2026-07-28T11:59:00.000Z'
     WHERE id = ?`,
  ).run(leased.id);
  direct.close();

  const recovered = await scheduler.runAvailable();
  assert.equal(recovered.recovered, 1);
  assert.equal(scheduler.getJob(leased.id).status, 'failed');
  advance(1_000);
  assert.equal((await scheduler.runAvailable()).done, 1);

  const originalError = console.error;
  const hardFailures = [];
  console.error = (...args) => hardFailures.push(args);
  t.after(() => {
    console.error = originalError;
  });
  scheduler.register('dead', () => {
    throw new Error('permanent failure');
  });
  const dead = scheduler.enqueue({
    type: 'dead',
    idempotencyKey: 'dead:one',
    maxAttempts: 1,
  }).job;
  assert.equal((await scheduler.runAvailable()).dead, 1);
  assert.equal(scheduler.getJob(dead.id).status, 'dead');
  assert.match(listFailures({ dbPath })[0].message, /stopped retrying/);
  assert.equal(hardFailures.length, 1);
});

test('runner concurrency is bounded at two', async (t) => {
  const { scheduler } = schedulerFixture(t);
  let active = 0;
  let peak = 0;
  scheduler.register('bounded', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
  });
  for (let index = 0; index < 4; index += 1) {
    scheduler.enqueue({
      type: 'bounded',
      idempotencyKey: `bounded:${index}`,
    });
  }
  const result = await scheduler.runAvailable({ concurrency: 9 });
  assert.equal(result.done, 4);
  assert.equal(peak, 2);
});

test('a live handler renews its lease so a second runner cannot duplicate it', async (t) => {
  const dbPath = path.join(
    os.tmpdir(),
    `cove-job-overlap-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  const first = new JobScheduler({ dbPath, leaseMs: 1_000 });
  const second = new JobScheduler({ dbPath, leaseMs: 1_000 });
  t.after(() => {
    first.close();
    second.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });
  let effects = 0;
  first.register('overlap', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    effects += 1;
  });
  second.register('overlap', () => {
    effects += 100;
  });
  const { job } = first.enqueue({
    type: 'overlap',
    idempotencyKey: 'overlap:one',
  });

  const running = first.runAvailable();
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const competing = await second.runAvailable();
  const completed = await running;
  assert.equal(competing.claimed, 0);
  assert.equal(competing.recovered, 0);
  assert.equal(completed.done, 1);
  assert.equal(effects, 1);
  assert.equal(first.getJob(job.id).status, 'done');
  assert.equal(listRecentReceipts({ dbPath, source: 'overlap' }).length, 1);
});

test('claiming uses an immediate transaction', () => {
  const source = readFileSync(
    new URL('../src/lib/reliability/jobs.ts', import.meta.url),
    'utf8',
  );
  const claim = source.slice(
    source.indexOf('private claimNext'),
    source.indexOf('private recordRunnerFailure'),
  );
  assert.match(claim, /\}\)\.immediate\(\);/);
});

test('an unexpected worker error is recorded without abandoning the pool', async (t) => {
  const { dbPath, scheduler } = schedulerFixture(t);
  const effects = [];
  scheduler.register('isolated', (job) => {
    effects.push(job.payload.name);
  });
  scheduler.enqueue({
    type: 'isolated',
    payload: { name: 'first' },
    priority: 10,
    idempotencyKey: 'isolated:first',
  });
  scheduler.enqueue({
    type: 'isolated',
    payload: { name: 'second' },
    priority: 1,
    idempotencyKey: 'isolated:second',
  });
  const execute = scheduler.execute.bind(scheduler);
  let injected = false;
  scheduler.execute = async (job) => {
    if (!injected) {
      injected = true;
      throw new Error('unexpected worker failure');
    }
    return execute(job);
  };

  const result = await scheduler.runAvailable({ concurrency: 2 });
  assert.equal(result.claimed, 2);
  assert.equal(result.done, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(effects, ['second']);
  assert.equal(
    listFailures({ dbPath }).some((failure) =>
      failure.source === 'scheduler' &&
      /unexpected worker failure/.test(failure.message)
    ),
    true,
  );
});

test('scheduler ticks sweep terminal reliability history by age', async (t) => {
  const { dbPath, scheduler } = schedulerFixture(t);
  const db = new Database(dbPath);
  t.after(() => db.close());
  const old = '2026-04-01T00:00:00.000Z';
  const recent = '2026-07-27T00:00:00.000Z';
  db.prepare(
    `INSERT INTO cove_jobs
       (id, type, payload, priority, run_after, attempts, max_attempts, status,
        idempotency_key, created_at, finished_at)
     VALUES (?, 'test', '{}', 0, ?, 1, 1, ?, ?, ?, ?)`,
  ).run('old-done', old, 'done', 'old-done', old, old);
  db.prepare(
    `INSERT INTO cove_jobs
       (id, type, payload, priority, run_after, attempts, max_attempts, status,
        idempotency_key, created_at, finished_at)
     VALUES (?, 'test', '{}', 0, ?, 1, 1, ?, ?, ?, ?)`,
  ).run('recent-dead', recent, 'dead', 'recent-dead', recent, recent);
  db.prepare(
    `INSERT INTO cove_jobs
       (id, type, payload, priority, run_after, attempts, max_attempts, status,
        idempotency_key, created_at)
     VALUES (?, 'test', '{}', 0, ?, 0, 1, 'queued', ?, ?)`,
  ).run('old-queued', old, 'old-queued', old);
  db.prepare(
    `INSERT INTO cove_receipts
       (id, source, started_at, finished_at, summary, actions_json,
        retry_count, outcome, created_at)
     VALUES ('old-receipt', 'test', ?, ?, 'old', '{}', 0, 'success', ?),
            ('recent-receipt', 'test', ?, ?, 'recent', '{}', 0, 'success', ?)`,
  ).run(old, old, old, recent, recent, recent);
  db.prepare(
    `INSERT INTO cove_failure_inbox
       (id, source, source_id, message, details_json, occurred_at,
        dismissed_at, created_at)
     VALUES ('old-failure', 'test', 'old', 'old', '{}', ?, ?, ?),
            ('open-failure', 'test', 'open', 'open', '{}', ?, NULL, ?)`,
  ).run(old, old, old, old, old);

  await scheduler.runAvailable();
  assert.deepEqual(
    db.prepare('SELECT id FROM cove_jobs ORDER BY id').pluck().all(),
    ['old-queued', 'recent-dead'],
  );
  assert.deepEqual(
    db.prepare('SELECT id FROM cove_receipts ORDER BY id').pluck().all(),
    ['recent-receipt'],
  );
  assert.deepEqual(
    db.prepare("SELECT id FROM cove_failure_inbox WHERE source <> 'jobs-unclaimed' ORDER BY id").pluck().all(),
    ['open-failure'],
  );
  assert.equal(
    listFailures({ dbPath }).some((failure) =>
      failure.source === 'jobs-unclaimed' && /test/.test(failure.message)
    ),
    true,
  );
});

test('queued jobs older than 24 hours surface their types and resolve when cleared', async (t) => {
  const { dbPath, scheduler, advance } = schedulerFixture(t);
  scheduler.register('known', () => undefined);
  const old = scheduler.enqueue({
    type: 'never-registered',
    idempotencyKey: 'unclaimed:one',
  }).job;
  advance(24 * 60 * 60_000 + 1);
  await scheduler.runAvailable();
  const visible = listFailures({ dbPath }).find((failure) => failure.source === 'jobs-unclaimed');
  assert.ok(visible);
  assert.match(visible.message, /never-registered/);

  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE cove_jobs SET status = 'done', finished_at = ? WHERE id = ?")
      .run('2026-07-29T12:00:00.001Z', old.id);
  } finally {
    db.close();
  }
  await scheduler.runAvailable();
  assert.equal(listFailures({ dbPath }).some((failure) => failure.source === 'jobs-unclaimed'), false);
});

test('jobs LaunchAgent polls every five minutes', () => {
  const installer = readFileSync(
    new URL('../scripts/install-cove-local.sh', import.meta.url),
    'utf8',
  );
  const jobsPlist = installer.slice(
    installer.indexOf('<string>com.cove.jobs</string>'),
    installer.indexOf('</plist>', installer.indexOf('<string>com.cove.jobs</string>')),
  );
  assert.match(
    jobsPlist,
    /<key>StartInterval<\/key>\s*<integer>300<\/integer>/,
  );
});

test('budget exhaustion defers the original job without consuming execution retries or claiming abandonment', async t=>{
 const {scheduler,dbPath,advance}=schedulerFixture(t);let calls=0;
 scheduler.register('budgeted',()=>{calls++;if(calls===1)throw new Error('background_usage_limit: cove_budget_retry_at=2026-07-30T12:00:00.000Z.');return {summary:'Reviewed'};});
 const {job}=scheduler.enqueue({type:'budgeted',payload:{},idempotencyKey:'budgeted:test',maxAttempts:1});assert.equal(await scheduler.runJob(job.id),'deferred');
 const db=new Database(dbPath);t.after(()=>db.close());const row=db.prepare('SELECT status,attempts,run_after FROM cove_jobs WHERE id=?').get(job.id);assert.deepEqual(row,{status:'queued',attempts:0,run_after:'2026-07-30T12:00:00.000Z'});
 advance(25*3600000);await scheduler.runAvailable();assert.equal(calls,1);assert.equal(listFailures({dbPath}).some(f=>f.source==='jobs-unclaimed'),false);
 advance(24*3600000);assert.equal(await scheduler.runJob(job.id),'done');assert.equal(calls,2);
});


test('historical job issues explain cause and recovery without leaking diagnostics', (t) => {
  const { dbPath } = schedulerFixture(t);
  const error = 'Chief-of-staff wake timed out. sk-secret /private/work.txt';
  const details = { type: 'chief-of-staff-wake', error };
  recordFailure({ dbPath, source: 'job', sourceId: 'old-chief', message: 'job stopped retrying: ' + error, details });
  const issue = listFailures({ dbPath })[0];
  assert.match(issue.message, /open commitments/);
  assert.match(issue.message, /time limit/);
  assert.match(issue.message, /stopped retrying/);
  assert.match(issue.message, /setup agent/);
  assert.doesNotMatch(issue.message, /Open Issues|sk-secret|work.txt|automatically/);
  assert.deepEqual(issue.details, details);
  recordFailure({ dbPath, source: 'job', sourceId: 'old-chief', message: 'job stopped retrying: ' + error, details: { type: 'chief-of-staff-wake' } });
  assert.match(listFailures({ dbPath })[0].message, /time limit/);
  assert.doesNotMatch(listFailures({ dbPath })[0].message, /sk-secret|work.txt/);
  recordFailure({ dbPath, source: 'job', sourceId: 'old-chief', message: 'job will retry: ' + error, details });
  assert.match(listFailures({ dbPath })[0].message, /try again automatically/);
  recordFailure({ dbPath, source: 'job', sourceId: 'old-chief', message: 'job will retry: ' + error, details: { ...details, retrying: false } });
  assert.doesNotMatch(listFailures({ dbPath })[0].message, /automatically/);
  recordFailure({ dbPath, source: 'other', sourceId: 'unchanged', message: 'Original safe wording.' });
  assert.ok(listFailures({ dbPath }).some((item) => item.message === 'Original safe wording.'));
});
