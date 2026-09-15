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
 const manager=createTaskSessionManager({dbPath:path.join(dir,'cove.db'),dataDir:dir,env:{CODEX_HOME:auth},spawnImpl:()=>child,signalGroup:()=>{},openDesktop:async url=>opened.push(url),resolveProjectDirectory:()=>null});
 t.after(()=>{manager.close();rmSync(dir,{recursive:true,force:true});});const run=manager.launch({taskId:'stop',owner:'together',promptSnapshot:{title:'Synthetic',detail:'Plan'}});
 child.stdout.write(JSON.stringify({type:'thread.started',thread_id:'native-stop'})+'\n');manager.abandonRun(run.id);
 await assert.rejects(manager.resume(run.id),/finish stopping/);assert.equal(opened.length,0);child.emit('close',1);await manager.resume(run.id);assert.deepEqual(opened,['codex://threads/native-stop']);
});

test('the background worker starts a Codex-only empty queue without requiring Claude',async t=>{
 const {spawnSync}=await import('node:child_process');const dir=mkdtempSync(path.join(os.tmpdir(),'cove-worker-codex-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(path.join(dir,'agent-settings.json'),JSON.stringify({version:1,provider:'codex',model:'gpt-6-astra',effort:'low'}));
 const result=spawnSync(process.execPath,['--import','tsx','scripts/cove-claude-worker.ts','--lane','execution'],{encoding:'utf8',timeout:15000,env:{HOME:dir,PATH:process.env.PATH,COVE_DATA_DIR:dir,COVE_DB_PATH:path.join(dir,'cove.db'),COVE_CLAUDE_WORKER_ENABLED:'1',COVE_CLAUDE_BIN:path.join(dir,'missing-claude'),COVE_CODEX_BIN:path.join(dir,'must-not-call'),COVE_NOTIFY:'0'}});
 assert.equal(result.status,0,result.stderr);assert.ok(readFileSync(path.join(dir,'cove.db')).length>0);
});

test('per-task provider overrides keep saved settings and submit the full brief with isolated launch flags', async t => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { default: Database } = await import('better-sqlite3');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-provider-choice-'));
  const auth = path.join(dir, 'auth'); mkdirSync(auth);
  writeFileSync(path.join(auth, 'auth.json'), '{}');
  const personalConfig = 'model = "personal-model"\n';
  writeFileSync(path.join(auth, 'config.toml'), personalConfig);
  const settings = JSON.stringify({version: 1, provider: 'claude', model: 'claude-fable-5-1', effort: 'medium', providers: {claude: {model: 'claude-fable-5-1', effort: 'medium'}, codex: {model: 'gpt-6-astra', effort: 'low'}}});
  writeFileSync(path.join(dir, 'agent-settings.json'), settings);
  const children = []; const calls = []; const prompts = [];
  const manager = createTaskSessionManager({dbPath: path.join(dir, 'cove.db'), dataDir: dir,
    env: { CODEX_HOME: auth, COVE_NOTIFY: '0' }, resolveProjectDirectory: () => null,
    markSession: () => {}, signalGroup: () => {},
    spawnImpl: (executable, args, options) => {
      const child = Object.assign(new EventEmitter(), {pid: 48001 + children.length,
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: () => child});
      let prompt = ''; child.stdin.on('data', data => { prompt += data.toString(); });
      calls.push({executable,args,options}); prompts.push(() => prompt); children.push(child); return child;
    }});
  t.after(() => { for (const child of children) child.emit('close', 1); manager.close(); rmSync(dir, {recursive:true, force:true}); });
  const brief = 'Saved briefing context. ' + 'x'.repeat(17000) + ' FULL_BRIEF_END';
  const db = new Database(path.join(dir, 'cove.db'));
  db.prepare("INSERT INTO tasks (id,title,brief,status,created_at,updated_at) VALUES ('choice','Choice',?,'open',?,?)").run(brief,new Date().toISOString(),new Date().toISOString()); db.close();
  const run = manager.launch({taskId:'choice',provider:'codex',owner:'together',mode:'planning',promptSnapshot:{title:'Choice',detail:'Prepare a plan',brief:'Client brief must be ignored'}});
  assert.equal(run.provider,'codex'); assert.equal(run.model,'gpt-6-astra');
  assert.equal(calls[0].options.env.CODEX_HOME,auth);
  for (const flag of ['--ignore-user-config','--ignore-rules','approval_policy="on-request"','web_search="disabled"','features.apps=false','features.multi_agent=false','sandbox_workspace_write.network_access=false','read-only']) assert.ok(calls[0].args.includes(flag),flag);
  assert.ok(prompts[0]().includes(brief)); assert.ok(!prompts[0]().includes('Client brief must be ignored'));
  const claude = manager.launch({taskId:'other',provider:'claude',owner:'claude',mode:'auto',promptSnapshot:{title:'Other',detail:'Prepare draft'}});
  assert.equal(claude.provider,'claude'); assert.equal(claude.model,'claude-fable-5-1'); assert.equal(claude.effort,'medium');
  assert.equal(readFileSync(path.join(dir,'agent-settings.json'),'utf8'),settings);
  assert.equal(readFileSync(path.join(auth,'config.toml'),'utf8'),personalConfig);
  const { setPrimaryAgent } = await import('../src/lib/agent-settings.mjs');
  setPrimaryAgent('codex', {COVE_DATA_DIR:dir});
  assert.equal(manager.getRun(claude.id).provider, 'claude');
  assert.equal(manager.launch({taskId:'other',owner:'claude',mode:'auto',promptSnapshot:{title:'Other',detail:'Prepare draft'}}).id, claude.id);
  const next = manager.launch({taskId:'new-primary',owner:'together',mode:'planning',promptSnapshot:{title:'Next',detail:'Plan next'}});
  assert.equal(next.provider,'codex'); assert.equal(next.model,'gpt-6-astra');

});

test('new Codex task sessions keep neutral cwd, explicit project context, scoped Auto access and stable resumes', async t => {
  const { EventEmitter }=await import('node:events');const { PassThrough }=await import('node:stream');const { default:Database }=await import('better-sqlite3');
  const dir=mkdtempSync(path.join(os.tmpdir(),'cove-project-routing-'));const auth=path.join(dir,'auth');mkdirSync(auth);writeFileSync(path.join(auth,'auth.json'),'{}');
  writeFileSync(path.join(dir,'agent-settings.json'),JSON.stringify({version:1,provider:'codex',model:'gpt-6-astra',effort:'low'}));
  const children=[],calls=[],prompts=[];const workspace='/work/catalyst';
  const manager=createTaskSessionManager({dbPath:path.join(dir,'cove.db'),dataDir:dir,env:{CODEX_HOME:auth,COVE_NOTIFY:'0'},resolveProjectDirectory:hint=>hint==='catalyst'?workspace:null,signalGroup:()=>{},spawnImpl:(executable,args,options)=>{
    const child=Object.assign(new EventEmitter(),{pid:49001+children.length,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),unref:()=>child});
    let prompt='';child.stdin.on('data',data=>{prompt+=data.toString();});children.push(child);calls.push({executable,args,options});prompts.push(()=>prompt);return child;
  }});
  t.after(()=>{for(const child of children)child.emit('close',1);manager.close();rmSync(dir,{recursive:true,force:true});});
  const db=new Database(path.join(dir,'cove.db'));const insert=db.prepare("INSERT INTO tasks(id,title,project,status,created_at,updated_at) VALUES(?,?,'catalyst','open',?,?)");
  for(const id of ['planning','auto'])insert.run(id,'Prepare Edge AI proposals',new Date().toISOString(),new Date().toISOString());
  const planning=manager.launch({taskId:'planning',provider:'codex',owner:'together',mode:'planning',promptSnapshot:{title:'Prepare Edge AI proposals',detail:'Prepare a plan',project:'Radius EHR'}});
  children[0].stdout.write('{"type":"thread.started","thread_id":"new-planning-thread"}\n');
  assert.equal(calls[0].options.cwd,planning.outputDir);assert.equal(calls[0].args[calls[0].args.indexOf('-C')+1],planning.outputDir);
  assert.equal(planning.workspacePath,planning.outputDir);assert.equal(planning.promptSnapshot.project,'catalyst');
  assert.ok(prompts[0]().includes(`Cove's saved task project workspace: ${workspace}`));assert.ok(prompts[0]().includes('Project: catalyst.'));
  assert.ok(calls[0].args.includes('read-only'));assert.ok(!calls[0].args.includes('--add-dir'));
  const planningResume=manager.getRun(planning.id).resumeCommand;assert.ok(planningResume.includes(`'-C' '${planning.outputDir}'`));assert.ok(!planningResume.includes('--add-dir'));
  const auto=manager.launch({taskId:'auto',provider:'codex',owner:'claude',mode:'auto',promptSnapshot:{title:'Prepare Edge AI proposals',detail:'Draft approved files',project:'Radius EHR'}});
  children[1].stdout.write('{"type":"thread.started","thread_id":"new-auto-thread"}\n');
  assert.equal(calls[1].options.cwd,auto.outputDir);assert.ok(calls[1].args.includes('workspace-write'));
  assert.deepEqual(calls[1].args.flatMap((arg,i)=>arg==='--add-dir'?[calls[1].args[i+1]]:[]),[workspace]);
  const autoResume=manager.getRun(auto.id).resumeCommand;assert.ok(autoResume.includes(`'-C' '${auto.outputDir}'`));assert.ok(autoResume.includes(`'--add-dir' '${workspace}'`));
  // Existing runs keep their original working directory and output grant.
  db.prepare('UPDATE cove_task_session_runs SET workspace_path=?,prompt_json=? WHERE id=?').run('/work/legacy',JSON.stringify({title:'Legacy task',detail:'Old context',project:'legacy'}),auto.id);
  const legacy=manager.getRun(auto.id).resumeCommand;assert.ok(legacy.includes("'-C' '/work/legacy'"));assert.ok(legacy.includes(`'--add-dir' '${auto.outputDir}'`));assert.ok(!legacy.includes(`'--add-dir' '${workspace}'`));
  db.close();
});
