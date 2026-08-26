---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

evals: an imported case carries its converter's claim, and an approximation is approved per run

A suite converted from another eval framework used to arrive at MCPJam with
its provenance stripped somewhere between the file and the hosted row, and a
converted case ran exactly like a hand-authored one. Both are now false.

**The claim travels.** Each case may carry `import: {status, sourceCaseKey?,
note?}` with the four statuses the platform already stores, and it now survives
file → SDK → REST → hosted case → run snapshot → read. The suite-file schema
gains the bounds the platform enforces (512-character `sourceCaseKey`,
2000-character `note`) and the rule that earns an `exact` claim: a non-empty
note citing the mapping rule. Both generated JSON-Schema artifacts are
regenerated from the zod source.

`exact` means CONVERTER-CLAIMED exact throughout — the converter says it
applied a structural rule, and MCPJam has verified nothing. It is never
"verified" or "accepted", in a type, a message, or a screen.

**The public API accepts the claim and only the claim.** Create and batch-create
take `import`; PATCH takes `import | null`, where omitted leaves the stored
claim and `null` removes it. Reads project the three claim fields by name, so
the acceptance bookkeeping stored beside them on the row is never published.
An approval or internal key in a case body is a 400, not a silently-stripped
field. `INVALID_IMPORT` joins the documented batch failure enum, which the
runtime has been returning all along.

**A file-owned run resolves its tool names before it writes anything.** One
shared check backs both `eval validate --project` and every `eval run --file`.
It reads `toolCall` steps only — prompt text that mentions a tool is a hint,
and an assertion about a tool is an expectation that may legitimately fail at
run time — and it checks per target rather than over their union, because a
union green-lights a case that fails on two targets out of three. A selected
case whose reference does not resolve refuses the launch before the suite is
synced; an unselected imported one has its claim rewritten to `unresolved`
(keeping `sourceCaseKey`) and is still persisted, because a disabled row keeps
its hosted history. A native case never acquires provenance it was not authored
with. `eval validate` without `--project` stays exactly as it was: no auth, no
network, same envelope and same exit codes.

**An approximation is approved for a run, never accepted for a case.**
`cloud eval run --file` gains repeatable `--allow-approximated <case>` and
`--approval-reason <text>`, checked against the cases the run will actually
execute before anything is billed: a native, exact, unsupported, unresolved,
disabled, unselected, unknown or duplicated selector refuses. Approved authored
ids map to hosted ids after sync and travel as `importApprovals` — the caller
supplies an id and a reason and nothing else, because the approver and the
timestamp are derived server-side and frozen into the run's own snapshot. The
same approvals go to every target of a grouped launch. The normalized approval
set and reason are part of the run's idempotency key, so approving something is
a different run from not approving it while flag order is not. There is no
persistent acceptance: the next run needs the flags again.

**Incomplete import evidence is not gateable, and not waivable.**
`PlatformEvalRun` gains `importEligibility`, runtime-validated and projected
field by field rather than spread. When it says `incomplete` — or `gateable:
false` under any status — `eval gate` returns exit 3 before any verdict or
waiver is considered. That is deliberate: import completeness is evidence
eligibility, not a measurement of the server, so it is never exit 1 and a
waiver granted because the evals regressed cannot buy a release out of it.
`legacy` and `eligible` proceed through the existing verdict logic unchanged,
and an older server that reports no eligibility at all behaves exactly as
before.
