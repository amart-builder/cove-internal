# Cove

Cove is an AI-native task organizer that acts like a chief of staff for your
life and work. It helps you stay organized without constantly maintaining a
system: it catches commitments, keeps follow-ups from disappearing, recommends
what matters today, and learns how your goals and responsibilities fit
together.

You can tell Claude or Codex about a task in plain language. If you choose to
connect Gmail, Cove helps keep you at inbox zero, prepares reply drafts in
your voice, and surfaces the messages that need your attention. If you connect
your meeting notes, a promise such as "I'll get you that proposal by Friday"
can become a durable follow-up without you stopping the conversation to write
it down. Cove interviews you about your goals and working style so its daily
recommendations become specific to you rather than generic productivity advice.

Cove is local-first. Your tasks and durable workflow records live in a SQLite database on your laptop; settings and some supporting state live in private local files. There is no Cove account to create and no Cove login screen. Enabled AI features use your signed-in model provider and send it relevant context. You open Cove like a website, but it runs on your own Mac while that Mac is awake.

---

## Get Cove set up

You do not set this up by hand. Send this repository's GitHub link to Claude or
Codex and say:

> Set me up with Cove.

If the repository is private, the agent must be given a clone that already works
on this Mac (for example, GitHub CLI signed in) before setup starts.

That is enough. The repository tells the agent how to begin the assisted setup,
which safety checks it must preserve, and when it needs your input. You should
not have to translate the install guide or paste a long technical prompt.

Before running commands, your assistant explains what Cove will do for you and
what the setup will involve. It then follows [SETUP.md](SETUP.md): checks the
Mac, verifies the checkout, interviews you one question at a time, captures
your real open work, and offers each optional connection in terms of the
outcome it unlocks. Email, meeting notes, calendar access, and messaging require your choice and a
live check. Full Cove includes gentle native deadline reminders.

When it is done, Cove is running at `http://localhost:3200` on your Mac.

For a first-day Basic Mode rollout, the safe baseline is real profile and task
context, the two Claude rituals, durable operator learning, and a verified local
backup. Full Cove adds the visual task board, People, Buddy, Morning Arrival,
and Close My Day. Email, meeting-note ingestion, and message reminders remain
opt-in backend connections. Skipping one does not make the core install
incomplete.

Full Cove includes a chief of staff that checks commitments between conversations.
Setup recommends the agent you are already using: Claude Fable 5.1 at low effort
or GPT-6 Astra at low effort, then verifies your choice. One selection carries
through briefs, Buddy, assigned tasks and background reviews. You need only
the selected provider. A personal mandate and verified first run are required.

Deadline checks and connected-calendar meeting reminders do not call a model.
AI reviews have visible rolling usage limits; retries count. Cove cannot read
your subscription balance. Checks run while your Mac is awake, and Issues shows
whether deadline and calendar coverage need attention.
Cove currently serves one person on one Mac; shared assistant access and phone
access to the board are not included.

### Start with Basic Mode

Basic Mode puts Cove's backend together while keeping the user experience to
two daily Claude rituals. Tasks, goals, selected email and meeting-note
connections, workers, receipts, and backups run underneath it, but the user
does not need to open the Cove website or use Terminal in daily life.

In the morning, Cove reviews the real context and recommends what the user
should focus on. At the end of the day, it asks what got done, what should carry
forward, and whether there are any notes or decisions the user wants to talk
through. The closeout also asks one thoughtful operator question each day so
Cove understands the user better over time.

Basic Mode does not require one persistent Claude session. Each ritual may open
in a fresh session because tasks, closeout context, and useful operator answers
are saved durably for the next one. Connected email and meeting notes can work
quietly in the backend, but they do not create separate scheduled Basic Mode
conversations.

To request it, add this sentence to the setup note above:

> Set me up with Cove in Basic Mode.

The canonical Basic Mode experience and acceptance criteria are in
[SETUP.md](SETUP.md#basic-mode). It is a different interface over the same Cove
system, so the user can open the full visual Cove later without moving their
data.

---

## Using Cove

Open `http://localhost:3200` (bookmark it the first time). You will see two primary spaces:

- **Today**: Morning Arrival helps you choose initial priorities and other work for today. Start your day, update tasks as you go, and use Close My Day to record progress and carry work forward. Quiet Current holds suggestions until you accept them.
- **People**: relationship records and context, set up in the CRM step.

Today also contains **All Work**, the original four-column board for backlog grooming, waiting work, and history. The board remains available, but it is no longer the place you have to live all day.

You do not have to add tasks by hand. Tell Claude or Codex in plain language: "remind me to call the roofer tomorrow" or "add finish the proposal to my board." Explicit requests become solid work. Work your assistant infers from email, meetings, or context enters Quiet Current in pencil through the [agent contract](AGENT_CONTRACT.md) and cannot become a commitment on its own.

---

## How email works

Email does not get a tab, on purpose. You keep living in Gmail, and Cove works in the background.

Twice a day, at times you pick, Cove reads your new mail and sorts it:

- **Someone needs a written reply?** Cove writes one in your voice and leaves it as a draft inside the thread, in your Gmail. You open the thread, read it, edit if you want, hit send. Cove never sends anything on its own.
- **Needs you to do something that is not a reply?** It goes on today's card as a checkbox.
- **Just something you should know?** Recorded in Recent activity, then archived.
- **Newsletters, promos, receipts?** Archived out of your inbox and logged, one click to rescue.

Everything that still needs you lands on one rolling `Email` card in Must happen today. Open it to see replies with drafts ready, action or review items, and a seven-day Things you should know log of informational or low-value mail Cove archived. Calendar responses use clear accepted, declined, tentative, invitation, update, cancellation, and booking summaries in that log. When you send a reply from Gmail, the next run archives that inbound message and clears it from the card. The same card remains current instead of creating a new dated card each day.

After each run Cove records a one-line receipt such as "Inbox triaged: 2 need you, 1 action" in Recent activity. The rolling card interrupts you only when something still needs you.

Cove keeps workflow state in its durable local ledger. Gmail stays simple: Inbox means it still needs you, Archive means it was handled, and search finds history. The only workflow marker Cove may add is the transitional `Cove/Triaged` ingestion marker.

---

## How it runs (for the curious)

- **One small program**, started by a macOS LaunchAgent named `com.cove.local`, serving `http://localhost:3200`, bound to localhost only (never exposed to the network).
- **A supervised worker** (`com.cove.claude-worker`) writes the Morning Brief and runs the bounded task work you assign, through the agent you picked. Logs to `~/Library/Logs/cove-claude-worker.log`.
- **A job scheduler** (`com.cove.jobs`) runs Cove's durable scheduled jobs and health checks. Logs to `~/Library/Logs/cove-jobs.log`.
- **A reminder checker** (`com.cove.reminders`) wakes once a minute, looks for tasks whose time has come, and fires a Cove-branded notification (and a text, if you set one up). The installer builds a tiny local `Cove Notifications.app` so macOS shows the blue Cove icon and a real Cove sender name. Logs to `~/Library/Logs/cove-reminders.log`.
- **A daily backup** (`com.cove.local.backup`) copies the database at 3:30am. Logs to `~/Library/Logs/cove-backup.log`.
- **An email triage job** (`com.cove.email-triage`), loaded only when Workspace email is configured, runs at your two chosen times and does the inbox pass described above. Logs to `~/Library/Logs/cove-email-triage.log`. It only ever creates drafts and moves labels; sending is always you.
- **A meeting watcher and drain** (`com.cove.meeting-watch`, `com.cove.meeting-drain`) poll Granola and any configured Gmail meeting-note source and analyze the notes. Both load on a standard install; with no meeting source configured the watcher reports itself disabled and does nothing.
- **A progress reconciler** (`com.cove.progress`) runs every 30 minutes and reads `data/session-pings/*.jsonl`. Nothing in a standard install writes those files, so it examines no projects, sends nothing to a model provider, and only updates its heartbeat file. If pings ever exist, it reads that project's recent `git log`, the `Current State` section of its `STATUS.md`, and recent Claude Code transcript wrap-ups under `~/.claude/projects`, and sends that evidence to your selected agent for read-only progress suggestions.
- **A weekly voice review** (`com.cove.voice-review`) loads on a standard install but the review itself stays off unless `COVE_VOICE_REVIEW=1` is set.
- **Chief-of-staff agents** (`com.cove.chief-of-staff-drain`, `-sweep`, `-nightly`, `-review`) load only on a Full Cove install with a saved primary agent and a private `data/cove-mandate.md`. Its `notify` actions stay in shadow (evidence only, no banner or text) while `data/attention-sweep.json` has `"shadow": true`.
- **One file of data**: `data/cove.db`, backed up every day to `data/backups/` (the latest 14 snapshots are kept), for recovery after data loss. A backup only includes work saved before it was taken.
- **Local storage, connected processing.** The board is stored on your Mac. Enabled model features send relevant task, email, meeting, and other context to Anthropic or OpenAI. Optional Google and Granola connections contact those services. See [SECURITY_AND_INTEGRATIONS.md](SECURITY_AND_INTEGRATIONS.md) for the boundaries.

Everything runs only while the Mac is awake. On an always-on Mac (a desktop or a Mac mini), reminders and triage fire like clockwork. On a laptop, they catch up when you open the lid.

Handy commands:

```bash
bash scripts/cove-backup.sh                            # back up the database right now
launchctl bootout gui/$(id -u)/com.cove.local          # stop Cove (and its auto-start)
launchctl bootout gui/$(id -u)/com.cove.reminders      # stop reminder notifications
launchctl bootout gui/$(id -u)/com.cove.email-triage   # stop scheduled email triage
```

To restore, stop Cove and its database-using workers, then run `bash scripts/cove-restore-backup.sh --yes <backup-file>`. The guarded script validates the backup and preserves the database it replaces.

## Tech stack

- Next.js 16 (React 19), TypeScript, Tailwind CSS.
- Local data: SQLite via `better-sqlite3` (the default). No login.
- Email, Calendar, and Google Docs: direct restricted Google API gateway using the user's own OAuth connection. Email is draft-only by application design.
- Supported runtime: one Mac, local SQLite, no login. See [ARCHITECTURE.md](ARCHITECTURE.md), [DATA.md](DATA.md), [SECURITY_AND_INTEGRATIONS.md](SECURITY_AND_INTEGRATIONS.md), [OPERATIONS.md](OPERATIONS.md), and [CONFIGURATION.md](CONFIGURATION.md).

## For coding agents and contributors

Start with [CODEBASE_GUIDE.md](CODEBASE_GUIDE.md). It maps the pages, API
routes, domain modules, background processes, durable state, trust boundaries,
and test suites. Then read [ARCHITECTURE.md](ARCHITECTURE.md) and the reference
document closest to the behavior you are changing.

The main rule is simple: models may interpret and propose, but deterministic
Cove code authorizes and writes. SQLite owns product state. Gmail owns email.
New code must preserve those boundaries and include a regression test for the
invariant it changes.

For repeatable behavior checks, see the [working-week evaluation](EVALUATION.md).
It combines a five-day state simulation with isolated model scenarios and saved-response replay.

### Follow-through you can inspect

Cove keeps a next review for each open task and commitment. The chief can propose
work times and prepare local drafts while preserving recorded deadlines. It does
not infer that work is complete. Open Your follow-through from Today to see next
steps, proposed capacity, repeated carryovers and anything prepared for you.
Calendar and estimate gaps stay visible. You remain in control of completion,
changed promises and anything sent outside Cove.

Choose and arrange the day in Morning Arrival's Plan your day step. After Start
my day, Cove preserves that plan and its written brief. Background planning does
not create another approval queue. Use All tasks to make explicit changes.
