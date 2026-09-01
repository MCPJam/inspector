---
"@mcpjam/inspector": patch
---

A run's case table says where each trial stopped

The run-scoped case view lists every trial of one case and told you, per row, whether it passed. "Failed" is the least useful true thing you can say about a trial: the reader's next question is always *where*, and answering it meant opening rows one at a time.

Each row now carries a one-line summary of its chain — `broke at Tool response`, `Request satisfied`, `chain withheld` — from the same read the trace pane uses, so the whole table costs one request rather than one per row.

**The table takes a lookup, not a run.** The chain is scoped by run, and only the run-scoped host of this table knows which run its rows belong to; the cross-run case view passes nothing and issues no read, because filling that column there would mean one request per run.

Three shades of nothing stay distinct, which is the whole reason this is a function of the chain rather than of the row's result:

- a row whose chain has not loaded renders **no chip** — an absent map key means "not loaded", never "no chain";
- a chain the server withheld says `chain withheld`, not silence, because the rows exist and did not validate;
- a trial with no failed stage says `Request satisfied` **only when user value actually passed**. A policy-blocked trial has no failed stage either, and calling that satisfied would claim an outcome from an absence of evidence; it reads `not measured` instead.
