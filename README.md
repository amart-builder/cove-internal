# Cove

Your shared working surface with Jarvis: a calm view of what matters now, what may matter next, and what your AI is carrying. Cove runs on your own Mac. Email stays where it already lives: in Gmail.

Cove is local-first. Your data lives in a single file on your laptop. There is no account to create, no login screen, and your board never leaves your machine. You open it like any website, by bookmarking a page, but it runs on your own computer and is always on.

---

## Get Cove set up

You do not set this up by hand. Send this repository's link to Claude or Codex and say "set up Cove for me." Your assistant follows the playbook in [SETUP.md](SETUP.md): it installs Cove, interviews you one question at a time about your responsibilities, goals, day, work sources, and delegation boundaries, builds your first current with you, and then offers optional email, CRM, reminder, and voice-note connections.

When it is done, Cove is running at `http://localhost:3200` on your Mac.

---

## Using Cove

Open `http://localhost:3200` (bookmark it the first time). You will see two primary spaces:

- **Today**: Quiet Current, the daily surface where one task is centered as Now. Accepted work is solid. Jarvis proposals are pale until you accept or begin them. `J` and `K` change focus; `Cmd+K` can focus any task without changing its state.
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

Everything that still needs you lands on one rolling `Email` card in Must happen today. Open it to see replies with drafts ready and action or review items. When you send a reply from Gmail, the next run archives that inbound message and clears it from the card. The same card remains current instead of creating a new dated card each day.

After each run Cove records a one-line receipt such as "Inbox triaged: 2 need you, 1 action" in Recent activity. The rolling card interrupts you only when something still needs you.

Cove keeps workflow state in its durable local ledger. Gmail stays simple: Inbox means it still needs you, Archive means it was handled, and search finds history. The only workflow marker Cove may add is the transitional `Cove/Triaged` ingestion marker.

---

## How it runs (for the curious)

- **One small program**, started by a macOS LaunchAgent named `com.cove.local`, serving `http://localhost:3200`, bound to localhost only (never exposed to the network).
- **A reminder checker** (`com.cove.reminders`) wakes once a minute, looks for tasks whose time has come, and fires the notification (and a text, if you set one up). Logs to `~/Library/Logs/cove-reminders.log`.
- **An email triage job** (`com.cove.email-triage`) runs at your two chosen times and does the inbox pass described above. Logs to `~/Library/Logs/cove-email-triage.log`. It only ever creates drafts and moves labels; sending is always you.
- **One file of data**: `data/cove.db`, backed up every day to `data/backups/` (the last 14 days are kept), so restarting or rebooting never loses anything.
- **Your board data stays on the Mac.** Email triage is the one feature that talks to the internet: it reads your Gmail and writes drafts through your own connected account, which you can disconnect any time.

Everything runs only while the Mac is awake. On an always-on Mac (a desktop or a Mac mini), reminders and triage fire like clockwork. On a laptop, they catch up when you open the lid.

Handy commands:

```bash
bash scripts/cove-backup.sh                            # back up the database right now
launchctl bootout gui/$(id -u)/com.cove.local          # stop Cove (and its auto-start)
launchctl bootout gui/$(id -u)/com.cove.reminders      # stop reminder notifications
launchctl bootout gui/$(id -u)/com.cove.email-triage   # stop scheduled email triage
```

To start fresh: stop Cove, **move** `data/cove.db` aside (rename it, don't delete it), and start it again. It recreates the default board, and your old board is still sitting there if you want it back. Same idea in reverse to restore: stop Cove, copy a file out of `data/backups/` over `data/cove.db`, start it again.

## Tech stack

- Next.js 16 (React 19), TypeScript, Tailwind CSS.
- Local data: SQLite via `better-sqlite3` (the default). No login.
- Email, Calendar, and Google Docs: direct restricted Google API gateway using the user's own OAuth connection. Email is draft-only by application design.
- Optional cloud data for multi-device use: Supabase or Convex (off by default). See [SETUP.md](SETUP.md).
