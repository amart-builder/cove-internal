# Morning summary: the Cove build wave is done

Alex, all 8 stages built, reviewed, and pushed overnight. The suite grew from 481 to 656 tests, all green, and the production build is clean. Every stage went through the loop we agreed on: Sol builds, a fresh Opus reviewer attacks it, fixes cycle until the reviewer says ship, then I verify against checks Sol never saw, commit, and push. After the last stage, one more fresh reviewer walked the whole wave end to end looking for seams between the stages; the two things it found that would have tripped Gary's install (a stale installer message and a backup check that could not pass on day one) are fixed and included.

## What shipped

1. **Reliability spine.** One job scheduler with leases and backoff, receipts on every automated action, a visible Issues page so nothing fails silently, versioned migrations, daily backups with a tested restore.
2. **Gmail spike verdict: RED.** We stay on Composio. The native connector cannot run headless and cannot exclude the send scope. Re-check after Claude Code upgrades.
3. **People (CRM).** One door for contacts with careful identity matching: email wins, name-only matches lock to the first email, ambiguity never merges.
4. **Ingestion pipeline.** Meeting notes and email flow through one claim ledger keyed by Gmail message id, so nothing double-processes, even with two Macs.
5. **Features.** Recurring tasks (confirm before creating, never spawns duplicates), stale-task watchdog, 30-day recently-deleted undo, email cards that stay in sync with Gmail both directions, commitment capture, guarded attachments, health collectors.
6. **Setup and coherence.** SETUP.md is now one ordered install script with hard quality gates. Buddy handles "reshuffle my afternoon" with a preview card; nothing changes until Apply is tapped, and the server enforces that with a single-use proof. "Send feedback" makes a Gmail draft. Plain English everywhere: Closing your day, Still open, People. New /guide page.
7. **One look.** All Work and People now match the Today tab's water aesthetic, light and dark, desktop and mobile. Today itself is untouched (verified pixel-identical; before/after screenshots below).
8. **Owner chips are real.** "Claude" opens a Claude Code session that does the whole task in auto-edits mode. "Together" opens the same session in plan mode. No repo or workspace needed. Results land in a Cove outputs folder and link back on the board. Runs have honest states (running, output ready, failed, abandoned) and a reaper that can never kill the wrong process.

## Bonus fix you will actually notice

Dark mode never survived a page reload, anywhere in the app, ever. The theme script was silently broken. Fixed. If you use dark mode, it now sticks.

## What the reviews caught (why the loop is worth it)

The independent reviewer BLOCKed three stages before they shipped. The two worth knowing about: the first cut of Buddy's replan quietly opened a path where the agent could rewrite your active day plan with no preview, in supabase mode too, and the first cut of the Stage 8 reaper could have let a dev server kill a healthy work session. Both were caught cold, fixed, and re-attacked before commit.

## Your one click (before Monday)

github.com/amart-builder/cove is still PRIVATE, and it does not have this week's work yet. Before Gary's install: push the new forge main to the cove mirror, then flip it public. The runbook (docs/gary-install-runbook-2026-08-03.md) now has both steps at the top, updated for Monday.

## One decision, no rush

Your own install still runs supabase mode. Everything new this week is local-mode only, so your install behaves exactly as before, just with the new look and vocabulary. If you want the new features (replan preview, feedback, Recent activity, owner chips), we migrate your machine to local mode: it means moving your tasks out of Supabase into the local database, roughly an hour of careful work plus checking. Say the word and I will plan it.

## Deliberately not done (fast-follow week)

Reopen-day undo, the fleet-health email, adoption coaching, external CRM adapters, and two small hardening items on the new session reaper. All noted in STATUS.md.

Screenshots: before and after shots of all three tabs are in the session scratchpad (stage7-shots folder). The runbook and one-pager are ready for Monday.
