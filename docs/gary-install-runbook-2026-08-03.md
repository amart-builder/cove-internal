# Install-day runbook: Gary Gersh, Monday 2026-08-03

Internal. For Alex on install day. The client-facing page is docs/gary-handoff-one-pager.md (print it or AirDrop it at the end).

## Before you leave the house

1. **Refresh the mirror repo.** github.com/amart-builder/cove must carry the latest main from the build wave (the week of 2026-07-28 shipped the setup script, Buddy replan, feedback, and the UI pass). Push the current cove main to the cove mirror before anything else.
2. **Flip the mirror repo public.** github.com/amart-builder/cove is still PRIVATE. Settings > General > Danger Zone > Change visibility. Without this, Gary's clone fails at step one.
3. **Test the clone logged out.** In a private browser window, open https://github.com/amart-builder/cove. If you can see it, Gary's Mac can clone it.
4. **Carry the fallback.** Zip a fresh clone of the mirror onto a USB stick or AirDrop-able folder. If Gary's network or GitHub acts up, you unzip to ~/cove and continue from Step 1 of SETUP.
5. Bring this runbook and the one-pager on your phone.

## The install (target: under 90 minutes)

1. On Gary's Mac: open the Claude Code app, paste the repo link, say "Set me up."
2. **Step 0 is mostly waiting.** The agent installs the developer tools, Node, and Claude CLI. Gary only clicks macOS dialogs and types his password. Narrate what's happening so it doesn't feel like a black box.
3. **The interview is the product.** When setup asks about Gary (name, timezone, goals, who matters to him), slow down here. Thin answers make a thin brief. The setup agent checks this, but you check it too.
4. **Meeting notes step:** setup asks what tool he uses for notes and wires the watcher. If he uses nothing, the email fallback covers him. Don't skip the pitch: this is how follow-ups become automatic.
5. **CRM step:** setup asks what he uses today. If he has one, let the agent research whether it can connect. Connect if possible, copy his data in if not.
6. **Email:** connect Gmail, Calendar, and Drive through Cove's direct Google Workspace OAuth setup in `SETUP.md`. Confirm the two triage runs are scheduled and that he understands drafts only, never sends.

## The finale (do not rush this)

This is the wow moment. It only works if the brief has real material.

1. **Load 3 to 5 of Gary's real priorities first.** Actual tasks in his words, plus his goals and a few contacts. A demo brief about nothing sells nothing.
2. Generate a **fresh** brief. If it looks like the quiet smoke test from Step 5 or comes back stale, force a new one (force-brief). The finale brief must be generated after his data is in.
3. Read it together. The bar: does it sound like it knows this person? If not, add material and regenerate. Don't present a miss.
4. **Five-minute practice morning:** Arrival, drag priorities, tap one owner chip, Start my day, then a mini settlement with one "progress plus a note" and one "carry." Then the honest reset so day one starts clean.
5. Walk the leave-behinds: the /guide page in the app, and "ask Buddy how do I..." Hand over the one-pager.

## Verify before you leave

- `launchctl list | grep com.cove` shows the services loaded, none flapping.
- App loads and the brief endpoint returns 200.
- All cove-* skills copied into his Claude skills folder.
- An owner chip actually opens a session on his machine (Claude chip = auto edits, Together = plan mode).
- One test email triage run has produced cards.
- Tell him the honest single-Mac truth: the laptop has to be open for Cove to work in the background. Closed lid means it catches up on wake, and nothing is lost.

## If things go sideways

- Clone fails: use the tarball, continue as normal.
- Brief generation fails: check the setup log, fix or regenerate. Never end the session on a broken brief; a weaker-but-real brief beats an error.
- Backup recovery: use `bash scripts/cove-restore-backup.sh --yes <backup-file>` as the tested restore path.
- Anything you can't fix in 10 minutes: note it, keep moving, fix it remotely tonight. The practice morning and the one-pager matter more than any single feature working perfectly today.
