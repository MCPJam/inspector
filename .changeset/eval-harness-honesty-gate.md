---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Stop harness-hosted eval suites from silently running on the emulated engine.

A host config carrying `harness` runs the REAL runtime in chat and in swarms —
both pre-flight the shared `checkHarnessRuntimeAvailable` gate and refuse
rather than degrade. Eval runs forwarded the same selector into the turn
pipeline but pre-flighted nothing and supplied no MCP proxy, so a suite pinned
to a Claude Code host quietly executed on the emulated engine and reported
GREEN. That is the worst available answer: the suite claims it measured Claude
Code, and it measured something else.

Eval runs now call the same gate — not a re-derived subset, so a rule added to
it later applies here too — once the run's host config and cases are known and
before anything spends. A refusal finalizes the run with the gate's own reason
(broker delivery off, approval-plus-MCP-tools, an enterprise-managed host, a
harness that cannot deliver the suite's servers, an ineligible model). A suite
mixing hosted and BYOK models names the cases that cannot run rather than
saying "some model is ineligible", and a model-free (pinned-only) case is never
gated on a model it does not use.

What was silent emulation is now one of two honest answers, never a green run
on an engine nobody asked for: an eligible configuration executes on the
harness (see "Run a harness eval on the iteration's own box"), and everything
else is refused by name. A suite that wants emulated execution keeps a
non-harness host, the same choice a chat user has.

Runs also record which engine they executed on. `configSnapshot.executionEngine`
is derived server-side from the run's own host config — never sent by a caller,
so nothing can claim a runtime it did not use — and surfaces as
`executionEngine` on `GET /eval-runs/{id}`. ABSENT means the run recorded no
engine, which readers must treat as unknown rather than as `emulated`: those
are different claims, and conflating them is the exact ambiguity that let the
silent degradation survive.
