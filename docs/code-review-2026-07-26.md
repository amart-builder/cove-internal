# Cove code review, 2026-07-26

Full-codebase review of 45,785 lines across ~180 source files. Eight independent reviewers: seven Claude Opus 5 agents split by area, plus one GPT-5.6 (Codex) pass over the five highest-risk files, briefed to catch what a Claude reviewer would wave through. Every P0 below was verified by hand against the running system before it was written down; findings that survived only as reasoning are marked.

The review rubric is deliberately biased toward deletion over abstraction, because one non-technical maintainer owns this code. No finding here proposes a new layer, framework, or pattern.

## Verdict

The architecture is sound and the hard parts are done well. No React component reaches the database directly, the cross-machine relay validates untrusted peer files properly, process spawning uses a real environment allowlist and process-group cleanup, and the idempotency design across mutations is unusually disciplined. Ten runtime dependencies for 46k lines is a real asset.

Three things are genuinely wrong and one of them was live: an ungated endpoint serving the entire CRM, host-header spoofing standing in for authorization on a network-bound machine, and about 4,000 lines of abandoned code that a setup agent will read as current.

## What was fixed during the review

**`/api/crm/attio` had no access check of any kind.** It answered any `Host` header and returned every contact: names, emails, phones, notes, relationship stage. Proven live before the fix, from this laptop against the Mini over the network:

```
GET /api/day-plan     Host: evil.example.com   ->  403   (correct)
GET /api/crm/attio    Host: evil.example.com   ->  200, 1,463,224 bytes
```

Because it accepted any `Host`, this was reachable through DNS rebinding from any web page, so it was exploitable against the loopback-only MacBook too, not just the network-bound Mini. Any site visited in a browser could have read the CRM as same-origin JSON.

Fixed in `7a7a3a5` by gating the route with `isTrustedCoveRequest`, the same check every sibling read route already used. Verified after deploy on both machines: spoofed host 403, honest loopback still 200. Tests 380/380, typecheck clean.

## P0: decide before Wednesday's client install

### 1. The Host header is the only authorization, and the Mini is bound to every interface

`request-security.ts` decides access by comparing the `Host` header against an allowlist. It never checks where the connection actually came from. The Mini serves on `*:3200` (all interfaces, Tailnet and home LAN), so this is the whole perimeter there.

Proven live:

```
GET /api/day-plan   (honest host, off-box)     ->  403
GET /api/day-plan   Host: localhost:3200       ->  200, full day plan + csrfToken
```

That response hands out the CSRF token, which is the key to every mutating route including `/api/cove-rest/<table>`. So any device on the Tailnet or the home network can read and write tasks, contacts, emails, and commitments. I did not perform a write; the read proof plus the code path is sufficient.

Compounding this, `COVE_TAILSCALE_ALLOWED_EMAILS` is set in `.env.local` and **no code reads it**. It looks like an identity layer and is not one.

**This needs your decision, because the obvious fix breaks something you use.** Binding the Mini to loopback would kill your `http://alexander-mac-mini...ts.net:3200/tasks` access. Options, in the order I would take them:

1. **Recommended: bind Next to `127.0.0.1` on the Mini and expose it to the Tailnet with Tailscale Serve.** Serve exists to publish a localhost service inside the Tailnet only, so the home LAN stops reaching Cove entirely, the local workers keep talking to `127.0.0.1:3200` unchanged, and Tailscale ACLs become a real perimeter instead of a claimed one. Verify what `Host` header Serve forwards before switching, and add it to the allowlist if needed.
2. Keep the current binding and require `COVE_DAY_PLAN_REMOTE_TOKEN` (`accessMode: 'session'`) for non-loopback access. **Note this does not work as-is:** neither the browser client nor the worker reads send that header today, so switching modes without adding token transport locks you out of your own Mini. It is also a shared bearer secret, not user identity.
3. Accept it, delete the misleading `COVE_TAILSCALE_ALLOWED_EMAILS`, and document that host membership is the only authorization. Honest and cheapest, but note that while Next listens on `*`, your home LAN bypasses Tailscale ACLs completely, so "Tailscale is the perimeter" is not true today.

In all three cases the Host allowlist stays: it is genuine DNS-rebinding protection, which is exactly what it was written for. It just is not an identity layer, and nothing should describe it as one.

Whichever you pick, a client install is loopback-only and single-machine, so **Gary is not exposed to this**.

### 2. Reads are gated more weakly than writes

`/api/cove-rest/[table]` GET calls `isTrustedCoveRequest`, while mutations call `hasDayPlanRouteAccess`. In `session` mode those differ: mutations require the token, reads require nothing but a trusted host. Every allowlisted table, including `email_items`, `drafts`, and `contacts`, is readable with no credential.

**Change:** require `hasDayPlanRouteAccess` for every method in `handleRequest`; keep the CSRF check as an additional requirement for mutations only. `src/app/api/cove-rest/[table]/route.ts:72`.

**Do not ship this before fixing the perimeter.** An adversarial pass caught that this breaks the maintainer's own setup: his browser reaches the Mini on a Tailscale hostname, which the wide read allowlist admits and the loopback-only mutation gate does not. Tightening reads to match writes turns his remote Tasks and CRM into 403s. Fix the perimeter (item 1) first; once Cove is loopback-only behind Tailscale Serve, reads and writes can share the strict gate with nothing lost.

### 3. Filterless PATCH and DELETE hit the whole table in cloud mode

In Supabase mode the route forwards the request to PostgREST with the service-role key and no requirement that a row filter be present. A caller that omits its filter updates or deletes every row in an allowlisted table. The local SQLite path already refuses this, so the two backends disagree about a destructive operation. Your machines run supabase mode, so this is live for you and not for a client.

Two related holes in the same file: query parameters are forwarded verbatim, so `select=` resource embedding reaches tables the allowlist never approved (`route.ts:46`); and in the local path `parseWhere` silently drops any operator it does not recognize, so `?status=eq.open&due_at=not.is.null` loses the second clause and marks **every open task** done (`src/lib/local/db.ts:354`).

**Change:** reject PATCH/DELETE without an `id`-style filter in both paths; copy only known-safe query parameters into the PostgREST URL and reject `select` values containing `(`; add a final `else { throw ... }` to `parseWhere`.

## P1: fix before or during the client install

**Data loss, two paths.** The CRM detail panel seeds its draft state once at mount and never re-seeds (`src/components/crm/LocalCRMView.tsx:492-496`), so after Buddy edits a contact, the next focus-and-blur on any field silently PATCHes the stale value back over Buddy's write. No typing required. Same class in `TaskDetail.tsx:93-101`, where the resync effect keys on the `task` object so any board refresh discards what the user is typing into an open modal. Fixes are a per-field re-seed effect and a `[task]` to `[taskId]` dependency change respectively.

**The brief can silently generate blind.** `missingRequired` is computed from untrimmed content (`src/lib/day-plan/brief.ts:409`), but the character budget can trim a required source to zero bytes. The per-source caps sum to 91,000 against a 60,000 budget, and STATUS.md already records the budget sitting exactly full once. When it fires, the brief runs with no task board and no settlements and nothing says why. One-line fix: filter on `entry.text.length === 0`.

**The brief's own instructions can vanish without failing.** If `prompts/chief-of-staff.md` is unreadable, `chiefOfStaffMandate()` substitutes a six-line v4 fallback and only `console.warn`s, and the mandate is not part of the input hash, so the degraded output is stamped and relayed as a valid v13 artifact. Delete the fallback, throw instead, and add the mandate hash to the input hash. That also removes the need to hand-bump the prompt version for prompt edits.

**Brain-dump extraction is hardcoded to Pacific.** `DUMP_TIMEZONE` in `dump-commands.ts:6` has no env override while the brief lane next door honours `COVE_BRIEF_TIMEZONE`. A client in New York saying "call Maria Tuesday at 9" gets 12:00 ET. This ships Wednesday.

**Orphaned Claude processes.** The brief and dump lanes spawn detached children without recording a pid, and neither table has a pid column, so nothing can reap them after a worker restart. A 45-minute Opus brief whose parent dies keeps running with no timeout while the new worker starts a second one. This is the exact orphan class that has frozen this machine before. Add `pid` to both tables and extend `recoverStaleOrphanGroups` to sweep them.

**An unhandled stdin error takes down the whole app.** Both spawn helpers write the prompt to `child.stdin` with no `'error'` listener, and there is no `process.on('uncaughtException')` anywhere. If `claude` exits before the write lands (not signed in is an observed state), EPIPE becomes an uncaught exception. In the buddy path that is inside the Next server, so one bad turn kills Cove. `src/lib/buddy/spawn-session.ts:107` already does this correctly; copy it.

**The buddy's delete confirmation is not load-bearing.** The mint endpoint ignores `turnId` and never checks that a pending delete exists for that row, and the buddy's own tool can fetch the CSRF token unauthenticated. A prompt-injected turn can therefore mint and consume its own delete token with no card ever shown. Require the mint to match a pending delete in the stored turn receipts, and take the label from storage rather than the client.

**The buddy's session-spawn is the one Claude spawn with no restrictions.** `buildBuddySeedCommand` omits `--strict-mcp-config`, `--mcp-config`, `--tools`, and `--no-chrome`, which every other spawn in the codebase pins. It runs with the user's full MCP set and default toolset, in a model-chosen directory, seeded with a model-written prompt composed from untrusted data rows. Add the four flags.

**Also P1:** the relay's `dataDir` is not passed to `collectMorningBriefSources` (`worker.ts:1092`), the same ambient-vs-injected bug class STATUS.md says already bit us twice, just on the read side; due dates are written as local midnight and read back as a UTC slice, so every save walks the date back one day at any UTC+ offset (`TodayView.tsx:305`, `KanbanBoard.tsx:328`); readiness assessment does synchronous file reads and two `git` subprocesses per item on a 1.5-second poll on the single-threaded server; a legacy `data/cove.db` binds the REST layer to an incompatible `tasks` table via `CREATE TABLE IF NOT EXISTS` (verified: this machine's live database has the pre-Convex schema with no `status`, no `due_at`, no `source_type`); `arrival_interacted_at` is missing from the `day_plans` CREATE TABLE so every fresh install creates-then-ALTERs, unguarded against the two RunAtLoad agents racing on first boot; late-arriving briefs can never surface their sales actions because `hasExtras` is frozen at mount; and task cards on the All Work board cannot be opened by keyboard at all, because `role="group"` is spread after dnd-kit's `role="button"`.

## P2: the deletion pass

This is the highest value-per-minute work in the review and it is nearly all `git rm`. Roughly 4,000 lines and three dependencies, none of it reachable.

**Convex is abandoned.** Eleven of fourteen files last changed 2026-04-03. Five of nine function modules are referenced by nothing. The schema has drifted past repair (no `status`, no `due_at`, no `commitments`, no `day_plan_*` table of any kind), and the entire chief-of-staff layer is unconditional SQLite, so Convex mode delivers a Kanban board and a contact list on a four-month-old schema, behind a login, with the actual product turned off. Meanwhile `ConvexClientProvider` wraps the whole app in every mode. Deleting it removes `convex/`, `SignIn.tsx`, `ContactDetail.tsx`, `ImportModal.tsx`, the Convex branches in `CRMView`/`KanbanBoard`, and the `convex` + `@convex-dev/auth` + `@auth/core` dependencies (~42MB of `node_modules`). Three independent reviewers reached this conclusion separately.

**Documentation that will actively mislead a setup agent.** `PLAN.md` is the build plan for a different, retired product and contains a live Supabase project ref. `SPEC.md` contradicts `README.md` on the framework version, the navigation, and the whole email design. `plans/` is eleven unreferenced files including 204 lines planning a Convex migration that `SETUP.md` now explicitly forbids. `openclaw/` is a worker prompt for a retired harness, still carrying your email address. `BUDDY-DEPLOY.md` targets a LaunchAgent the installer never creates (`com.cove.web` vs the real `com.cove.local`) and tells you to roll back with patch files that were never committed. `SETUP.md`'s storage-modes table promises multi-device sync that only covers tasks and CRM, with no migration tool, so a client who asks for phone access gets their chief-of-staff layer silently stranded. `README.md` never mentions Arrival, Settlement, the Brief, or Buddy, and still says "delete `data/cove.db` to start fresh", which now wipes the day-plan history, brief artifacts, buddy turns, and the commitment ledger.

**Dead code with no callers,** each proven with `git grep`: the arrival spike and its schedule library (517 lines plus 12 tests, never wired to any LaunchAgent); `scripts/run-email-triage.mjs` (365 lines, superseded by the `cove-email` skill writing through the REST route); the whole read path for `day_plan_assistant_turns`; `configureExecution` (60 lines, returned by the hook, called by nobody); `selectEligibleMorningBrief` (a second, already-drifted copy of the store's selection, whose test asserts the ordering production was explicitly written not to use); `selectRecommendedHumanFocus`; `listExecutionConfigs`; `selectExecutionModel` (ignores its argument, returns a constant); `checkedRows` in `ContactList` (selection checkboxes wired to nothing); `defaultVisible` on all eleven columns; the create-next-app starter SVGs; and `supabase/.temp/` holding live connection identifiers in the working tree.

**Duplication that has already drifted:** four copies of "calendar date in a timezone", six of date and relative-time formatting, three of `getInitials`, three of the blocked-tag helpers, two independent column-alias tables that already disagree about `'Backlog'` (so Defer works in Settlement while All Work refuses to render that column), and `correctionPrompt` defined once and re-inlined 600 lines later with drifted wording. All of these are deletions, not new abstractions.

## P2: the two guardrails that would have caught the P0

**Nothing typechecks.** `npm test` runs `tsx --test`, which strips types without checking them. There is no `typecheck` script and no CI. The only signal that the code compiles is `npm run build`, which the operating rules say not to run casually against the live server. Change `test` to `tsc --noEmit && tsx --test tests/*.test.mjs`. Costs a few seconds on a four-second suite.

**No route-level access test.** Every route re-implements its own access check because there is no middleware, which is exactly why `/api/crm/attio` could be missing one and nothing noticed for two months. One test that enumerates `src/app/api/**/route.ts` and asserts every exported handler 403s an untrusted `Host` would have caught it. Write that test as part of fixing the P0s.

Related test problems worth the hour: the migration test creates a table the store never touches and asserts it survived, so deleting every migration in `store.ts` leaves the suite green; the installer test slices the script by `indexOf` on comment markers, so renaming a comment silently widens the slice and makes its assertions vacuous; three test files write scratch state into the live `data/` directory; and one test sleeps 45ms of real wall clock in a file that already imports an injectable clock.

## P2/P3: structural

`store.ts` (3,549 lines) should lose its schema and migrations (410 lines), its row types and mappers (300), and the morning-brief block (450) to three sibling files, leaving ~2,300 lines of plan lifecycle. Do **not** split `mutateDayPlan` itself: it is one 710-line state machine over six shared accumulators and breaking it up would make it harder to read, not easier. `TodayView.tsx` (2,510 lines) has four clean seams (`useTodayBoard`, `JarvisSuggestions`, `SearchPalette`, `RitualOverlay`) worth about 900 lines, but the river layout pass should stay whole. `worker.ts` (1,445) splits into dump and brief workers with 300 lines of genuinely shared spawn machinery left behind. `api/day-plan/route.ts` (865) splits into body parsing and read-model projection, leaving ~230 lines of actual route.

These are the largest-effort items in the review and the least urgent. Each is independently landable. Do them one at a time, after the client install, with the test suite green between each.

## The Wednesday blocker this review nearly missed

`SETUP.md` step 1 is `git clone https://github.com/amart-builder/cove.git`, and the repo was made private on 2026-07-26. On Gary's Mac that command fails before a single line of Cove code runs, and the install agent has no instruction for what to do about it. Decide the access mechanism (a fine-grained token scoped to this repo and revoked after the install is the smallest option; adding him as a collaborator is the other) and write the prerequisite into SETUP.md before Wednesday.

## Where the adversarial pass disagreed with this review

A second model red-teamed the plan above. Three of its objections are recorded here rather than resolved, because they are judgment calls the maintainer should make:

- **The structural splits may not be worth doing at all.** Its argument: for one maintainer working with an AI assistant, a 3,549-line file is cheap to navigate (the assistant reads it whole) and the refactor buys regression risk with no user-facing payoff. The counter-argument is that this review found three real bugs inside `TodayView.tsx` that a smaller file would have made obvious. Both are true. If you do these, do them one at a time with the suite green between each, and stop when the benefit stops being obvious.
- **The helper consolidations are not pure deletion.** Creating `contact-display.ts` is a new shared file with call-site churn, not a `git rm`. Fair. The one that is unambiguously worth doing is the duplicated column-alias table, because the two copies already disagree about `'Backlog'` and that is a live bug. The rest of the duplication is harmless until it drifts.
- **The Convex removal is a deprecation, not cleanup.** It touches the root provider, four UI components, and an advertised storage mode. Treating it as an afternoon of `git rm` understates it. The document deletions genuinely are `git rm`; Convex is its own change with its own verification.

It also corrected two things that are now fixed above: the cove-rest read gate would break remote access if shipped before the perimeter fix, and option 2 for the Host problem does not work as written because nothing sends the token.

## Suggested order

0. **First:** settle the private-repo clone access for Gary's Mac, or Wednesday stops at command one.
1. **Now:** decide the Host-spoofing question (three options above) and fix the perimeter. Land the filterless PATCH/DELETE rejection, which is independent and safe. Add the `tsc --noEmit` gate and the route access test. Hold the cove-rest read gate until the perimeter is fixed, and hold the broad query-parameter allowlist until every query shape currently in use has been inventoried, because that one can break legitimate reads. Half a day.
2. **Before Wednesday, documents first.** Gary's install is driven by an agent reading this repo, so a document that contradicts `SETUP.md` is a client-install risk, not cleanup. `git rm` `SPEC.md`, `PLAN.md`, `plans/`, and `openclaw/`; fix `BUDDY-DEPLOY.md`'s LaunchAgent names; correct the storage-modes table in `SETUP.md` and the destructive "delete cove.db" line in `README.md`. Twenty minutes, no code touched, and it removes every document that would send an install agent the wrong way.
3. **Also before Wednesday:** the two data-loss bugs, the dump timezone, the brief's required-source hole and mandate fallback, the `dataDir` one-liner, the stdin error handler, the buddy spawn flags, and the legacy-database guard. Add two the red-team pulled forward: the missing `arrival_interacted_at` column (a fresh clone starts two agents at once and can race the migration on first boot, which is precisely a Wednesday failure) and the due-date timezone fix, unless Gary is confirmed to be in a UTC-negative timezone. All small and surgical; none of them touch structure.
4. **After Wednesday:** the code deletion pass, led by Convex, plus the dead functions and drifted duplicates. This one changes real code, so it waits until the install is behind us. One afternoon, and it makes everything after it easier.
5. **Then:** the remaining P1 correctness work (orphan reaping, delete-gate binding, readiness caching, due-date timezone), followed by the structural splits one at a time.

## What is good, and should be protected

- `parseRelayFile` in `brief-relay.ts`: size bound, version gate, strict ISO with causal ordering, future-skew rejection, filename/identity binding, and a checksum over a canonical string that deliberately excludes transport fields. Use it as the template for the looser `liveRemoteBriefAttempt`.
- The execution lane's orphan handling: detached children leading their own process group, signals sent to the group with a direct-child fallback, and the command line verified before killing so a reused pid is never hit.
- The confirm-delete token design: minted server-side, bound to `(table, row_id)` at mint time, single-use, and consumed before the delete so it fails closed.
- `reconcileBuddyReceipts` rebuilds receipts from authoritative tool output and only borrows the model's wording, so a green chip cannot appear for a change that did not happen.
- The optimistic-mutation bookkeeping in `RestTodayView` (per-task revision counters, confirmed-task refs) is careful, correct concurrency work and the reason a slow PATCH never resurrects stale rows.
- No UI test framework: behaviour is tested by extracting pure functions into `presentation.ts`. That is why 380 tests run in four seconds, and it is the right call for this maintainer.
- The comments that explain *why* rather than *what* are genuinely good, and they are the standard the rest of the codebase should be held to: the `MAX_SAFE_INTEGER`-not-`Infinity` note, the ordering-by-request-time-not-finish-time rationale, the no-hot-swap gate, and `BriefProgress` dropping `aria-valuenow` once its estimate is overrun.
