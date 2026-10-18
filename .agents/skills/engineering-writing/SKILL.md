---
name: engineering-writing
description: Write or edit engineering prose in MCPJam (specs, plans, decision entries, review pages, PR bodies, session summaries) so a reader who was not there can act on it. Use whenever you author or revise that prose, including inside the eng flow. Not for user-facing product copy; that is the ui-copy skill.
---

# Engineering writing

This skill is maintained in this repository. The reader is
an engineer or reviewer who missed the conversation and has a few minutes.

## Rules

1. **Lead with the point.** The first sentence of a section states the
   decision, the result or the ask. Background follows, if it is needed.
2. **Say what is true now.** Describe the system and the decision as they
   stand. How the work got here belongs in the decision log or the commit
   message, not in a spec or a code comment.
3. **Be concrete.** Name the file, function, table, endpoint, flag, number or
   persona. "Improves reliability" says nothing; "retries the upload three
   times and then queues it" does.
4. **One claim per sentence.** Short sentences, active voice, the actor named:
   "the Stop hook queues the record", not "the record is queued".
5. **Separate fact, decision and guess.** Mark what you verified, what someone
   decided (and who), and what you expect but have not checked.
6. **Keep the summary to a screen.** Link detail instead of cutting a
   consequential decision.
7. **Label diagrams** current, proposed or implemented, and each arrow with
   what crosses it.
8. **No filler.** Cut "leverage", "seamless", "robust", "it is worth noting",
   "in order to", and any sentence that restates the heading.

## What not to touch

Never reword literal commands, code, test output, error messages, log lines
or quotations from people. Quote them exactly, in code formatting or quote
marks, and put your commentary outside them.

## Check before you post

- Can a reviewer act on the first sentence of each section alone?
- Is every "we", "it" and "this" unambiguous?
- Does every number have a unit and a source?
- Did any literal command, result or quotation change? Restore it.
