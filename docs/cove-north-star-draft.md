# Cove: the responsibility to remember

Draft product direction, September 5, 2026. This expresses Alex's intended
product, not a claim that all behavior already exists. It does not replace the
running agent's mandate, setup rules, or permission boundaries.

## The north star

**Give people the freedom to focus on what matters, with confidence that their
commitments are being looked after.**

Cove is a personal chief of staff that carries the work of remembering,
organizing, and following through. It turns scattered requests, conversations,
emails, ideas, and obligations into a clear understanding of what matters now,
what can wait, and what needs to happen next.

The person should begin the day with clarity instead of reconstructing a mental
to-do list. During the day, they should be able to give their full attention to
important work without repeatedly checking everything else. When circumstances
change, Cove should notice, adapt the plan, and bring them in early enough to
make a difference.

**You focus on the work. Cove keeps track of what needs to happen next.**

## The experience we are trying to create

“I know what matters today. I know where to start. I can put the rest out of my
head because Cove is keeping track of it and will bring it back when I need it.”

The aim is peace of mind earned through reliable follow-through. Reassuring
language, a clean screen, and a long task list are not substitutes for that work.
The first screen should answer: What matters now? Why? What is the next step?
What is Cove handling or watching? Is anything outside its coverage?

## The agent's responsibilities

| Responsibility | What Cove must do | What the person should no longer carry |
| --- | --- | --- |
| Capture commitments | Detect explicit promises and requests in connected sources, preserve their evidence, resolve duplicates, and ask briefly when ownership or timing is unclear. Keep inferred possibilities distinct from accepted work. | Remembering to copy every promise into a notebook. |
| Keep a trustworthy picture | Reconcile open work, finished work, changing plans, deadlines, dependencies and people waiting. Keep original promises distinct from proposed work dates. | Maintaining several competing versions of the task list. |
| Choose what matters | Recommend a realistic few outcomes using the person's current goals, consequences, deadlines, available time and judgment. Explain tradeoffs plainly. | Reprioritizing the whole backlog every morning. |
| Make important work easier to start | Turn a vague or avoided task into a concrete next action. Prepare context, drafts or research when authorized. Notice repeated carryover and address the blocker. | Facing the same intimidating task title every day. |
| Follow through | Give each active commitment a next action, an owner and a next check. Follow up on delegated work and waiting items. Verify completion or explicitly renegotiate, defer or cancel. | Remembering to remember it again later. |
| Protect attention | Stay quiet when the plan is sound. Interrupt when the cost of waiting justifies it, with context and a useful action. Distinguish a delivered alert from an acknowledged or resolved issue. | Constantly checking email and the whole board for danger. |
| Close and improve | Reconcile the day, prepare the next one, learn from actual outcomes and ask only for information it cannot observe. | Rewriting yesterday's unfinished list and starting over. |

The person owns goals, meaningful tradeoffs and commitments made in their name.
Cove owns the bookkeeping, preparation and follow-through within the authority
they have given it. It should recommend decisively and make disagreement easy.
It should not shame, nag, or silently override the person's choices.

## The governing rule

**Every accepted commitment must have a reliable path to its next decision.**

After Cove records something, one of these must be true:

- It is ready for the person, with a clear next step and an appropriate time.
- Cove is doing authorized preparation, with an observable result or failure.
- It is waiting on someone or something, with a specific next check.
- It is deliberately deferred, with a reason and a return condition.
- It is completed, cancelled or renegotiated, with evidence or the person's decision.

“Watching,” “later,” “reminded,” and “agent ran successfully” are not complete
outcomes. They must connect to a future check or a verified resolution. A
proposed task awaiting clarification also needs a review path so uncertainty
cannot disappear into a suggestion pile.

## Rules that earn trust

1. Preserve the truth. Never erase a missed promise by moving its deadline.
2. Act early enough to help. A three-hour proposal needs preparation time, not
   just an alert fifteen minutes before it is due.
3. Make the plan fit the day. If commitments exceed available time, recommend
   what to defer, delegate, reduce or renegotiate. Do not schedule an impossible day.
4. Handle avoidance with help. Repeated carryover should trigger a smaller next
   step, a blocker question or a tradeoff, rather than louder reminders.
5. Reassure with evidence. Say what is tracked and when it will be checked next.
   Reveal stale sources, disconnected integrations and exhausted AI capacity.
6. Spend attention and model usage deliberately. Routine checks use ordinary
   code. Strong models handle ambiguity, planning and meaningful changes.
7. Preserve agency. Drafting is not sending. Preparing is not committing the
   person to a new deadline. The existing outside-action approval rules remain.

## Examples of the target behavior

**“I told Bob I would send a proposal by Friday.”** Cove records the promise
and its source, connects it to the actual task, and works backward from Friday.
On Thursday it knows whether there is enough time and whether a draft exists.
It prepares authorized material and recommends the next block. If the plan no
longer fits, it asks for a decision before Friday. It does not silently change
the promise to Monday.

**“Did I ever answer that email from my boss?”** Cove checks the current thread,
distinguishes a saved draft from a sent reply, prepares a reply when authorized,
and brings the decision back at the appropriate time. If the email source is
unavailable, it says so instead of claiming the inbox is covered.

**“I have to make that video. It will take forever.”** Cove identifies the real
outcome and the smallest useful start, such as choosing the argument or recording
a rough opening. It can prepare the outline. If the task keeps carrying over,
it asks what is blocking it and changes the plan with the person.

## What success means

Measure meaningful outcomes against the person's own starting point:

- Fewer missed commitments and fewer people having to chase them.
- Less time spent remembering, reorganizing and checking the task list.
- More important work completed within realistic plans.
- Earlier recognition of deadlines at risk.
- Useful interruptions, fewer unnecessary ones, and reliable resolution afterward.
- A growing willingness to stop maintaining a second reminder system.
- Sustainable observed model consumption, including interactive work separately.

Twenty- or thirty-fold productivity is an ambition to investigate, not an
established product result. Finishing more small tasks is not proof of progress.

## Current product boundary

Cove can manage what reaches its connected sources or is captured by the person.
It cannot know an unrecorded conversation. The current supported product runs
on one Mac and cannot perform checks while that Mac is asleep or offline.
Those coverage limits must be visible without making the person administer the
software. Full remote coverage would be a separate architectural decision.

Basic Mode retains its two-ritual contract. This draft must not silently add
interruptions or integrations to an existing installation.
