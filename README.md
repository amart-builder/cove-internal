# Forge

Your shared working surface with Jarvis: a calm view of what matters now, what may matter next, and what your AI is carrying. Forge runs on your own Mac. Email stays where it already lives: in Gmail.

Forge is local-first. Your data lives in a single file on your laptop. There is no account to create, no login screen, and your board never leaves your machine. You open it like any website, by bookmarking a page, but it runs on your own computer and is always on.

---

## Get Forge set up

You do not set this up by hand. Send this repository's link to Claude or Codex and say "set up Forge for me." Your assistant follows the playbook in [SETUP.md](SETUP.md): it installs Forge, interviews you one question at a time about your responsibilities, goals, day, work sources, and delegation boundaries, builds your first current with you, and then offers optional email, CRM, reminder, and voice-note connections.

When it is done, Forge is running at `http://localhost:3200` on your Mac.

---

## Using Forge

Open `http://localhost:3200` (bookmark it the first time). You will see two primary spaces:

- **Today**: Quiet Current, the daily surface where one task is centered as Now. Accepted work is solid. Jarvis proposals are pale until you accept or begin them. `J` and `K` change focus; `Cmd+K` can focus any task without changing its state.
- **People**: relationship records and context, set up in the CRM step.

Today also contains **All Work**, the original four-column board for backlog grooming, waiting work, and history. The board remains available, but it is no longer the place you have to live all day.

You do not have to add tasks by hand. Tell Claude or Codex in plain language: "remind me to call the roofer tomorrow" or "add finish the proposal to my board." Explicit requests become solid work. Work your assistant infers from email, meetings, or context enters Quiet Current in pencil through the [agent contract](AGENT_CONTRACT.md) and cannot become a commitment on its own.

---

## How email works

Email does not get a tab, on purpose. You keep living in Gmail, and Forge works in the background.

Twice a day, at times you pick, Forge reads your new mail and sorts it:

- **Someone needs a written reply?** Forge writes one in your voice and leaves it as a draft inside the thread, in your Gmail. You open the thread, read it, edit if you want, hit send. Forge never sends anything on its own.
- **Needs you to do something that is not a reply?** It goes on today's card as a checkbox.
- **Just something you should know?** Noted on the card.
- **Newsletters, promos, receipts?** Archived out of your inbox and logged, one click to rescue.

Everything lands on one card on your Tasks board, titled like "Emails: Jul 6", sitting in Must happen today. Open it to see what needs you: replies waiting in Gmail, action items to check off, and what got filed. When you send a reply from Gmail, the next run notices and clears it off the card on its own. Anything unfinished carries over to tomorrow's card.

After each run you get a one-line text: "Inbox triaged: 2 need you, 1 action." That is the whole interruption.

Forge keeps its memory in Gmail labels (`Forge/Reply`, `Forge/Archived`, and so on), so you can always see what it did right inside Gmail, and undo any of it there too.

---

## How it runs (for the curious)

- **One small program**, started by a macOS LaunchAgent named `com.forge.local`, serving `http://localhost:3200`, bound to localhost only (never exposed to the network).
- **A reminder checker** (`com.forge.reminders`) wakes once a minute, looks for tasks whose time has come, and fires the notification (and a text, if you set one up). Logs to `~/Library/Logs/forge-reminders.log`.
- **An email triage job** (`com.forge.email-triage`) runs at your two chosen times and does the inbox pass described above. Logs to `~/Library/Logs/forge-email-triage.log`. It only ever creates drafts and moves labels; sending is always you.
- **One file of data**: `data/forge.db`, backed up every day to `data/backups/` (the last 14 days are kept), so restarting or rebooting never loses anything.
- **Your board data stays on the Mac.** Email triage is the one feature that talks to the internet: it reads your Gmail and writes drafts through your own connected account, which you can disconnect any time.

Everything runs only while the Mac is awake. On an always-on Mac (a desktop or a Mac mini), reminders and triage fire like clockwork. On a laptop, they catch up when you open the lid.

Handy commands:

```bash
bash scripts/forge-backup.sh                            # back up the database right now
launchctl bootout gui/$(id -u)/com.forge.local          # stop Forge (and its auto-start)
launchctl bootout gui/$(id -u)/com.forge.reminders      # stop reminder notifications
launchctl bootout gui/$(id -u)/com.forge.email-triage   # stop scheduled email triage
```

To start fresh: stop Forge, **move** `data/forge.db` aside (rename it, don't delete it), and start it again. It recreates the default board, and your old board is still sitting there if you want it back. Same idea in reverse to restore: stop Forge, copy a file out of `data/backups/` over `data/forge.db`, start it again.

## Tech stack

- Next.js 16 (React 19), TypeScript, Tailwind CSS.
- Local data: SQLite via `better-sqlite3` (the default). No login.
- Email: read and drafted through your own Composio Gmail connection. Draft-only by design.
- Optional cloud data for multi-device use: Supabase or Convex (off by default). See [SETUP.md](SETUP.md).
