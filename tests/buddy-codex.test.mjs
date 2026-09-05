import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBuddyMcpHandler } from '../src/lib/buddy/mcp.ts';
import { main as runData } from '../scripts/cove-buddy-data.ts';
import { createCodexBuddyEventParser, runBuddyCommand } from '../src/lib/buddy/stream.ts';
import { BuddyCodexSetupError, buildCodexBuddyCommand, buddyProviderHead } from '../src/lib/buddy/codex.ts';
import { attachBuddyRun } from '../src/app/api/buddy/turn/implementation.ts';
import { buildBuddyTurnCommand, buildBuddyCompactionSummaryCommand } from '../src/lib/buddy/commands.ts';
import { createBuddyStore } from '../src/lib/buddy/store.ts';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-buddy-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const selection = { provider: 'codex', model: 'gpt-6-astra', effort: 'low' };

test('MCP validates envelopes and arguments before execution, never executes notifications', async () => {
  const calls = [];
  const handle = createBuddyMcpHandler(async (args, options) => { calls.push(args); options.write('RECEIPT {"table":"tasks","action":"update","id":"t1","summary":"Updated"}'); return 0; });
  assert.equal((await handle(request('tools/list'))).error.code, -32000);
  await handle(request('initialize', { protocolVersion: '2025-06-18' }));
  assert.equal((await handle(request('tools/list'))).result.tools.length, 1);
  for (const args of [[], ['x', 3], ['x'.repeat(33000)], ['x\0'], Array(65).fill('x')]) {
    assert.equal((await handle(request('tools/call', { name: 'cove_data', arguments: { args } }))).error.code, -32602);
  }
  await handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'cove_data', arguments: { args: ['query', 'tasks'] } } });
  assert.equal(calls.length, 0);
  const args = ['update', 'tasks', '--id', 't1', '--set', '{"title":"$(touch /tmp/never); literal"}'];
  const result = await handle(request('tools/call', { name: 'cove_data', arguments: { args } }));
  assert.deepEqual(calls, [args]);
  assert.equal(result.result.isError, false);
  assert.match(result.result.content[0].text, /^RECEIPT /);
  assert.equal((await handle(request('tools/call', { name: 'cove_data', arguments: { args: ['spawn-session'] } }))).result.isError, false);
  assert.equal(calls.length, 2);
});

test('MCP keeps the real permanent-delete confirmation boundary', async () => {
  let fetched = false;
  const handle = createBuddyMcpHandler((args, options) => runData(args, {
    ...options, fetch: async () => { fetched = true; throw new Error('unexpected fetch'); },
  }));
  await handle(request('initialize'));
  const result = await handle(request('tools/call', { name: 'cove_data', arguments: { args: ['delete', 'contacts', '--id', 'c1'] } }));
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /confirm token/i);
  assert.equal(fetched, false);
});

test('native stdio bridge answers initialization, rejects malformed JSON and oversized lines', t => {
  const dir = fixture(t);
  const env = { ...process.env, COVE_DATA_DIR: dir, COVE_DB_PATH: path.join(dir, 'cove.db'), COVE_BUDDY_APP_URL: 'http://127.0.0.1:1' };
  const command = ['--import', 'tsx', 'scripts/cove-buddy-mcp.ts'];
  const run = spawnSync(process.execPath, command, { env, encoding: 'utf8', input: 'invalid\n' + JSON.stringify(request('initialize')) + '\n' + JSON.stringify(request('tools/list', {}, 2)) + '\n', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].result.serverInfo.name, 'cove_buddy');
  assert.equal(lines[2].result.tools[0].name, 'cove_data');
  const oversized = spawnSync(process.execPath, command, { env, encoding: 'utf8', input: 'x'.repeat(70000), timeout: 15000 });
  assert.equal(oversized.status, 1);
  const missingUrl = { ...env }; delete missingUrl.COVE_BUDDY_APP_URL;
  assert.equal(spawnSync(process.execPath, command, { env: missingUrl, encoding: 'utf8', input: '', timeout: 15000 }).status, 1);
});

test('Codex parser accepts receipts only from Cove MCP and preserves native failure status', () => {
  const parser = createCodexBuddyEventParser();
  const parse = value => parser(JSON.stringify(value));
  assert.equal(parse({ type: 'thread.started', thread_id: 'session-1' })[0].sessionId, 'codex:session-1');
  const receipt = 'RECEIPT {"table":"tasks","action":"update","id":"t1","summary":"Updated"}';
  const item = { type: 'mcp_tool_call', id: 'm1', server: 'other', tool: 'cove_data', status: 'completed', result: { content: [{ type: 'text', text: receipt }] } };
  assert.deepEqual(parse({ type: 'item.completed', item }), []);
  const events = parse({ type: 'item.completed', item: { ...item, id: 'm2', server: 'cove_buddy' } });
  assert.equal(events[0].changes[0].id, 't1');
  assert.deepEqual(parse({ type: 'item.completed', item: { ...item, id: 'm2', server: 'cove_buddy' } }), []);
  parse({ type: 'item.completed', item: { type: 'agent_message', id: 'a1', text: 'Done' } });
  const done = parse({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } })[0];
  assert.equal(done.resultText, 'Done');
  assert.equal(done.costKnown, false);
  assert.equal(parse({ type: 'turn.failed', error: { message: 'Sign in required' } })[0].isError, true);
});

test('Codex commands pin selection, use isolated auth and only the narrow MCP tool', t => {
  const dir = fixture(t);
  const authHome = path.join(dir, 'operator-codex'); mkdirSync(authHome);
  writeFileSync(path.join(authHome, 'auth.json'), '{}');
  const env = { ...process.env, COVE_DATA_DIR: dir, CODEX_HOME: authHome };
  const command = buildCodexBuddyCommand({ selection, cwd: dir, prompt: 'Hello', env, headSessionId: 'claude-session' });
  assert.equal(command.provider, 'codex');
  assert.ok(command.args.includes('gpt-6-astra'));
  assert.ok(command.args.includes('model_reasoning_effort="low"'));
  assert.equal(command.args.includes('resume'), false);
  assert.equal(readlinkSync(path.join(command.env.CODEX_HOME, 'auth.json')), path.join(authHome, 'auth.json'));
  const config = readFileSync(path.join(command.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(config, /shell_tool = false/);
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /approvals_reviewer = "auto_review"/);
  assert.match(config, /enabled_tools = \["cove_data"\]/);
  assert.equal((config.match(/\[mcp_servers\./g) ?? []).length, 1);
  assert.equal(buddyProviderHead('codex:s1', 'claude'), null);
  assert.equal(buddyProviderHead('claude-s1', 'codex'), null);
  const resume = buildCodexBuddyCommand({ selection, cwd: dir, prompt: 'Hello', env, headSessionId: 'codex:s1' });
  assert.deepEqual(resume.args.slice(-3), ['resume', 's1', '-']);
});

test('selected Claude stays on the chosen exact model during normal turns and compaction', t => {
  const dir = fixture(t);
  const old = process.env.COVE_DATA_DIR; process.env.COVE_DATA_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.COVE_DATA_DIR; else process.env.COVE_DATA_DIR = old; });
  const chosen = { provider: 'claude', model: 'claude-fable-5-1', effort: 'low' };
  const command = buildBuddyTurnCommand({ selection: chosen, headSessionId: 'codex:s1', newSessionId: 'fresh', model: 'opus', effort: 'high', userText: 'Hello' });
  assert.ok(command.args.includes('claude-fable-5-1'));
  assert.deepEqual(command.args.slice(-2), ['--session-id', 'fresh']);
  assert.ok(buildBuddyCompactionSummaryCommand('s1', chosen).args.includes('claude-fable-5-1'));
});

test('provider metadata survives restart without pretending Codex cost is known', t => {
  const dir = fixture(t); const dbPath = path.join(dir, 'cove.db');
  let store = createBuddyStore({ dbPath });
  const turn = store.claimTurn({ userText: 'Hi', pageContext: null, model: 'sonnet', effort: 'low', routerReason: 'Selected', provider: 'codex', modelId: selection.model, providerChanged: true });
  store.completeTurn(turn.id, { state: 'succeeded', assistant_text: 'Hello', session_id: 'codex:s1' });
  store.close(); store = createBuddyStore({ dbPath }); t.after(() => store.close());
  const saved = store.getTurn(turn.id);
  assert.equal(saved.model_id, selection.model);
  assert.equal(saved.provider, 'codex');
  assert.equal(saved.cost_known, 0);
  assert.equal(saved.provider_changed, 1);
  assert.equal(store.getBuddyState().headSessionId, 'codex:s1');
});

test('native subprocess output reaches Buddy and a nonzero exit cannot masquerade as success', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'fake.cjs');
  writeFileSync(file, `process.stdin.resume(); process.stdin.on('end', () => { for (const e of [{type:'thread.started',thread_id:'s1'},{type:'item.completed',item:{type:'agent_message',id:'a1',text:'Ready'}},{type:'turn.completed'}]) console.log(JSON.stringify(e)); process.exitCode=Number(process.env.TEST_EXIT || 0); });`);
  const command = { provider: 'codex', executable: process.execPath, args: [file], cwd: dir, stdin: 'Hello' };
  const events = [];
  assert.equal((await runBuddyCommand(command, event => events.push(event))).resultText, 'Ready');
  assert.equal(events.at(-1).costKnown, false);
  await assert.rejects(runBuddyCommand(command, () => {}, { env: { TEST_EXIT: '1' } }), /missing_result:1/);
});

test('Codex setup recovery instructions survive the failed turn and event', async t => {
  const dir = fixture(t);
  const store = createBuddyStore({ dbPath: path.join(dir, 'cove.db') }); t.after(() => store.close());
  const turn = store.claimTurn({ userText: 'Hello', pageContext: null, model: 'sonnet', effort: 'low', routerReason: 'Selected', provider: 'codex' });
  const events = [];
  await attachBuddyRun({ store, turn, buildCommand: () => { throw new BuddyCodexSetupError('Codex needs you to sign in. Run codex login on this Mac, then retry your message.'); }, send: event => events.push(event), close: () => {} });
  assert.match(store.getTurn(turn.id).assistant_text, /codex login/);
  assert.equal(store.getTurn(turn.id).error_code, 'codex_setup_required');
  assert.match(events.at(-1).resultText, /codex login/);
  assert.equal(store.getBuddyState().headSessionId, null);
});

test('output overflow terminates and reaps a model that ignores SIGTERM', async t => {
  const dir = fixture(t);
  const file = path.join(dir, 'overflow.cjs');
  const pidFile = path.join(dir, 'pid');
  writeFileSync(file, `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); process.on('SIGTERM',()=>{}); process.stdin.resume(); process.stdin.on('end',()=>{ process.stdout.write('x'.repeat(5*1024*1024)); setInterval(()=>{},1000); });`);
  await assert.rejects(runBuddyCommand({ provider: 'codex', executable: process.execPath, args: [file, pidFile], cwd: dir, stdin: 'Hello' }, () => {}, { timeoutMs: 5000, terminationGraceMs: 30 }), /output_too_large/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Codex compaction stays within its provider and disables data tools', t => {
  const dir=fixture(t); const auth=path.join(dir,'operator');mkdirSync(auth);writeFileSync(path.join(auth,'auth.json'),'{}');
  const old={COVE_DATA_DIR:process.env.COVE_DATA_DIR,CODEX_HOME:process.env.CODEX_HOME};Object.assign(process.env,{COVE_DATA_DIR:dir,CODEX_HOME:auth});
  t.after(()=>{for(const [key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const command=buildBuddyCompactionSummaryCommand('codex:native-session',selection);
  assert.equal(command.provider,'codex');assert.ok(command.args.includes('gpt-6-astra'));assert.ok(command.args.includes('mcp_servers.cove_buddy.enabled=false'));assert.deepEqual(command.args.slice(-3),['resume','native-session','-']);
  assert.throws(()=>buildBuddyCompactionSummaryCommand('claude-session',selection),/another provider/);
  assert.throws(()=>buildBuddyCompactionSummaryCommand('codex:native-session',{provider:'claude',model:'claude-fable-5-1',effort:'low'}),/another provider/);
});

test('Codex Buddy task seed preserves the native head and uses only the injected runner',async t=>{
 const {seedBuddySession}=await import('../src/lib/buddy/spawn-session.ts');
 const {handleSpawnSessionPost}=await import('../src/app/api/buddy/spawn-session/implementation.ts');
 const {NextRequest}=await import('next/server');
 const {getQuietCurrentCsrfToken}=await import('../src/lib/quiet-current/store.ts');
 const dir=fixture(t);const auth=path.join(dir,'operator');mkdirSync(auth);writeFileSync(path.join(auth,'auth.json'),'{}');
 const old={COVE_DATA_DIR:process.env.COVE_DATA_DIR,CODEX_HOME:process.env.CODEX_HOME};Object.assign(process.env,{COVE_DATA_DIR:dir,CODEX_HOME:auth});
 t.after(()=>{for(const[key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const store=createBuddyStore({dbPath:path.join(dir,'cove.db')});t.after(()=>store.close());
 store.createSpawnedSession({sessionId:'local-session',dir,title:'Synthetic task',...selection});
 let called=0;seedBuddySession({store,sessionId:'local-session',dir,title:'Synthetic task',prompt:'Plan a synthetic task',selection,spawnImpl:()=>assert.fail('Must not spawn'),runCommand:async(command,onEvent)=>{
  called++;assert.equal(command.provider,'codex');assert.ok(command.args.includes('features.shell_tool=false'));assert.ok(command.args.includes('approval_policy="on-request"'));
  onEvent({kind:'started',sessionId:'codex:native-head'});return{isError:false,sessionId:'codex:native-head',resultText:'Ready',costUsd:0};
 }});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(called,1);const session=store.getSpawnedSession('local-session');assert.equal(session.state,'ready');assert.equal(session.provider_session_id,'native-head');
 const opened=[];const request=new NextRequest('http://127.0.0.1:3200/api/buddy/spawn-session',{method:'POST',headers:{host:'127.0.0.1:3200','x-cove-csrf':getQuietCurrentCsrfToken()},body:JSON.stringify({action:'resume',sessionId:'local-session'})});
 const response=await handleSpawnSessionPost(request,{store,workspaceRoot:dir,realpath:value=>value,stat:()=>({isDirectory:()=>true}),openTerminal:async command=>opened.push(command)});
 assert.equal(response.status,200);assert.match(opened[0],/native-head/);assert.match(opened[0],/on-request/);
});
