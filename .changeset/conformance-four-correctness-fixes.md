---
"@mcpjam/sdk": patch
---

Four conformance-correctness fixes: stop scoring permitted behavior, give the
Tasks acknowledgement a real verdict, report a wrong JSON-RPC id echo, and stop
penalizing capabilities a server never claimed.

**Advice about permitted behavior no longer costs points.** `readiness.ts` said
of the protocol-version-header observation that it is "reported and never
scored" — but every readiness warning deducted, so a server exercising the MAY
that `streamable-http.mdx` grants it ("a server that supports clients
implementing protocol versions earlier than 2025-06-18 MAY treat a request that
omits the header as protocol version 2025-03-26") lost SHOULD points, and the
resource-uri echo — which the spec only *illustrates* — lost MAY points.
`MCPReadinessWarning.informational` marks both: reported, never deducted. Every
existing warning keeps its deduction.

**The Tasks acknowledgement is judged, not excused.** A missing
`resultType: "complete"` was a warning, deferring to `wire-schema-valid` on the
grounds that it grades `UpdateTaskResult` / `CancelTaskResult`. It does not: the
Tasks suite runs its own runner, which installs no wire recorder and runs no
wire check, so the update and cancel frames were observed nowhere and a missing
required member read as a pass. It also cannot be judged from the decoded ack —
the v2 client consumes `resultType` on the way through — so the check now reads
the frame off the rpc log, the same move `tasks-status-payload-shape` makes.
With a raw frame it is a violation; without one it stays advice that says why.

**A wrong id echo is reported.** Ids paired via `String(a) === String(b)`, so a
response echoing `"1"` for a request that sent `1` correlated silently. Pairing
loosely is right — it keeps validation method-specific against a sloppy server —
but `RequestId` admits both types, so no schema can catch the echo, and the
tolerance was absorbing a real defect. Correlation is unchanged; the mismatch is
now recorded and reported.

**Unadvertised optional capabilities are not a coverage gap.** `prompts`,
`resources` and `tools` are optional, and a server advertising none of them has
no such operation to carry hints on. Counting them as unprobed forced
`modern-cache-hint-coverage` to could-not-run, so a tools-only server looked
unverified for declining features it never claimed. They are now reported as
inapplicable; only an advertised capability this run could not exercise is a gap.
