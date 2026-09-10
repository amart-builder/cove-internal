import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGatewayError } from '../src/lib/workspace/errors.ts';
import { buddyDataEnvironment, buddyDataPaths, BUDDY_DATA_ENV_KEYS } from '../src/lib/buddy/environment.ts';
import { buildCodexBuddyCommand } from '../src/lib/buddy/codex.ts';
import { buildBuddyTurnCommand } from '../src/lib/buddy/commands.ts';
import { main, parseBuddyDataArgs, runBuddyDataCommand } from '../scripts/cove-buddy-data.ts';
import { createBuddyMcpHandler } from '../src/lib/buddy/mcp.ts';

test('Buddy reads the same connected calendar gateway without a fictitious table', async () => {
  const lines = []; let seen;
  const command = parseBuddyDataArgs(['calendar', 'list', '--from', '2026-09-10T00:00:00-07:00', '--to', '2026-09-12T00:00:00-07:00']);
  await runBuddyDataCommand(command, { write: x => lines.push(x), workspaceGateway: {
    calendar: { listEvents: async input => { seen = input; return [{ id: 'event-1', summary: 'Planning', start: input.timeMin }]; } },
  }});
  assert.equal(seen.timeMin, '2026-09-10T00:00:00-07:00');
  assert.match(lines[0], /event-1/);
});

test('Buddy reports output overflow specifically and keeps earlier confirmed receipts', async () => {
  const handler = createBuddyMcpHandler(async (_args, {write}) => {
    write('RECEIPT {"id":"confirmed"}'); write('x'.repeat(1024 * 1024)); return 0;
  });
  await handler({ jsonrpc:'2.0',id:1,method:'initialize' });
  const response = await handler({ jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'cove_data',arguments:{args:['query','email_items']}} });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /confirmed/);
  assert.match(response.result.content[0].text, /output_limit/);
  assert.doesNotMatch(response.result.content[0].text, /failed or exceeded/);
});

test('Buddy exposes working filter syntax instead of generic invalid-filter advice', async () => {
  const errors = [];
  const code = await main(['query','tasks','--filter','status=eq.open'], { writeError: x => errors.push(x), fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(code, 1); assert.match(errors[0], /field\.operator\.value/);
});

async function read(args, options = {}) {
  const lines = [];
  await runBuddyDataCommand(parseBuddyDataArgs(args), { ...options, write: x => lines.push(x) });
  return JSON.parse(lines[0]);
}

test('Buddy rejects unknown capabilities and invalid ranges before accessing a connector', () => {
  for (const args of [
    ['calendar','delete','--id','event'],
    ['calendar','list','--from','2026-09-10','--to','2026-09-11'],
    ['calendar','list','--from','2026-09-11T00:00:00Z','--to','2026-09-10T00:00:00Z'],
    ['email','send','--id','m1'], ['document','get','--id','doc','--url','https://example.com'],
    ['read','/etc/passwd'], ['read','goals','--path','/etc/passwd'],
    ['email','message','--id','m','--offset','-1'], ['email','search','--query','hi','--limit','20oops'],
  ]) assert.throws(() => parseBuddyDataArgs(args), undefined, args.join(' '));
});

test('mailbox search keeps provider page tokens and detail reads are fully pageable', async () => {
  const body = 'a'.repeat(1500); let seen;
  const workspaceGateway = { mail: {
    listMessages: async input => { seen = input; return { messages:[{id:'m1',threadId:'t1'}], nextPageToken:'next' }; },
    getMessage: async input => { assert.equal(input.messageId,'m1'); return {id:'m1',threadId:'t1',text:body,headers:[]}; },
    getThread: async () => ({id:'t1',messages:[{id:'m1',text:body}]}),
  }};
  const search = await read(['email','search','--query','from:person@example.com','--page-token','previous'], {workspaceGateway});
  assert.equal(seen.pageToken,'previous'); assert.equal(JSON.parse(search.content).nextPageToken,'next');
  let offset = 0, assembled = '', result;
  do {
    result = await read(['email','message','--id','m1','--offset',String(offset),'--max-chars','500'],{workspaceGateway});
    assembled += result.content; offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(JSON.parse(assembled).text,body);
  assert.equal(result.sourceMayBeTruncated,false);
  assert.match((await read(['email','thread','--id','t1'],{workspaceGateway})).content,/m1/);
});

test('connector auth and scope errors stay specific and do not become empty results', async () => {
  const workspaceGateway = {mail:{listMessages:async () => {throw new WorkspaceGatewayError({code:'insufficient_scope',operation:'mail_list',safeMessage:'Reconnect with mail access.'});}}};
  await assert.rejects(() => read(['email','search','--query','test'],{workspaceGateway}), /insufficient_scope: Reconnect with mail access/);
  await assert.rejects(() => read(['calendar','list','--from','2026-09-10T00:00:00Z','--to','2026-09-11T00:00:00Z'],{workspaceGateway:{}}),/Calendar is not enabled/);
});

test('contacts use the existing CRM context projection and strip request tokens from other views', async () => {
  const urls = [];
  const fetch = async url => { urls.push(new URL(url)); return new Response(JSON.stringify(url.includes('context') ? {rendered:'Meeting and commitment history',csrfToken:'private-request-token'} : {contacts:[{id:'c1'}],csrfToken:'private-request-token'})); };
  const search = await read(['contacts','search','--search','A & B'],{fetch});
  assert.equal(urls[0].searchParams.get('search'),'A & B'); assert.doesNotMatch(search.content,/private-request-token/);
  assert.equal((await read(['contacts','context','--id','c1'],{fetch})).content,'Meeting and commitment history');
  await read(['contacts','history','--id','c1'],{fetch}); assert.equal(urls[2].searchParams.get('operation'),'get');
  assert.doesNotMatch((await read(['read','day-plan'],{fetch})).content,/private-request-token/);
});

test('configured goals and document detail are paged without arbitrary file access', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(),'cove-buddy-knowledge-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(path.join(dir,'brief')); writeFileSync(path.join(dir,'brief','goals.md'),'Real goals '.repeat(200));
  const goals = await read(['read','goals','--max-chars','500'],{dataDir:dir});
  assert.equal(goals.nextOffset,500); assert.match(goals.content,/Real goals/); assert.ok(goals.sourceUpdatedAt);
  const doc = await read(['document','get','--id','document-1'],{workspaceGateway:{documents:{getDocumentPlainText:async input=>{assert.equal(input.documentId,'document-1');return 'Document contents';}}}});
  assert.equal(doc.content,'Document contents'); assert.equal(doc.sourceMayBeTruncated,false);
});

test('table reads default to bounded rows and support deliberate projections and local pagination', async () => {
  let url;
  await read(['query','email_items','--select','id,subject,status','--offset','20'],{fetch:async value=>{url=new URL(value);return new Response('[]');}});
  assert.equal(url.searchParams.get('limit'),'20');assert.equal(url.searchParams.get('offset'),'20');assert.equal(url.searchParams.get('select'),'id,subject,status');
  await assert.rejects(()=>read(['query','contact_activities'],{fetch:async()=>{throw new Error('must not request');}}),/contacts context/);
});

test('actual CLI overflow and unexpected tool failure produce distinct errors without leaking exception text', async () => {
  for (const [run,pattern] of [
    [(args, options)=>main(args,{...options,fetch:async()=>new Response(JSON.stringify([{body:'x'.repeat(1024*1024)}]))}),/output_limit/],
    [async()=>{throw new Error('sensitive internal diagnostic');},/tool_execution_failed/],
  ]) {
    const handler=createBuddyMcpHandler(run);await handler({jsonrpc:'2.0',id:1,method:'initialize'});
    const result=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'cove_data',arguments:{args:['query','email_items']}}});
    assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,pattern);assert.doesNotMatch(result.result.content[0].text,/sensitive internal diagnostic/);
  }
});

test('Buddy shares canonical database selection even with a separate configuration directory', t => {
  const repo = mkdtempSync(path.join(os.tmpdir(),'cove-buddy-paths-'));t.after(()=>rmSync(repo,{recursive:true,force:true}));
  mkdirSync(path.join(repo,'data'));const config=path.join(repo,'configuration');
  assert.deepEqual(buddyDataPaths(repo,{env:{COVE_DATA_DIR:config}}),{dataDir:config,dbPath:path.join(repo,'data','cove.db')});
  writeFileSync(path.join(repo,'data','forge.db'),'');
  assert.equal(buddyDataPaths(repo,{env:{}}).dbPath,path.join(repo,'data','forge.db'));
  writeFileSync(path.join(repo,'data','cove.db'),'');
  assert.equal(buddyDataPaths(repo,{env:{}}).dbPath,path.join(repo,'data','cove.db'));
  assert.equal(buddyDataPaths(repo,{env:{COVE_DB_PATH:'/chosen/store.db'}}).dbPath,'/chosen/store.db');
});

test('both Buddy provider commands forward explicit source configuration without broad environment access', {concurrency:false}, t => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'cove-buddy-source-env-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const auth=path.join(dir,'auth');mkdirSync(auth);writeFileSync(path.join(auth,'auth.json'),'{}');
  const values={COVE_DATA_DIR:dir,COVE_DB_PATH:path.join(dir,'test.db'),COVE_BRIEF_GOALS_PATH:'/chosen/goals.md',COVE_TIMEZONE:'Europe/London',COVE_SALES_PIPELINE:'1',CODEX_HOME:auth};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const selected=buddyDataEnvironment(dir,{...values,PRIVATE_TEST_SECRET:'never-forward'});
  assert.equal(selected.PRIVATE_TEST_SECRET,undefined);
  assert.equal(selected.COVE_BRIEF_GOALS_PATH,values.COVE_BRIEF_GOALS_PATH);
  const codex=buildCodexBuddyCommand({selection:{provider:'codex',model:'gpt-6-astra',effort:'low'},cwd:dir,prompt:'hello',env:values});
  const claude=buildBuddyTurnCommand({headSessionId:null,newSessionId:'session-test',model:'sonnet',effort:'low',userText:'hello'});
  for(const command of [codex,claude])for(const key of ['COVE_DATA_DIR','COVE_DB_PATH','COVE_BRIEF_GOALS_PATH','COVE_TIMEZONE','COVE_SALES_PIPELINE'])assert.equal(command.env[key],values[key]);
  assert.ok(BUDDY_DATA_ENV_KEYS.includes('COVE_BRIEF_GOALS_PATH'));
  assert.ok(BUDDY_DATA_ENV_KEYS.includes('COVE_TIMEZONE'));
});
