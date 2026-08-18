---
"@mcpjam/sdk": major
---

The SDK sends the declared `caseId` on upload.

`EvalResultInput` gains an optional `caseId` — the case's DECLARED identity
(`EvalTestConfig.id`) — and it now rides the wire on every result an
`EvalSuite` reports. 5.0.0 made `id` required but changed no payload byte; the
field was declared and inert. This connects it.

The backend resolves by `caseId` first, falls back to the content-hash key, and
ADOPTS: an id-bearing upload that resolves by hash to a case with no declared id
patches the id on without touching the immutable `caseKey`. That is what lets a
renamed test keep its hosted history instead of forking it — the whole reason
the field exists.

**Breaking: `id` and `externalCaseId` must agree.** A test that declares both,
with different values, now throws at construction:

```ts
new EvalTest({
  id: "c_minted",
  externalCaseId: "legacy_case_7", // ← throws
  name: "refund flow",
  test: async (executor) => { ... },
});
```

They are two claims about which case this is, and picking a winner silently is
how one case's history gets cross-joined onto another's. The migration is always
`id := externalCaseId`: the hosted case is keyed under `external:<externalCaseId>`,
so declaring that same value as `id` lands the declared id in the join the case
already lives under and its history simply continues. A differing pair is
rejected at ingest too, so shipping it would fail the upload rather than pick a
winner. An empty `externalCaseId` is absent, not a second claim, and is
unaffected.

The one case the migration cannot fix is an `externalCaseId` outside the opaque-id
charset (`^[A-Za-z0-9_-]{1,128}$`) — that field was never charset-bound, so
values exist that no `id` can equal. 5.0.0's missing-`id` error suggested a
freshly minted id for exactly those configs, and that pair now throws. Rename the
external id itself to a conforming value and declare it in both fields; an
external id that was never charset-valid has no hosted history for the rename to
strand. The error message says so at the line that is wrong.

**Minimum reporting-backend contract.** Argument validation on the ingest
surface is strict: a backend that predates declared case ids rejects the WHOLE
report rather than dropping the unknown field. `@mcpjam/sdk` 6 therefore
requires a reporting backend that accepts `caseId`. MCPJam-hosted
`app.mcpjam.com` does; a caller-supplied `baseUrl` pointing at an older or
custom deployment may not, and such a rejection is now surfaced as an actionable
compatibility error naming the required upgrade — flagged as
`EvalReportingError.isReportingBackendIncompatible`, never retried, and never
reported as an eval verdict. `reportEvalResultsSafely` keeps its existing
strict/non-strict behavior.

`RunToEvalResultsOptions`, `IterationToEvalResultOptions` and
`SuiteRunToEvalResultsOptions` gain an optional `caseId` (and `caseIdByTest` for
the suite variant, mirroring `expectedToolCallsByTest`). These converters
receive a `casePrefix` rather than an `EvalTest`, so they cannot know the
declared identity — it is offered and never defaulted. Note that
`runToEvalResults` synthesizes `caseTitle` per iteration, so supplying one id
across a run groups its iterations as a single hosted case instead of one case
per iteration; that is the caller's choice to make. Passing nothing produces the
same payload as before, byte for byte.

The low-level mappers stay permissive: `promptsToEvalResult` and
`PromptResult.toEvalResult` forward whatever `caseId` the caller passes and do
not enforce the equality rule themselves. The construction-time check covers the
`EvalTest` path and the backend's ingest preflight covers everyone else.

Nothing else about the payload changes. A config with no `externalCaseId` emits
exactly what it emitted before, plus `caseId`.
