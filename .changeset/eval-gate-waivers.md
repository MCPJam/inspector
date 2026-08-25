---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Gate waivers end to end (Evals v2, Lane E, step E5b).

An eval run's release gate can now be overridden by an authorized user, on the
record, until an expiry they name — and the override is visible everywhere the
gate is. The Lane E charter's words are "authorized actor, reason, expiry,
affected policy/run, visible CI/report status; no silent or permanent waiver."
The platform (mcpjam-backend #1141) owns the authorization, the required expiry
and the 30-day cap. This is the half that owns **visible**.

**Nothing here makes a failing run pass.** The run keeps its own `result`, and
the waiver is a separate record that every reader consults and reports
separately. Two independent computations decide this verdict — the platform
derives a GitHub Check Run conclusion from the persisted run, and the CLI
recomputes its own gate client-side from public v1 GETs — so flipping the
persisted result would green both with nothing saying why.

`@mcpjam/sdk` widens the gate contract. `GateStatus` gains `waived` and
`GateReport` gains a `waived` outcome plus a `waiver` field; `StructuredRunVerdict`
gains `waived`; `StructuredCaseResult` gains `waiver`. New exports:
`applyGateWaiver`, `isGateWaiverInForce`, `formatGateWaiverLine`,
`GATE_WAIVER_REASON_NOTICE`, and the `GateWaiver` type. `waived` is deliberately
NOT folded into `passed`: both exit 0, but collapsing them makes the difference
unrecoverable one line later, which is the definition of a silent waiver.

`applyGateWaiver` upgrades **only** a real `failed` outcome. `incomplete` and
`usage_error` are never waived — a waiver granted because the evals regressed is
not consent to ship on a cancelled run, a wait timeout, or a flaked fetch, and
turning exit 3 into exit 0 there is fail-open. The waiver is still attached in
every case, so an artifact names it even when it decided nothing.

`@mcpjam/cli`'s `eval gate` reads the waiver off the run projection (no second
round trip) and names **who** waived, **why**, and **until when** in all four
outputs: the human report, `--reporter json-summary`, `--reporter junit-xml`
(as `<skipped>`, JUnit's own third state — it does not fail the build, and it
does not render as a clean green row), and `--reporter html` (its own violet
badge and section, neither the green of a pass nor the red of a failure). The
four exit codes are unchanged; `waived` joins `passed` at 0.

The CLI re-derives the waiver's validity from `expiresAt` rather than trusting
the platform's `active`. A Convex query is cached against the documents it read
and time is not a document, so a lapsed waiver can be served as active until
something writes to its row — the one failure that would silently turn a
time-boxed waiver into a permanent one, on exactly the path this step builds.

New subcommands `mcpjam cloud eval gate waive --run <id> --reason <text>
--expires-in <30m|12h|7d>` and `mcpjam cloud eval gate unwaive --run <id>
[--waiver <id>]`. Both are manage-tier and server-enforced — the CLI does not
pre-judge authorization — and `waive` prints the unredacted-storage notice
before it accepts a reason. A bare `--expires-in 7` is rejected as ambiguous.
`eval gate`'s `--run` moved from a commander-required option to one this command
enforces itself, so the subcommands can dispatch; the exit code for a missing
`--run` is unchanged at `2`.

New v1 endpoints (`POST`/`GET` `…/eval-runs/{runId}/gate-waivers`, `DELETE
…/gate-waivers/{waiverId}`) with strict bodies, and `EvalRun` gains `gateWaiver`
— `null` rather than omitted, so a caller can tell "no waiver" from "an older
deployment". Reading a waiver is available to anyone who can view the run, not
only to those who can grant one. Three agent/MCP operations: `waive_eval_gate`,
`get_eval_gate_waiver`, `revoke_eval_gate_waiver`.

Two error-translation fixes in the v1 layer, both of which affect more than
waivers. `ConvexError({ kind: 'forbidden' })` — how the platform raises every
eval tier denial — carried no `code` field, so it matched no branch in
`translateConvexWriteError` and reached the terminal 500: a deliberate refusal
reported as our own bug, paged for, and handed to the caller as a generic
internal error. It now answers 403 with the platform's own message, still
honoring `adminFailureIsForbidden` for the resources that deliberately hide
their gate. And the five `gate_waiver_*` refusal codes are recognized as 400s
that forward the platform's copy verbatim, rather than falling through to a 500
that strips the one sentence telling the caller what to do.

`renderStructuredRunJUnitXml` gains a `skipped` attribute, emitted only when
something was actually waived — never `skipped="0"`, which would be a wire
change on every report ever rendered in exchange for saying nothing.
