# Friday demo runbook

## Prep the night before

1. From the Cove repo, run `npm run demo:seed`.
2. Run `npm run demo:start`.
3. Open `http://localhost:3300/tasks` in a fresh tab. The Morning Arrival should open immediately with a finished brief, three charcoal focus cards, and two Not today cards.
4. Confirm the brief has three paragraphs and three Watching for you items. There should be no writing progress bar.
5. Stop the server with Control-C.

On Friday morning, run `npm run demo:seed` again so the plan date is Friday, then run `npm run demo:start`. Do not launch Cove's normal background workers for this demo.

If the production build is missing or the code changed after the last build, run `npm run build` before `npm run demo:start`.

## Walkthrough

### 1. Cold open

Open `http://localhost:3300/tasks` in a fresh tab.

Say: "This is Cove. It starts with the work that matters today instead of making me reconstruct the day from five different tools."

### 2. The brief

Pause on the brief and scroll through Watching for you.

Say: "Before I touch anything, Cove has already read the current work and written the brief. It knows the Horizon draft is the main move, the pricing decision is blocked on three choices, and the ops review needs decisions instead of a status recap."

The brief is pre-written in the demo database, so it appears immediately and never waits on generation.

### 3. Continue to the plan

Click `Continue`.

Say: "The brief becomes a plan I can edit. These three are the focus, and the rest stays visible without competing for attention."

Drag `Follow up with the Meridian intro` from Not today into the Today band. It first joins Also today. Drag that card over a charcoal focus card to promote it into the focus three.

Open the Meridian card to show the Task Sheet and the Me, Claude, Together owner control. Leave the owner as Me. Close the sheet, then open `Browse All Work` and close it again.

Say: "Nothing here is locked. I can change the order, pull in work, or decide whether I own it, Claude owns it, or we do it together."

### 4. Buddy as the correction channel

Open Buddy, but do not send a message unless you want to demonstrate a live correction.

Say: "If the brief or plan gets something wrong, I do not have to leave this screen. I tell Buddy what changed, and Cove can update the work while I am still going through the arrival."

Close Buddy.

### 5. Start the day

Click `Start my day`.

Say: "Now the plan becomes Today. I get one clear focus card, the rest of the day stays ordered, and the Together-owned pricing task starts a real Claude session."

Pause on the focus card and show the Claude session state if it appears.

## Do not click

- Do not open or demonstrate Email or Gmail. The demo has no Google Workspace config and no email-current item.
- Do not click Already done or Not today in a Task Sheet unless you want to change the rehearsal state.
- Do not run the normal launchd workers. Several standalone worker scripts still use the repo's real `data/` directory. `npm run demo:start` launches only the isolated Next server on port 3300.
- `Start my day` launches one real Claude task session for the Together-owned pricing item. For a zero-dispatch rehearsal, run `npm run demo:seed -- --no-claude` before starting the server. That version sets all three focus owners to Me and removes the disclosure line.

## Recovery

1. Stop `demo:start` with Control-C.
2. Run `npm run demo:reset`.
3. Run `npm run demo:start`.
4. Reload `http://localhost:3300/tasks` in a fresh tab.

The reset recreates `data/demo/` from scratch and takes well under a minute. If the server was running during reset, always restart it so its in-memory stores cannot retain the previous rehearsal.

## Isolation notes

The demo command pins the database, data directory, profile, execution registry, brief source files, brief web base, Buddy URL, timezone, and local runtime to `data/demo/` and port 3300. The board, day plan, brief, receipts, Buddy history, task-session records, email state, settings, profile, execution lookup, and workspace lookup all stay under `data/demo/`. Optional Attio and Jarvis brief sources are disabled for the demo.

The demo intentionally has no `cove-workspace.json`, so Gmail is disconnected. It also skips an email-current item because the walkthrough should not depend on live Gmail configuration.

Some standalone background scripts still hardcode the repo's normal `data/` directory for heartbeats, reminders, or worker logs. They are not started by `demo:start`. Do not launch them during the demo.
