---
name: cove-chief-of-staff
description: Operate Cove's persistent chief-of-staff session. Use when the user asks to wake it with a note, inspect its status or audit trail, run its weekly review, or explicitly reset its Codex session.
---

# Cove chief of staff

Run commands from the Cove repository. The persistent agent reasons from a
fresh local snapshot on every wake. Cove's trusted driver validates and applies
only its small action vocabulary.

## Wake it manually

Queue a wake without waiting for the agent:

```bash
node --import tsx scripts/cove-chief-of-staff.ts enqueue --reason manual --note "Review the current follow-ups"
```

The background drain normally handles the job. To process queued work now:

```bash
node --import tsx scripts/cove-chief-of-staff.ts drain --max 3
```

## Inspect it

```bash
node --import tsx scripts/cove-chief-of-staff.ts status
```

Audit data lives under `data/chief-of-staff/`:

- `session.json` holds the Codex session ID and wake count.
- `codex-home/` isolates the agent's config, sessions, and rollouts from the
  operator's Codex sessions. Its `auth.json` is a symlink to the operator's
  live Codex auth file, never a copied credential.
- `journal/` holds the driver-written daily journal.
- `snapshots/` holds the exact bounded input for the latest 50 wakes.
- `reviews/` holds weekly fresh-context reviews.
- SQLite table `chief_of_staff_actions` holds every applied or rejected action.

## Review or reset

Run the weekly review on demand:

```bash
node --import tsx scripts/cove-chief-of-staff.ts review
```

Reset only when the user explicitly asks. Reset archives the current session
record and starts a fresh Codex session on the next wake:

```bash
node --import tsx scripts/cove-chief-of-staff.ts reset --why "The session is no longer coherent"
```

## Safety boundary

The agent has no shell, file reads, MCP servers, network, or writes. Its only
hands are the JSON actions returned to Cove's validating driver. It may propose
task changes, add a non-terminal pipeline deal for a contact with no deal,
pipeline touches and safe pipeline changes, CRM notes that do not change
recency, or pencil suggestions. Use `pipeline_update` or `pipeline_move` when a
deal already exists. It cannot send email, delete or merge records, or change
its mandate. Cove rejects unknown actions, additions at `client`, `lost`, or
`parked`, and pipeline moves to `lost` or `parked`.
