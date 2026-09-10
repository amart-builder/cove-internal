import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,readdirSync,renameSync,utimesSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readNotificationContext} from '../src/lib/notifications/context.ts';
import {notificationUrl} from '../src/lib/attention/notification-links.mjs';
import {createAttentionTransport} from '../src/lib/attention/transport.mjs';
import {scheduleNotificationReminder,drainNotificationReminders} from '../src/lib/notifications/reminders.mjs';
function fixture(t){
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,description TEXT,status TEXT,due_at TEXT,archived_at TEXT,source_type TEXT);
 CREATE TABLE cove_attention_ledger(id TEXT,ref_kind TEXT,ref_id TEXT,reason TEXT,created_at TEXT);
 CREATE TABLE cove_follow_through_notices(id TEXT,ref_kind TEXT,ref_id TEXT,title TEXT,due_at TEXT,stage TEXT,updated_at TEXT);
 INSERT INTO tasks VALUES('task-a','Prepare the review','Keep the original notes.','open','2026-09-10T15:00:00-07:00',NULL,'chat');`);
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-notice-test-'));t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 return {db,dir};
}
test('attention link retains exact task and reason without placing private text in URL',t=>{
 const {db}=fixture(t);const reason='This is the complete explanation. '.repeat(25);
 db.prepare('INSERT INTO cove_attention_ledger VALUES(?,?,?,?,?)').run('event-a','task','task-a',reason,'2026-09-10T12:00:00Z');
 const url=new URL(notificationUrl({taskId:'task-a',attentionId:'event-a'}));
 assert.equal(url.searchParams.get('task'),'task-a');assert.equal(url.searchParams.get('notice'),'attention:event-a');assert(!url.href.includes(reason));
 const context=readNotificationContext(db,{taskId:'task-a',notice:'attention:event-a'});
 assert.equal(context.reason,reason);assert.equal(context.task.description,'Keep the original notes.');
 assert.throws(()=>readNotificationContext(db,{taskId:'another',notice:'attention:event-a'}),/does not belong/);
 db.prepare("UPDATE tasks SET status='done' WHERE id='task-a'").run();
 assert.equal(readNotificationContext(db,{notice:'attention:event-a'}).task.status,'done');
 assert.equal(db.prepare('SELECT status FROM tasks').get().status,'done');
});
test('missing task and non-task notices retain honest context',t=>{
 const {db}=fixture(t);assert.equal(readNotificationContext(db,{taskId:'gone',notice:'reminder'}).unavailable,true);
 db.prepare('INSERT INTO cove_attention_ledger VALUES(?,?,?,?,?)').run('mail','email','message-id','Review the message before replying.','2026-09-10T12:00:00Z');
 const context=readNotificationContext(db,{notice:'attention:mail'});assert(context.email);assert.equal(context.task,null);
 assert.throws(()=>readNotificationContext(db,{notice:'attention:missing'}),/no longer available/);
});
test('native attention transport passes the specific destination to Cove Notifications',()=>{
 const calls=[];const transport=createAttentionTransport({config:{},telegramToken:'',notificationAppPath:'/test/Cove Notifications.app',exists:()=>true,execFileSyncImpl:(...args)=>{calls.push(args);return '';}});
 const url=notificationUrl({taskId:'task-a',attentionId:'event-a'});transport.banner('A short preview','Needs attention',url);
 assert(calls[0][1].includes('--open-url'));assert(calls[0][1].includes(url));
});
test('requested repeat is durable, native-only, and leaves deadline unchanged',t=>{
 const {db,dir}=fixture(t);const now=new Date('2026-09-10T20:00:00Z');const due=db.prepare('SELECT due_at FROM tasks').get().due_at;
 assert.equal(scheduleNotificationReminder(dir,'task-a',now),'2026-09-10T21:00:00.000Z');
 scheduleNotificationReminder(dir,'task-a',now);assert.equal(readdirSync(path.join(dir,'reminders')).length,1);
 const calls=[];const failures=[];const input={db,dataDir:dir,notify:task=>calls.push(task.id),onFailure:f=>failures.push(f)};
 drainNotificationReminders({...input,now});assert.deepEqual(calls,[]);
 drainNotificationReminders({...input,now:new Date('2026-09-10T21:00:00Z')});
 drainNotificationReminders({...input,now:new Date('2026-09-10T21:01:00Z')});
 assert.deepEqual(calls,['task-a']);assert.deepEqual(failures,[]);assert.equal(db.prepare('SELECT due_at FROM tasks').get().due_at,due);
});
test('repeat skips completed tasks and retains uncertain receipt instead of blindly retrying',t=>{
 const {db,dir}=fixture(t);const now=new Date('2026-09-10T20:00:00Z'),later=new Date('2026-09-10T21:01:00Z');
 scheduleNotificationReminder(dir,'task-a',now);db.prepare("UPDATE tasks SET status='done'").run();let calls=0;
 drainNotificationReminders({db,dataDir:dir,now:later,notify:()=>{calls++;},onFailure:()=>{}});assert.equal(calls,0);
 db.prepare("UPDATE tasks SET status='open'").run();scheduleNotificationReminder(dir,'task-a',now);
 const failures=[];const input={db,dataDir:dir,now:later,notify:()=>{calls++;throw Error('delivery uncertain');},onFailure:f=>failures.push(f)};
 drainNotificationReminders(input);drainNotificationReminders(input);assert.equal(calls,1);assert.equal(failures.length,1);
 assert(readdirSync(path.join(dir,'reminders')).some(name=>name.endsWith('.uncertain')));
 scheduleNotificationReminder(dir,'task-a',later);
 const records=readdirSync(path.join(dir,'reminders'));assert(records.some(name=>name.endsWith('.uncertain')));assert(records.some(name=>name.endsWith('.json')));
});

test('a crashed delivery claim becomes a visible uncertain failure without resend',t=>{
 const {db,dir}=fixture(t);const now=new Date('2026-09-10T20:00:00Z');scheduleNotificationReminder(dir,'task-a',now);
 const folder=path.join(dir,'reminders');const file=path.join(folder,readdirSync(folder)[0]);renameSync(file,file+'.claimed');utimesSync(file+'.claimed',now,now);
 const failures=[];let calls=0;drainNotificationReminders({db,dataDir:dir,now:new Date(+now+10*60_000),notify:()=>{calls++;},onFailure:f=>failures.push(f)});
 assert.equal(calls,0);assert.equal(failures[0].id,'task-a');assert.match(failures[0].error,/could not confirm/);
});

test('requesting another reminder during delivery preserves both the active claim and next reminder',t=>{
 const {db,dir}=fixture(t);const now=new Date('2026-09-10T20:00:00Z');scheduleNotificationReminder(dir,'task-a',now);
 const failures=[];let calls=0;const later=new Date(+now+60*60_000);
 drainNotificationReminders({db,dataDir:dir,now:later,notify:()=>{calls++;scheduleNotificationReminder(dir,'task-a',later);},onFailure:f=>failures.push(f)});
 assert.equal(calls,1);assert.equal(failures.length,0);assert.equal(readdirSync(path.join(dir,'reminders')).length,1);
 drainNotificationReminders({db,dataDir:dir,now:new Date(+later+60*60_000),notify:()=>{calls++;},onFailure:f=>failures.push(f)});
 assert.equal(calls,2);assert.equal(failures.length,0);
});

for (const replaceDuringRestore of [false,true]) {
 test(`a replacement before claim survives delivery${replaceDuringRestore?' and concurrent restoration':''}`, t=>{
  const {db,dir}=fixture(t);
  const now=new Date('2026-09-10T20:00:00Z');
  const due=new Date(+now+60*60_000);
  scheduleNotificationReminder(dir,'task-a',now);
  const originalRename=fs.renameSync, originalLink=fs.linkSync;
  let replaced=false;
  fs.renameSync=(from,to)=>{
   if(!replaced&&String(to).endsWith('.claimed')){replaced=true;scheduleNotificationReminder(dir,'task-a',due);}
   return originalRename(from,to);
  };
  fs.linkSync=(from,to)=>{
   if(replaceDuringRestore)scheduleNotificationReminder(dir,'task-a',new Date(+due+60*60_000));
   return originalLink(from,to);
  };
  syncBuiltinESMExports();
  t.after(()=>{fs.renameSync=originalRename;fs.linkSync=originalLink;syncBuiltinESMExports();});
  const calls=[],failures=[];
  const input={db,dataDir:dir,notify:task=>calls.push(task.id),onFailure:f=>failures.push(f)};
  drainNotificationReminders({...input,now:due});
  assert.deepEqual(calls,[]);
  const file=path.join(dir,'reminders',readdirSync(path.join(dir,'reminders')).find(name=>name.endsWith('.json')));
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).remindAt,new Date(+due+(replaceDuringRestore?2:1)*60*60_000).toISOString());
  fs.renameSync=originalRename;fs.linkSync=originalLink;syncBuiltinESMExports();
  drainNotificationReminders({...input,now:new Date(+due+60*60_000)});
  assert.equal(calls.length,replaceDuringRestore?0:1);
  drainNotificationReminders({...input,now:new Date(+due+2*60*60_000)});
  assert.deepEqual(calls,['task-a']);assert.deepEqual(failures,[]);
  assert.equal(db.prepare('SELECT due_at FROM tasks').get().due_at,'2026-09-10T15:00:00-07:00');
 });
}
