# Coverage inventory

Coverage labels describe this harness, not all possible product behavior. A
supported product feature that was not exercised is **untested**, not N/A.
All account and billing responses below are **simulated**. Consult the evidence
index for actual completed runs; materializing a task is not executing it.

| Area | Representative slice | Remaining branches |
| --- | --- | --- |
| Discovery | A: public docs entry, tool absent initially | Other websites, CLI-help entry, natural Eval discovery prevalence |
| Directed activation | B: install pinned CLI, connect HTTP MCP, useful tool result, repeatable deterministic Eval | Hosted UI/desktop, real model evaluation, full conformance suite |
| Auth recovery | C: saved configuration lacks server credential; credential is available in starting environment | Expired/revoked keys, wrong organization, denied account permissions, OAuth browser flow |
| Credits | D: Team owner, zero synthetic credits, platform-fee refusal, private resolution, resume native session | Positive/low/insufficient live balances, plan-specific paid estimates, mid-run exhaustion |
| Usage | CLI help and normal public API discovery; unknown values stay unknown | Live usage accuracy, pricing calculation, stale balances, failed top-up/upgrade |
| Transport | MCP Streamable HTTP on isolated Docker network | stdio, legacy SSE, protocol-version mismatch, disconnect, rate limit, network timeout |
| Tools | Valid arithmetic arguments; typed argument error when tester invokes it | Other tool failures, partial model success, resources, prompts, subscriptions |
| Configuration | Fresh HOME/XDG state; preserved saved files and scripts | Missing Node, incompatible CLI version, wrong directory, malformed JSON matrix |
| Client mode | Noninteractive Claude Code and Codex CLI, separate processes | Interactive PTY prompts, MCPJam exposed as an MCP server/client registration |
| Recovery | Auth correction; two-step account change without resetting workspace | Interrupted run, lost launch response, resumed partial execution |
| Charging | Synthetic private ledger; idempotency fixture regression; failed requests do not debit | Live charges, refunds, lost-response duplicate submissions, BYOK fees |
| Roles | Team owner starting account | Guest, free owner, paid member, enterprise contact/recovery; supported product states but not proven here |
| Evidence | Shell captures, public CLI events, contemporaneous concern notes, hidden ledger, verifier rewards, rendered SVGs | Kernel-wide subprocess tracing; native terminal screenshots; output discarded by tester shell |

## Contract sources

- `cli/src/commands/eval.ts`: Eval launch, repeat iterations, idempotency keys,
  run wait deadlines, and report/gate flags.
- `cli/src/lib/platform-client.ts`, `sdk/src/platform/errors.ts`: wire errors,
  authentication advice, request IDs, and usage-limit guidance.
- `mcpjam-inspector/server/routes/v1/`: public API refusal mapping. A
  `PLATFORM_FEE_REQUIRED` reason is carried in a `FORBIDDEN` error; it is not
  synonymous with a 429 rate limit or an iteration/step cap.
- `mcpjam-inspector/client/src/` billing hooks/components: free/pro/team/
  enterprise plans, billing-owner permissions and top-up eligibility. Exact
  plan recovery must follow current account capabilities, not a guessed price.
- `cli/tests/support/deployment-fixtures.ts`, `fake-mcpjam.ts` and CLI Eval tests:
  reusable process and wire-contract patterns.
- `sdk/tests/eval-iteration-payment.test.ts`: existing payment retry coverage.

The CLI surface currently lacks a live credit-balance/cost-estimate binding.
Organization spend budgets, product credits, provider spend, repeated Eval
iterations, and model-step caps are separate concepts. No synthetic number in
this suite establishes a product threshold, price, or entitlement.

## Known output classes

The publisher generates `observed-output-classes.json` with exact event links.
The inventory to check includes: help/version, install progress/warnings,
successful connection/tool result, empty output, usage errors, missing command,
authentication required/invalid token, forbidden/platform-fee refusal,
not-found/unsupported fixture routes, invalid arguments/tool errors, run receipts,
finished Eval reports, timeouts/cancellation, provider refusal, harness failure,
and verifier reward/diagnostics. Unobserved classes remain untested; absence of a
particular error does not establish its quality.

## Interpretation

Report task success separately from friction. A task can finish with poor
guidance; a correct owner handoff can satisfy diagnosis without finishing the
task. Numerators count affected **runs**, not repeated notes or nested capture
events. Denominators contain only comparable, valid runs exposed to that
condition. Preliminary harness-invalid runs remain linked, with their causes,
but do not support product prevalence or before/after success claims.

The fresh-agent sample is a usability signal. It is neither a controlled human
study nor a statistical estimate of activation or conversion.

## Final supplemental observations

The final Codex recovery retest actually ran the protocol conformance suite:
14/14 applicable checks passed, with 30 explicitly not applicable to the selected
protocol/capabilities. Baseline and cycle-one Codex recovery runs had 13/14,
including the GET/405 false schema failure fixed in cycle two. This is one
fixture and one final fresh-agent exposure, not full transport conformance.

Both held-out A trials produced reproducible validation work; neither observed
journey naturally reached an Eval. Claude used the pinned final build. Codex's
`npm install --prefix` used public npm CLI6.2.2/SDK10.7.0 rather than the fixture
registry; its exact source commit is unverified. Preserve it as public discovery
evidence, not proof of the final patch. Lockfile URLs/integrity and the absence
of fixture archive requests expose that distinction. A future benchmark should
pin npm configuration independently of installation prefix and revalidate it.

Held-out checks also exposed fixture overflow and extra-argument handling
defects. They remain fixture findings; no third fix cycle was performed. Do not
infer unsupported product features from unsupported simulated execution or API
routes. Product plan combinations remain untested unless their contract proves
they are not applicable.
