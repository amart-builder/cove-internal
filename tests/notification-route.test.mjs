import assert from 'node:assert/strict';
import test from 'node:test';
import {NextRequest} from 'next/server';
import {GET,POST} from '../src/app/api/notifications/route.ts';
import {getQuietCurrentCsrfToken} from '../src/lib/quiet-current/store.ts';

// Every path that falls back to coveDataDir() must land in a scratch directory,
// never in <cwd>/data: a fresh checkout's verify run must not mint a database
// or a token the setup playbook would then treat as an existing install.
import { mkdtempSync as isolatedMkdtemp, rmSync as isolatedRm } from 'node:fs';
import isolatedOs from 'node:os';
import isolatedPath from 'node:path';
const ISOLATED_DATA_DIR = isolatedMkdtemp(isolatedPath.join(isolatedOs.tmpdir(), 'cove-test-data-'));
process.env.COVE_DATA_DIR = ISOLATED_DATA_DIR;
delete process.env.COVE_DB_PATH;
test.after(() => isolatedRm(ISOLATED_DATA_DIR, { recursive: true, force: true }));

test('notification routes reject foreign hosts, origins and missing CSRF before accessing data', async () => {
  const request=(host,method='GET',headers={})=>new NextRequest(`http://${host}/api/notifications`,{method,headers,...(method==='POST'?{body:JSON.stringify({action:'remind_later',taskId:'example'})}:{})});
  assert.equal((await GET(request('evil.example'))).status,403);
  assert.equal((await POST(request('127.0.0.1:3200','POST'))).status,403);
  assert.equal((await POST(request('127.0.0.1:3200','POST',{'x-cove-csrf':getQuietCurrentCsrfToken(),origin:'https://evil.example'}))).status,403);
});

test('valid CSRF does not bypass reminder input validation',async t=>{
  const old=process.env.NEXT_PUBLIC_COVE_RUNTIME;process.env.NEXT_PUBLIC_COVE_RUNTIME='local';
  t.after(()=>{if(old===undefined)delete process.env.NEXT_PUBLIC_COVE_RUNTIME;else process.env.NEXT_PUBLIC_COVE_RUNTIME=old;});
  const headers={'x-cove-csrf':getQuietCurrentCsrfToken()};
  for(const body of ['{',JSON.stringify({action:'remind_later',taskId:''}),JSON.stringify({action:'complete',taskId:'a'})]){
    assert.equal((await POST(new NextRequest('http://127.0.0.1:3200/api/notifications',{method:'POST',headers,body}))).status,400);
  }
  assert.equal((await GET(new NextRequest('http://127.0.0.1:3200/api/notifications?task='+ 'a'.repeat(251)))).status,400);
});
