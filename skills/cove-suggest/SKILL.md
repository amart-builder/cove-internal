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

## 1. Check the current first

```bash
curl -s 'http://localhost:3200/api/forge-rest/tasks?select=*&order=position.asc'
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
    "priority": "medium"
  }'
```

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
