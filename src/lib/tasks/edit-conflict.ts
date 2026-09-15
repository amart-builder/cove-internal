export type TaskEditGuard = { _expected?: Record<string, unknown> };
export const TASK_EDIT_CONFLICT = 'This task changed while you were editing. Your text is still here. Close and reopen the editor to review the latest version before saving.';

/** Compare only edited fields, inside the same transaction as the write.
 * The UI edits a calendar day, so its dueDate guard compares the displayed day.
 * No revision timestamp can safely distinguish unrelated field changes. */
export function taskEditMatches(row: Record<string, unknown>, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Invalid task edit guard.');
  const columns: Record<string,string> = { title:'title', description:'description', origin:'origin', priority:'priority', dueDate:'due_at', columnId:'column_id', tags:'tags', updatedAt:'updated_at' };
  for (const [key,value] of Object.entries(expected)) {
    if (!Object.hasOwn(columns,key)) throw new Error('Invalid task edit guard field.');
    let current=row[columns[key]];
    if (key==='tags') {
      try { if(typeof current==='string') current=JSON.parse(current); } catch { return false; }
      if(!Array.isArray(value) || !value.every(v=>typeof v==='string')) throw new Error('Invalid task tag guard.');
      // Order is presentation only. Preserve blocked markers in the comparison.
      if(JSON.stringify([...(Array.isArray(current)?current:[])].sort())!==JSON.stringify([...value].sort())) return false;
    } else {
      if(value!==null && typeof value!=='string') throw new Error('Invalid task field guard.');
      if(key==='dueDate') current=typeof current==='string'?current.slice(0,10):'';
      if(String(current??'')!==String(value??'')) return false;
    }
  }
  return true;
}

export function taskEditError(error: unknown): string {
  return error instanceof Error && error.message.includes('This task changed while you were editing') ? TASK_EDIT_CONFLICT : "Cove couldn't save those task details. Try again.";
}
