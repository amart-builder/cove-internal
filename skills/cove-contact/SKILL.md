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

## The three tables

All through the local REST API, no auth:

- `contacts`: id, company_id, name, email, phone, role, linkedin, location,
  how_we_met, tier (A/B/C), tags (array), notes, last_interaction_at.
- `companies`: id, name, domain, website, industry, location, tags, notes.
- `contact_activities`: id, contact_id, company_id, activity_type
  (note | call | meeting | email), title, content, direction, created_at.

## Capturing a person

1. **Never create a duplicate.** Check first, by email if you have one, else by
   name:
   ```bash
   curl -s 'http://localhost:3200/api/forge-rest/contacts?name=ilike.*sarah*&select=id,name,email,company_id'
   ```
   If they exist, PATCH the new facts onto the existing row instead.
2. **Resolve the company.** If a company is mentioned, look it up in
   `companies` the same way; create it if new (name is enough, add domain or
   industry only if the user said them).
3. **Create the contact** with only what the user actually said. Do not invent
   emails, roles, or spellings. `how_we_met` is gold; capture it whenever the
   user says where or how they met ("chamber event", "Brian's roofer").
4. **If an interaction just happened** ("met her today", "great call with"),
   also log an activity (step below) and set `last_interaction_at` to now.

## Logging an interaction

Find the contact, then:

```bash
curl -s -X POST 'http://localhost:3200/api/forge-rest/contact_activities' \
  -H 'Content-Type: application/json' \
  -d '{"contact_id":"<id>","activity_type":"call","title":"<one line>","content":"<what happened, what was agreed>"}'
```

Then PATCH the contact's `last_interaction_at` to now. The list in the CRM tab
sorts by it, so this is what keeps the CRM honest.

## Follow-ups

If the user implies a next step ("follow up Friday", "send him the proposal"),
also create the task by following the cove-task skill: task on the board, due
date, reminder. One capture, both systems updated.

## Answering questions

"Who is Dana?" or "when did I last talk to Steve?": GET the contact, their
company, and their activities (newest first), then answer in two or three plain
sentences: who they are, the relationship context (how_we_met, notes), and the
last interaction with its date. If nobody matches, say so and offer to add
them.

## Importing existing contacts

When the user hands over a CSV or contacts export: read it, map the obvious
columns (name, email, phone, company, notes), skip rows with no name, dedupe by
email against what is already in Cove, then POST the rest one by one. Create
companies as you meet them. Report back plainly: how many imported, how many
skipped as duplicates or unusable. For big files, confirm the column mapping
with the user on the first few rows before running the lot.

## Reply

One warm, plain sentence: what you saved and where it links.

- *"Saved Sarah Chen (Chen Plumbing) to your CRM with a note about the chamber
  event, and set a follow-up for Friday."*
- *"Logged the call with Mike and moved his last-contact date to today."*

Never use an em dash. Facts the user did not say never go in the record.
