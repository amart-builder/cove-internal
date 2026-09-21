---
name: cove-suggest
description: >-
  Propose inferred work to the user's Cove Quiet Current without committing it.
  Use when email, meetings, messages, calendar context, or agent reasoning suggest
  that the user may want to do something, but the user has not explicitly asked
  to add it as a task.
---

# Cove pencil suggestions

Inferred work belongs in pencil. Never create a committed task merely because it seems useful.

Task-creation conventions (consolidation, one card per source occurrence) live in the Cove repo's `prompts/triage.md`; read them before proposing multiple related cards.

## 1. Check the current first

```bash
curl -s 'http://localhost:3200/api/cove-rest/tasks?select=*&order=position.asc'
curl -s 'http://localhost:3200/api/quiet-current'
```

If `data/cove-profile.json` exists, read it too (on an install made before the rename the file is `data/forge-profile.json`; use that when the `cove-` name is absent). Use the person's confirmed responsibilities, outcomes, constraints, and failure patterns to explain why a proposal may matter. The profile is context, not permission.

Do not duplicate accepted work or an active proposal. Prefer silence when the evidence is weak.

## 2. Create the proposal

Keep the title action-first. State the evidence in `reason` and name the real source in `source`. Do not use model confidence as a substitute for evidence.

```bash
curl -s -X POST 'http://localhost:3200/api/quiet-current' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "suggest",
    "kind": "create_task",
    "title": "Reply to Jordan about the launch date",
    "description": "Confirm whether Tuesday still works.",
    "reason": "Jordan asked for confirmation in the latest thread.",
    "source": "Gmail thread with Jordan",
    "priority": "medium",
    "dueDate": "2026-09-24"
  }'
```

Always send a `dueDate`. An accepted proposal goes straight into the board's
"Must happen today" column and carries that date onto the card, and the date is
the only thing that can bring the card back: the due reminder, the attention
floor, the follow-through checks and the pre-deadline nudge all skip a task
without one. A proposal accepted with no date therefore sits in "Must happen
today" saying that every day, including the days it is not true, and
no reminder ever comes for it — the stale-task watchdog that rescues forgotten
cards does not look at that column. Take the day from the evidence when it names one, and
otherwise choose the day you would give the person if they asked, and say why in
`reason`. A bare `YYYY-MM-DD` means that morning; give a full local timestamp
(`2026-09-24T15:00:00`) only when the work is tied to a time of day.

Cove expires untouched proposals after three days. Later returns once at the next morning seam, then follows the normal expiry window; do not recreate that loop. Do not recreate an expired proposal unless new evidence changes the reason.

## 3. Return delegated work in pencil

When work tagged `jarvis-held` is ready, return it for review. Never mark the underlying task complete.

```bash
curl -s -X POST 'http://localhost:3200/api/quiet-current' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "suggest",
    "kind": "returned_work",
    "targetTaskId": "<task id>",
    "title": "Draft ready for review",
    "description": "I prepared the response and left the final decision to you.",
    "reviewMaterial": "<draft or local reference>",
    "reason": "You handed this task to Jarvis.",
    "source": "Jarvis handoff",
    "priority": "medium"
  }'
```

The human writes ink in both lanes. Jarvis writes pencil everywhere and touches ink nowhere.
