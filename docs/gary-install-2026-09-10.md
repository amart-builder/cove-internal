# Gary Gersh install day, Wed 2026-09-10

Internal prep note for Alex. Not client-facing.

## The one outcome

Gary's own words (email, Sep 1): "if they let me work from my phone and run things
with the laptop closed, that fixes my biggest problem by a mile." His Claude-written
prep doc ranks it the same way: "one place Gary can look, from his phone, that tells
him what to do right now. Everything else on this page is secondary."

Everything below serves that.

## What is actually true today (verified in the repo and the docs)

- Cove is a local web app on 127.0.0.1:3200 with no login. A phone cannot reach it,
  and it must not be exposed on the LAN. SETUP.md forbids Tailscale on client installs.
- Cove's Today and Arrival views are desktop-only (fixed pixel widths, drag and drop).
  People and All Work degrade fine on a phone, Today does not. Not fixable by tomorrow.
- Cove can reach a phone by exactly one route that needs nothing from us: Telegram.
  Gary's own bot token (he ran /telegram:access on Sep 3, bot "Spicy Father Bot") plus
  his chat id in data/cove-reminders.json. No SMS, push, or email transport exists.
- Inbound works too: the Telegram channel lets him message Claude on his Mac from his
  phone, and the cove-voice-note skill turns a Telegram voice note into a Cove task.
- Dispatch (Claude mobile app) starts a session on his Mac from his phone and sends its
  own push when the session finishes or needs approval. Needs Pro or Max, the Claude
  desktop app running, and the Mac awake. Remote Control already shows his MacBook Pro
  sessions in his Claude iOS app (seen Sep 3).
- Nothing lets a Cove job push through the Claude mobile app. Not documented anywhere.
- Every route above dies when the Mac sleeps. Lid closed means sleep unless it is on
  power with an external display, or sleep is disabled. This is the real constraint.
- Cowork is not a cloud runner. Gary's doc says it "runs scheduled tasks even when the
  laptop is closed." That is wrong. Cloud routines exist (claude.ai/code/routines) but
  they run in Anthropic's cloud, not on his Mac, so they cannot touch Cove or his mail.

## Recommendation: Telegram is the phone surface, starting tomorrow

Zero new code. One app on the phone for all of Cove's voice.

1. Morning brief and 4:45pm closeout land in Telegram (cove-notify.mjs already does
   this once channel is telegram).
2. Reminders and the daily "N things need a look" text go to Telegram.
3. He voice-notes or types tasks to the bot from the car. They land on the board.
4. He can ask Claude questions there too. Same bot, same thread.

Why this and not Dispatch: Dispatch is "phone tells Mac to do work." Telegram is "Mac
tells phone what matters, and phone captures." Gary's pain is the second one. Turn
Dispatch on as well (cheap, and he asked), but frame it as the button for "go do this
big thing," not the inbox.

Why one place matters: on Sep 3 Gary said "I can't have 2 options to do it," and we
told him to drop Telegram for the Claude app. Tomorrow reverses that. Say so plainly:
"I changed my mind after reading your doc. The Claude app cannot deliver Cove to your
phone. Telegram can. Telegram is Cove's voice; the Claude app is Claude's."

## Config to set on his Mac (in order)

1. `~/cove/data/cove-reminders.json` ->
   `{ "channel": "telegram", "telegram_chat_id": "<his id>", "always_on": false }`
   Get the chat id from the Sep 3 pairing (access.json in ~/.claude/channels/telegram).
2. Check `~/.claude/channels/telegram/.env` still has TELEGRAM_BOT_TOKEN.
3. Send a test line with `node scripts/cove-notify.mjs "Cove test"` and watch his phone.
4. Turn on the reminder text for the tasks that matter: `remind_text` defaults to 0 on
   every task, so with no change he gets one summary text a day and nothing else.
   Set it on his top 5 to 10 tasks during the practice morning.
5. `data/attention-sweep.json`: leave `shadow: true` for day one. Flip to false after a
   week of clean banners. Do not flip email_shadow.
6. Keep the inbound Telegram channel alive. It needs a running Claude session on his
   Mac. Nothing in the installer restarts it. Either he keeps that Claude window open,
   or we add a LaunchAgent for it. Tell him the truth: if that window closes, replies
   stop, but Cove's outbound texts still work (they do not need the session).

## Keep the Mac awake (the whole plan depends on this)

- Plugged in, lid open, at his desk. Say it in one sentence and do not soften it.
- System Settings > Battery (or Energy) > "Prevent automatic sleeping on power adapter
  when the display is off": on. Display can sleep, the Mac cannot.
- If he wants lid closed: only works on power with an external monitor attached. Not
  with the laptop alone in a bag.
- Our own finding (Aug 6): scheduled dark wakes do not run Claude. Sleep is fatal.
- Add to the finale: the 6:30am brief is the canary. If it did not arrive on Telegram
  by 7, the Mac slept. He texts you, we fix it, no shame.

## Repairs needed before the practice morning

From Gary's own doc. Do these first or the demo fails.

- Cove cannot open a new day. An empty day plan from Aug 27 is still open and blocks
  "Start my day." Settle or abandon it before anything else.
- Bella Figura mail (Microsoft) is disconnected, waiting on Cubit Tech's tenant admin.
  A third of his work is invisible to Cove until that lands. Not ours to fix tomorrow.
- Calendar events arrive twice (confirmation email attachment plus the real event).
- Contacts: the Sep 4 merge mangled cards (Michaela/Alexi, Ari/Jeffrey). He was told
  to undo the 957 "needs a check" merges. Confirm that happened before Cove's CRM
  imports anything.

## Open items I could not verify

- Whether the fresh-install test on Christine's laptop ran. STATUS.md lists it as
  "next," and the Cove task for it is still open. If it did not run, the public release
  is untested on a second machine. Tomorrow is a reinstall over his Aug 3 copy at
  ~/cove, which is lower risk than a blank Mac, but the rerun still needs care.
- Gary's Claude plan tier. Dispatch needs Pro or Max. Never came up on Sep 3.
- Whether the Aug 3 install on his Mac is at ~/cove on an old commit. Expect an old
  tree; the installer is rerunnable and preserves data.
- Call time tomorrow. Not on the calendar yet as of tonight.

## What "mobile-native Cove" means after tomorrow (backlog, not tomorrow)

- A phone-sized "What now" page: today's three priorities, the next meeting, one tap
  to mark done or bump. Read-mostly. This is the page Gary opens at a red light.
- Reach it over Tailscale Serve (device auth, listener stays on 127.0.0.1). Needs the
  client-install rule in SETUP.md rewritten, and COVE_TAILSCALE_TRUSTED_HOSTS set.
- Until that exists, Telegram is the phone product. Do not promise the page yet.
