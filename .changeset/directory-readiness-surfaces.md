---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Directory readiness: the observation algebra, a real dial, and the hosted worker

Surfaces the Claude and OpenAI directory-readiness runners through the product,
against the backend's durable run lifecycle and its managed observation broker.

**A model may observe; it may not decide.** Observation ids come from a frozen
per-publisher catalogue, and the lane, class, title and citation of the
resulting finding are the SDK's, fixed at build time. Both invariants are
re-checked when the finding is built rather than trusted from the catalogue's
type, so the one-character edit that moves an observation into a dispositive
lane cannot land silently. `llm` joins the provenance union. Every failure —
provider outage, malformed output, a reservation the org could not afford — is
a first-class state with a machine-readable reason, because "we could not
afford to look" must never render as "we looked and it was fine".

**A tool listing readiness never dialled.** `gatherOpenAIReadinessEvidence`
took a tool listing as an argument and never fetched one, so every wire run
graded the whole annotation inventory `not-evaluated` — checks that existed,
were wired up, and could not fire. `directory-readiness/mcp-dial.ts` performs
the handshake and the paginated listings, including the
`notifications/initialized` the lifecycle requires and server frameworks
enforce. Every listing reports whether it FINISHED, and a truncated one
produces a coverage gap rather than a universal claim over a subset.

**Reuse is guarded.** `gatherClaudeReadinessEvidence` is the OpenAI gatherer's
symmetrical twin, and the evidence adapters refuse a conformance result from a
different target, a different config, or a run that did not exercise everything
it selected — completeness read from the checks, since a run is `"failed"` from
its first violation whatever else never ran. Refusal degrades to MISSING, never
to a pass.

Node plugin file sources move into the SDK's Node entry so the CLI can grade a
local package without depending on a web server or copying the archive rules.
`plugin-bundle/index.ts` and the browser entry stay free of `node:fs` and of an
archive library.

Adds `POST /api/mcp/conformance/readiness/:publisher`, synchronous and
deterministic, with no observation broker and no flag to ask for one: a local
run has no lease and no payer.
