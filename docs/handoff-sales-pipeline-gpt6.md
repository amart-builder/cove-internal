# Cutover: Cove sales pipeline ("the sales dashboard")

You are picking up the Edge AI sales pipeline inside Cove from Claude (Fable 5.1), who
led the build with GPT-5.6 Sol implementing and Claude Opus 5 reviewing. This file is
the whole handoff. Read it fully before touching anything, then read `AGENTS.md` and
`CODEBASE_GUIDE.md` in the repo root.

## Who you work for and what this is

Alex Martin runs Edge AI, an AI consulting business (about $16k MRR today, target is
to scale it hard). Cove is his local operator app: task board, morning arrival, CRM,
email drafts, a persistent chief-of-staff agent. The "sales dashboard" is the pipeline
page at `http://127.0.0.1:3200/crm/pipeline`. It is live and in daily use.

Alex is non-technical and reads at a plain-English level. Explain the why, keep
sentences short, never use an em dash or an en dash anywhere (code comments, commit
messages, UI copy, replies). Tell him plainly when an idea is weak. Give options with
a recommendation, not open questions.

## Where things stand (as of 2026-09-05)

Live numbers from the API this morning: 25 deals, 21 open leads, 12 overdue, 5 due in
the next 7 days, 4 clients at $16,000 MRR.

Shipped and verified:

- Page at `/crm/pipeline` (People tab has a People | Pipeline sub nav). Attention-first
  grouped list, not a drag board: four summary tiles (client MRR, open leads, overdue,
  due in 7 days), a "Needs attention" list (overdue, no next action, no follow-up
  date), then every stage in funnel order with an inline stage select, and a right
  detail pane with save-on-blur fields, a "Log a touch" form, and the contact's real
  activity timeline.
- Restyled on 2026-09-03 to the Morning Arrival design language (tokens, no hex,
  `press-scale`, `day-ritual-swap-in`, Arrival card and button classes). Keep that
  language for anything new on the page. Reference files:
  `src/components/tasks/MorningArrival.tsx`, `src/components/tasks/arrival/*`.
- Morning brief source for overdue follow-ups exists: `pipelineFollowUpsSource` in
  `src/lib/day-plan/brief-sources.ts`.
- Chief-of-staff snapshot has a Pipeline section: `pipelineSection` in
  `src/lib/chief-of-staff/snapshot.ts`. The chief can suggest pipeline moves but
  cannot set `lost` or `parked` itself (those need Alex).
- Claude skill `skills/cove-pipeline/SKILL.md` is how an agent runs the pipeline day
  to day (add, move, log a touch, head-of-sales report). `skills/cove-contact` routes
  sales next steps there.

Known open items, both LOW, from the last review:

1. `PipelineView.tsx` `saveField`: key the save-on-blur in-flight guard per field so
   a failed save is never reported as saved when two blurs race.
2. After a touch is logged, either make the post-touch draft sync functional or
   disable the two next-step inputs while the touch is submitting.

Alex has not yet said what he wants built next on the dashboard. Before writing code,
ask him for the top outcomes he wants, in one message with options and your
recommendation. Candidates worth offering:

- Auto-log touches from sent email and calendar events (call_scheduled from a booked
  call) so the pipeline stays current without manual logging.
- A weekly head-of-sales report (conversion by stage, stalls, expected MRR) delivered
  through the morning brief or the chief-of-staff.
- Per-deal value and close-date fields feeding a simple forecast tile.
- Attention notifications for overdue leads through the attention ledger (there is
  already a `notify` action and a deal notify path; it is rejected when the pipeline
  is off).

## Repo and runtime facts

- Repo: `/Users/alexanderjmartin/Atlas/Projects/Cove`. Branch `main`. Next.js 16,
  React 19, better-sqlite3, TypeScript. Read `node_modules/next/dist/docs/` before
  assuming Next behavior; this version differs from training data.
- Served by LaunchAgent `com.cove.local` at `http://127.0.0.1:3200`. Rebuild and
  restart after any change you want to see live:

  ```bash
  cd /Users/alexanderjmartin/Atlas/Projects/Cove && npm run build && launchctl kickstart -k gui/$(id -u)/com.cove.local
  ```

  Never leave a second dev server running. This laptop has 16GB RAM and has frozen
  from swap before. Kill any browser or server you start before you finish.
- Checks: `npm test` (tsc plus node:test, currently 1191 passing), `npm run lint`
  (zero warnings), `npm run build`. Pipeline-only tests:

  ```bash
  node --import tsx --test tests/pipeline.test.mjs tests/pipeline-store.test.mjs tests/pipeline-route.test.mjs
  ```

- Live check: `curl -s "http://127.0.0.1:3200/api/crm?operation=pipeline"` returns
  `summary`, `deals`, `attention`.
- Screenshots: Playwright is installed at
  `/Users/alexanderjmartin/Atlas/Projects/catalyst/jarvis-pro/film-assets/node_modules/playwright`
  (`require(process.env.PW_DIR)` with `PW_DIR` set to that path). Close the browser.
- Feature switches live in the gitignored `.env.local`: `COVE_SALES_PIPELINE=1` and
  `NEXT_PUBLIC_COVE_SALES_PIPELINE=1` (build-time inlined, so a rebuild is needed
  after changing it). Without both, the Pipeline tab hides, `/crm/pipeline` returns
  not-found, and the API returns 404 `{ "error": "sales_pipeline_disabled" }`.
  `COVE_CHIEF_OF_STAFF=1` gates the chief-of-staff lanes the same way. Never remove
  these gates and never commit `.env.local`.

## Code map

| File | Role |
|---|---|
| `src/lib/crm/pipeline.ts` | Pure rules: stages, types, follow-up status, summary, attention items, validation. No I/O. |
| `src/lib/crm/pipeline-store.ts` | `LocalPipelineStore`: SQLite persistence (`pipeline_deals`, migration 21, one deal per contact, FK cascade, CHECK constraints). |
| `src/lib/crm/sales-pipeline.ts` | Server-side gate helper `salesPipelineEnabled`. |
| `src/lib/runtime/sales-pipeline.ts` | Client-side gate `isSalesPipelineEnabled()`. |
| `src/app/api/crm/route.ts` | The only door. GET `operation=pipeline`; POST actions `pipeline_upsert`, `pipeline_move`, `pipeline_log_touch`, `pipeline_remove`. |
| `src/app/crm/pipeline/page.tsx` | Page shell, `notFound()` when gated off. |
| `src/components/crm/PipelineView.tsx` | The whole page UI (about 1100 lines). |
| `src/components/crm/CrmSubNav.tsx` | People | Pipeline segmented control; hides Pipeline when gated off. |
| `skills/cove-pipeline/SKILL.md` | Agent operating manual for the pipeline. Excluded from the public export. |
| `tests/pipeline*.test.mjs` | Rules, store, and route tests. |

Stages in funnel order: `reach_out`, `keep_warm`, `interested`, `call_scheduled`,
`pitched`, `discovery_ready`, `discovery_booked`, `proposal`, `client`, `lost`,
`parked`. Open means every stage except `client`, `lost`, `parked`. MRR counts
`client` rows only. Every open lead must carry a next action and a follow-up date.

Invariants the tests enforce. Do not break them:

- A stage change writes a `pipeline_stage` row into `contact_activities` and never
  touches contact recency. Only `pipeline_log_touch` bumps `last_interaction_at`, and
  it does so atomically with the deal update.
- `pipeline_upsert` cannot change stage after creation. Only `pipeline_move` or a
  touch can.
- Pipeline data never goes through the generic REST table endpoint or the Buddy
  allowlist.
- Contact `merge` reparents the loser's deal or returns 409 when both sides hold one.
  Contact `delete` returns 409 while a deal is open or a client.
- Patch keys accept camelCase or snake_case.

## Working rules for this repo

- Before any git write, read the "Active Session" block at the top of `STATUS.md`
  and take the lock: `~/Atlas/bin/session-lock.sh acquire Cove "<task>"`. Release it
  when done. If it refuses, another session holds it; wait.
- Stage specific files. Never `git add -A`. Commit messages: plain, no em dashes.
- Push only with `~/Atlas/bin/git-safe-push.sh /Users/alexanderjmartin/Atlas/Projects/Cove`.
  A plain `git push` is blocked on purpose.
- `origin` is the private repo `amart-builder/cove-internal`. The public client repo
  `amart-builder/cove` is a sanitized export produced by
  `scripts/export-cove-client.mjs` and published by a separate procedure
  (`OPERATIONS.md`). Do not push there. The pipeline ships gated off in that export
  and its skill is excluded; keep it that way. `docs/` is not exported, so this
  file stays private.
- No real names, client names, emails, or hostnames in tests or prompts. Use
  `Sam Rivera`, `Example Co`, `owner@example.com` style fixtures. The export runs a
  secret and identifier scan and will fail otherwise.
- No new dependencies without a stated reason. Simplest thing that works; Alex
  maintains this.
- Other agents also work in this repo. Coordinate through `STATUS.md` before editing
  `src/lib/intake`, `src/lib/health`, `src/lib/day-plan`, or the meeting and Granola
  tests; those areas have active owners.
- When you finish a piece of work: full `npm test`, lint, build, restart the service,
  screenshot the page, add a dated entry to `STATUS.md` (what shipped, verification,
  what is next), commit, push private, release the lock.

## First message to Alex

Confirm you have read this file, name the two LOW items, and ask which outcomes he
wants first for the dashboard, with the candidate list above and your recommendation.
Do not start building features he has not asked for.
