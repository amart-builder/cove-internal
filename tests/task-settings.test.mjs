import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  handleTaskSettingsGet,
  handleTaskSettingsPatch,
} from '../src/app/api/task-settings/implementation.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';
import {
  readTaskSettings,
  taskSettingsPath,
  writeTaskSettings,
} from '../src/lib/tasks/settings.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-task-settings-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(body) {
  return new NextRequest('http://localhost:3200/api/task-settings', {
    method: 'PATCH',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-cove-csrf': getQuietCurrentCsrfToken(),
    },
    body: JSON.stringify(body),
  });
}

test('task settings without focus_count remain compatible and default to one', (t) => {
  const dir = fixture(t);
  const file = taskSettingsPath(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ stale_after_days: 21 }));

  assert.deepEqual(readTaskSettings(dir), {
    stale_after_days: 21,
    focus_count: 1,
  });
});

test('task settings reject focus counts outside the integer range', async () => {
  for (const value of [0, 4, 1.5, '2']) {
    let wrote = false;
    const response = await handleTaskSettingsPatch(request({ focus_count: value }), {
      runtimeMode: 'local',
      readSettings: () => ({ stale_after_days: 14, focus_count: 1 }),
      writeSettings: () => {
        wrote = true;
        throw new Error('invalid value reached the writer');
      },
    });
    assert.equal(response.status, 400, String(value));
    assert.equal(wrote, false, String(value));
  }
});

test('task settings PATCH requires the Cove CSRF token', async () => {
  for (const token of [undefined, 'wrong-token']) {
    const headers = {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
    };
    if (token) headers['x-cove-csrf'] = token;
    const response = await handleTaskSettingsPatch(
      new NextRequest('http://localhost:3200/api/task-settings', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ focus_count: 2 }),
      }),
      {
        runtimeMode: 'local',
        readSettings: () => {
          throw new Error('CSRF rejection reached settings storage');
        },
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: 'Cove request token is missing.',
    });
  }
});

test('task settings PATCH merges focus_count without dropping stale_after_days', async (t) => {
  const dir = fixture(t);
  writeTaskSettings({ stale_after_days: 30, focus_count: 1 }, dir);

  const response = await handleTaskSettingsPatch(request({ focus_count: 3 }), {
    runtimeMode: 'local',
    readSettings: () => readTaskSettings(dir),
    writeSettings: (settings) => writeTaskSettings(settings, dir),
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).settings, {
    stale_after_days: 30,
    focus_count: 3,
  });
  assert.deepEqual(JSON.parse(readFileSync(taskSettingsPath(dir), 'utf8')), {
    stale_after_days: 30,
    focus_count: 3,
  });
});

test('task settings GET is local-only and returns the validated settings', async () => {
  const local = await handleTaskSettingsGet(
    new NextRequest('http://localhost:3200/api/task-settings', {
      headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' },
    }),
    {
      runtimeMode: 'local',
      readSettings: () => ({ stale_after_days: 18, focus_count: 2 }),
    },
  );
  assert.deepEqual(await local.json(), {
    enabled: true,
    settings: { stale_after_days: 18, focus_count: 2 },
  });

  const remote = await handleTaskSettingsGet(
    new NextRequest('http://localhost:3200/api/task-settings', {
      headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' },
    }),
    { runtimeMode: 'supabase' },
  );
  assert.deepEqual(await remote.json(), { enabled: false });
});
