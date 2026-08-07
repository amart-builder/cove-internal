# Cove agent handoff

Changing Cove itself rather than installing it? Read `CODEBASE_GUIDE.md` first.

If a user sends you this repository and asks you to install or set up Cove, read
`README.md` and all of `SETUP.md` before changing the machine. Follow the setup
playbook in order. Do not improvise a different runtime or infer that an
optional integration was requested.

For a person's first Cove install:

- Default to the assisted first-day rollout in `SETUP.md`.
- Use paths discovered on that Mac. Never copy another person's database,
  profile, goals, credentials, LaunchAgents, or absolute paths.
- Never run a demo seed or a `demo:*` command against the person's install.
- On a laptop, never use `--mini`.
- Capture the person's real open work before generating the first real Morning
  Brief. An empty board is not a successful smoke test.
- Keep the attention and urgent-email model lanes in shadow mode. Do not connect
  email, meeting notes, Telegram, or iMessage unless the user chooses that
  integration and stays for its live acceptance check.
- Use the user's signed-in Claude Code subscription for the first install unless
  they explicitly choose a different supported brief writer.
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
