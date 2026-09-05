# Cove Operations

## Install and start

Follow `SETUP.md`. The installer renders absolute Node paths into LaunchAgents, creates a private empty `.env.local` when needed, starts the localhost app and background lanes, and reports a slow worker heartbeat as a warning with a retry command.

The supported app URL is `http://127.0.0.1:3200` (or `http://localhost:3200`). Logs live in `~/Library/Logs/` with `cove` in the filename.

## Health

The Current displays live readiness for email, the brief writer, and the background worker. Empty and unavailable are different states. `/api/health` exposes the same read model to trusted local requests, plus the latest periodic health snapshot.

Failures that need attention are recorded in Cove's Issues surface. A partial receipt means useful work completed but the named remainder needs a later run or operator action.

## Recovery

- Stale Morning Brief claims become retryable through the normal Morning Arrival control.
- Failed email archives leave the item open and retryable.
- Dead jobs appear in Issues rather than disappearing.
- Create a fresh recovery point with `bash scripts/cove-backup.sh`. A backup failure returns a nonzero exit code; unrelated queued work is not run.
- Use `bash scripts/cove-restore-backup.sh --yes <backup-file>` for database recovery. Stop the app and database-using workers first.
- Re-run `bash scripts/install-cove-local.sh` after moving the repository or changing the Node installation.

## Verification

Run `npm run verify` in an isolated checkout before an install artifact or release. Do not build over the `.next` directory of the running daily-driver app. Use the Node version supported by `package.json`; this review used Node 24. It performs type checking, lint, the full automated suite, the production build, and the installer, skill-authentication, and redaction contract tests.

## Release boundary

The internal repository is not a client artifact. Build a sanitized tree with `node scripts/export-cove-client.mjs --output <empty-directory>`, inspect its manifest and checks, then test that exact directory. Publication and repository visibility changes are separate approved actions.

## Reminder coverage and model usage

Issues > On your radar reports the reminder worker's heartbeat and calendar
freshness. A disconnected calendar means no meeting coverage. A stale heartbeat
means the reminder service needs attention, even if no job has failed. Sleeping
or shut-down Macs cannot notify. Existing explicit reminders continue if the
optional follow-through checker fails.

The deterministic checker runs without AI tokens. It checks connected meetings
at most every five minutes and eligible approaching/overdue tasks during local
8am to 6pm hours. It shares cooldowns and banner limits with existing reminders.
One-hour snooze persists across restarts. A notification with an uncertain
handoff is shown for review, never blindly retried.

Background AI shows rolling attempt limits and the selected model. Hitting a
limit pauses model review, not deterministic reminders. Failures and retries
count; interactive Buddy and task sessions are outside these background limits.
Neither tokens observed nor calls remaining measure a subscription balance.

When a Codex task needs permission, use its Continue button to resume in an
interactive session. Update the CLI and verify the exact selected model before
initial installation; an older CLI may reject a model available on the account.

## Reviewing follow-through

Open the link beside Today for Your follow-through. The page separates scheduled
agent reviews, proposed work, preparation drafts and reminder delivery. Unknown
calendar availability or missing task estimates do not count as free time. The
capacity estimate currently assumes 9am to 5pm in the operator timezone and keeps
30% of non-meeting time free. It does not book calendar appointments.

On my radar acknowledges an item without completing it. Responsibility
acknowledgement postpones the agent check and supported attention alerts for one
hour. Explicit user-set task alarms retain their existing reminder policy. A
missed or uncertain native delivery remains visible for review. Seeing the native
banner on the person's own Mac is still part of installation acceptance.

For a person who keeps Do Not Disturb on, add **Cove Notifications** to that
Focus's Allowed Apps, then test without turning Focus off. Its app name in
Notifications settings is **Cove**. Terminal and terminal-notifier exceptions
do not apply to Cove's sender. If submission succeeds but no banner appears,
check Cove's desktop notification style and whether screen sharing, mirroring,
screen lock or display sleep is suppressing presentation. Do not broaden those
privacy settings automatically; successful submission alone is not delivery
acceptance.

AI-capacity denial keeps a queued job until the indicated rolling window clears;
it does not spend execution retries. Actual process failures still count. Routine
work leaves a quarter of the same bounded allowance for chief-of-staff and brief
calls, while total hourly, daily and weekly caps remain authoritative. This is a
call allowance, not a provider subscription balance or a guarantee of equal token
cost. Check pending reviews and Issues when the allowance is resting.

### Native notification wording

Cove's banners should read like a short note from your chief of staff. Name the
item and explain why it needs attention now, using plain language. For example:
“Your meeting starts in 15 minutes: Planning. Take a moment to prep.” or
“Due tomorrow: Send Bob the proposal. Make time for the next step.”
Use the actual schedule, never invent a deadline or claim that open work is
definitely unfinished. Keep source labels and content sanitization for inferred
work. Routine reminders use local templates and require no extra model calls.
