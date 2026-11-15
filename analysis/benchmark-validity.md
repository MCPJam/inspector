> Preliminary, noncomparative v1.2 observations; excluded from improvement denominators.

# Harbor 1.2 benchmark validity review

Review-only interpretation of immutable `work/jobs/baseline-six-v12`. Frozen verifiers and rewards are unchanged. All Evals below are deterministic sandbox simulations, not live hosted models or billing.

| Run | Agent | Strict Harbor reward | Independent observed outcome | Interpretation |
|---|---|---:|---|---|
| `healthy__dyyzkKT` | Codex | 0 | Direct MCPJam tool call succeeded; two public-API Evals completed/passed with reproducible Python script. | CLI-specific Eval criterion unmet, not a parser failure. Broader normal-product-interface goal succeeded. Fixture predicate limitation caused a detour; do not call this a product activation failure. |
| `healthy__nn7HFaC` | Claude Code | 0 | MCPJam CLI Eval completed/passed, executing add(2,3)=5; saved `run_eval.sh`. No direct tester tool call. | B requires both direct tool-call evidence and CLI Eval. Eval-as-first-value is valid product behavior but fails this narrower construct. Report successful Eval separately. |
| `auth__E5Qeyba` | Codex | 0 | Authenticated doctor and tool calls succeeded; credential supplied from first direct connection. No authentication refusal. | Recovery branch was never exercised. Coverage miss, not failed authentication or demonstrated recovery failure. |
| `auth__Tx2qPDy` | Claude Code | 1 | One authentication refusal followed by authenticated MCPJam tool success and preserved reproduction script. | Required recovery sequence observed. |

## Exact evidence

All event directories below are under `<run>/artifacts/capture/<event-id>/`; they contain `event.json`, stdout, stderr, and ordered stream capture. Private state is `<run>/artifacts/fixture/state.json`; strict metrics are `<run>/verifier/metrics.json`.

- Codex healthy [91c71adbe58b4b4ca34598940f2dc65f](../baseline-six-v12--healthy__dyyzkKT/commands/0034-91c71adbe58b4b4ca34598940f2dc65f/event.json): `npx mcpjam cloud eval run ...` exits 4, `FEATURE_NOT_SUPPORTED`, reason `fixture_unsupported_execution`. Suite used `toolResultMatches`, a real product predicate (`evaluators/src/predicates/types.ts`), outside fixture support. This error is a fixture limitation.
- Codex healthy [ef796275148a47058fd7ecb1a1d5a2fa](../baseline-six-v12--healthy__dyyzkKT/commands/0071-ef796275148a47058fd7ecb1a1d5a2fa/event.json): switches assertion to `toolResultContains`, PATCHes case through public API, then Python POST launches `run_fixture_1`. Ledger records completed/passed, add(19,23)=42.
- Codex healthy [5717171c5b2d4d038a2e6a5c2f87a8db](../baseline-six-v12--healthy__dyyzkKT/commands/0019-5717171c5b2d4d038a2e6a5c2f87a8db/event.json): creates/runs `reproduce.py`; prints `run_fixture_2: passed`. Ledger records second distinct deliberate run. Two separate launches are not proof of duplicate billing from a retry.
- Codex healthy direct tool matches: [a23e6c6d6db348f389293761fa4f237b](../baseline-six-v12--healthy__dyyzkKT/commands/0043-a23e6c6d6db348f389293761fa4f237b/event.json), [8be20ba4d10c47218663fa1e8c72dd79](../baseline-six-v12--healthy__dyyzkKT/commands/0032-8be20ba4d10c47218663fa1e8c72dd79/event.json). These include nested shell capture of the same call; do not count them as independent trials.
- Claude healthy [2a1cc7d9fd4c496ca1014daa401a114b](../baseline-six-v12--healthy__nn7HFaC/commands/0005-2a1cc7d9fd4c496ca1014daa401a114b/event.json): CLI `cloud eval run --suite suite_fixture --wait --reporter json-summary --out /workspace/run1.json`; passed report with run_fixture_1. Ledger has only source=`simulated_eval` tool call, no source=`tester`. A preceding `cloud projects servers list` in the same shell produces a real usage error, retained alongside successful Eval output.
- Codex auth [ab65a27fa7c14e7387b19bd551ab167b](../baseline-six-v12--auth__E5Qeyba/commands/0055-ab65a27fa7c14e7387b19bd551ab167b/event.json): first direct `server doctor --url ... --access-token "$MCP_SERVER_TOKEN" --rpc` succeeds.
- Codex auth [261e0b69919840c186ad67c788a100e7](../baseline-six-v12--auth__E5Qeyba/commands/0011-261e0b69919840c186ad67c788a100e7/event.json): `tools call` uses the supplied token and returns a successful sum. Private ledger has zero auth refusals; no missing refusal was dropped by parsing.
- Claude auth direct successful tool event [244180658daa4c188a40e5d970c231d7](../baseline-six-v12--auth__Tx2qPDy/commands/0008-244180658daa4c188a40e5d970c231d7/event.json); private ledger records one earlier MCP_AUTH_REQUIRED refusal.

## Reporting requirements

Keep strict rewards visible and unchanged. Alongside them, publish independently observed API/CLI Eval completion and direct tool success. Label unexercised authentication recovery as a coverage miss. Exclude unsupported fixture routes/predicates from product-failure frequencies. Any future acceptance of public-API Evals, Eval-as-first-value, or preemptive auth setup needs a new benchmark version and comparable reruns, not retrospective reward edits.

The current direct-tool-plus-Eval criterion is narrower than prompt B's wording. Task success, friction, and coverage validity must not be collapsed into one reward number.
