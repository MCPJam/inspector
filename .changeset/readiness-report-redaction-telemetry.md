---
"@mcpjam/inspector": patch
---

Directory readiness: redact the stored report, and instrument the run

Two things a readiness run needed before any surface reads its output.

**The report is redacted on the way into storage.** A readiness report is a
debugging artifact — findings carry the raw observation behind each verdict,
which is how a submitter learns why a lane failed. That is the right default
inside the process that produced it and the wrong one for a blob that outlives
the run and gets read back by surfaces that did not exist when it was written;
`DirectoryReadinessFinding.details` already documents itself as redacted before
it travels, and the stored path was the one place that promise was not kept.

It goes through `redactConformanceReportForSharing` — both layers, because the
key-name pass alone is a blocklist and a blocklist eventually misses the shape
a future check introduces. Redaction is structure-preserving, so lanes,
coverage and remediation survive.

This is defense in depth, not a breach fix: the report route is
project-authorized and was never public, and no check shipping today writes a
credential into a finding. That last fact is the argument rather than the
counter-argument — the guarantee has to exist before the check that first
records a request, not after.

One accepted cost, pinned in a test so it stays a decision: the redactor
scrubs whatever follows a `Bearer ` scheme, which is right for an
`Authorization` header and also catches the parameter name of a
`WWW-Authenticate` challenge (`Bearer realm="x"` → `Bearer [REDACTED]"x"`).
The parameter value survives. Teaching a shared security utility to recognise
one header narrows a rule that currently errs safe, which deserves its own
review.

**Runs are instrumented at both ends.** A start event from the v1 route — the
one place a hosted run is created, so it covers every surface that starts one
— and a terminal event from the detached worker, attributed through a new
`captureServerEventForActor` to the identity resolved while the request still
existed. The terminal event is emitted from a `finally`, so an abandoned lease
counts as an outcome rather than as missing data.

The three axes are reported separately, because collapsing them is the
misreading the product exists to prevent: whether the run finished, what it
graded, and whether the optional paid pass ran are three different answers. No
report contents and no target URL are ever sent.
