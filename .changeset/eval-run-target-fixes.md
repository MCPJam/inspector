---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Finish the run-target receipt, and stop deciding admission on prose.

A FAILED ENVIRONMENT TARGET now says which environment it was. Only host targets
were carried onto failed entries, so a fan-out across environments reported
`Failed: target` — a receipt that names no target cannot tell you what to retry,
which is the whole reason it is discriminated rather than a bag of optional
fields. Attached environments also gain their names from a single listing, which
the `TARGET_REQUIRED` refusal needed just as badly: it was offering ids to choose
between, not the names anyone knows them by.

COMPOSING NO LONGER WRITES BEFORE THE REQUEST IS KNOWN TO BE GOOD. A mistyped
case name used to leave an ad-hoc environment created and attached to the suite
for a run that never started, with an error mentioning neither write. Reads that
can reject a request now happen while rejecting is still free. The report of
what compose persisted also reaches non-API failures — a dropped connection
persists the same two writes — and rides structured `details` rather than prose
alone, annotated in place so an abort stays an abort for callers matching on it.
The approval line for a composed proposal says the suite's environment list
changes, because approving one authorises that edit.

HARNESS REFUSALS CARRY A STRUCTURED `kind` instead of being recognised by their
own wording. Eval admission runs the shared gate twice — once from the host
config alone, before the run's per-case models are known — and told a model
refusal from a host-level one by matching the message text. Rephrasing a
user-facing sentence could therefore change which runs are admitted, silently.

The batch dry run also passes the environment's PINNED COMPUTER IMAGE, which it
had already resolved. The gate distinguishes "no pin" from "nobody looked", and
the dry run was reporting the second when it knew the first.

Also: `readJsonObjectBody` moves to the v1 adapter beside `synthesizeServerBody`
— the two are a pair, and the difference between them (whether a strict schema
can see the caller's fields) now has one explanation instead of a copy per
route; the suite-environment attach body is strict for the same reason the
grouped-launch body is; a 404 is blamed on the server's version only when it is
a route miss, not when the live route reports a deleted suite; the environments
route header no longer claims every write needs ADMIN when creating does not;
and the CLI reference documents `environments ensure-adhoc` and
`environments name`, which shipped with no documentation at all.
