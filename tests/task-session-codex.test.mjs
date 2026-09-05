import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTaskSessionManager } from '../src/lib/task-sessions/manager.ts';
import { createCodexTaskParser, codexTaskResumeCommand } from '../src/lib/task-sessions/codex.ts';
import { probeCodexAuthStatus, codexLoginCommand } from '../src/lib/buddy/codex-auth.ts';

test('native parser tolerates malformed envelopes, split UTF-8, and failed turns', () => {
  const ids = []; const parser = createCodexTaskParser(id => ids.push(id));
  parser.push('null\n[]\ntrue\n');
  parser.push('{"type":"thread.started","thread_id":"valid-id"}\n');
  const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Prêt 🌊' } }) + '\n');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.push('{"type":"turn.failed","error":{"message":"Permission required"}}');
  assert.deepEqual(parser.finish(), { sessionId: 'valid-id', text: 'Prêt 🌊', completed: false, error: 'Permission required' });
  assert.deepEqual(ids, ['valid-id']);
  assert.throws(() => codexTaskResumeCommand({ executable: 'codex', home: '/tmp/home', cwd: '/tmp', sessionId: '--last', model: 'gpt-6-astra', effort: 'low', planning: false }), /Invalid/);
});

test('task parser overflow kills and reaps a SIGTERM-ignoring process before releasing supervision', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-native-task-'));
  const auth = path.join(dir, 'auth'); mkdirSync(auth); writeFileSync(path.join(auth, 'auth.json'), '{}');
  writeFileSync(path.join(dir, 'agent-settings.json'), JSON.stringify({ version: 1, provider: 'codex', model: 'gpt-6-astra', effort: 'low' }));
  const executable = path.join(dir, 'fake-codex'); const pidFile = path.join(dir, 'pid');
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.on('SIGTERM',()=>{}); process.stdin.resume(); process.stdin.on('end',()=>{process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);});`, { mode: 0o700 });
  const manager = createTaskSessionManager({ dbPath: path.join(dir, 'cove.db'), dataDir: dir, env: { ...process.env, COVE_CODEX_BIN: executable, CODEX_HOME: auth, COVE_NOTIFY: '0' }, timeoutMs: 5000, terminationGraceMs: 50, resolveProjectDirectory: () => null });
  t.after(() => { manager.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = manager.launch({ taskId: 'synthetic-task', owner: 'claude', promptSnapshot: { title: 'Synthetic check', detail: 'Do not change files.' } });
  const deadline = Date.now() + 7000;
  while (manager.getRun(run.id).status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.getRun(run.id).errorCode, 'session_output_too_large');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('Codex sign-in status requires successful CLI exit and login shell arguments stay literal', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-auth-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'fake-codex');
  const env = { ...process.env, COVE_CODEX_BIN: executable, CODEX_HOME: dir };
  writeFileSync(executable, `#!${process.execPath}\nconsole.error('Logged in using ChatGPT');`, { mode: 0o700 });
  assert.deepEqual(await probeCodexAuthStatus(env), { signedIn: true });
  writeFileSync(executable, `#!${process.execPath}\nconsole.error('Logged in using ChatGPT');process.exitCode=1;`);
  assert.deepEqual(await probeCodexAuthStatus(env), { signedIn: false });
  assert.equal(codexLoginCommand({ CODEX_HOME: '/tmp/a; literal', COVE_CODEX_BIN: '/tmp/codex $(literal)' }), "CODEX_HOME='/tmp/a; literal' '/tmp/codex $(literal)' login");
});

test('a stopped Codex process cannot be resumed until it actually exits',async t=>{
 const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-resume-stop-'));const auth=path.join(dir,'auth');mkdirSync(auth);writeFileSync(path.join(auth,'auth.json'),'{}');writeFileSync(path.join(dir,'agent-settings.json'),JSON.stringify({version:1,provider:'codex',model:'gpt-6-astra',effort:'low'}));
 const child=Object.assign(new EventEmitter(),{pid:47001,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true,unref:()=>child});const opened=[];
 const manager=createTaskSessionManager({dbPath:path.join(dir,'cove.db'),dataDir:dir,env:{CODEX_HOME:auth},spawnImpl:()=>child,signalGroup:()=>{},openTerminal:async command=>opened.push(command),resolveProjectDirectory:()=>null});
 t.after(()=>{manager.close();rmSync(dir,{recursive:true,force:true});});const run=manager.launch({taskId:'stop',owner:'together',promptSnapshot:{title:'Synthetic',detail:'Plan'}});
 child.stdout.write(JSON.stringify({type:'thread.started',thread_id:'native-stop'})+'\n');manager.abandonRun(run.id);
 await assert.rejects(manager.resume(run.id),/finish stopping/);assert.equal(opened.length,0);child.emit('close',1);await manager.resume(run.id);assert.equal(opened.length,1);
});

test('the background worker starts a Codex-only empty queue without requiring Claude',async t=>{
 const {spawnSync}=await import('node:child_process');const dir=mkdtempSync(path.join(os.tmpdir(),'cove-worker-codex-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(path.join(dir,'agent-settings.json'),JSON.stringify({version:1,provider:'codex',model:'gpt-6-astra',effort:'low'}));
 const result=spawnSync(process.execPath,['--import','tsx','scripts/cove-claude-worker.ts','--lane','execution'],{encoding:'utf8',timeout:15000,env:{HOME:dir,PATH:process.env.PATH,COVE_DATA_DIR:dir,COVE_DB_PATH:path.join(dir,'cove.db'),COVE_CLAUDE_WORKER_ENABLED:'1',COVE_CLAUDE_BIN:path.join(dir,'missing-claude'),COVE_CODEX_BIN:path.join(dir,'must-not-call'),COVE_NOTIFY:'0'}});
 assert.equal(result.status,0,result.stderr);assert.ok(readFileSync(path.join(dir,'cove.db')).length>0);
});
