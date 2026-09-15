import type Database from 'better-sqlite3';

export type NotificationTask = {id:string;title:string;description:string|null;origin?:string|null;status:string;due_at:string|null;archived_at:string|null;
};
export type NotificationContext = {
  title:string; reason:string; createdAt:string|null; task:NotificationTask|null;
  email:boolean; unavailable:boolean;
};
export function readNotificationContext(db:Database.Database, input:{taskId?:string|null;notice?:string|null;email?:boolean}):NotificationContext {
  let taskId=input.taskId;
  let title='Cove notification';
  let reason=input.notice==='reminder' ? 'A scheduled reminder brought this task back to your attention. Ask Buddy to check where the task came from and why it was scheduled.' : 'Cove brought this task to your attention. Review its current details and choose the next step.';
  let createdAt:string|null=null;
  let email=input.email===true;
  if(input.notice?.startsWith('attention:')) {
    const row=db.prepare('SELECT ref_kind,ref_id,reason,created_at FROM cove_attention_ledger WHERE id=?').get(input.notice.slice(10)) as
      | {ref_kind:string;ref_id:string;reason:string;created_at:string}|undefined;
    if(!row) throw new Error('This notification is no longer available.');
    if(taskId && (row.ref_kind!=='task'||row.ref_id!==taskId)) throw new Error('This notification does not belong to that task.');
    taskId=row.ref_kind==='task'?row.ref_id:null;
    reason=row.reason;createdAt=row.created_at;email=row.ref_kind==='email';
  } else if(input.notice?.startsWith('follow-through:')) {
    const row=db.prepare('SELECT ref_kind,ref_id,title,due_at,stage,updated_at FROM cove_follow_through_notices WHERE id=?').get(input.notice.slice(15)) as
      | {ref_kind:string;ref_id:string;title:string;due_at:string;stage:string;updated_at:string;
        }|undefined;
    if(!row) throw new Error('This reminder is no longer available.');
    if(taskId && (row.ref_kind!=='task'||row.ref_id!==taskId)) throw new Error('This reminder does not belong to that task.');
    taskId=row.ref_kind==='task'?row.ref_id:null;title=row.title;createdAt=row.updated_at;
    reason=row.stage=== "preparation"
        ? "Cove brought back a recorded preparation check. Review the current source and what is ready."
        : row.stage === 'meeting'?'Cove reminded you to prepare for this meeting.':row.stage==='advance'?'Cove reminded you ahead of the recorded deadline so you could make time for the next step.':'This commitment was past due and still open when Cove checked. Review its current status before acting.';
    reason+=` Recorded time: ${row.due_at}.`;
  } else if(input.notice && !['task','reminder'].includes(input.notice)) throw new Error('Unknown notification link.');
  const task=taskId? (db.prepare('SELECT id,title,description,origin,status,due_at,archived_at FROM tasks WHERE id=?').get(taskId) as NotificationTask|undefined)
    :undefined;
  return {title:task?.title??title, reason,createdAt,task:task??null,email,unavailable:Boolean(taskId&&!task)};
}
