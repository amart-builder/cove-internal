import {NextRequest,NextResponse} from 'next/server';
import {hasDayPlanRouteAccess} from '@/lib/request-security';
import {getQuietCurrentCsrfToken} from '@/lib/quiet-current/store';
import {getRuntimeMode} from '@/lib/runtime/mode';
import {openLocalDatabase,localDatabasePath} from '@/lib/local/database';
import {readNotificationContext} from '@/lib/notifications/context';
import {scheduleNotificationReminder} from '@/lib/notifications/reminders.mjs';
import path from 'node:path';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function denied(request:NextRequest,write=false) {
  if(!hasDayPlanRouteAccess(request)||(write&&request.headers.get('x-cove-csrf')!==getQuietCurrentCsrfToken())) return NextResponse.json({error:'Untrusted request.'},{status:403});
  if(getRuntimeMode()!=='local')return NextResponse.json({error:'Local Cove is required.'},{status:404});
}
export async function GET(request:NextRequest) {
  const error=denied(request);if(error)return error;
  const params=request.nextUrl.searchParams;
  if([...params.values()].some(value=>value.length>250))return NextResponse.json({error:'Invalid notification link.'},{status:400});
  const db=openLocalDatabase();
  try {return NextResponse.json(readNotificationContext(db,{taskId:params.get('task'),notice:params.get('notice'),email:params.get('email')==='1'}));}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Notification unavailable.'},{status:404});}
  finally{db.close();}
}
export async function POST(request:NextRequest) {
  const error=denied(request,true);if(error)return error;
  const raw=await request.text();if(raw.length>1024)return NextResponse.json({error:'Request too large.'},{status:413});
  let body;try{body=JSON.parse(raw);}catch{return NextResponse.json({error:'Invalid request.'},{status:400});}
  if(body?.action!=='remind_later'||typeof body.taskId!=='string'||!body.taskId||body.taskId.length>200)return NextResponse.json({error:'Invalid reminder request.'},{status:400});
  const db=openLocalDatabase();
  try {
    const task=db.prepare("SELECT id FROM tasks WHERE id=? AND status='open' AND archived_at IS NULL").get(body.taskId);
    if(!task)return NextResponse.json({error:'This task is no longer open.'},{status:409});
    return NextResponse.json({remindAt:scheduleNotificationReminder(path.dirname(localDatabasePath()),body.taskId)});
  }finally{db.close();}
}
