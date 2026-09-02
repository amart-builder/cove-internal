---
name: cove-contact
description: >-
  Capture people and companies into the local Cove CRM from natural language,
  log calls and meetings, and answer questions from it. Use when the user
  mentions meeting someone, wants to remember a person or company, or asks
  about one, including "met Sarah at the event", "add John to my CRM", "log a
  call with Mike", "who is Dana?", "when did I last talk to Steve?", or hands
  over a contacts export to import.
---

# Cove contact capture

Turn what the user tells you about a person into a clean record in the local
Cove CRM at `http://localhost:3200`, and answer questions back out of it.
Confirm in one short, human sentence when done.

## The CRM door

Read `NEXT_PUBLIC_COVE_RUNTIME` from `.env.local` before choosing the data
path. In `local` mode, all contact and relationship-history reads and writes go
through `http://localhost:3200/api/crm`. Never call the generic table endpoint
for `contacts` or `contact_activities` in local mode. In `supabase` or `convex`
mode, keep using that install's existing CRM path; the local interface must
never split a cloud install across two stores.

For a non-local install, retain the pre-existing generic endpoints:
`/api/cove-rest/contacts` and `/api/cove-rest/contact_activities`. The local
`/api/crm` examples below apply only when runtime mode is `local`.

Reads return a `csrfToken`. Send that token as `X-Cove-CSRF` on every POST.
The CRM resolves identity before creating a person:

```bash
curl -s 'http://localhost:3200/api/crm?operation=list&search=sarah'
```

## Capturing a person

1. **Never create a duplicate.** Ask the CRM to resolve or create. It checks
   email first, then a normalized full name:
   ```bash
   curl -s -X POST 'http://localhost:3200/api/crm' \
     -H 'Content-Type: application/json' \
     -H 'X-Cove-CSRF: <token from a CRM GET>' \
     -d '{"action":"resolve","input":{"name":"Sarah Chen","email":"sarah@example.com","source":"manual"}}'
   ```
   A `matched` or `created` result contains the contact. An `ambiguous` result
   contains candidates. Never pick one or create another record when the
   result is ambiguous. Tell the user which matches need clarification.
   On `matched`, send every newly stated fact to the `update` action for that
   contact. PATCH role changes, a newly learned email, phone, company, notes,
   or other stated facts instead of silently dropping them:
   ```bash
   curl -s -X POST 'http://localhost:3200/api/crm' \
     -H 'Content-Type: application/json' \
     -H 'X-Cove-CSRF: <token from a CRM GET>' \
     -d '{"action":"update","input":{"contactId":"<matched id>","patch":{"role":"<new role>","email":"<new email>","phone":"<new phone>"}}}'
   ```
2. **Resolve the company.** Company CRUD still uses the local
   `/api/cove-rest/companies` endpoint. Look it up first and create only when
   it is new. Reuse the `csrfToken` returned by the CRM GET for the mutation:
   ```bash
   curl -s -X POST 'http://localhost:3200/api/cove-rest/companies' \
     -H 'Content-Type: application/json' \
     -H 'X-Cove-CSRF: <token from a CRM GET>' \
     -d '{"name":"Chen Plumbing"}'
   ```
3. **Save only stated facts.** Do not invent emails, roles, or spellings.
   `howWeMet` is gold; capture it whenever the user says where or how they met
   ("chamber event", "Brian's roofer").
4. **If an interaction just happened** ("met her today", "great call with"),
   also log an activity (step below) and set `last_interaction_at` to now.

## Logging an interaction

Find the contact, then:

```bash
curl -s -X POST 'http://localhost:3200/api/crm' \
  -H 'Content-Type: application/json' \
  -H 'X-Cove-CSRF: <token from a CRM GET>' \
  -d '{"action":"append_activity","input":{"contactId":"<id>","activityType":"call","title":"<one line>","content":"<what happened, what was agreed>","source":"manual"}}'
```

Appending the activity updates the contact's last-interaction time in the same
transaction.

## Follow-ups

Sales next steps belong in the Cove pipeline. Follow the cove-pipeline skill to
save the next action and follow-up date with the lead. Create a Cove board task
only when the user explicitly asks for a task or reminder in addition to the
pipeline follow-up.

## Answering questions

"Who is Dana?" or "when did I last talk to Steve?": search with
`GET /api/crm?operation=list&search=dana`, then fetch the selected full record
with `GET /api/crm?operation=get&id=<id>&limit=20`. Answer in two or three
plain sentences: who they are, the relationship context, and the last
interaction with its date. If nobody matches, say so and offer to add them.

## Importing existing contacts

When the user hands over a CSV or contacts export: read it, map the obvious
columns (name, email, phone, company, notes), skip rows with no name, then send
each row through the `resolve` action with source `manual`. On `matched`, update
the matched contact with new stated facts. Count `created`, `matched`,
`ambiguous`, and unusable rows separately. Never turn an ambiguous import row
into a new contact. Create companies as you meet them. For big files, confirm
the column mapping with the user on the first few rows before running the lot.

## Reply

One warm, plain sentence: what you saved and where it links.

- *"Saved Sarah Chen (Chen Plumbing) to your CRM with a note about the chamber
  event, and set a follow-up for Friday."*
- *"Logged the call with Mike and moved his last-contact date to today."*

Never use an em dash. Facts the user did not say never go in the record.
