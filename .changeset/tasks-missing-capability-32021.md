---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Recognize `-32021` as the tasks extension's Missing Required Client Capability
code, not the pre-renumber `-32003`.

`mcp-error-codes.ts` has recorded the right values since the 2026-07-28
renumber: `MissingRequiredClientCapability` is `-32021`, and `-32003` sits in
`PRE_RENUMBER_DRAFT_ERROR_CODES` under a comment saying those are "NOT final
wire codes". Two places never got the memo and kept `-32003` as a literal:
`TASKS_DECLARATION_REQUIRED_ERROR_CODE` in the client manager, and the tasks
conformance runner's own copy of the constant. Both now read from the central
table, so the next renumber is a one-line change in one file.

The conformance consequence was a false verdict in both directions. A server
answering the canonical `-32021` failed `tasks-undeclared-capability-rejected`,
and one still answering the obsolete `-32003` passed it — on the check whose
whole job is to prove the server refuses undeclared task work. The core suite
already asserted `-32021` in `modern-undeclared-capability-error`, so the two
conformance modules were grading the same requirement against different codes.

ext-tasks made this change in `c523f2c`, for the reasons the commit gives:
SEP-2663 uses `-32021` throughout, the core 2026-07-28 schema defines
`MissingRequiredClientCapabilityError` as `-32021`, and `-32003` appears in no
core schema version. The extension's root `index.md` still shows `-32003` and is
stale; `specification/draft/tasks.md` is authoritative.

A server that still emits `-32003` now fails — it does not conform — but it is
told which draft it is running rather than being reported as an anonymous wrong
code, so the fix is one line for whoever reads the report. The same naming
applies to the `tasks-undeclared-creation-refused` warning, which stays a pass
because no task reached a non-declaring client.
