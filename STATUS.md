# Forge - STATUS

<!-- BEGIN repo-identity -->
## Repo Identity
- **group_id:** forge
- **canonical_repo:** projects/astack/forge
- **macbook_path:** /Users/alexanderjmartin/Atlas/projects/astack/forge
- **mac_mini_path:** /Users/alexandermartin/Desktop/Atlas/projects/astack/forge
- **github:** public `amart-builder/forge`, clean on `main` as of 2026-07-10 commit `63ac66d`
- **default_branch:** main
- **owned_by:** shared
- **deploy:** http://localhost:3200 on the Mac Mini; Alex's MacBook URL is http://alexander-mac-mini.taildd6a98.ts.net:3200/tasks
- **never_commit:** .env*, data/forge.db*, secrets, private email/task/contact exports
- **push:** use the repo safe-push flow when this repo is clean enough to commit; never raw git push
<!-- END repo-identity -->

<!-- BEGIN active-session -->
## Active Session
- **system:** cowork
- **device:** Alexanders-MacBook-Pro-2
- **since:** 2026-07-24T12:35:06-0700
- **task:** Gate morning brief on closing the previous day
<!-- END active-session -->

---

**Last updated:** 2026-07-20 (plan-review tool allowlist aligned with CLI plan mode; not committed)
**State:** The MacBook's loopback-only `com.forge.web` now serves the wide Morning Arrival with Claude-powered task creation, completion, editing, ownership, and reprioritization, plus explicit execution modes, durable background runs, and reviewable results. `com.forge.claude-worker` is installed and healthy. Autonomous execution remains disabled until an allowlisted project is deliberately configured. The 8 a.m. trigger is still not installed. Email triage remains a separate Mini service and was not changed.

## North Star Goal
Make Forge the source of truth for Alex's day-to-day execution: tasks, email action items, CRM context, and daily priorities in one operating surface.

## Product Direction (decided 2026-07-16, Alex-approved)
Forge is the day's MEMORY and CONTROL TOWER; the Claude desktop app is the HANDS where work happens. Forge is a visible cockpit for exactly two ritual moments (Morning Arrival, evening settlement) and a background state layer in between. Mid-day, Forge's surface inside Claude is the `forge-day` skill (~/.claude/skills/forge-day): log outcomes, offer the next priority, capture tasks/decisions via scripts/forge-buddy-data.ts. Pull-back mechanism: strictly budgeted Mac notifications (needs-a-decision / blocked / didn't-finish only). Refuse: in-Forge plan-review consoles, growing the buddy beyond a Forge-data command palette, hard dependence on claude:// deep links (copy/resume path is co-equal; context transfer is the product, auto-open is polish). Product metric: time from finished task to right next task — not time spent in Forge.

## Assumptions
- Forge Tasks is the primary task surface.
- Supabase-backed task data is the live path through /api/forge-rest.
- The board columns are: Not Started, Must happen today, In Flight / Waiting, and Done.
- Email triage should not be re-enabled without Alex confirming, because it reads real Gmail and writes Forge action cards.
- Closed tasks require direct evidence before marking done.

## Product Direction v2 (decided 2026-07-17, Alex's vision, refined by cross-model consult)

Forge's next chapter: from control tower to **proactive chief of staff — a co-manager of Alex's life**, working for him around the clock. His words: "making sure no follow ups are dropped... making sure I make good progress towards my goals." The consult's reframe, which we adopted: Forge doesn't need to *be* smarter than Alex; it needs to be more continuous, more prepared, and impossible to distract — commitments never dropped, the next thing always warm, escalation only on exceptions. "24/7" is event-driven + scheduled on the Mini, never an always-running agent.

Five new primitives (build order by trust-earned-per-effort):
1. **Commitment ledger** (the keystone): every promise, follow-up, quota, and open decision as a typed record — source quote, due/review date, confidence, Alex-confirmed flag, evidence of completion. A task list tracks tasks; the ledger knows *Alex owes Brian a reply about Tuesday*.
2. **Evening brain dump** ("End my day" box): free text/Wispr dictation parsed into follow-ups, ideas, corrections, overnight requests → ledger. Extractions keep their source quote and confidence; nothing external ever fires from a dump.
3. **Trigger/gap engine**: deterministic detectors first (content quota vs Supernova queue, follow-ups due, meetings without prep, tasks with no next action).
4. **Overnight lane with receipts**: picks the highest-value item from a pre-authorized portfolio (explicit overnight asks first, then gaps), one bounded inspectable artifact per night, draft-only, morning receipt (what/why/preview/approve-discard). Shadow mode first. "Nothing worth doing tonight" is a success state. Never blocks the morning brief.
5. **Attention broker**: hard interruption budget; urgent-email interrupts only after shadow-tested precision (~95%), otherwise digests. Snoozable end-of-day nudge.

Phases: P1 ledger + brain dump + gap detectors → P2 overnight lane (shadow → one artifact/night) → P3 just-in-time prep (real bounded planning run for the next priority while Alex works the current one; "Ready" packet, no activity theater) + attention broker → P4 earned autonomy, promoted per-domain by explicit ask ("12 of 13 approved unchanged — make automatic?"), never inferred.
Standing rule (Alex, 2026-07-17): before saying "I can't see that" or asking him, GO LOOK — session transcripts, STATUS.md files, git, the board, memory are all readable. Only ask what lives in his head.
Explicitly rejected: always-running general agent, autonomous external sends, custom voice stack, constant day resequencing, implicit permission learning, pre-opened idle Claude sessions. Email triage stays OFF until Alex explicitly re-enables. 14-day pilot metrics gate each autonomy expansion (≥60-70% of overnight artifacts genuinely used, else Alex seeds the queue explicitly).

## Current State

### 2026-07-24 Morning brief gated on closing the previous day (working tree)

- Problem Alex hit: he skipped End My Day, and the 7:30 brief wrote itself off sources that literally cannot see an unsettled yesterday (`day_snapshots` rows only exist after `settlement_commit`). The brief was not slightly worse, it was a confident guess.
- The gate is cross-machine only, and it fail-opens. The ritual machine (MBP) publishes `data/settlement-relay/closure.json` with `latest_local_date` + `open_local_date`; the brief machine (Mini) reads it and holds. No closure file, stale file (>26h), or malformed file means no opinion, so the brief always runs. A same-machine gate reading `day_plans` was designed, built, reviewed, and then deleted: `day_plans.open_slot` is UNIQUE and `ensureDayPlan` returns the open plan whatever date it is asked for, so a plan dated today cannot exist while an earlier day is open. The gate would have read as protection and provided none.
- Gated in two places, both pre-claim: the 7:30 cron enqueue (`enqueueDueMorningBrief`) and the drain loop in `runOneMorningBrief`. A blocked row stays `queued`, never `failed`, so the moment he closes the day the same loop writes the brief he was owed. The settlement path is deliberately never gated: gating the brief settlement itself just requested would deadlock the morning.
- Skip button: "Write my brief now" in the arrival brief step (`POST /api/day-plan` action `force-brief`). It bypasses the gate, and if a brief already exists that the no-hot-swap guard is holding back, it attaches that one content-only (no version bump) instead of starting a second run. Disabled while the round trip is in flight.
- Progress bar: `BriefProgress.tsx` counts against the measured median (n=15: min 75s, max 666s, avg 186s, median ~132s) so he can see whether he has time for a coffee. Live region is scoped to the queued→writing sentence only; the countdown would talk over a screen reader.
- Bug fixed along the way: an adopted brief artifact was inheriting the placeholder row's `created_at`, which made an old brief look freshly requested.
- Verified: `npx tsc --noEmit` clean, 363/363 tests (new coverage for the gate, the force attach, the drain hold, and the relay-reader validation), plus fresh-context Codex and Opus reviews. Known and not fixed: the cross-machine force/cron race (both machines can start a brief in the same window) is a pre-existing pattern, not new here.

### 2026-07-20 Progress settlement disposition for multi-day work (shipped)

- End-of-day settlement now offers four dispositions: Progress (new), Carry, Defer, Drop. Progress records optional `progressNote` (≤500 chars) and `nextStep` (≤200 chars), counts the commitment as kept, leaves the task/board untouched, and writes no reconciliation rows (like Carry). Snapshot `unresolvedItems` carry both fields; old snapshots without them still parse.
- Tomorrow's recommendation seed prefers the first Progress item by position, then falls back to first Carry.
- "Worked on today" evidence: same-local-date `day_plan_execution_runs` rows for the item/task (task `updated_at` was rejected — Forge bookkeeping writes it). Items with evidence get an editable automatic Progress pre-selection (capped at 2 attempts per settlement open) plus a "Claude worked on this today." hint.
- Morning brief: continuing work (Progress, with note + next step) is separated from not-moved Carry items, with carried-streak counts over consecutive calendar days within the 7-day snapshot window; chief-of-staff prompt is now v8 with the momentum-vs-not-moved paragraph.
- Execution seeds gain `YESTERDAY_PROGRESS`/`NEXT_STEP` lines (JSON-stringified data, only when present) from the latest Progress snapshot entry for that task within 14 days.
- Verified: held-out acceptance script (store flow, seed ordering, reconciliation isolation, oversize rejection, seed lines), tsc, 180+ scoped tests, fresh-context Opus review (verdict SHIP; both findings — 500-vs-400 misclass on the progress-details guard, unbounded auto-post retry — fixed and re-verified).

### 2026-07-20 Task-first Claude seeds and plan-resume mode hint (working tree)

- Execution and Buddy seed commands now put Forge role/setup instructions in `--append-system-prompt`; stdin starts with `# <task title>` and immediately carries the task fields or user request so Claude Desktop can derive a useful session title instead of “General Coding Session.” Existing safety, deliverable, and orchestrator-resume instructions were preserved.
- Every day-plan `Open in Claude Code` affordance receives the run mode. Plan-review runs show a muted warning that the app opens in its default mode and Alex must switch the picker to Plan; autonomous and generic Buddy session links do not show it.
- Preserved the separately added uncommitted $3.00 default budget for plan-review and autonomous execution seeds.
- Verified: TypeScript, scoped ESLint, `git diff --check`, and 34 focused worker, Buddy spawn, day-plan execution, and mode-hint render tests. No live Claude session or app handoff was started. No commit was created.
- Next gate: after intentional deployment, start one real Forge plan and one Buddy session to confirm their desktop sidebar titles use the task title, then verify the Plan-mode caption is legible on the live card.

### 2026-07-20 Plan-run grounding and degenerate-output validation (working tree)

- Plan-review execution seeds now receive the plan-mode-coherent `Read,Glob,Grep,Task,Skill,AskUserQuestion,Write,ExitPlanMode,WebFetch,WebSearch` set in permission mode `plan`; `Bash` and `Edit` remain excluded, while `Write` is available only through plan mode's plan-file exception under `--safe-mode`. Their default budget is $3.00, explicit run budgets still win, and autonomous tools plus its $3.00 default are unchanged.
- The plan prompt requires real tool reads and real path citations, and tells the model to stop honestly if tools are unavailable instead of simulating tool output.
- Exit-zero plan results now fail with `plan_degenerate` when their substantive text is under 200 characters or the captured Claude `stream-json` output contains zero real `tool_use` events. The zero-tool gate is intentionally unconditional: a genuine no-file strategy plan may cost one Retry, accepted because every Forge run cwd has readable context and a fabricated 1,681-character plan passed the substance check. The store also refuses an exit-zero plan transition with missing or short result text, so failed runs use the existing board failure path instead of `plan_ready` or `ready_to_join`.
- Validation passed: TypeScript, scoped ESLint, `git diff --check`, and 32 focused worker/execution tests. The exact stalled Supernova one-liner and a substantive multi-paragraph plan with zero tool use both persist as failed with exit code 0 and `plan_degenerate`, expose no session handle, and never open a session; a grounded three-paragraph plan with a real `Read` event passes. No live Claude run was started.
- Next gate: restart the supervised worker when this working tree is intentionally deployed, then run one real Plan kickoff and confirm the plan cites files it actually read. No commit was created.

### 2026-07-20 Project-aware Forge-launched Claude sessions (working tree)

- Buddy session spawning now accepts either an explicit Atlas path or an immediate Atlas project-folder hint. Project matching is normalized, ambiguity-safe, and protected by the shared realpath-inside-Atlas guard; resolution failures return the actual folder-name list.
- Buddy and execution seed conversations now begin with the task title so Claude Desktop can generate relevant sidebar titles. CLI `--name` behavior remains in place.
- Plan-review runs resolve the day-plan item's project (the task's first tag), then title as fallback, and persist the resolved directory in the existing run workspace path used by both execution and resume commands. Autonomous workspace selection is unchanged.
- Independent review fix: plan-review cwd is now resolved once when the run is enqueued and is excluded from execution authorization and claim-time workspace equality. Folder drift cannot cancel the queued plan run; autonomous workspace authorization remains strict. Short project-folder names require exact matches, and outside-Atlas directory symlinks are rejected by the realpath guard.
- Verified: 62 focused tests (including day-plan store and execution suites), TypeScript, scoped ESLint, and `git diff --check` pass. No live Claude session was spawned. Not committed.

### 2026-07-20 Buddy Claude sign-in guidance (working tree)

- Failed Buddy turns now recognize Claude CLI sign-out messages and replace the raw CLI error with friendly, numbered Terminal sign-in instructions while preserving Retry behavior.
- The guidance names the serving host and adds a remote-machine warning when Buddy deep links are disabled. The Buddy session payload now exposes that existing server setting to the panel.
- Verified: detector tests (2/2), Buddy route tests (11/11), TypeScript, scoped ESLint, and `git diff --check` all pass. No component rendering harness exists, so no new one was introduced.

### 2026-07-19 Phase 1.5: commitment resolution + arrival/settlement self-heal (shipped)

- Evening dumps now resolve or update existing commitments with grounded evidence (high-confidence done → status closed with quote; high update → due_at/note; medium/low → proposed_resolution the brief asks about), preserve ambiguous resolutions for morning confirmation, isolate per-commitment failures, and never touch a commitment that left open status mid-extraction. Brief source adds RESOLVED FROM YOUR NOTES + proposed/updated markers; MORNING_BRIEF_PROMPT_VERSION=7; chief-of-staff.md v7 (owner): acknowledge closures, quote-and-ask proposals, suggestions-are-suggestions, "talking points" never "beats".
- Pristine empty Morning Arrival heals on open: one attach-only ensure repopulates candidates and attaches a succeeded brief; loopback GET now reports such a brief as `briefGeneration: succeeded` instead of idle. Heal is visibility-gated (document must be visible) — correct in real browsers; automated QA panes that report hidden must force visibilityState.
- Settlement open reconciles canonical task completion server-side (REST/Buddy-completed tasks show under Completed without reload on the Close-My-Day click path; an auto-reopened dialog from persisted state re-reconciles on the next explicit open). Fails open on REST hiccups. Partial commitment-fetch failures render `Unavailable (fetch failed).` instead of a false `None.`. Evidence merges use a REST compare-and-swap; local SQLite `updateRows` now returns PostgREST-style RETURNING rows so the CAS works in local mode (was: every resolution threw while silently writing).
- Build history: Sol built, independent Opus review (fix-then-ship, 3 findings), Sol died twice (network stream + dead codex refresh token — codex on the MBP needs interactive `codex login`), native Opus worker audited and finished, fixing two live-breakers Sol left (one-shot heal burned on empty candidates; the local CAS bug). Verified: 316/316 serial tests, tsc, lint; live browser acceptance passed for all three parts (real extraction with correct resolutions incl. "Tuesday at 2pm"→ISO; heal fired exactly once populating 3 items; settlement showed REST-completed work). Route loopback self-calls default to :3200 (`defaultBriefWebBase`) — non-3200 deployments must set FORGE_BRIEF_WEB_BASE or settlement completions silently fail open.

### 2026-07-18 Phase 1 chief of staff: commitment ledger + End My Day brain dump + gap detectors (shipped)

- **Commitment ledger**: shared `commitments` table (Supabase `forge_commitments` — created live via authed supabase CLI `db query --linked`; SQLite mirror + migrate guards; one allow-list opens REST + buddy CLI). Fields: kind (follow_up/promise/waiting_on/open_decision/overnight_request/idea), source_quote (verbatim), due_at/review_at, confidence, confirmed, status, evidence.
- **End My Day brain dump**: optional ≤8000-char textarea in DaySettlement (server truncates, never blocks settlement), enqueues `day_dumps` row (SQLite queue mirroring briefs: claim/complete/fail + stale sweep). New worker lane `dump` (also under watch/all): Sol-first read-only-sandboxed parse with Claude fallback, strict validator (verbatim-substring quotes, ISO dates, ≤20 items), one corrective retry per engine, inserts via CSRF-guarded loopback forge-rest, honest partial receipts.
- **Gap detectors** (`gap-detectors.ts`, pure/deterministic): contentQuotaGap (PT-day bucketing of supernova-engine pipeline/queue + posted; env FORGE_SUPERNOVA_ENGINE_DIR + FORGE_CONTENT_QUOTA_POSTS=2), followUpsDue (Pacific end-of-tomorrow cutoff), staleOpenItems. New computed brief source `commitments` (OPEN_COMMITMENTS_AND_GAPS, priority 5, optional, fail-open, NOT in cross-machine checkpoint); priorities renumbered 1-11; MORNING_BRIEF_PROMPT_VERSION=6. prompts/chief-of-staff.md gained the owner-authored ledger section (weave due items into the plan, quote his words on unconfirmed items, quota numbers are facts, overnight requests recorded-not-executed).
- Verified: 300/300 + tsc clean under the president's run; fresh Opus review SHIP with zero gating findings (8 minor, 6 fixed); held-out E2E acceptance passed — real Sol parse of a synthetic dump (5 commitments, correct kinds/verbatim quotes/date resolution incl. "next Tuesday"→Jul 21), quota detector correct against the live supernova queue (0 scheduled, 4 awaiting approval, gap 2), synthetic data cleaned after.
- First live exercise: Alex's End My Day tonight; extractions land in the 7:30 brief as OPEN_COMMITMENTS_AND_GAPS. Overnight_request items are RECORDED only (Phase 2 executes them).

### 2026-07-17 Morning brief v5: Sol chief-of-staff writer + lean prompt + operator context (shipped)

- Alex's verdict on v4: unhelpful, confusing, cold, AI-sounding, "doesn't understand me." v5 rebuilds the brief around a lean owner-authored mandate (`prompts/chief-of-staff.md`, edited only by the president, loaded verbatim at prompt build, module-relative path + cwd fallback + logged v4 fallback) with his voice rules (warm greeting + three-lane re-anchor, never guess, no jargon, no "beats", watch items as finished human sentences, LEADUP supersedes stale planning docs).
- Writer is now GPT-5.6 Sol at high reasoning via codex CLI (`FORGE_BRIEF_WRITER=codex`, `FORGE_CODEX_BIN`), read-only sandbox from a private temp dir, one corrective retry, automatic Claude fallback, `writer` provenance stored in the brief JSON. Both machines codex-first.
- Two new file sources: `operator_profile` (~/Atlas/brain/operator-profile.md, P2) and `leadup` (~/Atlas/brain/brief-leadup.md, P3, the 14-day interview backfill approved by Alex 2026-07-17). Jarvis memory pull widened to 3 merged searches. Full source priority reorder. Checkpoint protocol records explicit null for absent optional files so a missing optional file can never brick the Mini (all four absence cases tested).
- UI: watch items render as "Label. finished-sentence" only (no evidence refs/last-seen); "Beats only" chip renamed "Talking points"; MORNING_BRIEF_PROMPT_VERSION=5 everywhere (relay skips foreign versions).
- Verified: 289/289 tests + tsc clean under the president's own run; fresh Opus review (one gating checkpoint finding, fixed + retested); two real end-to-end acceptance briefs generated through the full pipeline with writer=codex, second one judged against the golden voice example and accepted. Today's stored brief (ab4c3bff) is that accepted one.
- Live plists still need env application at deploy: FORGE_BRIEF_WRITER/FORGE_CODEX_BIN (+ Mini operator-profile/leadup paths, since Mini Atlas lives under ~/Desktop). Next check: tomorrow's 7:30 Mini brief should arrive Sol-written; get Alex's read on the voice.

### 2026-07-16 gbrain code index live (working tree)

- Repo indexed into local gbrain (171 files, 1069 chunks, checkpoint bbc1e4d): `gbrain search` / `code-def` / `code-refs` / `code-callers` work from anywhere in this worktree (pinned via `.gbrain-source`, gitignored). Search guidance block added to CLAUDE.md. Code-search only; jarvis-memory remains the only memory system. Semantic search live (Voyage voyage-code-3 embeddings; key at ~/.config/edge-ai/voyage.key, exported in ~/.zshrc). Re-index after real changes with `/sync-gbrain`. CLAUDE.md + .gitignore edits uncommitted; fold into the next commit.

### 2026-07-16 Forge kickoff relay upgraded to Fable 5 + orchestrator (working tree)

- Every new day-plan and Buddy kickoff now seeds Claude with Fable 5, high effort, the raised mode-specific budget, and an orchestrator resume instruction. Legacy Sonnet and Opus aliases remain executable for already-stored runs.
- Kickoff and Buddy session IDs are appended to the Forge orchestrator marker file. Successful kickoff runs background-open their resumable Claude session on macOS when deep links are enabled. Live UI states show a disabled `Working…` indicator until the session is ready to open.
- Added the repo-owned SessionStart hook and an idempotent installer merge for Claude settings. Existing settings and hooks are preserved; the installer itself was not run.
- Verification: TypeScript and scoped ESLint passed; affected worker, Buddy spawn, execution, presentation, and route tests passed; hook match/non-match and shell syntax checks passed. No build was run because the live service owns `.next`.
- Not committed. Next action: review the working-tree diff, then run the normal operator-controlled install/restart flow when ready.

### 2026-07-15 Legacy assistant-turn queue retired (working tree)

- Removed the dead Morning Arrival assistant-turn route, async worker lane, planner command, client helpers, queue-only store methods, and lane-only tests. The live assistant-apply path, shared proposal patching, assistant-turn table, execution lane, and morning-brief lane remain intact.
- Verification: `npx tsc --noEmit` passed and `node --test --import tsx tests/*.test.mjs` passed 240 of 240 tests. No build was run because the live server owns the build output.
- Not committed. Next action: the president runs the build, then decides whether to commit the retirement.

### 2026-07-15 Morning Arrival rebuilt as a guided 3-step briefing (president mode, evening session)

- Alex's verdict on the old arrival: information overload, "stresses me out." Interviewed him to the real target: a calm start, the feeling of the world's best chief of staff walking you through an easy process to choose your day. His locked picks: guided steps, whole-card drag (no handle button), tap-to-change owner chip.
- Shipped on branch `feature/arrival-guided-flow` (based on `codex/morning-command-center`, NOT main): 3-act flow (brief narrative → priorities → anything else) with persistent header/StepDots/sticky footer, single filled "Start my day," calm de-boxed styling per the apple-design/emil-design-eng doctrine. New `src/components/tasks/arrival/` components; MorningArrival.tsx is now the orchestrator; props contract unchanged except one added optional `onAddSuggestion`.
- Second feature same session: "Claude suggests adding" rows now have "Add to today ▾" with an owner chooser (Me/Claude/Together) → new `item_add` day-plan mutation (route validation, 10-item cap, default-throw switch arm so unknown actions can't silently commit, stable identity key in `src/lib/day-plan/arrival-addition.ts`); "Added" state is derived from the persisted plan so it survives remounts and blocks duplicates. `selectEssentialItems` keeps explicit additions visible past the 3-cap.
- Verified: 37/37 day-plan tests, tsc + eslint clean, full live browser acceptance (steps, drag persistence, owner chip incl. Escape ordering chip>card>never-ritual, refine polling, Start my day flipping plan state in SQLite, add-suggestion end to end incl. reload survival), two fresh Opus reviews (both SHIP; all findings fixed), Sol self-review clean.
- Gotcha that cost time twice: Next dev serving a stale compiled store bundle makes correct source look broken (silent no-op mutations). Fix: `rm -rf .next` + restart before trusting live behavior.
- NEXT: Alex to decide merge-to-main + Mini deploy (his real board runs the Mini build on port 3200; this branch isn't on it). Product tradeoff worth a look: a late-arriving brief doesn't add the extras step mid-ritual (frozen at mount, by design) so sales cadence can sit unseen until reopen.

### 2026-07-15 Morning brief moved to the Mac Mini (cross-machine relay) + in-flight arrival UI

- The MacBook-asleep failure hit on cue (7:33 dark-wake froze the 7:30 generation; backfill recovered but the arrival showed the deterministic fallback with no explanation, and the late brief never attached to the already-created plan). Alex decided: the 24/7 Mini generates the brief; the arrival must show when a brief is being written.
- **Shipped both** (see `docs/morning-brief.md` "Cross-machine relay" for the full design): write-once JSON relay over Syncthing (never SQLite), attempt-status channel so the MBP holds backfill while the Mini works, source-checkpoint gate so the Mini fails closed on stale synced sources, transactional import, guarded late-attach with a durable `arrival_interacted_at` marker, one-shot attach on load/visibility + 15s poll only while generation is live, and the "Your brief is being written…" arrival line.
- **The Syncthing/SQLite hazard is closed**: both machines' forge.db (+ claude-runs, heartbeat, backups) are now stignored — applied BY HAND on both machines (Syncthing never syncs .stignore; its old header claimed otherwise and was corrected). `install-forge-local.sh --mini` refuses to install until the operator confirms the block is on both machines.
- Ops state: Mini runs `com.forge.morning-brief` at 7:30 (logs at ~/Library/Logs/forge-morning-brief.log on the Mini); MBP's 7:30 one-shot is decommissioned; MBP worker publishes checkpoint + settlement relay. Mini claude auth verified in the gui launchd domain (SSH says "Not logged in" — expected, Keychain is locked over SSH).
- Process: Sol spec review (FIX-SPEC-FIRST, 12 findings — all implemented), one scoped cross-model code review per Alex's trim decision (FIX-FIRST, 9 findings — all fixed), 136 targeted tests green, live acceptance end-to-end including the real 2026-07-15 brief late-attaching into Alex's open plan (verified on screen).
- **Live dress rehearsal PASSED (2026-07-15 afternoon):** a one-off run on the Mini (temporary LaunchAgent, `FORGE_BRIEF_TIMEZONE=Pacific/Auckland` to target 2026-07-16) generated tomorrow's brief for real in the gui launchd context (~3 min), wrote queued/running status files (synced to MBP in ~90s), and the artifact relay file `2026-07-16-claw-test-mini.local-ec24f09f….json` synced to MBP. MBP correctly did NOT import it yet — the scan window is deliberately today+yesterday, so it imports after midnight. Tomorrow's real 7:30 run generates a fresher 7-16 artifact that wins newest-eligible selection over the rehearsal one; no cleanup needed (rehearsal plist/log already removed from the Mini). Alex saw the attached 2026-07-15 brief live and called it "absolutely fantastic."
- Watch tomorrow (2026-07-16 ~7:30): first fully autonomous Mini generation. Check `day_plan_briefs` on the Mini + relay file + MBP import (should happen even before 7:30 for the rehearsal artifact); the MBP backfill covers any failure.
- **Branch `codex/morning-command-center` is NOT pushed** (4 commits ahead of any remote: c4dcfd9, ffee3ee, e93e9b3+docs, 83ec3f2+chores). Alex has not approved a push; use `~/Atlas/bin/git-safe-push.sh` when he does.
- Same day, GOALS.md got its second revision after a structured interview (tandem north star: $30k/month cash flow AND a Main Street AI MVP beta-testing with a real operator by Aug 11, 2026; MVP sized by pain and market, never build speed; daily Jarvis-Pro-vs-MSAI collisions judged fresh by the brief; Friday MVP countdown added to never-drop with a Jul 24 no-leading-candidate tripwire). The brief regenerates automatically on the goals change.

### 2026-07-14 Design-craft pass shipped; Morning Brief engine in build

- Commit `ffee3ee`: full design-craft pass on the morning flow (press feedback everywhere, one house easing token `--ease-out-forge`, touch hover gating, execution-panel enter motion, persistent ritual layer with accessible 120ms crossfade between views, stale-settlement explanation line, disabled-arrival tooltip, tokenized stray colors, successful runs no longer stamped `errorCode: claude_failed` — that was a latent bug on every successful run). Dual-reviewed: fresh Opus SHIP; Codex found the crossfade a11y hole + shell width pop, both fixed. Live on the rebuilt `com.forge.web`.
- Alex dogfooded the full loop live: settled the stale July 10 day, July 14 arrival proposed fresh and opened. His verdict on settlement: "really cool and nice." His core product note: the arrival proposal is deterministic and instant, with no actual thinking — he wants a real chief-of-staff brief (goals-aware, progress-aware, actively claiming work for Claude).
- Canonical goals now live at `~/Atlas/brain/GOALS.md` (rewritten 2026-07-14 from a live goals interview; merges the 2026-07-11 path-to-30k memo; the interview doubles as the prototype for a future Forge onboarding flow). Chief-of-staff contract is in it: expand capacity not ambition, AI runs the sales cadence with drafts, 40-min audience cap, force-ranked 90-day stack.
- **Morning Brief engine v1 SHIPPED and live-accepted** (see `docs/morning-brief.md` for the as-built shape and invariants). Sol's design review drove the spec; his implementation review found 5 P1s (wrong default port, nested-corrupt 500, global reconciliation scoping, trigger replay double-generation, stale client brief across plans) — all fixed with tests (34 in `tests/day-plan-brief.test.mjs`). Live acceptance 2026-07-14 evening: kicked `com.forge.morning-brief`, the one-shot lane generated artifact `0ccb12dd…` (opus/high/$1.50, 2 min) from real data; all 3 candidate taskIds resolve against the live task API; the lens correctly cites GOALS.md ($13.5k floor, "4 paid setups, not a $30k headline"), the sprint memo (Gio-not-Navi, Zack channel offer, Jamie discovery call), and today's email (Ploy, Asher); it honestly flags missing calendar/CRM coverage; every sales action is beats_only + approval_required. Ops note: a clean one-shot run writes an empty log — check `day_plan_briefs` for the artifact, not the log. `com.forge.claude-worker` plist now carries `FORGE_BRIEF_WEB_BASE`; `com.forge.morning-brief` plist installed at 7:30. Real dogfood: tomorrow morning (2026-07-15) the 7:30 run generates for the new day and Arrival should open with Claude's lens.
- Approved direction queued after the brief engine: restyle the ritual layers (arrival/started/settlement) into the Living Current design language (glass over the dimmed scene instead of white sheets) — Alex signed off on the direction 2026-07-14.
- Deep-link routes are undocumented (`claude://resume`, `claude://code/new` in Claude.app's asar): re-verify after Claude desktop updates.

### 2026-07-10 Day Started payoff view + Open in Claude Code deep link (evening session)

- Start My Day no longer dead-ends: when any accepted item is owned by Claude or Together, the ritual layer transitions to an explicit `started` view (no auto-close timer) showing "Start here: <first focus>" plus one row per handed-off item with live status chips. Unready items get a "Needs setup" chip with the readiness reason and working config controls; `configureExecution` now also permits accepted agent-owned items on an active day (me-owned/dropped still denied), and the active-day kickoff path handles post-start fixes. "Enter my day" is the explicit exit and focuses the recommended task.
- Runs in `plan_ready`/`ready_to_join` show **Open in Claude Code**, which navigates to `claude://resume?session=<claude_session_id>` — the Claude desktop app's (undocumented but verified) deep-link route that imports a headless CLI session into the Mac app. Verified live twice, including a real Together plan run imported as a desktop session. `claude://code/new?q=<prompt>&folder=<path>` also verified for fresh desktop sessions. Undocumented routes: re-verify after Claude desktop updates. Custom-protocol navigation is silently blocked in embedded/sandboxed browsers; in real Chrome/Safari the first click shows an "Open Claude.app?" prompt.
- Security tightened, not loosened: `claudeSessionId` was previously exposed for every run status; the public projection now includes it only for loopback access mode AND `plan_ready`/`ready_to_join`, stripped like workspacePath/pid otherwise (matrix-tested).
- Living Current now surfaces run state durably: a shared pure selector (`selectCurrentExecutionRow`, hash-matched, never stale) drives non-interactive status chips on the focused pill, downstream nodes, and shelf entries, with Open in Claude Code only in the expanded focused surface (no nested buttons). Terminal runs (failed/interrupted/cancelled) are retryable from the shared panel, labeled "Retry".
- Escape in Morning Arrival is now collapse-only and never bypasses the ritual; the explicit bypass button remains.
- Verification: two independent reviews (fresh-context Opus: SHIP; cross-model Codex found the retry + overlay-close bugs, both fixed with new tests), 18+11 targeted tests plus all affected suites green, tsc, scoped eslint, production build, and live browser acceptance on the rebuilt `com.forge.web`: real Start My Day with a Together-owned card, payoff view rendered, run reached Ready to join, deep link imported the session into the desktop app (main.log "Imported CLI session b5a1b990…").
- Dogfood note: today's real plan is now active with Jarvis Pro marketing handed to Together; its plan session is imported in the desktop app awaiting Alex.

Next gate: dogfood the started view on the next real morning (does the payoff screen plus desktop handoff remove the post-start dead end?), then tackle the remaining arrival clunk: no explanation while the footer primary action is locked during in-flight kickoffs, and unready-item visibility before Start My Day.

### 2026-07-10 Morning Arrival Claude execution layer implemented and dogfood-ready

- Morning Arrival now launches a headless Claude session from the Forge project, loads the project's `CLAUDE.md`, and explicitly invokes `.claude/skills/forge-refine-today`. The skill translates one natural-language replan into bounded create, complete, edit, owner, and position operations. Forge validates the structured result; Claude never writes storage directly.
- Task-backed changes use a durable SQLite mutation ledger before the browser reconciles them to Supabase. Explicit task IDs make creates idempotent, completions move the real task to Done, edits preserve the full outcome and definition of done, and the ledger is acknowledged only after the task API succeeds.
- Claude and Together cards require an explicit execution mode before anything launches. Plan mode creates a real resumable Claude session with no file tools. Together always uses Plan. Autonomous is available only after selecting an allowlisted clean Git project, setting a capped budget, and enabling the separate execution switch; it has no Bash or network tool and stops at Awaiting review.
- Assistant turns, execution configuration, and run state live in separate SQLite tables. Exact brief and authorization hashes bind a run to its approved mode, model, workspace, and budget. Configuration changes cancel stale queued work, failed or cancelled runs can be retried as a new attempt, duplicate clicks remain idempotent, and Start My Day queues ready cards atomically while reporting unready ones.
- The supervised `com.forge.claude-worker` LaunchAgent is installed locally with a fresh heartbeat, private 0600 logs, cancellation, stale-process recovery, TERM-to-KILL escalation, and truthful Queued / Working / Plan ready / Ready to join / Awaiting review states. The browser API omits local paths and process IDs.
- Successful Claude output is stored as a bounded public result summary and rendered for review on the card. Exit 0 never marks the underlying task complete.
- Real isolated acceptance passed against Claude Code 2.1.202: bounded prompt refinement applied an owner change, a resumable Plan session reached Plan ready, and an Autonomous run in a throwaway clean repository created only its requested marker file and stopped at Awaiting review. No live Forge task or Atlas repository was used for these runs.
- Production build and local services are healthy. Browser QA confirmed all three visible priorities, the prompt composer, and Start My Day fit in one screen with no horizontal overflow or console errors.
- The previously failing real prompt was replayed successfully: Supernova is priority one with all three generator subtasks, client-call scheduling is priority two, Jarvis Pro marketing is priority three, Dan Martin prep is Done, and the intake task contains the Jarvis Pro setup and Gary Gersh context. The task mutation queue is empty after verified Supabase reconciliation.
- Verification is green with the 99-test suite plus 17 focused post-review tests, TypeScript, full ESLint with only two unrelated existing warnings, production build, live headless Claude skill invocation, service health checks, and browser acceptance.

Next gate: choose Claude or Together on one of the new real priorities, run a Plan kickoff, and judge whether the resulting task brief contains enough context to start useful work without another setup conversation. Do not enable Autonomous for a real project until that repository is clean, explicitly allowlisted, and the task has a concrete definition of done. A direct one-click Terminal resume action remains optional polish.

### 2026-07-10 Local Morning Command Center dogfood gate prepared

- Rebuilt `codex/morning-command-center` and rebootstrapped the existing MacBook `com.forge.web` service without running the broad installer. The service now binds only to `127.0.0.1:3200` and sets `FORGE_DAY_PLAN_ACCESS_MODE=loopback`.
- Runtime verification passed: `/tasks` and the local day-plan route return 200, a public Host header returns 403, and the loaded LaunchAgent contains the expected bind and access mode.
- The MacBook email-triage, reminders, duplicate `com.forge.local`, and arrival-trigger agents remained absent. The retired email-triage plist was not touched.
- Supervised dry-run pulses passed for valid config, before-time suppression, a due morning, quiet-date suppression, overlapping-run locking, and unavailable-server fail-closed behavior. No receipt, persistent config, browser open, or arrival LaunchAgent was created.
- The first live dogfood load exposed one real boundary mismatch: a 2,685-character task description exceeded the Day Plan API's 1,200-character outcome limit, so Arrival failed before opening. Candidate display prose now shortens to the API contract with an ellipsis while preserving the underlying task; oversized identity metadata falls back safely instead of collapsing tasks, and ritual initialization errors remain visible alongside other warnings.
- Fresh verification passed with 69 tests, TypeScript, scoped ESLint, production build, live candidate parsing, and an independent delta review. The first real Morning Arrival is now open locally with three task-backed recommendations.
- Second dogfood refinement: desktop Morning Arrival now shows all three priorities left-to-right in one wide pane. Collapsed cards contain the title, a bounded short summary, optional useful project pill, a drag handle, and Details. Full source task descriptions, owner controls, rationale, deadline, and Not today live behind Details. Suggested labels and Move up/down controls are gone.
- Browser acceptance passed at a 1440 by 900 desktop viewport and the narrower fallback: all three cards are simultaneously visible on desktop, the live 2,685-character description remains readable in Details, Escape closes Details and returns focus without bypassing the ritual, and keyboard drag persistence was verified before restoring the original priority order.
- Third dogfood refinement: the visible Details button is gone. Clicking a card's non-interactive surface now opens or closes its full details, while the dedicated drag handle and Me / Claude / Together controls keep their own interaction boundaries. Cards gain a subtle 1.01 scale, 4px lift, and stronger shadow on hover/focus, with transforms disabled for reduced-motion users and while dragging.
- Live acceptance confirmed whole-card disclosure, the complete 2,685-character source description, owner clicks that do not toggle details, unchanged ownership/order, and computed hover motion. Ownership truth remains explicit: Claude or Together selections say execution has not started.
- Recovery copies are retained at `~/Library/LaunchAgents/com.forge.web.plist.before-morning-command-center.20260710-135843` and `~/Library/Application Support/Forge/backups/.next.before-morning-command-center.20260710-135843` until dogfood is stable.

Next gate: use the refined Morning Arrival to start the first real planned day, then dogfood Morning Arrival and Day Settlement on four of five workdays. Measure time from laptop open to intentional first work and record any moment where Forge feels interruptive, unclear, or untrustworthy. Do not install the 8 a.m. trigger yet.

### 2026-07-10 Morning Command Center Phase 0 / 1A dogfood slice implemented

- Branch `codex/morning-command-center` now adds a durable SQLite Day Plan, append-only decision events, Day Snapshots, and a task-reconciliation ledger with expected-version and idempotency controls.
- Morning Arrival is a translucent guided layer over Living Current. It uses up to three current Today / In Flight tasks, explains the recommendation, shows project and ownership, supports pointer and keyboard reordering, expansion, Snooze, Skip, bypass, and a non-destructive Not today action. Cards remain `preselected` until Start My Day records the actual human confirmation.
- Start My Day gives one truthful transition and routes Living Current to a real Me / Together focus or an honest Claude handoff brief. No Claude execution, kickoff, overnight work, or fake working state exists in this slice.
- Day Settlement is manually available with Carry, Defer, and Drop. Drop explicitly archives the underlying task. Defer moves work to Not Started and durably schedules it to resurface in Today after seven days. Interrupted task reconciliation retries from the ledger. A missed prior-day Settlement opens before the next Morning Arrival rather than suppressing or misdating it.
- The macOS arrival trigger exists only as a reversible dry-run spike. It is not installed or wired into the main installer. It models an 08:00 LaunchAgent pulse, wake/login catch-up, workdays and quiet dates, receipts, snooze, prior-day recovery, and fail-closed behavior. Duplicate-tab behavior and live launch reliability still require supervised testing.
- Day-plan routes deny access when no server-owned access mode is configured. Local dogfood explicitly uses `FORGE_DAY_PLAN_ACCESS_MODE=loopback` while the server is bound to `127.0.0.1`. Non-loopback access requires session mode plus a separate proxy-injected secret in addition to trusted-host and CSRF checks; the browser does not inject that secret yet.
- Validation is green: 66 state/API/schedule tests, TypeScript, scoped ESLint, production builds, desktop and 390px browser QA, focus trapping, reload persistence, Not today preservation, Start My Day routing, Settlement reconciliation, overdue defer/resurface ordering, and missed-day recovery.
- QA incident: the first browser harness inherited the build's Supabase runtime and created three clearly named QA tasks in the live task API. Those exact three IDs were immediately deleted and verified absent; no existing task was edited. Later browser runs rebuilt in local mode and used isolated SQLite files.
- Not included yet: installed 8 a.m. launch behavior, scheduled Settlement, prompt-box refinement, direct Edit / Later controls, Claude session kickoff, autonomous runs, and overnight execution.

The server-only rebootstrap and supervised dry-run gate above supersede this section's original next step. Do not install the trigger or deploy this branch to clients before the four-of-five-day observation.

### 2026-07-10 Living Current T1-T3 deployed and canary-verified

- Merged PR #2 to `main` at `63ac66d` and deployed it to `com.atlas.forge-web` on the Mac Mini. Canonical live surface: http://alexander-mac-mini.taildd6a98.ts.net:3200/tasks.
- T1 makes state honest: the surface distinguishes committed work, Jarvis-held work, email briefs, loading, stale saved data, and retryable failures without implying work happened when it did not.
- T2 gives Later one deliberate return at the next local 5:00 AM seam, preserves refined wording, respects real expiry, handles legacy deferred records, and keeps undo idempotent.
- T3 hydrates a validated three-day arrival snapshot before paint, keeps optimistic work out of persistent storage, tracks server-confirmed mutation baselines, and refreshes without overwriting in-flight work.
- Request hardening now restricts Forge REST and Quiet Current to configured hosts, origins, and protocols. Live canary confirmed trusted requests return 200 and untrusted host requests return 403.
- Verification is green on both machines: 27 of 27 tests, lint with zero errors and two unrelated existing warnings, production build, desktop and mobile browser canary, no console errors, no horizontal overflow, and a 201 focus-change event.
- Fable 5's full review and a final fresh-context delta review found no P0 to P2 release blockers.
- Product gate: observe at least one real Jarvis Pro client using Forge without hands-on help before expanding into T4 delegation autonomy. Use that session to learn the actual morning ritual, switching behavior, and points of confusion.

### 2026-07-08 Mini is BACK and now owns email triage (Codex engine, VERIFIED LIVE)

The whole Mini queue from 07-07 is done and proven:

- **Mini repo synced**: the "dirty" files were Syncthing copies of already-pushed work (proven byte-identical to origin/main per file before touching anything); stashed as a safety net (`stash@{0}` on the Mini, droppable) and fast-forwarded d587be5 -> 2cf9668. Note: `~/Desktop/Atlas` on the Mini is now a SYMLINK to `~/Atlas` (moved 2026-07-07, presumably for the TCC/launchd problem); same repo, two paths.
- **Codex CLI installed on the Mini** (npm, codex-cli 0.143.0) and logged in WITHOUT re-auth by copying `~/.codex/auth.json` from the MBP (ChatGPT login). Flags verified against real `--help`: `-m`, `-c key=value`, `--dangerously-bypass-approvals-and-sandbox`, stdin `-` all parse. The runner's flag spellings were right.
- **Composio wired into Codex**: `~/.codex/config.toml` on the Mini points at the hosted Composio MCP (same API key header as the MBP's Claude config). Live smoke test: codex called COMPOSIO_SEARCH_TOOLS and got GMAIL_FETCH_EMAILS back.
- **Supabase-mode skill fixes landed** (2cf9668): email_items POST now includes `"provider":"gmail"` (NOT NULL on live table) and Step 6 documents the remind_* retry for supabase installs missing those columns.
- **Mini forge rebuilt + serving**: `.env.local` was MISSING on the Mini (first rebuild silently came up in local SQLite mode!); copied from the MBP, rebuilt, com.atlas.forge-web kickstarted, board at :3200 serves the real Supabase columns.
- **FIRST SUPERVISED CODEX TRIAGE PASSED** (gpt-5.5, xhigh, exit 0, ~116k tokens): real inbox run drafted a reply to Heather Martinelli in-thread (draft r-1252160083511349427), filed 2 action items (Jay Miller meeting notes to-do, Cloudflare domain expiry), archived 1 login link, rebuilt "Emails: Jul 8" on the live board, stamped the cursor. Telegram from the Mini verified with a delivered test ping.
- **Schedule moved**: com.forge.email-triage now on the Mini (09:00/13:00/17:00; weekdays guard lives in the script) with PATH incl. /opt/homebrew/bin (codex's node shebang needs it; manual runs must export it too). MBP's triage agent booted out, plist kept as `.retired-20260708`. MBP keeps com.forge.web so the laptop bookmark still works (both point at the same Supabase data).
- STILL OPEN: Alex to judge the Heather draft (only 1 reply draft in this run; calibration wants 2-3 before full trust); nudge card link still `localhost:3200` (phone-unfriendly); public-flip decision.

### 2026-07-07 CRM step BUILT + browser-verified (last surface before the public flip)

Local-mode CRM is live. New `src/components/crm/LocalCRMView.tsx` (two panes: searchable contact list + detail with notes/tier/tags/how-we-met, activity timeline, add-contact form with create-new-company) consumes the previously dead `src/lib/data/crm.ts` REST functions; `CRMView.tsx` local branch swapped from the placeholder (supabase/Attio and convex branches untouched, verified by diff). Built by an Opus subagent from spec; its fresh-context review fixed 3 real bugs (silent catch on the last-contact touch, crash on empty PATCH return, tag dedupe). Browser-verified end to end on the throwaway DB (port 3410): created Sarah Chen + Chen Plumbing through the UI form, how_we_met saved on blur, meeting activity posted + timeline rendered + `last_interaction_at` touched (list re-sorted), search matches company names and shows a clean empty state, all rows confirmed persisted via REST, zero console errors. tsc clean.

New `skills/forge-contact/SKILL.md`: natural-language capture (dedupe-first, resolve-or-create company, log activity + touch last contact, chain follow-ups into forge-task), "who is X" briefings, CSV import with confirm-the-mapping. Installer picks it up automatically (copies all skills/forge-*). SETUP.md step 7 rewritten from stub to the real client walkthrough (2-question interview, optional import, demo capture).

Skipped for v1 (deliberate): meeting_notes table, CSV-import API route (Claude imports via REST), editing companies in the UI. SPEC.md's /api/contacts/* routes are stale spec, not gaps.

NEXT: the public repo flip (needs Alex's explicit go). After that Forge is fully productized: Tasks + Email + CRM all built and verified.

### 2026-07-07 (later) Engine-aware triage (Codex option) + public-flip sweep CLEAN

- **Triage runner is now engine-aware**, for Alex's own machines (clients stay on Claude by default): `data/forge-email.json` gains `engine` ("claude" default | "codex"), `codex_model` (default "gpt-5.5"), `codex_reasoning` (default "xhigh"), and `weekdays_only` (guard in the script via `date +%u`, NOT launchd Weekday keys). `triage_times` takes N entries; Alex wants 3x weekdays at 09:00/13:00/17:00 PT. The Codex path pipes the repo's `skills/forge-email/SKILL.md` plus an unattended-safety preamble into `codex exec` on stdin. UNVERIFIED and blocking before the Codex schedule goes live: the codex CLI flag spellings (`-m`, `-c model_reasoning_effort=`, `--dangerously-bypass-approvals-and-sandbox`) were written from conventions, codex is not installed on the MBP. At Mini install time: run one live supervised `codex exec` triage, verify flags parse, and have Alex judge 2 to 3 GPT-5.5 drafts (voice recalibration) before trusting it unattended.
- **Public-flip secrets sweep: CLEAN TO FLIP.** Full 30-commit history swept: zero live secrets, no .env or db file ever committed, fixtures are synthetic @example.com personas, .gitignore solid. Recommendation to Alex (his call pending): publish via a fresh-history public mirror repo (e.g. amart-builder/forge-app) instead of flipping this repo, because this repo's STATUS.md history carries client names, a Telegram chat id, the Tailscale hostname, and internal ops narrative.
- **Queued for the Mini's return:** pull repo, install the runner + verify codex flags, supervised first Codex triage + draft calibration, move the triage schedule and `forge_url` off the laptop, retire the laptop's `com.forge.web` + `com.forge.email-triage` once the Mini owns them, restore jarvis-memory.

### 2026-07-03 Card verified in browser + dev-mode swap-spiral root-caused and fixed

The one outstanding step is DONE. Browser-verified on a throwaway local DB (port 3410, real inbox untouched): the `Emails: Jul 3` card rendered all six sections with correct grouping (Carried over 1 / Reply 2 / Action 1 / Notifications 1 / Archived 1 / Done today 1), every Gmail deep link correct (`#inbox/<threadId>` per item, `#search/label:Forge/Reply` and `:Forge/Archived` rollups), checkboxes only on carried/reply/action. Clicked a reply checkbox: row left the open sections, Done today ticked 1 -> 2, and REST confirmed `email_items.status=actioned` persisted to SQLite. One cosmetic dev-only quirk: board data loads via `localhost:3410` but not `127.0.0.1:3410` (client fetch never fires on the IP host); use localhost for local verification, not worth chasing.

ROOT CAUSE FOUND for the repeated 40GB swap spirals that kept killing Forge sessions on the MacBook: a stray May-2024 `package.json` + `package-lock.json` in `~` (old Solana project) made Next infer the workspace root as the HOME DIRECTORY. Tailwind then failed to resolve from the wrong base and dev fell into a compile-fail-retry loop (~27 retries/min, each leaking into the compiler graph -> gigabytes in minutes -> swap death spiral -> frozen machine -> crashed sessions -> orphaned processes compounding the next attempt). Fixed in `next.config.ts`: `turbopack.root` + `outputFileTracingRoot` pinned to the repo (also protects client installs from their own stray home lockfiles). CRITICAL SECOND HALF: the broken runs left a poisoned `.next` cache that kept replaying the failure loop even after the config fix — if the spiral ever recurs, `rm -rf .next` once. After both fixes: dev boots in 449ms, /tasks compiles cold in 1.6s, server steady ~530MB. Do NOT remove the home-dir lockfiles without Alex (not ours), the config pin makes them harmless. Dev-only noise seen and not chased: "Failed to generate static paths for /api/forge-rest/[table]" TypeError at startup (route works fine).

### 2026-07-06 (later) Nudge + schedule LIVE on the MacBook; unattended dress rehearsal PASSED

- Telegram nudge wired: data/forge-reminders.json -> chat 5740717209, token read from ~/.claude/channels/telegram/.env. Test ping delivered.
- Always-on Forge web server installed on the MacBook: LaunchAgent com.forge.web runs `next start -p 3200` (supabase mode, prod build, ~107MB). localhost:3200/tasks serves the live board here. Installed because the Mini has been OFFLINE 11 days (Tailscale last saw it Jun 25) so the Tailscale bookmark is dead; when the Mini returns it can take this back.
- Triage schedule installed: LaunchAgent com.forge.email-triage fires scripts/forge-email-triage.sh at 09:00 + 15:00; logs at ~/Library/Logs/forge-email-triage.log.
- GAP FOUND + FIXED: forge-* skills were never installed to ~/.claude/skills on this machine (installer step, never run here), so headless runs could not find forge-email. Copied forge-email/task/voice/voice-note in (humanizer already present).
- Dress rehearsal: ran forge-email-triage.sh by hand = a real unattended headless run. It ingested a genuinely new Wispr Flow receipt, archived it, rebuilt the card, sent the nudge, exit 0, safety held. The scheduled path is proven end to end.
- Future nicety (from the run itself): nudge's card link is localhost:3200, phone-unfriendly; point forge_url at a stable URL when the Mini is back.

### 2026-07-06 LIVE email verification PASSED (with Alex)

Ran the full pipeline against the real alex@joinedgeai.com inbox, Alex watching. All core mechanics verified live:
- Labels bootstrap: all six Forge/* labels created (Triaged=Label_9, Reply=Label_10, FYI=Label_11, Action=Label_12, Done=Label_13, Archived=Label_14; cached in data/forge-email.json on the MacBook).
- Real triage run 1: QuickBooks promo -> archived (out of inbox, logged on card); Calendly booking notice -> FYI. Card "Emails: Jul 6" created on the LIVE board (Must happen today) via a local dev server on :3200 in supabase mode.
- Real triage run 2: Alex's test email classified reply; draft written in his voice (voice.md honored, Calendly link https://calendly.com/edge-ai/30min pulled from real usage, not invented) and **nested correctly in-thread** via GMAIL_CREATE_EMAIL_DRAFT with empty subject. Alex's verdict: "passes the bar."
- Round-trip: thread flipped to Forge/Done, out of inbox, row status=actioned, card rebuilt to "Done today: 1 replied". (Alex chose not to send the self-addressed test; the done-flip was applied manually via the same label/status transitions the reconcile pass performs. Test draft deleted at his request.)

LIVE-SUPABASE SCHEMA DELTAS the skill must handle (found live, adapt before the scheduled runner goes live on a supabase-mode install): (1) forge_email_items requires provider NOT NULL -> always send "provider":"gmail"; (2) forge_tasks has NO remind_native/remind_text columns (local-mode-only migration) -> omit remind_* fields when the REST target is supabase mode, or add the columns in Supabase. Consider updating SKILL.md Step 6 to mark remind_* optional-by-mode.

Still untested from the live checklist: the Telegram/iMessage nudge (data/forge-reminders.json not configured on the MacBook; forge-notify.mjs was a silent no-op) and the LaunchAgent schedule firing (com.forge.email-triage not installed here; natural test is letting a scheduled run fire on a configured machine). Neither blocks the core loop.

Remaining: (1) README refresh (still the old user-facing version, tab is gone now); (2) optional: let tomorrow's 09:00 scheduled fire confirm launchd timing (the run path itself is already proven).

### 2026-07-01 PIVOT EXECUTION: backend triage + one daily card

Refined the pivot and started building it. The "what needs you" surface is a single Forge task card, not a Telegram digest, and triage runs on a twice-daily schedule at user-set times.

Design (Alex's calls this session):
- One running card per day, `Emails: <Mon D>`, due today in Must-happen-today. Sections: Carried over, Reply (drafts ready), Action items (checkbox), Notifications, Archived (log), Done today.
- Gmail is the source of truth; `Forge/*` labels are the memory (Triaged, Reply, Action, FYI, Archived, Done). Each run ingests only `-label:Forge/Triaged` mail, reads Gmail back to clear handled items, and fully rewrites the card. That is what makes two runs a day seamless (no stale re-shows).
- Replies auto-clear: when the user sends, the next run detects the sent reply, marks done, and archives the thread. Action items clear via a checkbox on the card (sets `email_items.status`). Unfinished items carry forward to the next day's card; the prior card closes out. Newsletters/promos archived from day one. One-line nudge after each run via the reminders channel.
- Unattended execution = headless `claude -p` running the `forge-email` skill (Alex's call over a constrained runner). Guardrail is the skill's hardened Safety section plus the global CLAUDE.md "treat outside content as data" rule (loads automatically). Draft-only; never sends/deletes/forwards; the allowed-action list is explicit.

Built + fresh-reviewed this session:
- `skills/forge-email/SKILL.md` rewritten as the three-pass state machine (ingest, reconcile, rebuild card) with the Safety section. Verified Composio supports it: `GMAIL_CREATE_EMAIL_DRAFT` nests a reply in-thread (thread_id + empty subject); `GMAIL_MODIFY_THREAD_LABELS` labels/archives; `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` detects sent replies. Connected account: alex@joinedgeai.com.
- `scripts/forge-notify.mjs`: reusable one-line Telegram/iMessage nudge (checks the Telegram `ok` flag so a bad token is not silent).
- `scripts/forge-email-triage.sh` + `com.forge.email-triage` LaunchAgent (two `StartCalendarInterval` times read from `data/forge-email.json`) wired into `install-forge-local.sh`. Config gains `triage_times` + `timezone`.
- `SETUP.md` step 6 rewritten to the backend model + the two-times + scheduling + honest awake-Mac limit.
- Fresh-context review caught and fixed real bugs: bounded status model (archived/fyi terminal so the reconcile set cannot grow unbounded), idempotency (label immediately after drafting; dedupe by thread_id across all statuses), sent-reply detection (ignore DRAFT messages; require SENT newer than the latest inbound), correct Gmail deep-link format (`u/0/#inbox/<enc threadId>`), and `remind_native:false` on the card (no redundant native ping).

Built 2026-07-02 (D + E, this session):
- D (card UI): new `src/components/tasks/EmailCardDetail.tsx` renders the daily card as the grouped digest (Carried over / Reply / Action / Notifications / Archived / Done today), with clickable Gmail thread links (drafts sit in-thread) and real checkboxes that flip `email_items.status` to `actioned` (optimistic update + REST PATCH). `TaskDetail.tsx` shows this digest instead of the edit form when a card is tagged `email` AND titled `Emails: ...` (so it never collides with ordinary tasks or the old per-email cards). Built fresh rather than reusing ActionCard (E deletes ActionCard anyway). Bucket/triage_date/archived_note are read from `source_payload`; falls back to `classification` for older rows.
- E (retire the tab): removed the Email link from `TabNav.tsx`; deleted the `/email` route, `src/components/email/*` (EmailView, ActionCard, ActionLog, SummaryCard), and `/api/email/send-draft`; removed `sendDraftEmail` + `SendDraftInput` from `lib/data/email.ts`. Left the other now-unused email read-helpers in email.ts as harmless dead code (optional future cleanup). `listAllEmailItems` + `updateEmailItem` stay (the card uses them).
- `npm run build` PASSES clean: compiles, TypeScript clean, and the route list confirms `/email` and `/api/email/send-draft` are gone (only `/`, `/crm`, `/tasks`, `/api/crm/attio`, `/api/forge-rest/[table]` remain).

Remaining (updated 2026-07-03; item 1 is DONE, see the 2026-07-03 entry above):
1. ~~Browser-verify the card render + checkbox round-trip.~~ DONE 2026-07-03 (all 6 sections, Gmail links, checkbox persisted to SQLite).
2. Live verification on alex@joinedgeai.com: labels bootstrap, a real in-thread draft, archive, the card, the reconcile round-trip (send one reply, re-run, confirm it clears + archives), the nudge, and the schedule firing. Touches the real inbox, so do it deliberately with Alex.
3. README is still the old user-facing version; refresh now that the tab is gone.

GOTCHA (fix before any local deploy / scheduled runner): the repo's better-sqlite3 native module is compiled for Node 23 (ABI 131, `/opt/homebrew/bin/node`). The login shell here defaults to Node 20 (ABI 115, `/usr/local/bin/node`); running Forge in local mode under Node 20 crashes at the first DB call ("NODE_MODULE_VERSION 131 vs 115"). `install-forge-local.sh` resolves node via `process.execPath`, so whatever `node` is first on PATH at install time MUST be the one better-sqlite3 was built against (or `npm rebuild better-sqlite3` under the target node). Worth hardening the installer to detect + warn on ABI mismatch.

Note: `data/forge-email.json`, `forge-email-state.json`, `forge-reminders.json` are absent on the MacBook, so email is not live here; this MacBook runs supabase mode. Session lock for `astack/forge` held by this cowork instance.

### 2026-06-30 PIVOT: Email goes invisible, native Gmail drafts, no Forge Email tab
**Decision (Alex, 2026-06-30):** Drop the separate Forge Email surface. The email skill drafts replies directly into the user's Gmail as native draft replies, sitting in the real thread, ready to edit and send from Gmail (desktop or phone). Forge does not replace email; it pre-writes replies where the user already lives. Forge's surfaces become Tasks + CRM only.

**Why (agreed):** the real want is "the reply already written, waiting where I already am, one tap to send," not a triage queue in a new app. Native drafts win: no new surface to check; native threading/attachments/mobile for free (the Forge Email tab was desktop-only and only while the Mac was awake); less to build and maintain (retire the Email UI AND the Composio send route); lower trust barrier (review in Gmail; a draft never self-sends).

**Keep the one valuable thing we'd otherwise lose (the ranked "what needs you"):** the skill labels threads it touches (e.g. `Forge/Needs-you`, `Forge/FYI`) and posts a one-line digest to Telegram ("drafted 4 replies, 3 FYIs labeled"). The user gets the prioritized view as a Gmail search, not an app tab.

**New architecture:**
- Background `forge-email` skill (on demand or scheduled): read new mail via Composio, classify, draft in voice (`~/.claude/voice.md` + humanizer), create a native Gmail draft reply IN THREAD, label the thread, post a short digest.
- User reviews + sends natively in Gmail. No Forge send route.

**Do next session (execute the pivot):**
1. VERIFY FIRST (real risk): confirm Composio `GMAIL_CREATE_EMAIL_DRAFT` can make a reply draft that nests in the original thread (needs `thread_id` + In-Reply-To/References headers). If it cannot, fall back to Gmail API `drafts.create` with a raw MIME that sets those headers. A draft that starts a NEW thread instead of nesting is the main thing that would break the feel. Test on Alex's own account (alex@joinedgeai.com, connected here).
2. Refactor `skills/forge-email/SKILL.md`: output target changes from Forge `email_items`/`drafts`/REST to Gmail drafts + label + digest. Keep the classify + draft-in-voice logic (it carries over).
3. Retire the Forge Email tab (`src/components/email/*`, the `/email` route) or hide behind a flag. Tasks + CRM stay.
4. Retire `src/app/api/email/send-draft/route.ts` (Composio send) once nothing uses it.
5. Update `SETUP.md` Email step: no Email tab; drafts land in Gmail, explain the label + digest.
6. Decide: on-demand vs scheduled background triage; label taxonomy; digest channel (Telegram likely).

**Preserved (NOT wasted by the pivot):**
- `forge-voice` + `~/.claude/voice.md` + the bundled humanizer. voice.md was validated live: Alex reviewed 3 sample drafts on 2026-06-30 and said they sound like him (calibration passed at round 1). It is his real profile at `~/.claude/voice.md`.
- The `forge-email` skill's classify + draft logic; the Composio Gmail connection + setup (still needed to read mail + create drafts).

**Status:** nothing built for the pivot yet. Pre-pivot email work stays in git history (`3c93ebb` send route, `2ad26e9` voice). Session lock for `astack/forge` is held by this cowork instance.

### 2026-06-30 Jarvis Pro: Email voice honing (humanizer + learned voice.md)
- Alex's ask: drafts must sound human and sound like the specific user. Two layers: the humanizer skill runs on every draft out of the box, and a learned per-user voice profile shapes the writing.
- New skill `skills/forge-voice/SKILL.md`: reads the user's own sent mail via Composio (`in:sent`, last 30 to 90 days, widening if sparse), strips quoted chains and skips forwards/one-liners, deduces their voice (greeting/sign-off, rhythm, formality by relationship, phrases, punctuation, length), writes `~/.claude/voice.md`, then runs 2 to 3 live calibration rounds (sample drafts, "sound like you? what would you change?", refine). Re-runnable anytime ("update my voice").
- `forge-email` drafting now reads `~/.claude/voice.md` (falls back to CLAUDE.md or recent sent mail if absent) and runs every draft through the humanizer skill. No em dashes.
- Bundled the humanizer skill (MIT, v2.5.1) into the repo at `skills/humanizer/` so a fresh client actually has it; `install-forge-local.sh` refreshes the forge-* skills each run but installs the humanizer only if absent (never clobbers a newer copy the client relies on).
- SETUP Email step gained "e. Hone their writing voice" before first triage; daily-loop step renumbered to g.
- voice.md lives at `~/.claude/voice.md` (per-client, outside the repo, reusable for any writing); stores style + short anchors, not whole emails.
- Verified: no em/en dashes in the new skill or doc edits; voice.md + humanizer references consistent across all three files; installer `bash -n` clean. This auto-generates the client's equivalent of Alex's hand-built `writing-as-alex` + `VOICE.md`. Fresh-context review in progress.

### 2026-06-30 Jarvis Pro: Email step (Composio triage + reply + send)
- Scope (Alex's calls): connect via Composio, each client uses their OWN Composio account so Alex never holds a client's inbox; v1 = triage + reply + send on the existing Email tab (a triage queue, not a full mailbox). Draft-only: the user always sends.
- Inbound: new skill `skills/forge-email/SKILL.md`. Pulls new Gmail via the Composio MCP (`GMAIL_FETCH_EMAILS`, `in:inbox after:<cursor>`), dedupes by `message_id`, classifies (action_item / tiding / log_only), drafts replies in the client's voice (their `~/.claude/CLAUDE.md`, falling back to their sent-mail tone), and POSTs cards to `email_items` + `drafts` (+ a one-line `email_triage_runs` summary) over the local REST API. `recommended_action` constrained to the UI vocabulary (reply/follow_up/delegate/flag/review/archive) so cards render right. Cursor in `data/forge-email-state.json` (gitignored); `after:` is date-granular by design, dedupe covers the overlap.
- Outbound: rewrote `src/app/api/email/send-draft/route.ts` to call Composio's HTTP execute API (`POST backend.composio.dev/api/v3/tools/execute/GMAIL_REPLY_TO_THREAD`, `x-api-key`) instead of the old personal `gog` shell-out. The existing Send button now sends instantly through the client's Gmail with no UI changes. Reads `COMPOSIO_API_KEY` from `.env.local` and `connected_account_id` from `data/forge-email.json` (both gitignored); the key is header-only, never logged or returned.
- Setup: `SETUP.md` Step 6 "Set up Email" walks the client through a Composio account, connecting the Composio MCP to Claude Code, the one-click Gmail OAuth, writing the config + key, and the first triage. CRM moved to its own Step 7 stub.
- Productization fixes: genericized hard-coded "Alex"/"Codex" strings in the email components (ActionCard/EmailView/SummaryCard) to "you"/"me"; fixed the stale "once Gmail sending is configured" draft copy; added an in-code warning on the Convex `send` stub (Convex mode does not actually send).
- Verified 2026-06-30: live Composio Gmail fetch returns the mapped fields; all four email tables + columns exist (source_payload JSON, priority INTEGER); REST write path proven (Tasks step); tsc clean on every touched file. Live send is confirmed at first real use with the client's own key (not testable here without extracting their key, which is not done). Fresh-context review passed after fixes (recommended_action vocabulary, dedupe efficiency + date-cursor note, voice fallback, name leaks, friendlier timeout). One overridden flag: `is_html:false` is a real field in the verified GMAIL_REPLY_TO_THREAD schema, kept as a plain-text guard.
- Bonus noticed: Composio also has Google Calendar connected, so the Tasks scheduler can become calendar-aware later.
- Next: CRM step, then flip the repo from private to public for the send-the-link flow.

### 2026-06-30 Jarvis Pro: Tasks step (natural-language capture + reminders)
- Natural-language capture skill at `skills/forge-task/SKILL.md` (the installer copies it into the client's `~/.claude/skills`). Triggers on "remind me to", "add to my board", etc. Claude picks a due date when none is given (from current task load + the user's CLAUDE.md priorities; calendar once connections are wired in the Email step), writes the task via `POST /api/forge-rest/tasks`, sets the reminder, and replies offering a text reminder.
- Reminders: three new `tasks` columns (`remind_native` default on, `remind_text` default off, `notified_at`) with an idempotent migration in `db.ts`. New helper `scripts/forge-reminders.mjs` runs every 60s via LaunchAgent `com.forge.reminders`: fires a native macOS notification (osascript) and, if a channel is set in `data/forge-reminders.json` (gitignored), a Telegram (bot API) or iMessage (osascript) text. Atomic claim (`UPDATE ... WHERE notified_at IS NULL`) prevents double-fire across overlapping ticks; date-only due dates resolve to local 9am.
- Docs split: `README.md` is the user-facing guide; `SETUP.md` is the agent playbook (clone/build/run, the Tasks interview, channel setup, Email/CRM stubs, storage modes). Setup covers the bookmark walkthrough, the "Telegram or iMessage?" interview (writes `data/forge-reminders.json`), honest laptop-vs-always-on messaging (reminders only fire while the Mac is awake unless there is a Mini/VPS), the voice-note opt-in, and a full Telegram/iMessage channel-setup walkthrough verified against the official plugins (BotFather + token + pairing for Telegram; Full Disk Access + allowlist for iMessage). Telegram is recommended for outbound reminders (Bot API); iMessage outbound via AppleScript is best-effort and is Mac-Mini-only (a single Apple ID on a laptop duplicates every message).
- Native reminders need no setup; text delivery needs a configured channel target. Everything runs only while the Mac is awake.
- Verified 2026-06-30: tsc clean; migration idempotent on fresh + pre-existing DBs; helper end-to-end (fires due-open only, skips future/done/undated, no double-fire on a second run, native notifications actually popped); REST POST stores + returns the reminder fields (booleans + tags round-trip). Fresh-context review passed after fixes (em dashes removed, double-fire race closed, date-only timezone fixed, stale README launchctl command corrected).
- Voice notes (done, opt-in): `scripts/install-forge-voice.sh` builds an on-device transcription env at `.venv-voice` (gitignored) using mlx-whisper on Apple Silicon (proven on Python 3.14, model `mlx-community/whisper-small.en-mlx`) or faster-whisper on Intel (prefers Python 3.12/3.11, with a plain-English failure message). `scripts/forge-transcribe.sh` turns an audio file into clean text; the `forge-voice-note` skill (Telegram `download_attachment` / iMessage path -> transcribe -> follow forge-task) ships and is installed by `install-forge-local.sh`. Verified: a `say` clip converted to Telegram .ogg transcribed exactly; argv-isolated (injection-safe), stdout clean. Same awake-only limit as text reminders. Fresh-context review passed (only fix: Intel Python compatibility, done).

### 2026-06-30 Jarvis Pro: local-first re-base (new default)
- Added a third runtime mode, `local`, and made it the DEFAULT when `NEXT_PUBLIC_FORGE_RUNTIME` is unset. Local mode uses a SQLite file (`data/forge.db`) via better-sqlite3, no login, no cloud. Supabase and Convex remain opt-in.
- Owner machines unaffected: MacBook and Mini both pin `NEXT_PUBLIC_FORGE_RUNTIME=supabase` in their gitignored `.env.local`, so only fresh clones (clients) get local mode.
- New `src/lib/local/db.ts` answers `/api/forge-rest/[table]` against SQLite (PostgREST subset: select, multi-col order + nullslast, limit/offset, eq/neq/gt/lt/in/is filters), parameterized + identifier-validated, seeds the 4 default columns on first run.
- `ConvexClientProvider` passes through with no auth gate in local mode; Tasks + Email dispatchers route local to the REST views; CRM shows a placeholder until the CRM step.
- Auto-start + backup: `scripts/install-forge-local.sh` installs LaunchAgent `com.forge.local` on 127.0.0.1:3200 + daily backups (`scripts/forge-backup.sh`, 14 kept).
- README rewritten for the local, no-login, bookmark-a-website client model (fixed the dead clone URL, removed stale Mini/OpenClaw/gog setup content).
- Verified 2026-06-30: 22/22 engine unit tests pass (incl. limit/offset + like wildcard); `tsc --noEmit` clean; isolated `next build` succeeds in default local mode; production server on :3399 with a temp DB seeded 4 columns, created/listed/updated a task (tags round-trip as array, persisted to SQLite), `/tasks` = 200 with zero login markers. Done in an isolated copy so the other running session was untouched.
- Fresh-context review (separate agent): no blockers, no SQL injection, no auth leak, supabase/convex provably unchanged. Fixed its flagged items: LaunchAgent resolves Node via `process.execPath` + verifies the server booted + uses `launchctl bootstrap/bootout`; `like`/`ilike` translate `*`→`%`; `limit`/`offset` integer-guarded. Re-verified clean.
- Committed + pushed as `87368f0` on `main` (amart-builder/forge). Repo stays private until the full client setup (Tasks/Email/CRM) is done, then flips to public for the send-the-link flow.
- Notifications: delivered in the Tasks step above (native macOS while the Mac is awake; optional Telegram/iMessage text).

### Earlier (Alex's live Mini Forge)
- Live /tasks returns 200.
- The Tasks code now has a small check/circle control on every non-Done task card. Clicking it moves the task to the Done column and persists `status=done`, so the board and database agree.
- Local verification passed on 2026-05-27: `npm run lint` (same six pre-existing warnings), `npm run build`, and a browser smoke test on `http://127.0.0.1:3210/tasks` that moved a temporary task from Not Started to Done, confirmed the Supabase row was `status=done`, then deleted the temporary row.
- Dirty tree cleanup completed on 2026-05-27: MacBook Forge is clean at `a05395f` and pushed to GitHub. The Mini clone was preserved with backup branch `backup/mini-main-before-a05395f-20260527` plus stash `codex-2026-05-27 mini dirty tree before origin-main sync`, then aligned cleanly to `origin/main`.
- Live Mini verification passed on 2026-05-27: rebuilt Forge on the Mini, restarted `com.atlas.forge-web`, confirmed the Tailscale URL returned 200, and browser-smoked the one-click Done control with a temporary task that was deleted afterward.
- On 2026-06-01, the live Must happen today lane was corrected after the Morning Operator Brief cron wrote to the old unprefixed Atlas `tasks` table instead of live Forge. The live board was set to four active Must happen today tasks: "Finish Edge AI website and sendable offer", "Push the Edge AI offer to warm network", "Prep Mitch Claude setup kit", and "Email Heather to schedule Josh and Joe AI sessions."
- Later on 2026-06-01, Alex reported the day list was done except ongoing Mitch prep. Verification shows "Finish Edge AI website and sendable offer", "Push the Edge AI offer to warm network", and "Email Heather to schedule Josh and Joe AI sessions" are in Done with `status=done`; "Prep Mitch Claude setup kit" is open in Not Started, due 2026-06-02.
- Also on 2026-06-01, Alex added "Finish Jarvis VPS deployment and test it" and then promoted it into Must happen today so it is ready for 2026-06-02. It is open, high priority, due 2026-06-01, and tagged `today`.
- On 2026-06-01, the Done-column task "Secure the Martin Healthcare Advisors login" was normalized from `status=open` to `status=done`; verification now shows no Done-column tasks with an open status.
- The canonical task URL remains http://alexander-mac-mini.taildd6a98.ts.net:3200/tasks for Alex and http://localhost:3200/tasks on the Mini. The old Atlas Web app and public Forge demo are not live task boards.
- On 2026-05-26, Alex made the Edge AI website the only Must happen today task. That task later appeared in Done even though Alex still needed to finish it; it has now been reopened and expanded to cover the sendable offer.
- Previously seeded GOALS.md priorities remain in the backlog but are not due today.
- Existing stale April/May tasks remain in place until verified. Do not bulk-close them without evidence.

## Completed
- [x] Verified the live Forge Tasks page.
- [x] Seeded the current operating priorities into Forge.
- [x] Normalized tasks already in the Done column to status=done.
- [x] Set the Edge AI website as the only task due today and moved all other active today-tagged/due-today tasks back to Not Started.
- [x] Added a one-click Done control to task cards and made drag/detail moves update `status` based on the destination column.
- [x] Cleaned and pushed the Forge dirty tree, aligned the Mini clone to the pushed commit, and redeployed Forge on port 3200.
- [x] Corrected the 2026-06-01 Must happen today lane in live Forge and removed the erroneous today-focus flags from the old archived Atlas task table.
- [x] Fixed the Done-column status mismatch for "Secure the Martin Healthcare Advisors login" and reverified Done-column status consistency.
- [x] Cleared the 2026-06-01 Must happen today lane after Alex completed the day list, leaving Mitch setup prep open for 2026-06-02.
- [x] Added "Finish Jarvis VPS deployment and test it" to Forge and promoted it into Must happen today.

## Roadmap
### Now
- [ ] Use Forge as the default capture surface for new tasks.
- [ ] Finish Jarvis VPS deployment and test it.
- [ ] Prep Mitch Claude setup kit: standard `CLAUDE.md`, starter skills, and teaching plan for 2026-06-02 afternoon.
- [ ] Triage stale Forge tasks into keep, done, or kill with evidence.
- [ ] Draft and publish the Catalyst LinkedIn offer post.
- [ ] Send the four warm Catalyst referral asks.
- [ ] Review/send the Jacob cleanup economics reply.

### Next
- [ ] Decide whether to re-enable Forge email triage after Alex confirms Gmail ingestion is allowed.
- [ ] Add a daily Forge review rhythm: morning priorities, midday check, end-of-day cleanup.
- [ ] Make the stale backlog smaller than 10 active open tasks.

## Blockers / Risks
- Email triage is paused; fresh Gmail cards will not appear until explicitly re-enabled.
- Old tasks include stale email-derived items and should not be trusted blindly.
- Mini cleanup preserved old divergent local commits and dirty files in a backup branch/stash; do not delete those until Alex is comfortable the deployed Forge state has everything needed.

## Key Docs
- [README](README.md)
- [SPEC](SPEC.md)
- [Parent Astack status](../STATUS.md)
