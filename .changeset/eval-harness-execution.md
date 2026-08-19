---
"@mcpjam/inspector": minor
---

Run a harness eval on the iteration's own box, and admit only what it can honestly do.

The honesty gate turned silent emulation into an explicit refusal. This turns
the refusal into execution for the configurations a harness can actually run,
and keeps refusing the ones it cannot.

Admission now decides on two facts. A **pinned computer image is required**,
with no fallback to the acting member's personal computer: a harness eval
iteration runs on one disposable box, and borrowing a shared one would carry
state between iterations, which is the opposite of what a per-iteration box is
for. Its static half distinguishes an *omitted* pin ("not looked up" — the
batch route validates targets before any environment resolution) from an
explicit `null` ("resolved absence"), so a fan-out never refuses every harness
target over a fact nobody checked. And `widgetRendered` assertions are
**refused rather than skipped**: a harness reaches MCP through the signed
proxy, so the inspector's widget manager never sees the call — and a skipped
assertion on a passing run is indistinguishable from one that held.

Execution threads what the harness turn needs, every field gated on the harness
selector so an emulated eval stays byte-identical: the iteration's **existing**
sandbox (the same box already exposed as `bash` — one box per iteration, never
two, carried on the handler options rather than the member-readable run
snapshot so it cannot be forged), the same MCP-proxy strategy the hosted chat
routes resolve, and `builtInTools` passed explicitly, because the harness reads
built-ins off that field and nowhere else.

Pinned skills are deliberately not wired yet, and the code says so: an eval
pins skills that carry no runtime identity or aggregate hash, and synthesizing
them would put an invented integrity hash on the box.
