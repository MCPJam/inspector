---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Disclose the host axis before a run launches (Evals v2, Lane G, step G4c).

G4b shipped the pre-run disclosure but had to REFUSE the host axis: the
backend contract took only `caseIds`/`environmentId(s)`, so the only query
available for a host-targeted launch was the selector-less suite-base
derivation — which a host config can contradict with its own model and
harness. A run could have been disclosed "emulated, no sandbox" moments
before it booted a harness sandbox, so an honest absence was shipped instead.

`testSuites:getRunDisclosure` now takes `namedHostId` (mcpjam-backend #1131),
and this un-refuses every surface that was standing down:

- `GET /v1/.../run-disclosure` accepts `?host=<id>`, and its mutual-exclusion
  400 becomes three-way — a launch plan resolves on exactly one axis, and an
  environment already resolves a host. The route also forwards the runner's
  `harness-execution` capability handshake, which the backend gates the
  disclosed engine on exactly as it gates the run's own pinned config. That
  list is ASSERTED by the route from the executing process, never accepted
  from the query: this process is the runner, so it is the only honest source
  for what it can execute, and it now comes from one constant shared with the
  launch path so the disclosure and the run cannot describe different engines.
- `@mcpjam/sdk/platform`: `PlatformApiClient.getEvalRunDisclosure` takes
  `namedHostId`, and `get_eval_run_disclosure` gains a `host` selector.
  `run_eval_suite` no longer skips the fetch for a single-host plan — it
  forwards the frozen plan's host, so what is disclosed stays exactly what
  runs.
- `mcpjam cloud eval run --host` now prints a disclosure block (the renderer
  never needed a change; there was simply nothing to render before).
- The "Run all" hint in the eval suite header fetches and renders for a suite
  whose sole target is one attached host, instead of the static refusal.

The one deliberate gap left: a MULTI-TARGET launch spanning hosts still
reports the disclosure as unavailable — the contract answers for one launch
plan, so a fan-out across hosts has no single engine or model set to
describe, and stitching N pre-launch round trips into a composite would be a
different contract than the one the audit stamp records. The refusal now
names that limit rather than the retired "no host selector" one.

**Requires a backend carrying the `namedHostId` argument** (mcpjam-backend
#1131), and the ordering matters in one direction. The runner capability
handshake is sent on EVERY disclosure request, not only host-targeted ones —
the backend gates the disclosed engine on it for the environment axis too — so
against a deployment that predates #1131, strict argument validation rejects
every disclosure request, not just the new axis. Disclosure then goes dark for
environment and flat plans that worked before.

It degrades safely rather than dangerously: the disclosure fetch is
best-effort, so runs still LAUNCH normally, `onDisclosureUnavailable` fires
with the reason, and the receipt simply carries no `disclosure` field. #1131 is
required for the disclosure, never for the run. Shipping the backend first is
completely safe — nothing sends the new arguments until this release lands.
