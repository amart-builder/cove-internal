---
name: cove-voice
description: >-
  Learn the user's email writing voice from their real sent mail and save it to
  ~/.claude/voice.md so every email Cove drafts sounds like them. Use during
  Email setup, or whenever the user wants to refresh or fix how their drafts
  sound ("learn my voice", "hone my email voice", "my drafts don't sound like
  me", "update my writing voice").
---

# Cove voice honing

Goal: produce `~/.claude/voice.md`, a short profile of how THIS user writes
email, learned from their own sent mail and tuned with their feedback. Cove's
email drafting reads it so replies sound like them, not like an assistant.

Email must already be connected through Cove's restricted Google gateway (see the Email step in
`SETUP.md`). If it is not, set that up first.

## 1. Read their real sent mail
Run the trusted bounded sample reader:

```bash
./node_modules/.bin/tsx scripts/cove-voice-samples.ts
```

It reads at most 60 sent messages, strips quoted chains, and returns at most 30
bounded writing samples. Do not use a Gmail tool, raw credential, or generic
Google request instead.

- If even 90 days gives you fewer than ~5 substantive messages (a brand-new
  account, or someone who rarely emails), do not invent a voice. Write a minimal
  `~/.claude/voice.md` saying there is not enough sent mail yet, to use their
  `~/.claude/CLAUDE.md` tone for now, tell the user, and skip the calibration
  below. Suggest they re-run this once they have sent more email.

## 2. Deduce the voice
Read 15 to 30 of those and notice, concretely:

- Greeting and sign-off (Hey / Hi / none; Best / Thanks / just their name / none).
- Sentence length and rhythm (short and clipped? longer and flowing? mixed?).
- Formality, and how it shifts by recipient (a client vs a friend vs a stranger).
- Recurring phrases and verbal tics; words they reach for; words they never use.
- Punctuation and casing habits (exclamations? ellipses? lowercase? emoji?).
- How they open, how they close, how they say yes / no / "let me check".
- Typical length.

## 3. Write a first `~/.claude/voice.md`
Use this shape. Be specific and short. Put 2 or 3 real (lightly trimmed) lines
of their own writing as anchors.

```markdown
# <Name>'s email voice
Learned from <N> sent emails (<date range>). Re-run the cove-voice skill to refresh.

## Core rules
- <greeting / sign-off habit>
- <sentence length and rhythm>
- <formality and warmth>
- Never use an em dash.
- Phrases they use: <...>. Phrases to avoid: <corporate lines they never write>.
- Typical length: <...>.

## Tone by relationship
- Close contacts: <...>
- Clients and prospects: <...>
- New or unknown: <...>

## Anchors (their own words)
> <short real excerpt 1>
> <short real excerpt 2>

## What makes it sound like them
- <a few concrete tells>
```

## 4. Calibrate with the user (2 to 3 rounds)
Do not just hand over the file. Tune it live:

1. Pick 3 realistic scenarios, grounded in the people and topics you saw in
   their sent mail (a reply to a client, a quick scheduling note, a polite no).
   If their triage queue already has real emails, use those instead. Draft each
   using the voice.md you just wrote, then run each through the **humanizer**
   skill for a clean pass (only 3 drafts, so a full pass is fine). If the
   humanizer skill is not installed, apply its core rules yourself.
2. Show the user the 3 drafts. Ask plainly: "Do these sound like you? What would
   you change?" Keep your question short.
3. Fold their feedback into `~/.claude/voice.md`: tighten a rule, fix the tone,
   add a phrase they actually say, cut one they hate.
4. Repeat with fresh drafts until they say it sounds like them. Usually 2 to 3
   rounds. Stop when they are happy, not at a fixed count.

## 5. Save and confirm
Write the final `~/.claude/voice.md`. Tell the user it is saved, that every email
you draft from now on will use it, and that they can say "update my voice"
anytime to run this again (handy after their style or role changes).

## Rules
- This reads their private sent mail to learn style only. Store style notes and
  short anchors in voice.md, never whole emails.
- The humanizer skill runs on every draft you show here. No em dashes, ever.
- Never send anything during this. It is calibration only.
