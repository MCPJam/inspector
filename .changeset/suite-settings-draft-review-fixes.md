---
"@mcpjam/inspector": patch
---

A save reports what it actually wrote, and typing survives an edit landing elsewhere

Three follow-ups from review of the draft-and-commit settings sheet. The
first two lose an edit.

**A field the save could not carry was marked saved anyway.** On a
deployment that predates the composite mutation, the fallback drops settings
the older mutation does not declare — a judge rubric today — and its toast
says so. But the commit still reported a clean save, so the draft rebased
every dirty key, including the one that never travelled. The rubric stopped
being an unsaved change and there was nothing left to retry. The commit now
names the keys it dropped and the draft keeps them dirty, which is what the
toast was already promising.

**An in-flight save landed on the suite you switched to.** Rebasing a live
suite already ignores a result that belongs to a different suite; the
matching commit path did not check, so a mutation started on suite A and
resolved after the person opened suite B wrote A's values into B's draft.
Both paths now carry the suite the save was started for.

**The accuracy field was pulled out from under someone typing.** Following
the prop is what stops the input from displaying a number the draft no
longer holds, but the guard could not tell a live edit from a settled one,
so a colleague's save or a discard elsewhere replaced half-typed text.
Typing now wins until it is committed or abandoned — and Escape genuinely
abandons it, where before the blur it triggered committed the value it was
meant to throw away.
