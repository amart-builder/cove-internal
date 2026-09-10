/** Stable local destinations. No message content belongs in a notification URL. */
export function notificationUrl({ taskId, attentionId, followThroughId, email = false, reminder = false } = {}, base = 'http://127.0.0.1:3200') {
  const url = new URL('/tasks', base);
  url.searchParams.set('view', 'today');
  if (taskId) url.searchParams.set('task', taskId);
  if (attentionId) url.searchParams.set('notice', `attention:${attentionId}`);
  else if (followThroughId) url.searchParams.set('notice', `follow-through:${followThroughId}`);
  else if (taskId) url.searchParams.set('notice', reminder ? 'reminder' : 'task');
  if (email) url.searchParams.set('email', '1');
  return url.toString();
}
