---
name: cove-task
description: >-
  Capture a task or reminder onto the local Cove task board from natural
  language. Use whenever the user wants to remember to do something or track a
  to-do, including phrases like "remind me to", "add to my task board", "add a
  task", "put on my list", "I need to", "don't let me forget to", "follow up
  on", or "task for tomorrow". Picks a due date (asking the calendar and current
  load when one isn't given) and sets a reminder.
---

# Cove task capture

Turn a natural-language request into a task on the local Cove board at
`http://localhost:3200`, with a sensible due date and a reminder. Confirm in one
short, human sentence when done.

## 1. Read the request token and board

Read the current day-plan state first. Keep its `csrfToken`; every POST or
PATCH below must send it as `X-Cove-CSRF`.

```bash
curl -s 'http://localhost:3200/api/day-plan'
```

Then read the board:

```bash
curl -s 'http://localhost:3200/api/cove-rest/task_columns?select=*&order=position.asc'
```

Columns are: **Not Started**, **Must happen today**, **In Flight / Waiting**,
**Done**. Keep the `id` for the column you choose.

## 2. Pull out the task

From what the user said, determine:

- **title**: short and action-first ("Call Joe about the roof bid"), not a
  sentence.
- **priority**: `high`, `medium`, or `low`. Infer from urgency words; default
  `medium`.
- **tags**: optional, only if obvious (e.g. `["follow-up"]`).
- **due date/time**: see step 3.

## 3. Decide the due date

**If the user gave a time or date**, use it exactly. Convert to a local ISO
datetime, e.g. "Friday at 3pm" → `2026-07-03T15:00:00`. If they gave a day but
no time, use `09:00:00` that morning.

**If the user gave no due date**, schedule it intelligently. Look at:

1. Current open tasks and their due dates, to avoid piling everything on one
   day:
   ```bash
   curl -s 'http://localhost:3200/api/cove-rest/tasks?select=title,due_at,priority,status&status=eq.open'
   ```
2. The user's priorities in their `CLAUDE.md` (check `~/.claude/CLAUDE.md` and
   any project `CLAUDE.md`). Higher-priority themes get sooner dates.
3. Their calendar, **if** a calendar tool is connected (Google Calendar via an
   MCP/CLI). If no calendar is available, skip it; this comes online once
   connections are set up. Do not block on it.

Then pick a realistic due datetime and **tell the user the date you chose** so
they can correct it.

## 4. Choose the column

- Due today or explicitly urgent → **Must happen today**.
- Already underway or waiting on someone → **In Flight / Waiting**.
- Otherwise → **Not Started**.

## 5. Decide reminders

- **Native Mac notification is on by default** (`remind_native: true`). It fires
  at the due time while the Mac is awake.
- Set `remind_text: true` **only** if the user asked to be texted, or if a text
  channel is configured and the task is high priority. A text channel is
  configured if `data/cove-reminders.json` exists in the Cove repo folder
  (usually `~/cove`; `~/forge` on installs made before the rename). An install
  from before the rename has `data/forge-reminders.json` instead, which counts
  just the same.

## 6. Create the task

```bash
curl -s -X POST 'http://localhost:3200/api/cove-rest/tasks' \
  -H 'Content-Type: application/json' \
  -H 'X-Cove-CSRF: <token from the day-plan GET>' \
  -d '{
    "column_id": "<chosen column id>",
    "title": "<title>",
    "description": "",
    "priority": "<low|medium|high>",
    "due_at": "<local ISO datetime>",
    "tags": [],
    "remind_native": true,
    "remind_text": false
  }'
```

If you ever change a task's `due_at` later, also set `"notified_at": null` in
the same PATCH so the reminder fires again at the new time.

## 7. Reply

Keep it to one warm, plain sentence, and surface the due date you set.

- Native only: *"Added to your task list, due Friday at 3pm. Let me know if you
  want me to text remind you as well."*
- Text already on: *"Added, due Friday at 3pm. I'll text you when it's time."*
- No text channel set up yet: still offer it: *"Added, due Friday at 3pm. I can
  also text reminders if you connect Telegram or iMessage; just say the word."*

Never use an em dash. Sound like a sharp assistant, not a form confirmation.
