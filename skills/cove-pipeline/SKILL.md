---
name: cove-pipeline
description: >-
  Read and manage the local Cove sales pipeline for Edge AI consulting. Use
  when the user asks for a pipeline review, head of sales report, lead status,
  follow-up plan, overdue leads, client MRR, or asks to add, move, or log a
  touch with a consulting lead.
---

# Cove pipeline

Use `http://localhost:3200/api/crm` to keep Edge AI consulting leads current.
This is local-runtime functionality. Read `NEXT_PUBLIC_COVE_RUNTIME` from
`.env.local` first and stop if it is not `local`. Never use the generic Cove
REST table endpoint for pipeline data.

Before calling the API, confirm `.env.local` contains both
`COVE_SALES_PIPELINE=1` and `NEXT_PUBLIC_COVE_SALES_PIPELINE=1`. If either is
missing, or the API returns `sales_pipeline_disabled`, print exactly:
`Sales pipeline is off. Add COVE_SALES_PIPELINE=1 and NEXT_PUBLIC_COVE_SALES_PIPELINE=1 to .env.local and rebuild.`

## Pipeline stages

Use these stages in this order:

- `reach_out`: A specific person Alex intends to contact.
- `keep_warm`: A relationship worth maintaining without an active sale now.
- `interested`: They have shown real interest and need a concrete next step.
- `call_scheduled`: A sales call is on the calendar.
- `pitched`: The offer was discussed and they are deciding.
- `discovery_ready`: They are ready to book paid discovery.
- `discovery_booked`: Paid discovery is booked.
- `proposal`: A proposal is in their hands.
- `client`: They are an active client. Monthly value is real MRR here.
- `lost`: The opportunity ended.
- `parked`: The opportunity is intentionally paused.

Every open lead, meaning every stage except `client`, `lost`, and `parked`,
must have a specific next action and a follow-up date.

## The CRM door

Start with a read. It returns the current board and the CSRF token required for
every write:

```bash
curl -s 'http://localhost:3200/api/crm?operation=pipeline'
```

Send the returned `csrfToken` as `X-Cove-CSRF` on every POST. Never write
directly to SQLite.

If `COVE_DAY_PLAN_ACCESS_MODE=session` is set, every request also needs the
`X-Cove-Day-Plan-Session` header with the configured session token.

## Read and report the board

Read `operation=pipeline`. The response contains `deals`, ordered `stages`,
`summary`, `attention`, and the operator-local `today` date.

Give a short head of sales report in this order:

1. Client MRR and open lead count.
2. Overdue follow-ups, oldest due first, with the exact next action.
3. Leads that can move this week, especially calls, pitches, discovery, and proposals.
4. Keep-warm leads with missing or overdue follow-ups, then those with the oldest touch.

State missing information plainly. Do not turn an expected monthly value into
real MRR. Only `client` monthly value counts as MRR.

## Add a lead

Resolve the person before adding a deal:

```bash
curl -s -X POST 'http://localhost:3200/api/crm' \
  -H 'Content-Type: application/json' \
  -H 'X-Cove-CSRF: <token from the pipeline GET>' \
  -d '{"action":"resolve","input":{"name":"Sarah Chen","email":"sarah@example.com","source":"manual"}}'
```

Use the contact from a `matched` or `created` result. If the result is
`ambiguous`, show the candidates and ask the user to choose. Never guess and
never create another person to avoid the ambiguity.

Then add the deal. Patch fields are `monthlyValue`, `discoveryPrice`,
`nextAction`, `nextFollowUpAt`, `source`, and `notes`. Dates are calendar dates
in `YYYY-MM-DD` form.

The API also accepts `monthly_value`, `discovery_price`, `next_action`, and
`next_follow_up_at`. Use either camel case or snake case for a field, never
both spellings in the same request. Touch inputs likewise accept
`activity_type`, `next_action`, and `next_follow_up_at`.

```bash
curl -s -X POST 'http://localhost:3200/api/crm' \
  -H 'Content-Type: application/json' \
  -H 'X-Cove-CSRF: <token from the pipeline GET>' \
  -d '{"action":"pipeline_upsert","input":{"contactId":"<contact id>","stage":"interested","patch":{"monthlyValue":5000,"discoveryPrice":1000,"nextAction":"Send the discovery outline","nextFollowUpAt":"2026-09-04","source":"Zac Bright"}}}'
```

For an existing deal, omit `stage` and update only the stated patch fields.
Use `pipeline_move` for a stage change.

## Log a touch

Use `pipeline_log_touch` for a call, email, text, meeting, or note. Always set
the next action and follow-up date in the same call. Add `stage` only when the
touch genuinely changed the deal stage.

```bash
curl -s -X POST 'http://localhost:3200/api/crm' \
  -H 'Content-Type: application/json' \
  -H 'X-Cove-CSRF: <token from the pipeline GET>' \
  -d '{"action":"pipeline_log_touch","input":{"contactId":"<contact id>","activityType":"call","title":"Discovery call with Sarah","content":"She wants an operating review for the sales team.","nextAction":"Send discovery scope and payment link","nextFollowUpAt":"2026-09-03","stage":"discovery_ready"}}'
```

Record only what happened and what was agreed. Do not invent sentiment,
budget, timing, referrals, or commitments.

## Move a stage

Use a move when no new interaction needs to be logged:

```bash
curl -s -X POST 'http://localhost:3200/api/crm' \
  -H 'Content-Type: application/json' \
  -H 'X-Cove-CSRF: <token from the pipeline GET>' \
  -d '{"action":"pipeline_move","input":{"contactId":"<contact id>","stage":"proposal","note":"Proposal sent after Alex approved it."}}'
```

Never call `pipeline_remove`. Move an ended opportunity to `lost` or an
intentional pause to `parked` so its history stays visible.

Sales next steps belong in this pipeline. Create a Cove board task only when
the user explicitly asks for a task or reminder in addition to the pipeline
follow-up.

## Reply

Confirm the exact pipeline change in one or two plain sentences. For reports,
lead with the number that matters and the overdue action. Never use an em dash.
