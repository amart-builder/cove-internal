# Forge agent contract

Claude and Codex use the same local HTTP contract. Forge normally runs at `http://localhost:3200`.

## Authority rule

- An explicit user request may become a task directly.
- Work inferred from email, meetings, messages, or model reasoning must become a Quiet Current suggestion.
- Reading or focusing a suggestion is free. Only an explicit acceptance or a clear work action may turn it into a task.
- Never complete, retire, defer, or hand off accepted work without a human action or a standing permission the user can inspect.
- If `data/forge-profile.json` exists, use it to make reasons and priorities more relevant. It describes context, not authority: it never turns inferred work into ink or permits an external action by itself.

## Read the current

```bash
curl -s 'http://localhost:3200/api/forge-rest/task_columns?select=*&order=position.asc'
curl -s 'http://localhost:3200/api/forge-rest/tasks?select=*&order=position.asc'
curl -s 'http://localhost:3200/api/quiet-current'
```

## Propose work in pencil

Every proposal requires a human-readable reason and source. It expires after three days by default. If the person chooses Later, Forge hides it until the next morning seam, shows it one final time with that context, and then lets the normal three-day expiry finish the decision. Choosing Later again does not schedule another return.

```bash
curl -s -X POST 'http://localhost:3200/api/quiet-current' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "suggest",
    "kind": "create_task",
    "title": "Review the revised proposal",
    "description": "Check the commercial terms and send your decision.",
    "reason": "The client replied with revised terms this morning.",
    "source": "Gmail thread with Acme",
    "priority": "high"
  }'
```

Forge supports `create_task`, `returned_work`, and `observed_progress`. Returned work is work Jarvis did and may include `reviewMaterial`. Observed progress is evidence of work the person did themselves; it requires `targetTaskId`, never carries Jarvis ownership, and offers a plain mark-done or open-task decision. All three still arrive in pencil. Defer, retire, and handoff offers stay out of the agent API until their target-task transactions can be made atomic.

## Handoff state

Tasks carried by Jarvis use the `jarvis-held` tag. Jarvis may work only on tasks the person handed over or on standing routines granted during setup. Finished agent work should return through a `returned_work` suggestion rather than being marked complete.

## Groundwork autonomy

Groundwork runs with read-only repo tools and an isolated empty Claude settings file, so user hooks and write or shell tools are unavailable. `WebSearch` remains enabled because current external facts materially improve useful groundwork; it is the lane's one intentional network egress channel. Groundwork may research and draft, but it must never send outbound communication.

## Date and time semantics

Only add a time to `due_at` when the person supplied a real clock time. For date-only work, use midnight in either the canonical server timezone or UTC; Quiet Current treats both local midnight and UTC midnight as an un-timed date and will not draw a time anchor. Never turn an estimated duration or a convenient serialization hour into a displayed schedule.

## Decision history

Forge records focus, acceptance, refinement, dismissal, decay, handoff, completion, and undo events in `data/quiet-current.json`. This file is local, gitignored, bounded, and intended to become correctable preference summaries rather than invisible model folklore.

If Forge surfaces a rollback error after reopening a proposal, pencil and ink may both remain visible until the person resolves the mismatch. Treat that pair as one fail-visible item: do not duplicate it, re-propose it, or infer that either side won.

Quiet Current state lives on the machine serving the Forge page. In a Supabase or Convex setup, choose one canonical Forge server and have every browser and agent use that URL. Running separate Forge servers against the same cloud task database will sync ink but not the pencil layer.
