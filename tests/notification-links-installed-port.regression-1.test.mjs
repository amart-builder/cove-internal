// The installer writes COVE_BRIEF_WEB_BASE and every link follows it, except
// two notifications that hardcoded port 3200. On an install that took another
// port, the "needs you" banner and the hard-failure banner opened a dead page.
import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {createExecutionNotifier} from '../src/lib/claude-execution/notify.ts';
import {notifyHardFailure} from '../src/lib/reliability/notifications.ts';

const APP='/Users/test/Applications/Cove Notifications.app/Contents/MacOS/CoveNotifier';
function child(){const c=new EventEmitter();c.unref=()=>{};queueMicrotask(()=>c.emit('close',0));return c;}
function openUrlOf(call){const i=call.args.indexOf('--open-url');return i<0?null:call.args[i+1];}

test('the board link follows the port this install actually runs on',async()=>{
 const calls=[];
 const notify=createExecutionNotifier({
  env:{COVE_NOTIFY:'1',COVE_NOTIFICATION_APP:APP,COVE_BRIEF_WEB_BASE:'http://127.0.0.1:4100'},
  processStartedAt:new Date(Date.now()-60_000),
  exists:candidate=>candidate===APP,
  spawnImpl:(executable,args,options)=>{calls.push({executable,args,options});return child();},
  logger:()=>{},
 });
 await notify({runId:'run-1',state:'plan_ready',itemTitle:'Finish the brief',transitionedAt:new Date().toISOString()});
 assert.equal(calls.length,1);
 assert.equal(openUrlOf(calls[0]),'http://127.0.0.1:4100/tasks');
});

test('the failure link follows it too',()=>{
 const calls=[];
 notifyHardFailure({source:'job:backup',message:'Backup did not finish.'},{
  env:{COVE_NOTIFY:'1',COVE_NOTIFICATION_APP:APP,COVE_BRIEF_WEB_BASE:'http://127.0.0.1:4100'},
  exists:candidate=>candidate===APP,
  spawnImpl:(executable,args,options)=>{calls.push({executable,args,options});return child();},
  logError:()=>{},
 });
 assert.equal(calls.length,1);
 assert.equal(openUrlOf(calls[0]),'http://127.0.0.1:4100/failures');
});

test('an ordinary install still lands on 3200',()=>{
 const calls=[];
 notifyHardFailure({source:'job:backup',message:'Backup did not finish.'},{
  env:{COVE_NOTIFY:'1',COVE_NOTIFICATION_APP:APP},
  exists:candidate=>candidate===APP,
  spawnImpl:(executable,args,options)=>{calls.push({executable,args,options});return child();},
  logError:()=>{},
 });
 assert.equal(openUrlOf(calls[0]),'http://127.0.0.1:3200/failures');
});
