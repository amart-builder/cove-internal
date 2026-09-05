import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {handleLocalRest} from '../src/lib/local/db.ts';
import {taskEditorDraft,taskEditorExpected,taskEditorPatch} from '../src/lib/tasks/editor-patch.ts';
import {taskEditMatches} from '../src/lib/tasks/edit-conflict.ts';
test('conditional editor writes reject a same-field race but preserve unrelated background edits',t=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'cove-edit-conflict-'));const prior=process.env.COVE_DB_PATH;process.env.COVE_DB_PATH=path.join(dir,'cove.db');t.after(()=>{if(prior===undefined)delete process.env.COVE_DB_PATH;else process.env.COVE_DB_PATH=prior;rmSync(dir,{recursive:true,force:true});});
 const q=new URLSearchParams({id:'eq.task'});handleLocalRest('tasks','POST',new URLSearchParams(),{id:'task',title:'Original',description:'Original notes',status:'open'});
 handleLocalRest('tasks','PATCH',q,{description:'New background notes'});
 const saved=handleLocalRest('tasks','PATCH',q,{title:'My title',_expected:{title:'Original'}});assert.equal(saved.status,200);assert.equal(saved.body[0].description,'New background notes');
 const conflict=handleLocalRest('tasks','PATCH',q,{title:'Stale title',_expected:{title:'Original'}});assert.equal(conflict.status,409);assert.match(conflict.body,/changed while you were editing/);
 assert.equal(handleLocalRest('tasks','GET',q).body[0].title,'My title');
});
test('tag guards preserve current untouched tags while protecting an edited visible tag list',()=>{
 const baseline=taskEditorDraft({title:'Task',priority:'medium',tags:['client'],blocked:false});
 const patch=taskEditorPatch(baseline,{...baseline,blocked:true},['client','new']);
 assert.ok(taskEditMatches({tags:'["client","new"]'},taskEditorExpected(baseline,patch,['client','new'])));
 const edited=taskEditorPatch(baseline,{...baseline,tagsText:'edited'},['client','new']);
 assert.equal(taskEditMatches({tags:'["client","new"]'},taskEditorExpected(baseline,edited,['client','new'])),false);
 assert.throws(()=>taskEditMatches({}, {untrusted:'value'}),/Invalid/);
});
