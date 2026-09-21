# Cove Operations

## Install and start

Follow `SETUP.md`. The installer renders absolute Node paths into LaunchAgents, creates a private empty `.env.local` when needed, and starts the localhost app and background lanes. A missing fresh worker heartbeat fails installation with diagnostics and a retry command. A responding website alone does not prove the worker is healthy.

The supported app URL is `http://127.0.0.1:3200` (or `http://localhost:3200`). Logs live in `~/Library/Logs/` with `cove` in the filename.

## Stopping Cove

A full install loads more than a dozen LaunchAgents. Stopping `com.cove.local`
stops the website and nothing else: the supervised worker, the reliability
scheduler, reminders, email triage, the meeting watcher and drain, the progress
reconciler, the weekly voice review, the four chief-of-staff lanes and the daily
backup all keep running, and the chief-of-staff lanes call the selected model and
can notify. Telling a person Cove is off after stopping only the website is wrong.

```bash
bash scripts/cove-stop.sh --status   # what is loaded, and what starts at login
bash scripts/cove-stop.sh            # stop every Cove service now
bash scripts/cove-stop.sh --disable  # stop them and keep them stopped
bash scripts/install-cove-local.sh   # start them again
```

`launchctl bootout` unloads a service until the next login; macOS loads every
plist still in `~/Library/LaunchAgents` when the person logs in again. Only
`--disable` (`launchctl disable`) survives a restart, and the installer's own
`launchctl enable` calls clear it on the next install, which is what makes the
install/stop pair symmetric.

Stopping never touches data. The database, `data/backups/`, the profile, goals,
mandate, connector settings and Keychain entries are all left in place, and
`install-cove-local.sh` resumes the same installation. There is no uninstaller:
removing Cove means stopping it with `--disable`, deleting the checkout once its
data has been copied somewhere safe, and then clearing what the installer wrote
outside it. That is:

- `~/Library/LaunchAgents/com.cove.*.plist` -- `--disable` deliberately leaves
  these in place so a reinstall is symmetric, so removal has to delete them.
- The `launchctl disable` overrides themselves, which outlive the plists and
  are stored per user account, not per file. A reinstall clears the ones the
  installer knows about, so this is tidiness rather than a trap -- but it is
  the one leftover that is invisible unless you look for it:
  `launchctl print-disabled gui/$(id -u) | grep com.cove`, then
  `launchctl enable gui/$(id -u)/<label>` for each.
- `~/Library/Logs/cove*.log` -- one per lane, and the only record of what ran
  after the checkout is gone. They hold task and job ids, reminder ids and
  error text rather than the content of the work.
- `~/Applications/Cove Notifications.app`.
- The `~/.claude/skills/cove-*` and Codex `cove-*` skill folders.
- `~/.claude/hooks/cove-orchestrator.sh` and the `SessionStart` entry pointing
  at it in `~/.claude/settings.json`. Remove both: the entry is what runs the
  file, at the start of every Claude Code session on that account, Cove's or
  anyone's.
- `~/.cove/orchestrator-sessions`, the append-only list of Claude session ids
  that hook reads.

Google credentials live in the macOS Keychain and are removed there.

## Health

The Current displays live readiness for email, the brief writer, and the background worker. Empty and unavailable are different states. `/api/health` exposes the same read model to trusted local requests, plus the latest periodic health snapshot.

Failures that need attention are recorded in Cove's Issues surface. A partial receipt means useful work completed but the named remainder needs a later run or operator action.

## When Google says it needs connecting again

The email lane reports `Google Workspace needs to be connected again.` whenever
the stored refresh token no longer works. Check what Cove thinks it has:

```bash
./node_modules/.bin/tsx scripts/cove-google-connect.ts status
```

That prints the connected Gmail address, or says the connection is missing or
no longer usable. To reconnect, re-run the same `connect` command used during
setup; `reauthorize` is an alias for it, and the saved inbox-check times,
timezone and weekday setting are preserved unless those flags are passed again:

```bash
./node_modules/.bin/tsx scripts/cove-google-connect.ts connect \
  --client-json /absolute/path/to/client_secret.json
```

`disconnect` removes the Keychain entries and keeps the old configuration file
beside its replacement.

**A Google Cloud OAuth client left in Testing publishing status issues refresh
tokens that expire after seven days.** An install connected with one will report
exactly this message a week later, on its own, with nothing wrong on the Mac.
Publish the consent screen, or expect to reconnect weekly. This is the single
most likely way a working email connection stops working without anyone
touching it.

These commands read the data directory Cove is configured with, so run them
from the checkout, with the same `COVE_DATA_DIR` the install uses if it is not
the default.

## Morning Brief schedule

The existing Claude worker starts the Morning Brief at 08:00 on weekdays in
Cove's brief timezone once the previous workday is closed. Closing an overdue
day after 08:00 starts today's brief automatically after reconciliation.
Evening closeout and closeout before 08:00 wait for the scheduled morning.
An asleep Mac catches up when it wakes; the browser does not need to be open.
A failed attempt stays in Issues and Morning Arrival for manual retry instead
of repeatedly spending model capacity. Explicit Brief me anyway remains available.

## Recovery

- Stale Morning Brief claims become retryable through the normal Morning Arrival control.
- Failed email archives leave the item open and retryable.
- Dead jobs appear in Issues rather than disappearing.
- Create a fresh recovery point with `bash scripts/cove-backup.sh`. A backup failure returns a nonzero exit code; unrelated queued work is not run.
- Use `bash scripts/cove-restore-backup.sh --yes <backup-file>` for database recovery. Stop the app and database-using workers first. The restore refuses while any `com.cove.*` or `com.forge.*` service is loaded, which is what `bash scripts/cove-stop.sh` clears. That gate does not see a web app started by hand, as setup does before the installer runs: stop that process in its own terminal first. The open-handle check behind the gate is a race backstop, not a substitute, because Cove opens the database per operation and an idle moment looks like nobody has it.
- Re-run `bash scripts/install-cove-local.sh` after moving the repository or changing the Node installation.

## Verification

Run `npm run verify` in an isolated checkout before an install artifact or release. Do not build over the `.next` directory of the running daily-driver app. Use the Node version supported by `package.json`; this review used Node 24. It performs type checking, lint, the full automated suite, the production build, and the installer, skill-authentication, and redaction contract tests.

## Release boundary

The internal repository is not a client artifact. Build a sanitized tree with `node scripts/export-cove-client.mjs --output <empty-directory>`, inspect its manifest and checks, then test that exact directory. Publication and repository visibility changes are separate approved actions.

## Reminder coverage and model usage

Reminder coverage at the top of Your follow-through reports the reminder worker's heartbeat and calendar
freshness. A disconnected calendar means no meeting coverage. A stale heartbeat
means the reminder service needs attention, even if no job has failed. Sleeping
or shut-down Macs cannot notify. Existing explicit reminders continue if the
optional follow-through checker fails.

The deterministic checker runs without AI tokens. It checks connected meetings
at most every five minutes and eligible approaching/overdue tasks during local
8am to 6pm hours. It shares cooldowns and banner limits with existing reminders. Approaching
deadlines can use a reserved slot after ordinary overdue reminders, while the
final slot stays available for meetings or urgent email. A morning deadline
warning preserves the noon check-in slot. The daily total remains six.
Task reminder clicks open the matching task details in Today or All Work.
One-hour snooze persists across restarts. A notification with an uncertain
handoff is shown for review, never blindly retried.
Routine overdue reminders held by alert policy are informational. Held imminent
deadlines, missed meetings and delivery failures remain visible until reviewed,
even when newer reminder history exists. Text timeouts remain unconfirmed;
the noon text reservation is retained even if its fallback Mac banner fails.
Meetings whose entire prep window falls in quiet hours are not failed reminders.
Remote iMessage allows 10 seconds to connect plus a bounded Messages window,
within a 30-second overall timeout. A responsive Mini alone does not prove text
arrival on the phone.

The responsibility total separates actual tasks and confirmed commitments from
unconfirmed suggestions. Unestimated work is shown as unknown. Ambiguous source
dates are preserved with a confirmation label, without inventing deadlines.
Completed routine reviews supersede older warnings only for the same routine
with no event-specific payload. Specific failed event reviews remain visible.


Background AI shows the selected model and separate rolling usage for background
reviews and daily planning. Defaults are 12 calls/hour, 96/day and 400/week per
pool. Background reviews cannot spend the Morning Brief and closeout allowance.
Failures and retries count within their pool; interactive Buddy and task sessions
are outside these background limits. Deterministic reminders remain available.
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
work leaves a quarter of the background pool for chief-of-staff calls. Daily
planning has a separate pool with the same configured hourly, daily and weekly
caps. A brief denied by its own pool stays queued across restarts, shows its
next eligible time, and retries automatically. Input-size errors are distinct
from usage denial, and the UI displays only safe failure explanations. This is a
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

Scheduler failures name the affected work and link to Issues. The Issues entry
explains a safe cause and whether Cove is retrying. Once retries stop, it gives
the person an immediate fallback and directs repair to their setup agent. Raw
provider diagnostics stay in stored job and failure details, not banner text.
Chief reviews use their fifteen-minute driver timeout rather than the shared
two-minute monitoring timeout; the scheduler renews its lease during execution.

## Optional iCloud reminder bridge

The personal phone beta uses `com.cove.apple-reminders`, a 30-second deterministic
sync service. It reads `data/apple-reminders.json`; receipts, queue entries and
link state live under its configured `stateDir`. The helper needs its own full
macOS Reminders permission through the standard app dialog. Running it as a
child of an already-authorized terminal is not sufficient proof that launchd
can use it. Rebuilding an ad-hoc signed helper can require permission again.

Verify a fresh service tick, then actual iCloud arrival and a displayed phone
alert. Verify completion and exact-time edits both ways using one labeled test
task. A saved native record alone proves neither device synchronization nor
notification presentation. Complete the Apple test item and recoverably archive
its Cove task afterward. Do not change unrelated Apple reminders.

The Mac must be awake for chat access and new synchronization. After a reminder
has synced through iCloud, the iPhone can deliver that saved reminder without
the Mac remaining awake. This does not make the Cove agent an always-on cloud
service. Urgent alarm activation is not automated by this beta.

To disconnect, disable the configuration, stop the dedicated sync LaunchAgent
and restart the phone MCP process without its reminder connection. Existing
Apple reminders remain scheduled until explicitly cancelled. Do not erase link
state to recover from an error: uncertain saves and concurrent edits need their
receipts to prevent duplicates. Queue errors and native conflicts are returned
by `cove_reminders` and the chief snapshot. The standard Mac reminder service
and other background lanes keep their existing configuration.
