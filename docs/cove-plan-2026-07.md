# Cove change plan, July 2026

The running plan from the system-by-system architecture walkthrough. We extend it section by section, settle it once (with a cross-model red-team on the settled version), then action it all in one build wave. Decisions recorded here are Alex's calls from the walkthrough sessions.

Status: IN PROGRESS. Sections settled: Task Management. Pending walkthroughs: Email, CRM, Setup and Teaching, Buddy and Execution.

## Already shipped during the audit (2026-07-28)

Shared column aliases, autonomy off by default for fresh installs, SETUP Step 0 preflight with agent-driven installs, Forge to Cove rename with compatibility layers, de-personalized product logic (operator-aware meeting follow-ups, neutral brief memory queries), private mirror repo `amart-builder/cove`, SETUP hard-gate on profile and goals quality, SETUP teaches mid-day replanning.

## Task Management (settled with Alex, 2026-07-28)

### 1. Recurring tasks: the second current owns the rhythm (BUILD)

Alex's frame: the middle current is the day's chosen priorities. The second current is the day's rhythm: the daily email card, plus every recurring obligation the user has declared ("post content every day"). Checkable daily, never crowding the center.

Proposed architecture (to red-team at settlement):

- New table `recurring_templates`: title, optional description, cadence (`daily`, `weekdays`, `weekly:<day>`, `monthly:<day>`), active flag, paused_until, last_spawned_local_date. No LLM anywhere in the spawn path.
- A deterministic spawner in the claude-worker watch lane materializes today's instances as real task cards on first opportunity each local day (same catch-up-on-wake pattern as the brief backfill). Dedupe key is template id plus local date, so a lid-closed morning can never double-spawn.
- Instances render in the second current lane, tagged `recurring`, one tap to check off.
- Settlement treats an unfinished recurring instance as auto-expiring, never Carry: a missed daily does not pile up seven stale cards. The miss itself feeds the brief.
- The brief gets a deterministic `recurring_rhythm` source: streaks and misses per template ("content posted 4 days straight; skipped yesterday"). Guarantee comes from the spawner; narrative comes from the brief. Never the reverse.
- Capture paths: the task skill and triage detect recurrence intent ("every day", "each Monday") and create a template plus today's instance; the setup interview asks "what do you do daily or weekly, no matter what?" and seeds templates on day one.

### 2. Mid-day replanning through the Buddy (BUILD)

The replan machinery exists end to end at the API layer (`/api/day-plan/assistant-apply`, the refine skill) and nothing in the UI calls it. Decision: the Buddy dock is the mid-day replan surface. Wire Buddy so a plain "new urgent thing, reshuffle my afternoon" runs the refine contract against today's plan and shows the proposed changes for one-tap apply. Until this ships, SETUP teaches the Claude-session phrasing (already added).

### 3. Single MacBook is the primary architecture (BUILD) — DESIGN LAW

Alex's rule, 2026-07-28: a standard user on one MacBook Pro gets ALL the features Alex has. Exactly two documented differences, and no others: (1) text pings arrive over Telegram instead of iMessage (iMessage requires a dedicated always-on Mac), and (2) triage and background work run only while the laptop is open, catching up on wake. Any feature that exists only on a two-machine setup is a bug against this law. Concretely:

- Meeting watcher and progress reconciler: remove the `--mini`-only gating; run them in the watch lane while the Mac is awake with catch-up on wake. The Mini remains an optional upgrade, not a requirement.
- Morning brief: the on-open backfill is the primary single-Mac path; keep it first-class and honest about the ~2 minute write.
- Reminders: catch-up on wake, with expectations set in plain words during setup (already in SETUP).
- The brief must stop warning about missing Mini heartbeats on installs that never had a Mini: heartbeat warnings only when the lane was actually installed.

### 4. Never-drop closes its two gaps (BUILD)

- Stale-task watchdog on the board itself: a deterministic detector for open tasks untouched for N days (start: 14) in Not Started or In Flight, surfaced as a brief section and a pale suggestion ("still want this?"). Today only the commitments ledger has staleness detection; board tasks can rot silently.
- Surface `operator_unconfigured` from the meeting-watch summary in the brief (flag exists, nothing reads it yet).

### 5. Undo becomes reasonable (BUILD)

- Task delete becomes archive-with-undo (toast, consistent with complete-undo). A "Recently deleted" view holds archived-by-delete tasks 30 days; hard delete only from there. Removes the one permanent-loss single-confirm in the product.
- Reopen-day: settlement dispositions get a bounded undo (reopen the just-closed day within the same evening). Scope carefully at build time.

### 6. Buddy feedback channel (BUILD)

Any user can send Alex a feature request or bug report from the Buddy. Implementation: Buddy composes a pre-filled Gmail draft (via the user's own connected email) addressed to the support address, user hits send themselves. Preserves the structural no-autonomous-send guarantee. Include app version and a one-line context header. If email is not set up, fall back to showing a copyable message.

### Explicitly not doing (task management)

- No always-running agent, no constant day resequencing (standing product law).
- No mobile app; multi-device stays the opt-in cloud mode.
- No calendar write-back this wave.

## Meeting Notes (settled with Alex, 2026-07-28; verified against code)

What exists today: extraction and triage are real and live-tested. Detected notes emails get follow-ups extracted; the operator's items run through the standard six-question triage onto the board; other people's items become waiting-on commitments. The email-triage run also invokes the watcher as a backstop.

What is missing for the vision (BUILD, all in the wave):

1. **SETUP onboarding step**: a Meeting Notes section parallel to Email and CRM. Ask which notes tool they use (Gemini, Granola, Fathom, Otter, other), pitch why it matters (agent context plus automatic follow-up capture), write a tool-specific `data/cove-meetings.json`, and install the watcher on a normal single-Mac install (today it is Mini-only and SETUP never mentions it, so no client gets it).
2. **Tool-agnostic detection**: a small library of known sender/subject patterns per notes tool that SETUP picks from, plus a guided path for unknown tools. The shipped default only matches Gemini.
3. **Email-triage fallback bucket**: a real meeting-notes classification in the email skill so notes land correctly even when the watcher is not installed or its query misses; today they fall through to ordinary reply/action/fyi handling.
4. **CRM create-or-append**: for each person named in the notes, look up or create the contact and append a meeting activity to their relationship history; set the real `contact_id` on waiting-on commitments (the pipeline currently hardcodes null and never touches the CRM; the only CRM-from-meetings path today is manually talking to the contact skill).
5. **Processed receipt**: a visible "found meeting notes from X: N tasks, M waiting-on, linked contacts Y, Z" signal (notification or board card), replacing the current silent heartbeat file, while keeping the deliberate no-loud-ping policy for meeting-sourced items.

## Email (walkthrough pending)

Known candidates going in: Composio free-tier limits verification; voice-calibration flow rehearsal.

## CRM (setup flow settled with Alex, 2026-07-28; full walkthrough pending)

### Connect-first CRM setup (BUILD)

New SETUP flow, replacing the current interview-plus-optional-CSV step:

1. Ask whether the user already has a CRM (HubSpot, Pipedrive, Attio, Salesforce, a spreadsheet, anything).
2. If yes, the setup agent does LIVE online research on that specific CRM: does it expose an API, an MCP server, or a Composio integration? Strongly recommend connecting it.
3. **Connectable existing CRM**: connect it and use it directly. Migrate nothing. Cove reads and writes their real CRM.
4. **Not connectable** (or no CRM): copy their data into the local Cove CRM (guided export/CSV import, mapping confirmed on first rows) and they start living in it.
5. Either way the guarantee holds: meeting notes always have a CRM to land in.

Architecture implication: the meeting-notes create-or-append path (Meeting Notes item 4) and the contact skill write through one small CRM backend interface with two implementations, local SQLite and connected-external (MCP/Composio tools, resolved per install). Alex's own Attio setup is the precedent for the external path. Config records which backend the install uses; the watcher and skills consult it rather than assuming local.

### Other CRM candidates (walkthrough pending)

Verify skill-copy on install (done for this machine, verify in rehearsal); import-flow polish.

## Setup and Teaching (walkthrough pending)

Known candidates: first-value runbook (client's real priorities in before first brief), one-page handoff, clean-machine rehearsal findings.

## Process

1. Walk each remaining system with Alex; extend this plan.
2. Settle the full plan; one cross-model red-team pass on the settled version.
3. Action everything in one build wave with per-item verification and a final fresh-context review.
