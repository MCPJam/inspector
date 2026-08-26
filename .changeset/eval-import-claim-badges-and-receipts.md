---
"@mcpjam/inspector": minor
---

evals UI: an imported case says what it claims, and a run says who approved what

A converted case looked identical to a hand-authored one on every screen, and a
run that took an approximation on somebody's say-so said nothing about whose.

**Case badges.** The overview and the case sidebar show one compact badge per
imported case, from one shared component so all three surfaces say the same
words. `exact` renders as **"claimed exact"** and is styled NEUTRALLY — a green
tick beside a claim nobody checked would read as an MCPJam guarantee, and
people would stop reading the note that explains what the claim actually rests
on. `approximated` is cautionary, `unsupported` and `unresolved` are blockers
scoped to the case rather than to the suite, and a native case gets no badge at
all. Nothing anywhere calls a claim "verified" or "accepted".

**The mapping note, read-only.** The case editor shows the converter's cited
rule and source-case key beside the claim, and does not let anyone edit them —
rewriting the justification for a claim without changing the claim is the one
edit that makes the record actively misleading.

**Frozen run evidence.** Run detail fetches the canonical single-run projection
for the run it is showing, rather than reading the run-list row it is handed
(which carries no eligibility) or walking the suite's current cases (which get
edited after runs finish). It renders each approved approximation's frozen
actor, timestamp, reason and source case — all written by the server at launch,
never the current viewer — and describes incomplete evidence as **"not
gateable"** rather than as a failure, because the run has not said the server
regressed, it has said its own evidence cannot be relied on.

Docs follow the same line: the import skill no longer claims disabled cases go
unsynced or that the API drops per-case claims, and the CLI reference documents
`eval validate --project`, the mandatory pre-sync resolution on every file run,
the per-run approval flags, and `eval gate`'s exit 3 for incomplete import
evidence.
