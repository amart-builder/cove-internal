# Cove agent handoff

Changing Cove itself rather than installing it? Read `CODEBASE_GUIDE.md` first.

If a user sends you this repository or its GitHub link and says "Set me up with
Cove," "install Cove," or the equivalent, treat that as the complete setup
request. Do not ask them to restate the long technical instructions. Read
`README.md` and all of `SETUP.md` before changing the machine, then begin with
the outcome-led explanation required there. Follow the setup playbook in order.
Do not improvise a different runtime or infer that an optional integration was
requested.

For a person's first Cove install:

- Default to the assisted first-day rollout in `SETUP.md`.
- If the user did not request Basic Mode, use Full Cove. Explain the two
  experience choices briefly and let them switch before installation without
  making them design the setup themselves.
- If the user asks for Basic Mode, treat the `Basic Mode` section of `SETUP.md`
  as the user-experience and acceptance contract. Deliver only two scheduled
  Claude Mac app rituals: a Morning Brief and an end-of-day conversation. Put
  the daily operator question inside closeout rather than creating a third
  interruption. Use the best supported Claude capabilities rather than
  hard-coding a fragile mechanism.
- Basic Mode uses Cove's existing local database, goals, connectors, workers,
  and safety boundaries. Do not build a prompt-only substitute, a parallel task
  store, or user-facing email-triage routine. Basic Mode does not depend on a
  persistent Claude session. Persist task changes, closeout notes, and useful
  operator answers so a fresh ritual session can recover them. Terminal and the
  Cove website may be used by the setup agent for installation and testing, but
  they are not part of the user's Basic Mode workflow.
- Use paths discovered on that Mac. Never copy another person's database,
  profile, goals, credentials, LaunchAgents, or absolute paths.
- Never run a demo seed or a `demo:*` command against the person's install.
- On a laptop, never use `--mini`.
- Capture the person's real open work before generating the first real Morning
  Brief. An empty board is not a successful smoke test.
- Keep the attention and urgent-email model lanes in shadow mode. Do not connect
  email, meeting notes, Telegram, or iMessage unless the user chooses that
  integration and stays for its live acceptance check.
- Explicitly ask whether Claude or Codex should be the primary Cove agent.
  Recommend the provider receiving the setup request, ask one model question,
  and verify the chosen exact model with cove-agent-settings.mjs. Full Cove
  includes chief-of-staff service and native follow-through by default. Basic
  Mode keeps the two-ritual contract. Do not require both providers.
- Stop on a failed preflight, verification, build, identity check, or backup
  check. Explain the failure instead of bypassing it.
- Do not send email or messages, publish, purchase, expose Cove to the network,
  or enable an external action on the user's behalf.

Setup is complete only when the app, worker, first real brief, task capture and
edit flow, closeout practice, backup, and restart persistence have been checked,
and the user has been told exactly which background lanes are active.

<!-- BEGIN:nextjs-agent-rules -->
# This is not the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may
differ from your training data. Read the relevant guide in
`node_modules/next/dist/docs/` before writing code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
