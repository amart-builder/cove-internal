'use client';
import {useEffect,useRef,useState} from 'react';
import type {NotificationContext,NotificationTask} from '@/lib/notifications/context';
import {getDayPlanCsrfToken} from '@/lib/data/day-plan';
import ModalScrim from './arrival/ModalScrim';
import EmailCardDetail from './EmailCardDetail';

type Action='today'|'priority'|'complete';
export default function NotificationTaskSheet({query,onClose,onAction}: {
  query:string;onClose:()=>void;onAction:(action:Action,task:NotificationTask)=>Promise<void>;
}) {
  const closeButtonRef=useRef<HTMLButtonElement>(null);
  const [context,setContext]=useState<NotificationContext|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [receipt,setReceipt]=useState('');
  useEffect(()=>{
    const abort=new AbortController();
    fetch(`/api/notifications?${query}`,{signal:abort.signal,cache:'no-store'})
      .then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error??'Could not load this notification.');return data;})
      .then(setContext).catch(error=>{if(!abort.signal.aborted)setError(error.message);});
    return ()=>abort.abort();
  },[query]);
  const task=context?.task;
  const open=Boolean(task&&task.status==='open'&&!task.archived_at);
  async function act(action:Action|'remind') {
    if(!task||busy)return;
    setBusy(true);setError('');setReceipt('');
    try {
      if(action==='remind') {
        const response=await fetch('/api/notifications',{method:'POST',headers:{'Content-Type':'application/json','X-Cove-CSRF':await getDayPlanCsrfToken()},body:JSON.stringify({action:'remind_later',taskId:task.id})});
        const result=await response.json();if(!response.ok)throw new Error(result.error??'Could not schedule the reminder.');
        setReceipt(`Reminder set for ${new Date(result.remindAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}. The deadline is unchanged.`);
      } else {
        await onAction(action,task);
        if(action==='complete'){
          setContext(current=>current?{...current,task:{...task,status:'done'}}:current);
          closeButtonRef.current?.focus();
        }
        setReceipt(action==='complete'?'Task marked complete.':action==='priority'?'Added to your initial priorities.':'Added to today.');
      }
    }catch(error){setError(error instanceof Error?error.message:'Cove could not save that change.');}
    finally{setBusy(false);}
  }
  return <ModalScrim labelledBy="notification-title" returnFocus={null} onClose={onClose} panelClassName="notification-task-panel">
    <header className="email-review-header">
      <div><p className="notification-eyebrow">From Cove</p><h2 id="notification-title">{context?.title??'Your notification'}</h2></div>
      <button ref={closeButtonRef} type="button" data-modal-initial-focus aria-label="Close notification" onClick={onClose}>×</button>
    </header>
    {context?.email ? <><div className="notification-task-content"><section className="notification-reason"><h3>Why Cove notified you</h3><p>{context.reason}</p></section></div><EmailCardDetail onClose={onClose}/></> : <div className="notification-task-content">
      {!context&&!error&&<p role="status">Loading the full explanation…</p>}
      {context&&<>
        <section className="notification-reason"><h3>Why Cove notified you</h3><p>{context.reason}</p>{context.createdAt&&<small>{new Date(context.createdAt).toLocaleString()}</small>}</section>
        {context.unavailable&&<p>This task is no longer available. The notification has been kept for context.</p>}
        {task&&<>
          <p className="notification-task-state">{open?'Open':task.status==='done'?'Already completed':'Archived'}{task.due_at&&<> · Due {task.due_at.length===10?new Date(`${task.due_at}T12:00:00`).toLocaleDateString():new Date(task.due_at).toLocaleString()}</>}</p>
          {task.description&&<section><h3>Task details</h3><p className="notification-task-description">{task.description}</p></section>}
          {open&&<div className="notification-task-actions" aria-label="Task actions">
            <button disabled={busy} onClick={()=>void act('priority')}>Add to initial priorities</button>
            <button disabled={busy} onClick={()=>void act('today')}>Add to today</button>
            <button disabled={busy} onClick={()=>void act('complete')}>Mark complete</button>
            <button disabled={busy} onClick={()=>void act('remind')}>Remind me in 1 hour</button>
          </div>}
          {!open&&<p>The notification does not reopen this task or add it to your day.</p>}
        </>}
        {!task&&!context.unavailable&&<a className="notification-related-link" href="/follow-through">Open follow-through</a>}
      </>}
      {receipt&&<p role="status" className="notification-receipt">{receipt}</p>}
    </div>}
    {error&&<p role="alert" className="notification-task-error">{error}</p>}
  </ModalScrim>;
}
