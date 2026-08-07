import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  deleteTask,
  listTasks,
} from '../src/lib/data/tasks.ts';

test('Supabase task list and delete requests preserve the pre-stage REST shape', {
  concurrency: false,
}, async (t) => {
  const previousRuntime = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'supabase';
  globalThis.window = {
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('/api/cove-rest/tasks') && (init.method ?? 'GET') === 'GET') {
      return new Response('[]');
    }
    if (String(url) === '/api/day-plan') {
      return new Response('{"csrfToken":"mode-token"}');
    }
    if (String(url) === '/api/cove-rest/tasks?id=eq.t1' && init.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${String(url)} ${init.method ?? 'GET'}`);
  };
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previousRuntime;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });

  await listTasks();
  await deleteTask('t1');

  const listCall = calls.find((call) => call.url.startsWith('/api/cove-rest/tasks?'));
  assert.equal(listCall.url, '/api/cove-rest/tasks?select=*&order=position.asc');
  const deleteCall = calls.find((call) => call.init.method === 'DELETE');
  assert.equal(deleteCall.url, '/api/cove-rest/tasks?id=eq.t1');
  assert.equal(deleteCall.init.body, undefined);
  assert.equal(deleteCall.init.headers['X-Cove-Hard-Delete'], undefined);
  assert.equal(calls.some((call) => call.init.method === 'PATCH'), false);
});

test('archive, undo, Recently deleted, and recurrence affordances are local-mode gated', () => {
  const root = process.cwd();
  const detail = readFileSync(path.join(root, 'src/components/tasks/TaskDetail.tsx'), 'utf8');
  const board = readFileSync(path.join(root, 'src/components/tasks/KanbanBoard.tsx'), 'utf8');
  const today = readFileSync(path.join(root, 'src/components/tasks/TodayView.tsx'), 'utf8');
  const route = readFileSync(path.join(root, 'src/app/api/cove-rest/[table]/implementation.ts'), 'utf8');
  const quietRoute = readFileSync(path.join(root, 'src/app/api/quiet-current/route.ts'), 'utf8');
  const brief = readFileSync(path.join(root, 'src/lib/day-plan/brief-sources.ts'), 'utf8');

  assert.match(detail, /!localMode && !window\.confirm/);
  assert.match(detail, /localMode && task\.proposedRecurrenceCadence/);
  assert.match(board, /onRestoreTask=\{localMode/);
  assert.match(board, /onConfirmRecurrence=\{localMode/);
  assert.match(today, /localMode && \(\s*<RhythmManager/);
  assert.match(today, /onConfirmRecurrence=\{localMode/);
  assert.match(route, /runtimeMode === "local" &&\s*method === "DELETE"/);
  assert.doesNotMatch(route, /url\.searchParams\.set\("status", "neq\.archived"\)/);
  assert.match(brief, /\.\.\.\(localMode\s*\?\s*\[/);
  assert.match(quietRoute, /getRuntimeMode\(\) === "local"/);
  assert.match(quietRoute, /suggestion\.kind !== "stale_task"/);
});
