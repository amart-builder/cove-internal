# Cove change plan, July 2026

The running plan from the system-by-system architecture walkthrough. We extend it section by section, settle it once (with a cross-model red-team on the settled version), then action it all in one build wave. Decisions recorded here are Alex's calls from the walkthrough sessions.

Status: SETTLED 2026-07-28 evening (all walkthroughs done; cross-model red-team applied; Alex signed off on the four contested calls). Build wave is internally SEQUENCED; see "Wave order and reliability spine" at the end.

> Superseded on 2026-07-29 for Google Workspace: the red native-Claude-connector spike remains historically accurate, but active Cove runtime and setup now use Cove's direct restricted Google OAuth gateway. See `docs/email-architecture-redesign.md`.

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

## Email (walkthrough done 2026-07-28; deeper scope to confirm at settlement)

Settled by Alex: default cadence stays twice daily (9:00, 15:00, user-configurable). No draft nudging of any kind: the card link is the only pointer, sending is the user's habit, quiet by design. Email gets DEEPER work in the wave, not just polish.

Deeper-email items CONFIRMED by Alex (2026-07-28 evening):

1. **CRM-aware drafting** (confirmed): when drafting a reply, pull the sender's record through the CRM interface (relationship history, last touch, open waiting-on items) so drafts read like they know the person. Writes a contact activity for meaningful correspondence (create-or-append, same interface as meeting notes).
2. **Commitment capture from email** (confirmed): promises in sent replies and inbound threads ("I'll get this to you Friday") land in the commitments ledger as follow_up / waiting_on with the source quote.
3. **Attachment awareness** (confirmed; Alex kept it in the wave, guarded): triage reads common attachments for classification and draft context (an invoice is an action item, not a notification). Guardrails required at build: size caps, common formats only, no OCR in v1, attachment content treated strictly as untrusted data (never as instructions), bounded cost per run.
4. **Meeting-notes fallback bucket** (confirmed; also Meeting Notes item 3): triage recognizes meeting-notes emails and routes them into the meeting pipeline instead of normal reply handling.
5. **Long-sleep catch-up**: first triage after days of lid-closed must reach back to the last successful run, not a fixed 2-day window. Verify and fix.

6. **Card and inbox two-way sync** (Alex's spec, 2026-07-28): (a) thread deleted or archived in Gmail -> its card item auto-checks off; (b) the drafted reply, or any reply by the user in the thread, was sent -> auto-check off; (c) item checked off on the card while the thread still sits in the inbox -> archive the thread in Gmail. Implementation notes: inbox-state reconciliation runs on every triage pass (Gmail wins into the card); the card-to-Gmail direction is instant on checkbox click; runs report what they auto-checked in one quiet card line ("3 threads you handled in Gmail were checked off") so the behavior is visible and trusted. Archiving stays within the existing label-modification capability; sending stays structurally impossible.

7. **Replace Composio with the native Claude Gmail connector** (Alex's decision): kills the Composio account/API-key setup step entirely. FEASIBILITY SPIKE FIRST: the scheduled triage runs headless; verify connector auth is available in headless/background runs before migrating. Rollout: first client install (2026-07-29) uses the proven Composio path; the wave ships the connector path and migrates existing installs. The meeting watcher's Gmail access migrates on the same decision. Composio-limits verification is dropped (moot).

Explicitly not doing (email): no email tab, no autonomous send ever, no urgent-interrupt pings until the precision-gated attention broker ships, no draft nudges.

## UI Unification (Alex, 2026-07-28)

The main Today tab's water/current aesthetic is the design north star ("really beautiful", keep it). BUILD: makeover of the All Work tab and the People (CRM) tab to match it: same palette, spacing, calm de-boxed styling, motion doctrine (apple-design / emil-design-eng, house easing token). One product, one vibe, all three surfaces. Design pass with live review before the wave closes.

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

## Setup and Teaching (settled with Alex, 2026-07-28 evening)

Keep: interview-first structure, the private-draft quality gate, prove-don't-promise, the honest-limits speech.

1. **The first brief is the finale (BUILD, SETUP restructure)**: interview and files first, then tasks + email + CRM + meeting notes loaded, THEN the first brief generates as the closing moment, reading back a day it genuinely knows. A quiet technical smoke-test brief still runs mid-setup to catch failures early. This SETUP.md reorder is doc-only and ships BEFORE the first client install (2026-07-29), ahead of the wave.
2. **Pretend first morning (BUILD, SETUP addition, also pre-client)**: a 5-minute guided practice Arrival with demo data during setup (read a brief, drag priorities, assign an owner, start the day, close it), so the real first morning is the second time through the ritual.
3. **Durable leave-behind, two parts (BUILD, wave)**: (a) the Buddy answers "how do I..." questions as the living manual, with the exact phrases; (b) a calm in-app /guide page in the water aesthetic: the three daily moments, the vocabulary, the replan phrase, what runs when the lid is closed. Setup ends by showing both.
4. **Plain-English vocabulary everywhere (BUILD, folds into UI unification)**: kill visible jargon; "Day settlement" -> closing your day, "Unresolved commitments" -> still open, one register across the UI. Internal identifiers unchanged.

## Buddy and Execution (settled with Alex, 2026-07-28 evening)

### Owner chips redefined as session launchers (BUILD) — the law

Alex's semantics, replacing the workspace-gated meaning:

- **"Claude" owner** = open a Claude session in AUTO-EDITS permission mode (settled by Alex after red-team: file edits and task work run autonomously; consequential actions still hit Claude Code's own approval prompt; never bypassPermissions, because the no-finals rule must be a lock, not an instruction), seeded with the task detail, expected to complete the entire task autonomously with no explanation beyond what the task carries. Full laptop reach (whatever the user could do themselves), because it is literally a Claude session on their machine. Hard line in the seed instructions: no binding or final actions (no sending, publishing, purchasing, nothing irreversible); it produces drafts, files, and ready-to-fire work product.
- **"Together" owner** = the same seeded session, opened in PLAN mode.
- No workspace allowlist or git repo required for the chips. Deliverables default to a Cove-managed outputs folder so results are always findable; results and resume links still land back on the board.
- The existing gated headless lane (allowlisted workspace, budget, clean repo) is NOT deleted: it remains the machinery for unattended/overnight execution later. The chips just stop depending on it.
- Trust model, said out loud in setup: auto mode's boundary is Claude Code's own permission system plus the no-finals seed rule, identical to the user running Claude by hand.
- Approval-state fallback: this Claude CLI launch path does not expose a stable machine-readable permission-prompt event. Until it does, Cove keeps the run at "running," shows that Claude may be waiting for approval, and keeps the resume link on the board. The explicit "awaiting approval" state is supported for a future reliable signal and is never guessed from log text.

### Buddy scope (settled)

Stays a Cove-data command palette with manners: receipts, gated deletes, session spawning. Additions already planned: mid-day replan wiring and the feedback channel. No general chatbot in the dock (standing law reaffirmed).

### Hygiene (BUILD)

- Orphan reaping: record child pids for brief/dump/execution children so a dead server never strands runs.
- Replace the 1.5s git-subprocess readiness polling in the day ritual with cached/on-demand checks.
- Rehearsal-verify: day-one behavior of the owner chips on a fresh no-workspace install; spawn-session UX on a machine with no projects folder.

## Health and Adoption Check (proposed 2026-07-28, awaiting Alex confirm at settlement)

Alex's ask: a recurring agent that checks whether Cove is functioning and achieving its goal, and talks to the user when it isn't. Reshaped from "architecture review on a timer" (rejected: architecture doesn't change every 48 hours; repeated review invents findings) to:

- Every 2-3 days, deterministic collectors gather (a) system health: brief generation, triage run success, spool drain, service heartbeats, backups; (b) adoption signals: days since last Arrival/settlement, drafts written vs sent, stale tasks, broken recurring streaks.
- ONE bounded Claude pass judges "is Cove serving this person, and what is the one thing to say."
- Output respects the attention laws: a morning-brief section when something needs the user; Telegram ping only for hard failures (e.g. triage dead 3 consecutive runs); no unprompted conversations. User can ask "how is Cove doing?" anytime.
- Optional, opt-in with full disclosure: a weekly system-facts-only health email from client installs to the operator's Jarvis Pro support address, so fleet problems surface before the client calls. Alex decides per client.

## Wave order and reliability spine (settled after cross-model red-team, 2026-07-28 evening)

The wave builds in this order; later stages depend on earlier ones:

1. **Reliability spine first**: one background-job scheduler with leases, priorities, and backoff (a lid-open morning must not stampede six jobs); idempotency keys on every automated write; receipts (source, time, actions, retries) on every automated action; a **visible failure inbox** surface where unprocessed mail, failed notes, expired logins, dead jobs, and partial writes appear instead of vanishing; versioned migrations; automated backups with a TESTED restore.
2. **Gmail connector feasibility spike**, hard pass bar: headless auth works unattended, least-privilege scopes, token refresh, and a send-denial test proving the send capability is structurally excluded. Any red = stay on Composio. **SPIKE RESULT 2026-07-28: RED, staying on Composio.** The native connector's tools never load in headless `-p` runs (tracked Claude Code bug: anthropics/claude-code #26364 #37805 #36060 #43298), Google's consent screen can't be narrowed to exclude send scope (send is suppressed at the product layer only), and there is no way to build a strict headless session that structurally excludes a send tool. Re-check after Claude Code upgrades (`claude -p "list your gmail tools"`); do not migrate until that passes and the full bar is re-run.
3. **CRM interface + local backend** with contact identity resolution (dedupe before auto-creating people). External adapters are NOT shipped code: they are wired per client at setup when a real client has a connectable CRM (Alex's call; the connect-first setup flow is unchanged).
4. **One shared meeting/email ingestion pipeline**, deduped by Gmail message id, feeding both the watcher and the email-triage fallback so the same notes can never double-process.
5. **Features**: recurrence (with a DB uniqueness constraint per template per local day, settlement interaction defined, and user confirmation before a recurrence template is created from natural language), stale-task watchdog, archive-with-undo, card-inbox sync, commitment capture, CRM-aware drafting, attachment awareness (guarded), meeting-notes SETUP step, health COLLECTORS.
6. **Setup, receipts UX, mid-day replan wiring, plain-English vocabulary.**
7. **UI unification pass** (All Work + People to the water aesthetic) with live design review.
8. **Owner chips last**, after task/run lifecycle states exist (running, awaiting approval, failed, output ready, abandoned; and rules for a task settled or deleted while its session runs). Chip modes are enforced by session permission mode: Claude = auto-edits, Together = plan.

Hard-failure alerting goes to Telegram directly, never only the brief (a broken brief cannot report itself).

**Fast-follows (the week after the wave)**: reopen-day undo, fleet-health email (opt-in), Claude-judged adoption coaching (collectors ship in the wave), external CRM adapters as clients need them.

## Process

1. Walk each remaining system with Alex; extend this plan. DONE.
2. Settle the full plan; one cross-model red-team pass on the settled version. DONE (red-team findings folded in above; Alex decided the four contested calls 2026-07-28 evening).
3. Action everything in the sequenced build wave with per-item verification, cross-system integration checks at each stage boundary, and a final fresh-context review.
