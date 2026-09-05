"use client";
import { useCallback, useEffect, useState } from "react";
import { getDayPlanCsrfToken } from "@/lib/data/day-plan";

type Coverage = {enabled:boolean;healthy:boolean;lastCheckedAt:string|null;calendar:{status:string;fresh:boolean};notices:Array<{id:string;title:string;status:string;snoozedUntil:string|null}>};
export default function FollowThrough({ compact = false }: { compact?: boolean }) {
 const [state,setState]=useState<Coverage>(); const [error,setError]=useState<string>();
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  try { const response=await fetch('/api/follow-through',{cache:'no-store',signal}); if(!response.ok) throw new Error(); const value=await response.json(); if(!signal?.aborted) { setState(value); setError(undefined); } }
  catch { if(!signal?.aborted) setError('Cove could not check reminder coverage. Refresh to try again.'); }
 },[]);
 useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);const timer=setInterval(()=>void refresh(controller.signal),60000);return()=>{controller.abort();clearInterval(timer);};},[refresh]);
 if(!state?.enabled && !error) return null;
 if(compact) return <a href="/failures" className="text-xs text-muted-foreground hover:text-foreground" aria-label="View reminder coverage">{error || !state?.healthy ? 'Reminder checks need attention' : state.calendar.fresh ? 'Watching deadlines and meetings' : state.calendar.status === 'not_connected' ? 'Watching deadlines · Calendar not connected' : 'Watching deadlines · Calendar needs attention'}</a>;
 return <section aria-label="Reminder coverage" className="mt-5 rounded-xl border border-border bg-card p-5">
  <h2 className="text-base font-medium">On your radar</h2>
  {error && <p role="alert" className="mt-2 text-sm text-accent-red">{error}</p>}
  {state?.enabled && <>
   <p className="mt-2 text-sm">{state.healthy?'Cove is checking deadlines while this Mac is awake.':'Deadline checks need attention. Ask your setup agent to check the reminder service.'}</p>
   <p className="mt-2 text-sm text-muted-foreground">{state.calendar.fresh?'Calendar checked. Meeting prep reminders are active.':state.calendar.status==='not_connected'?'Calendar is not connected. Meeting reminders are unavailable.':'Calendar could not be checked recently. Meeting reminders may be missing.'}</p>
   <p className="mt-2 text-xs text-muted-foreground">Gentle reminders run from 8am to 6pm in your timezone. Model usage limits do not stop these checks. Closed or sleeping Macs cannot notify you.</p>
   {state.notices.filter(n=>['pending','uncertain','failed','delivered'].includes(n.status)).slice(0,5).map(n=><div key={n.id} className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-sm"><div><p>{n.title}</p><p className="text-xs text-muted-foreground">{n.snoozedUntil && Date.parse(n.snoozedUntil)>Date.now()?'Snoozed for one hour':n.status==='uncertain'?'Delivery was interrupted. Please review this item.':n.status==='failed'?'Notification failed. Please review this item.':n.status==='delivered'?'Reminder sent':'Waiting for a suitable reminder time'}</p></div><button type="button" className="shrink-0 text-xs text-accent-blue" onClick={()=>{
    void getDayPlanCsrfToken().then(token=>fetch('/api/follow-through',{method:'POST',headers:{'Content-Type':'application/json','X-Cove-CSRF':token},body:JSON.stringify({action:'snooze',id:n.id})})).then(async response=>{const result=await response.json();if(!response.ok||!result.ok)throw new Error();await refresh();}).catch(()=>setError('Could not snooze that reminder. Try again.'));
   }}>Snooze 1h</button></div>)}
  </>}
 </section>;
}
