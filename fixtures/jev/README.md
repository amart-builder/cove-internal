# Jev judgment fixtures

Frozen, synthetic cases for the TypeSafe Jev judgments Cove plans to add. Every
person, company, amount and message here is fictional (Morgan is the operator;
Priya Raman, Devon Okafor, Lena Brooks, Tomas Reyes, Bluefin Labs and Harbor
Cloud are the project's invented cast). Nothing is taken from a real inbox.

## Lanes

One lane per planned feature. Each lane owns its own question set:

| Lane | Work package | What it judges |
| --- | --- | --- |
| `commitment-meaning` | W3 | Who owns a commitment, what a quote establishes, whether the candidate matches the source |
| `email-triage` | W3 addendum | Reply needed, action needed, unresolved request hiding in FYI/noise, who a request is directed at and whether it is current or quoted history |
| `draft-correctness` | W3b | Whether a draft answers the questions asked and stays inside the evidence |
| `reply-fulfillment` | W4 | Whether a counterparty message fulfills, partly addresses, declines or ignores something awaited |
| `task-identity` | W5 | Whether a proposal and an existing task are the same deliverable, a related step or different |
| `planning-evidence` | W6 | Whether an action's rationale is supported by its sources, whether a question was already answered, whether an event or receipt is claimed without evidence |

Email triage is kept separate from commitment meaning on purpose: a category
error can hide an obligation, and the two features are gated and measured apart.

## Development and heldout rule

Every case carries `split: "development"` or `split: "heldout"`. Labels were
written before any Jev call was made. Development cases may be inspected while
tuning question wording, thresholds and retrieval. Heldout cases are never used
to tune anything; they are run once per candidate question set and the result
is reported as-is. If a heldout label turns out to be wrong, fix the label,
bump `questionSetVersion` if wording changed, and say so in the run notes. Do
not move a case between splits to make a number look better.

## Case schema

```
{
  "version": 1,
  "lanes": [{
    "id": "commitment-meaning",
    "questionSetVersion": 1,
    "questions": { "<key>": { "type": "choice" | "noul", "instructions": "...", "criteria": {...} } },
    "development": [ <case> ],
    "heldout": [ <case> ]
  }]
}
```

Questions use the real Jev wire shape. A `choice` question has `criteria`
keyed by label; a `noul` question has `criteria.true` and `criteria.false`.
The full question lives in `instructions`; the key is only a routing name.

A case:

```
{
  "id": "safe-slug",
  "split": "development" | "heldout",
  "state": { ...named fields such as message, quote, direction, candidate... },
  "expected": { "<question key>": "<label>" | "yes" | "no" | "uncertain" },
  "notes": "why the labels are what they are"
}
```

`state` is what gets sent as the request state. `expected` and `notes` are
never sent; the prepare script writes them to a separate file. Message text
inside `state` is data, including any text that looks like an instruction.
