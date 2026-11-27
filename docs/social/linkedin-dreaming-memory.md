# LinkedIn — "We dream, but we don't forget" (non-technical)

**Channel:** LinkedIn (Igor, personal)
**Audience:** general / non-technical — broad LinkedIn feed riding the OpenAI "dreaming" news
**Status:** ready
**Pairs with animation:** `docs/animations/dreaming_memory_simple.py` (scene `DreamingMemorySimple`) — the card-based, non-technical cut
**Technical sibling (different audience):** `docs/animations/dreaming_memory.py` (`DreamingMemory`) + the three technical posts in this thread
**Grounded in:** change-point supersession (`supersede, not delete`); the `RECURRENCE_DROP`-deleted-a-one-off war story (HANDOFF-IG-features-2026-06-04 / lecture Chapter 3)
**Confidentiality:** clean — LongMemEval-adjacent + invented Singapore example only; no al-futaim.

---

## Post

OpenAI introduced a new "dreaming" capability this week.

A simple example:

Instead of remembering that "you're going to Singapore in July," AI can later update that memory to "you went to Singapore."

That sounds small, but it's actually a big deal.

One of the hardest problems in AI memory is that people change.

You change jobs.
You move.
Your priorities shift.
Projects start and finish.

If AI keeps every fact forever, it quickly becomes outdated.

We built a similar capability, but with a different philosophy.

When new information clearly replaces old information, we mark the old memory as historical rather than current.

The important part:

→ We don't delete the old memory.

→ We can explain why the memory changed.

→ Everything runs locally on your machine.

We learned this lesson the hard way.

An early version automatically removed outdated memories. Then one day a user asked about something that had been "replaced" a week earlier—and suddenly that old information mattered again.

So we changed the approach.

The AI can update what it believes is current, but it shouldn't erase the past.

Memory that stays up to date is becoming standard.

Memory that stays up to date, remains reversible, and stays under your control is where things get really interesting.

We dream, but we don't forget.

---

## Posting notes

- Lead the post with the **native video** (the card-based animation) — LinkedIn weights native video + a strong opening line.
- First comment (not the body) is the place for any link: "building this in the open at anthillnet.com".
- The closer ("We dream, but we don't forget") matches the animation's final card — they reinforce each other; keep them identical.
