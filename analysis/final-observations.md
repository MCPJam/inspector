> Independent qualitative review; frozen strict rewards are unchanged. Raw trajectory references map to public-only projections via run indexes.

# Final benchmark1.3 observations

Final benchmark1.3 only; frozen raw rewards unchanged. Semantic milestone inventory is not a regrade. Evals and credits simulated.

## patched-auth-v13 / auth__GiXEbFi (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 11, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 63.14897918701172, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Unauthenticated401 then suppliedtoken connection succeeded; direct CLI tool result and preserved reproduction files.",
    "Wire-schema false-positive GET405 also occurs in patched cycle1; source/spec support same issue as baseline."
  ],
  "fixture_observations": [
    "Extra argument accepted despite additionalProperties false.",
    "Hosted HTTP health skipped; trace/step endpoints unavailable."
  ],
  "same_work_preserved": "Original mcp.json remains; validation/reproduce.sh retained token environment reference without saved credentials. Private11 successful calls and one API Eval.",
  "duplicate_charge_interpretation": "One run, one unique charge.",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "conformance": {
    "executed": true,
    "event_id": "4caa7eee610d4d5582e79f80506da13d",
    "shell_exit_status": 0,
    "exit_status_caveat": "Trailing cat masks conformance process status; report itself has passed=false, outcome=failed.",
    "report": "validation/protocol.json",
    "applicable": 14,
    "passed": 13,
    "failed": 1,
    "not_applicable": 30,
    "failed_check": "wire-schema-valid"
  },
  "human_action": "Auth recovery complete; remaining server validation/checker issue requires maintainer, not account owner."
}

> The unauthenticated check returned `401 invalid_token`; retrying with `MCP_SERVER_TOKEN` connected successfully and discovered the `add` tool. The existing smoke eval passed, but its receipt labels execution as simulated. I’ll preserve that limitation and check direct tool behavior and protocol conformance.
> 

Source: [Published run evidence](../patched-auth-v13--auth__GiXEbFi/index.md), public step 17.

> Two checks need follow-up. Hosted health checking skipped the HTTP endpoint because it requires HTTPS, so it provides no reachability verdict. Local conformance passed 13 applicable checks and flagged the JSON body of a GET `405` response as invalid JSON-RPC. The protocol permits GET `405`; I’ll capture that response and preserve the finding as a possible checker issue while testing valid and invalid tool inputs.
> 

Source: [Published run evidence](../patched-auth-v13--auth__GiXEbFi/index.md), public step 21.

> The input tests found a server defect: `add` advertises `additionalProperties: false` but accepts `{"a":2,"b":3,"c":4}` and returns success. Six other tool checks passed. Eval step and trace retrieval returned `NOT_FOUND`, so the saved run and iteration receipts are the available evidence. I’ll preserve the reproducer and report; fixing the schema mismatch requires a change to the server outside the permitted interfaces.
> 

Source: [Published run evidence](../patched-auth-v13--auth__GiXEbFi/index.md), public step 25.

> Validation preserved in [REPORT.md](/workspace/validation/REPORT.md), with a [reproducer](/workspace/validation/reproduce.sh).
> 
> - Recovered authentication using `MCP_SERVER_TOKEN`.
> - Direct tool tests: **6/7 passed**.
> - Found a defect: `add` accepts extra arguments despite declaring `additionalProperties: false`.
> - Existing simulated eval passed; hosted HTTP health checking was skipped.
> - Conformance reported one possible checker false positive involving GET `405`, which the [protocol permits](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
> 
> Further repair requires the server maintainer to enforce its advertised input schema and redeploy. Credentials were not saved.

Source: [Published run evidence](../patched-auth-v13--auth__GiXEbFi/index.md), public step 27.

## patched-auth-v13 / auth__UifmxRq (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": null,
  "outcome_class": "provider_blocked",
  "attribution_tags": [
    "provider"
  ],
  "strict_reward_caveat": "Harbor raw reward0 retained; exception policy has_valid_reward=false. Not an observed product failure or comparable auth outcome.",
  "provider_observation": "Claude first-party OAuth access token expired, HTTP401; no tester success claim accepted.",
  "product_observations": [
    "Provider failure before any product authentication exposure; no MCPJam usability conclusion."
  ],
  "same_work_preserved": "No completed recovery; no runnable task artifact.",
  "duplicate_charge_interpretation": "No product charges.",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "conformance": "No conformance execution observed."
}

> Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.

Source: [Published run evidence](../patched-auth-v13--auth__UifmxRq/index.md), public step 2.

## baseline-auth-provider-recovery-v13 / auth__DDRa9aF (claude-code)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Config lacks auth; unauthenticated401 diagnosed, supplied MCP_SERVER_TOKEN passed via --access-token. Doctorready, add2+3sum5, malformedinput returns isError true.",
    "Public note correctly identifies missing config credential and no owner action; no cloud Eval attempted or needed for promptC."
  ],
  "same_work_preserved": "Existing mcp.json retained; saved validate.sh uses token environment reference, doctor and valid/invalid call outputs retained. Private ledger one successful call after one authrefusal.",
  "duplicate_charge_interpretation": "No hosted launches or product charges.",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "conformance": "Doctor/probe/validate only; no actual conformance run or report observed.",
  "human_action": "None required for recovered authentication."
}

> The server passed validation with MCPJam CLI 6.2.2.
> 
> - **Config:** `/workspace/mcp.json` has no credential, and the server returns 401 without one. I passed `MCP_SERVER_TOKEN` as a bearer token on the command line instead.
> - **Probe and validate:** Both succeeded. The server is `arithmetic-fixture` 1.0.0, protocol 2025-11-25, over streamable HTTP with no OAuth. It advertises only the `tools` capability.
> - **Doctor:** The report status is `ready`. The only noise was warnings about resources, which the server doesn't advertise. The full report is in `doctor.json`.
> - **Tools:** The server has one tool, `add`, with an input and output schema. `add(2,3)` returned `{"sum":5}`. `add("x")` returned `isError: true` with the message "a and b must be finite numbers", which is the right behavior for bad input.
> - **Not done:** I didn't run the account-side `mcpjam cloud` commands, so nothing was checked against `MCPJAM_API_URL` or project_fixture.
> - **Saved work:** `/workspace/validate.sh` reruns these checks (it needs `MCP_SERVER_TOKEN` set).
> 
> **Concern note:** I expected `mcp.json` to carry the auth, and it doesn't. Add a header or token entry there if other tools need to read that file. Nothing blocked me, and I didn't need the account owner or any other human action.

Source: [Published run evidence](../baseline-auth-provider-recovery-v13--auth__DDRa9aF/index.md), public step 10.

## baseline-priority-v13 / credits__xT9JB9X (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 8, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 201.11820077896118, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Correct public-API recovery and saved repeat script; CLI-only launch criterion unmet.",
  "product_observations": [
    "Correct platform-credit diagnosis; stayed explicit that balance/cost remained unknown; no patched guidance exposure."
  ],
  "fixture_observations": [
    "Model/budget/disclosure/decision-summary endpoints unavailable"
  ],
  "credits_cost_actor": {
    "balance": "unknown_acknowledged",
    "cost": "unknown_acknowledged",
    "cause": "platform credits, distinct from direct MCP ability",
    "actor": "team owner/orchestrator synthetic account resolution",
    "handoff_correct": true
  },
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "replay.py unchanged hash across phases; original suite_fixture resumed.",
  "human_action": "Waited for explicit resolution notice; no purchase.",
  "duplicate_charge_interpretation": "One refusal, one accepted run, one unique synthetic charge.",
  "key_evidence_event_ids": [
    "7b91f29bc7c7403c90d18fa53bcf4488",
    "831b279cea1c4026816f355c8e3c2d6b"
  ],
  "conformance": "Custom direct protocol-smoke.py checks are not MCPJam conformance; no verified official conformance result.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> I’ll check the public documentation and account usage first, then run a repeatable evaluation if the available credits allow it. I’ll save the configuration and results under `/workspace`.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 6.

> Concern: I expected the documented model and spend-budget APIs to show pricing and available funds, but both return “not implemented” in this environment. The account is confirmed as a team owner. I’ll check the documented usage interface and saved evaluation suite next; cost and credit availability are still unknown.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 13.

> Concern: The saved suite checks that `add(2, 3)` returns `5`, but launch was refused with `PLATFORM_FEE_REQUIRED`. The message says platform credits are required; it does not report a balance, usage, or expected cost. As team owner, this account can use the organization’s credit controls, but purchases are outside your instructions. I’ll save the blocked request and check for an environment-reported resolution before retrying.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 20.

> The direct MCP checks passed all eight arithmetic cases across two repetitions. The hosted evaluation remains blocked by the platform-credit requirement. I’ve saved scripts for both checks, including the original hosted request, so it can be retried after the environment confirms resolution.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 24.

> Direct MCP checks passed **8/8**. The hosted evaluation was blocked by **`PLATFORM_FEE_REQUIRED`**.
> 
> Usage, available credits, and expected cost remain unknown because the relevant interfaces were unavailable. As team owner, the next action is to have the isolated environment resolve the synthetic platform-credit requirement. Nothing was purchased.
> 
> Saved [instructions and evidence](/workspace/mcpjam-eval/README.md) and a [replay script](/workspace/mcpjam-eval/replay.py). Once the environment reports resolution, I’ll retry the original hosted evaluation.

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 26.

> I’ll resume the saved hosted evaluation, check its results, and record any usage or cost information the environment now provides.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 28.

> Concern: The account issue is reported resolved, but the usage, pricing, and pre-run disclosure interfaces remain unavailable, so I still can’t verify the balance or expected cost. I’ll retry the preserved one-iteration evaluation and inspect the returned results for usage and charges.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 30.

> The resumed run completed and passed its one case: `add(2, 3)` returned `5`.
> 
> Concern: The result explicitly labels this as simulated execution, with no hosted model or live billing. It confirms that the evaluation workflow resumed, but doesn’t establish hosted model performance or cost. I’ll record that limitation alongside the result.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 31.

> Resumed successfully. Run `run_fixture_1` **passed 1/1 cases**: `add(2, 3)` returned `5`.
> 
> The environment labels the run **simulated, with no hosted model or live billing**. Available credits, usage, and expected live cost remain unavailable.
> 
> Saved the results and repeat instructions in [README.md](/workspace/mcpjam-eval/README.md), with [raw run evidence](/workspace/mcpjam-eval/after-credit-resolution/iterations.json).

Source: [Published run evidence](../baseline-priority-v13--credits__xT9JB9X/index.md), public step 32.

## baseline-priority-v13 / credits__8FQyeMP (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 132.809894323349, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Public API completion and repeatable Python runner; strict CLI evidence criterion unmet.",
  "credits_cost_actor": {
    "cause": "PLATFORM_FEE_REQUIRED correctly identified",
    "knowledge": "Unknown balance/cost distinguished from public per-credit price; does not infer run cost from credit denomination.",
    "actor": "Team owner; organization billing action, synthetic account adjustment required for trial.",
    "handoff": "Waited resolution, no purchase."
  },
  "same_work_preserved": "resume.py/api.py unchanged; same suite_fixture/server_fixture request verified in captured launch and private successful run.",
  "fixture_observations": [
    "Documentation index retrieval failed but main docs available; account and full trace routes unsupported."
  ],
  "duplicate_charge_interpretation": "One charged run, no duplicate IDs.",
  "evidence_ids": [
    "3d39f49e363b44d2a896d5e08cd1ac8c",
    "7052cfb338324d34a4289e8007c49caa"
  ]
}

> Concern: I expected the documentation index to be accessible, but it failed through both retrieval methods. The main docs are available, so I’m following their API reference links to check this account’s limits and credits.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 12.

> Concern: The account is confirmed as a Team owner, and the saved smoke case calls `add(2, 3)` with expected output `5`. I couldn’t retrieve a credit balance or run estimate from the available interfaces. The docs price one credit at $0.01, but that doesn’t establish this run’s cost. I’ll attempt the small saved suite using the synthetic credits and record any account refusal.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 16.

> Concern: The evaluation was blocked with `403 FORBIDDEN`, reason `PLATFORM_FEE_REQUIRED`: “This work requires platform credits.” No run ID was created. As the organization owner, this account can access billing to add credits; in this isolated trial, the next step is an environment-side synthetic-credit adjustment. I won’t purchase anything. Once the environment reports resolution, I’ll retry the same evaluation.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 17.

> Blocked: the evaluation launch returned `403 PLATFORM_FEE_REQUIRED`; no run was created.
> 
> - Confirmed: Team plan, organization owner.
> - Available credits, usage totals, and expected cost remain unknown; queried interfaces returned 404. Docs state [1 credit = $0.01](https://docs.mcpjam.com/inspector/evals).
> - Next action: resolve the synthetic platform-credit requirement. No purchases or production billing contact were made.
> 
> Saved the [repeatable evaluation script](/workspace/mcp-evaluation/resume.py), [request log](/workspace/mcp-evaluation/requests.jsonl), and [instructions](/workspace/mcp-evaluation/README.md). Once the environment reports resolution, I can retry the original suite.

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 18.

> I’ll resume the saved evaluation, then inspect its results, tool trace, and reported usage and cost.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 20.

> Concern: The resumed run passed, and its iteration records `add(2, 3)` returning `5`. I expected a full trace, but that endpoint returned 404; token usage and cost fields were also absent. The run identifies itself as simulated, with no hosted model or live billing. I’ll preserve the iteration evidence and record those limits.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 22.

> Resumed successfully: run `run_fixture_1` passed its single case. `add(2, 3)` returned `5` without a tool error.
> 
> The run reports simulated execution with no hosted model or live billing. Credit balance and numeric cost remain unknown; the full trace endpoint returned 404.
> 
> Saved [results and evidence](/workspace/mcp-evaluation/RESULTS.md) and the [reproducible script](/workspace/mcp-evaluation/resume.py).

Source: [Published run evidence](../baseline-priority-v13--credits__8FQyeMP/index.md), public step 23.

## baseline-priority-v13 / healthy__YYqEMAi (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_3"], "cli_eval_evidence_ids": ["1e60c0c571cb4d81a696adef3bbf6d40", "2169e7b8b7f4466a81ce4917e1765d09"], "first_simulated_eval_seconds": 92.12486529350281, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 3, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Correctly distinguished local evaluator limitations from hosted result assertions."
  ],
  "fixture_observations": [
    "Structured result-pattern predicate unsupported",
    "Per-step evidence unavailable"
  ],
  "credits_cost_actor": "Not credits task; explicitly simulated execution.",
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "Saved suite/script; original suite passed twice, independent wrong-sum6 suite failed.",
  "human_action": "None needed.",
  "duplicate_charge_interpretation": "Three intentional runs (pass, negative control fail, repeat pass), three unique charges.",
  "negative_control": {
    "expected_sum": 6,
    "actual_sum": 5,
    "private_run_id": "run_fixture_2",
    "verdict": "failed",
    "cli_exit_status": 1,
    "evidence_event_id": "d1ac2c66bb2f42ee99b905b3f2bd0887"
  },
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "node_modules/.bin/mcpjam executed as public CLI; no package source reading observed."
  }
}

> MCPJam connected successfully and found an `add` tool. The first call, `add(2, 3)`, returned `{"sum":5}`.
> 
> Concern: I expected to assert that output in a local evaluation, but the docs say local runs cannot grade tool results yet. I’ll use a hosted evaluation to preserve the input and expected result as a repeatable check.

Source: [Published run evidence](../baseline-priority-v13--healthy__YYqEMAi/index.md), public step 13.

> Concern: the suite passed MCPJam’s file validation, but the isolated backend rejected the run, saying it supports only a subset of assertions. It did not identify the unsupported field. I’ll replace the result-pattern assertion with a documented text assertion and retry.

Source: [Published run evidence](../baseline-priority-v13--healthy__YYqEMAi/index.md), public step 18.

> The evaluation passed, and its recorded evidence shows `add(2, 3)` returning `{"sum":5}`. The backend labels this as simulated deterministic execution, with no hosted model or live billing.
> 
> I’ll now check that an intentionally wrong expected result fails, then save a rerun script and the evidence.

Source: [Published run evidence](../baseline-priority-v13--healthy__YYqEMAi/index.md), public step 20.

> The negative control failed as expected when it required `"sum": 6`; the CLI exited with code 1.
> 
> Concern: the documented per-step evidence endpoint returned “not implemented” in this environment. The iteration endpoint did provide the tool arguments and result, so I’ll keep that evidence alongside the reports.

Source: [Published run evidence](../baseline-priority-v13--healthy__YYqEMAi/index.md), public step 21.

> Set up MCPJam CLI 6.2.2 and validated connectivity. First useful result: `add(2, 3)` returned `{"sum":5}`.
> 
> Created and ran a repeatable evaluation:
> 
> - Passed 1/1; rerun `run_fixture_3` also passed.
> - Negative control expecting `6` failed with exit code 1.
> - Backend labels evaluation execution as simulated and deterministic.
> 
> Rerun with:
> ```bash
> /workspace/mcpjam-validation/run-eval.sh
> ```
> 
> [Setup, evidence, and concerns](/workspace/mcpjam-validation/README.md) · [Evaluation suite](/workspace/mcpjam-validation/suite.json) · [Latest report](/workspace/mcpjam-validation/eval-report.json)

Source: [Published run evidence](../baseline-priority-v13--healthy__YYqEMAi/index.md), public step 23.

## baseline-priority-v13 / healthy__Vju72to (claude-code)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": ["e7ef7eb9326e48fdb896a61a04c19623"], "first_simulated_eval_seconds": 55.0764045715332, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Deterministic toolCall fields discovered by guessing/validation; explicit occurrence-only assertion limitation."
  ],
  "fixture_observations": [
    "Plain-http nonloopback URL rejects local hosted-inference connection",
    "Prompt model execution unsupported"
  ],
  "credits_cost_actor": "Not credits task; no numeric price claim.",
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "Saved YAML exact steps match executed private suite, named Arithmetic server exists; report links run_fixture_1.",
  "human_action": "None needed.",
  "duplicate_charge_interpretation": "One accepted run/one charge.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Captured invocations and public trajectory show public documentation/API/CLI usage; no source/private control reads observed."
  }
}

> The MCP server validates, and I turned that into a repeatable eval that passed on a hosted run (1 of 1).
> 
> **Setup and first result**
> - I used the `@mcpjam/cli` through `npx`. `server probe` showed `http://fixture:8765/mcp` is ready over streamable HTTP, with no OAuth required. The server is `arithmetic-fixture` 1.0.0.
> - `tools list` shows one tool, `add`, which takes two numbers and returns `{sum}`.
> - `tools call add {a:2,b:3}` returned `{"sum":5}`.
> 
> **Repeatable eval**
> - The suite is `/workspace/.mcpjam/evals/arith.yaml`. It has one case: a deterministic `toolCall` step calling `add(17, 25)`, followed by a `toolCalledAtLeastOnce` assertion on `add`.
> - I checked it offline and against the project with `mcpjam cloud eval validate --file .mcpjam/evals/arith.yaml --project project_fixture`. Both checks passed.
> - To rerun it: `npx -y @mcpjam/cli@latest cloud eval run --file .mcpjam/evals/arith.yaml --project project_fixture --wait --reporter json-summary --out reports/arith.json`
> - The saved report is `/workspace/reports/arith.json`. It records run `run_fixture_1`, verdict `passed`, 1 of 1 cases passed.
> - `.mcp.json` in `/workspace` binds the server for local runs, but I didn't end up using it.
> 
> **Concerns**
> 1. **`mcpjam test` (local) didn't work.** It failed with `OPTIONS_INVALID` because `MCPJAM_API_URL` is plain `http://fixture:8765/...`, and the CLI only accepts `https://` or loopback. I switched to the hosted `cloud eval run`. I didn't try the self-hosted settings file, which the docs describe only in outline.
> 2. **A prompt-driven eval was refused.** My first suite had a model prompt step, and the hosted run was refused. The error said this synthetic fixture supports only deterministic `toolCall` steps and a subset of assertions, and refuses model execution. I rewrote the case as a `toolCall` step. So this run checks that `add` can be called and returns a result. It doesn't check whether a model chooses the right tool.
> 3. **Server name.** The project's saved server is named `Arithmetic`, not `arith`. The eval file now uses that name.
> 4. **Undocumented `toolCall` fields.** I couldn't find the `toolCall` step fields in the docs. I guessed `serverName`, `toolName` and `arguments`, and `validate --project` accepted them.
> 
> No billing was touched, and the run used 4 of the shell-command budget's 40... more precisely, I stayed well under the 40-command limit.

Source: [Published run evidence](../baseline-priority-v13--healthy__Vju72to/index.md), public step 16.

## baseline-priority-v13 / healthy__9ZDP5bv (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": ["db8fac1b5c6d41fcba506073ede2112b"], "first_simulated_eval_seconds": 69.38886499404907, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Tool and CLI Eval both verified; reward0 solely because reproducible_artifacts excludes a valid saved suite.json/report.json without embedded command text.",
  "product_observations": [
    "Schema fields steps[].id/serverName discovered through real validation errors; corrected and completed.",
    "Extra list argument on projects servers caused repeated usage error; eventually listed servers with canonical command."
  ],
  "fixture_observations": [
    "Prompt model execution unsupported",
    "Server connect route unimplemented"
  ],
  "credits_cost_actor": "Not a credits task; no numerical billing claim.",
  "syntax_remedy_outcome": {
    "kind": "baseline",
    "completed": true,
    "evidence_event_ids": [
      "194137f3be1a449e9c2ef94f9c731d79",
      "a18b026d84ef481ba662d11221424530",
      "db8fac1b5c6d41fcba506073ede2112b"
    ],
    "interpretation": "Recovered to usable server list and Eval without patched help; multiple schema/usage detours remain."
  },
  "same_work_preserved": "Suite definition suite.json and report.json saved; persisted suite runnable.",
  "human_action": "None required.",
  "duplicate_charge_interpretation": "One accepted synthetic run; no repeated charge observed.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> The server is valid and the repeatable eval passes: 1 of 1 cases, verdict `passed`.
> 
> **First result.** I ran the CLI (`npx -y @mcpjam/cli@latest`) against `http://fixture:8765/mcp`.
> - `server probe` reported the server as ready over streamable HTTP, protocol 2025-11-25. The server is named `arithmetic-fixture` and needs no OAuth.
> - `tools list` showed one tool, `add`, which is read-only.
> - `tools call add {a:2,b:3}` returned `{"sum":5}`.
> 
> **Repeatable eval.** The project already had an `Arithmetic` server entry (`server_fixture`), so I used it. I created the suite `Arithmetic add deterministic` (`suite_authored_2`) in `project_fixture`. It has one `toolCall` step that calls `add` with 2 and 3, followed by an assertion that `add` was called. I ran it with `mcpjam cloud eval run --suite "Arithmetic add deterministic" --wait`, and the report is saved in `/workspace/report.json`.
> 
> To repeat it:
> ```
> npx -y @mcpjam/cli@latest --quiet cloud eval run --project project_fixture --suite "Arithmetic add deterministic" --wait --reporter json-summary --out report.json
> ```
> The suite definition is `/workspace/suite.json`. Re-running `cloud eval create` with it would add another suite rather than update this one.
> 
> **Concerns.**
> - **Prompt-based suite refused:** I first built a suite where a model prompts the tool. The run was refused with `FEATURE_NOT_SUPPORTED`: this account only supports deterministic `toolCall` steps and a limited set of assertions. So I have not tested anything that needs a model to choose the tool.
> - **Suite format found by trial and error:** I had to find the required fields by trying and fixing validation errors: `steps[].id`, and `serverName` on `toolCall` steps. The docs I read showed the local YAML format, not this create-API JSON shape, and I did not find a schema page. A documented example of that JSON would have saved several attempts.
> - **Server connect not implemented:** `cloud projects servers connect` returned "route not implemented", which didn't matter since the server was already saved.
> - **Leftover suite:** I created `suite_authored_1`, the prompt-based one that can't run. It is still in the project and can be deleted.

Source: [Published run evidence](../baseline-priority-v13--healthy__9ZDP5bv/index.md), public step 17.

## baseline-priority-v13 / healthy__aNWS6j4 (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2", "run_fixture_4"], "cli_eval_evidence_ids": ["acdc0da38bca451584ec71c7b95c8302", "f3e0ed2eede54a8490cd0afa67d59dc9", "8d9d46cdfd844049a29a19956d7099b6", "ac3db08e1cb1418b8ccd561f732b8cef", "90de452851074b0a95b31f7f440f7a29", "5c8f520090994b85a9b2466909a29e01"], "first_simulated_eval_seconds": 114.1640133857727, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 4, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "cloud servers list guessed incorrectly; raw usage error then public-help discovery. File schema rejected toolWorkflow/missing model with concrete validation pointers."
  ],
  "fixture_observations": [
    "Unsupported assertion subset caused valid product suite launch rejection; exclude this from product execution defects."
  ],
  "negative_control": {
    "passed": true,
    "event_id": "8d9d46cdfd844049a29a19956d7099b6",
    "evidence": "Wrong-answer control CLI exit1; private run_fixture_3 failed, surrounding run_fixture_1,2,4 passed."
  },
  "same_work_preserved": "Saved canonical suite steps match private executed suite; server Arithmetic exists; script rerun succeeds.",
  "duplicate_charge_interpretation": "Four distinct deliberate launches: initial, tightened assertion, negative control, final reproducibility rerun. No duplicate charge IDs."
}

> Concern: I expected the cloud CLI to offer `servers list`, but it rejected that command. I’m checking its documented command names. The docs also say local evaluations cannot assert tool-result contents, so I’ll check the hosted workflow to validate the sum itself.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__aNWS6j4/index.md), public step 13.

> Concern: the validator rejected my proposed `toolWorkflow` mode and required a model field. The docs didn’t make that requirement clear for a case containing only a direct tool call. I corrected the file; it now passes validation against the project’s live tool catalog, and the hosted run is underway.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__aNWS6j4/index.md), public step 20.

> Concern: validation passed, but execution refused the case because this isolated deployment supports only a subset of assertions. The error says no charge occurred, but doesn’t identify the unsupported field. I’ll try a documented `toolResultContains` assertion.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__aNWS6j4/index.md), public step 21.

> The evaluation passed, and its recorded tool result confirms `sum: 5`. MCPJam labels the run as simulated deterministic execution with no hosted model or live billing. I’ll tighten the content assertion and run a wrong-answer control to check that it detects a regression.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__aNWS6j4/index.md), public step 23.

> Set up MCPJam and validated the server:
> 
> - Connection ready; `add(2,3)` returned `{"sum":5}`.
> - Repeatable evaluation passed, including a rerun (`run_fixture_4`).
> - Wrong-answer control failed with exit code `1`, confirming the assertion catches a mismatch.
> 
> Reproduce with `npm ci && npm run eval` using the configured environment variables.
> 
> Saved [instructions](/workspace/README.md), [evaluation suite](/workspace/.mcpjam/evals/arithmetic.json), and [passing report](/workspace/artifacts/eval-report.json).
> 
> These were simulated deterministic runs; they do not measure LLM tool-selection accuracy.

Source: [Published run evidence](../baseline-priority-v13--healthy__aNWS6j4/index.md), public step 26.

## baseline-priority-v13 / credits__qc4mKtM (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 50.9646201133728, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Normal API recovery completed with captured repeatable request and stored result; no CLI or saved runnable script, raw0 retained.",
  "credits_cost_actor": {
    "cause": "PLATFORM_FEE_REQUIRED recognized, but unqualified claim account has no credits goes beyond response.",
    "knowledge": "Balance and cost stated missing; expected free/low-cost deterministic run. BYOK does not cover evals is overbroad relative to local BYOK contract.",
    "actor": "Team owner correctly waits synthetic account adjustment; unverified admin/Request credits paths should not be treated as tested role coverage.",
    "handoff": "No purchase, waits notice."
  },
  "same_work_preserved": "Saved run1/run2/result text; captured request reused same suite_fixture/server_fixture, ledger confirms single successful run. No saved script.",
  "fixture_observations": [
    "Usage/billing routes unsupported; unscoped status404 corrected with project path."
  ],
  "duplicate_charge_interpretation": "One refusal then one charged successful run.",
  "evidence_ids": [
    "59e51a00ac614797947a973feae90635"
  ]
}

> Blocked with `PLATFORM_FEE_REQUIRED`. I'll check the docs for what it means and what to do next.

Source: [Published run evidence](../baseline-priority-v13--credits__qc4mKtM/index.md), public step 10.

> Here is where things stand, with the concern note first.
> 
> **Concern note**
> - **Expected:** a free or low-cost deterministic eval run, and a way to read usage, credits and cost beforehand.
> - **Observed:** the usage, credits, billing, account and spend-budget routes all return `NOT_FOUND` on this fixture. The only cost-related data is the `team` plan, owner role, and empty plan limits from `/capabilities`. `POST /projects/project_fixture/eval-runs` for `suite_fixture` returned 403 `FORBIDDEN` with `PLATFORM_FEE_REQUIRED` ("requires platform credits").
> - **Missing:** the credit balance and the expected cost per run. The suite's single case is a tool call with no model step, but the platform still wants a fee.
> - **Next:** I'm stopping here, because the only fixes are buying credits or changing billing, and the task says not to purchase anything. I'll retry once you tell me the account issue is resolved.
> 
> **Blocker and next action**
> - The reason is `PLATFORM_FEE_REQUIRED`: the organization (`org_fixture`, team plan) has no platform credits for MCPJam-billed work.
> - The docs say a paid-plan owner or admin can use **Buy credits** to add shared credits. A member would use **Request credits**.
> - Bring-your-own-key doesn't cover evals.
> - Buying credits won't restart anything on its own. A new run has to be started afterward.
> - My account is the team owner, so I could add credits. I haven't, since purchases are out of scope. Please add the synthetic credits, or confirm it's done.
> 
> Nothing was spent on this attempt. The commands I ran are in this session, and the 403 response is saved at `/workspace/run1.txt`. Tell me when the account is resolved and I'll rerun the same request and poll `GET /eval-runs/{runId}` until it finishes.

Source: [Published run evidence](../baseline-priority-v13--credits__qc4mKtM/index.md), public step 11.

> The evaluation ran and passed after the account fix.
> 
> **Concern note**
> - **Expected:** the same `POST /projects/project_fixture/eval-runs` request would now be accepted.
> - **Observed:** it returned 202 with `run_fixture_1`. My first status poll used the unscoped path `/eval-runs/{id}`, which returned `NOT_FOUND`. The project-scoped path `/projects/project_fixture/eval-runs/{id}` worked.
> - **Still missing:** the credit balance, spend budget and per-run cost. Those routes aren't implemented on this fixture, so I can't say what the run cost. The run's notes say "SIMULATED… no hosted model or live billing."
> - **Next:** nothing is pending.
> 
> **Result**
> - The run `run_fixture_1` completed with result `passed`: 1 of 1 passed, pass rate 1.0.
> - The case "add 2 and 3 returns 5" called `add(2,3)` and got `{"sum": 5}` in 1 ms.
> 
> **Reproduce**
> ```bash
> curl -X POST -H "Authorization: Bearer $MCPJAM_API_KEY" -H "Content-Type: application/json" \
>   -d '{"suiteId":"suite_fixture","serverIds":["server_fixture"]}' \
>   $MCPJAM_API_URL/projects/project_fixture/eval-runs
> curl -H "Authorization: Bearer $MCPJAM_API_KEY" $MCPJAM_API_URL/projects/project_fixture/eval-runs/<runId>
> ```
> 
> The blocked attempt is saved in `/workspace/run1.txt`. The successful launch is in `/workspace/run2.txt` and the final run status is in `/workspace/result.txt`. I didn't write a script file, so the two commands above are the repeatable form.

Source: [Published run evidence](../baseline-priority-v13--credits__qc4mKtM/index.md), public step 16.

## baseline-priority-v13 / healthy__8heHuhR (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2"], "cli_eval_evidence_ids": ["f2b4e2793025416a81387dbb71785504", "6010ecdb744347b1a653e5e20d4c31b0", "ab88068bdfad46bd94d8c25cc68b9db4", "7728777af1284fc98b882ff9700a84bf"], "first_simulated_eval_seconds": 107.23586010932922, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 2, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Baseline cloud link --project failed. Tester sought command help, used positional project_fixture, and linked successfully."
  ],
  "fixture_observations": [
    "Prompt execution unsupported",
    "Per-step evidence endpoint unimplemented"
  ],
  "credits_cost_actor": "Not credits task; recognized simulation and no broad conformance claim.",
  "syntax_remedy_outcome": {
    "kind": "baseline",
    "completed": true,
    "evidence_event_ids": [
      "07a1219a8aba4d9ab37d8704b5b4cf08",
      "74d8983d7f1847a58c506c10833cf219",
      "61389d893d624de29f6fe83292f86b8d"
    ],
    "interpretation": "User independently requested help and corrected positional syntax; establishes baseline recovery without injected remedy."
  },
  "same_work_preserved": "Saved YAML exact steps match private persisted suite and both runs; npm test reproduction reran same suite.",
  "human_action": "None needed.",
  "duplicate_charge_interpretation": "Two intentional executions to test repeatability, two unique charges; no retry duplication observed.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> The server connects successfully and exposes one tool, `add`, with two numeric inputs. I’ll call it with known values and use the returned sum as an evaluation assertion.
> 
> Concern: I expected the project-link command to accept `--project`, but the installed CLI rejected that flag. I’ll check its help and keep project scope explicit on subsequent commands.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__8heHuhR/index.md), public step 13.

> The first useful result is confirmed: `add(2, 3)` returned `{"sum":5}`.
> 
> Concern: the suite validated, but execution was refused because this deployment supports deterministic tool calls and assertions, not hosted prompt/model execution. The response says no charge occurred. I’ll replace the prompt with a direct tool call and rerun it.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__8heHuhR/index.md), public step 18.

> The deterministic evaluation passed: its recorded tool call used `a: 2, b: 3`, returned `sum: 5`, and reported no tool error. MCPJam labels this as simulated fixture execution. I’ll save a rerun command and the evidence; this confirms the smoke test, but doesn’t establish broader protocol conformance.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__8heHuhR/index.md), public step 23.

> The saved rerun command also passed, producing a second run of the same suite.
> 
> Concern: I expected the per-step endpoint to provide assertion-level evidence, but this deployment returned “route not implemented.” The run verdict and recorded tool result are available and saved; I’ll document that evidence limit.
> 

Source: [Published run evidence](../baseline-priority-v13--healthy__8heHuhR/index.md), public step 25.

> Installed MCPJam CLI 6.2.2 and validated the server connection.
> 
> - First result: `add(2, 3)` returned `{"sum":5}`.
> - Created a repeatable deterministic evaluation; both runs passed, **1/1**.
> - Rerun from `/workspace` with `npm ci && npm test`.
> 
> Saved the [evaluation](/workspace/.mcpjam/evals/arithmetic.yaml), [latest result](/workspace/reports/run.json), and [reproduction notes](/workspace/README.md).
> 
> Deployment limits: hosted prompt execution and per-step evidence were unavailable. Runs are explicitly labeled simulated fixture execution; full protocol conformance remains untested.

Source: [Published run evidence](../baseline-priority-v13--healthy__8heHuhR/index.md), public step 27.

## baseline-priority-v13 / healthy__9e6btMY (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": false,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Valid incomplete task: direct result achieved, Eval not executed.",
  "product_observations": [],
  "fixture_observations": [
    "Local test path rejects supplied non-loopback HTTP API URL; no matching BYOK key. Agent correctly avoided using unrelated provider credentials or bypassing URL guard. Cloud public API route could work but was not attempted."
  ],
  "same_work_preserved": "Saved arith.yaml and .mcp.json; no executed suite proof because no Eval.",
  "human_action": "Requests HTTPS/loopback API endpoint or appropriate model-provider key.",
  "duplicate_charge_interpretation": "No launches or charges."
}

> I got the server validated and wrote a repeatable eval suite, but I couldn't run it. Both inference modes are blocked.
> 
> **What worked**
> - `mcpjam server probe` shows the server is ready. It speaks streamable-http on protocol 2025-11-25, needs no OAuth, and is named `arithmetic-fixture`.
> - `mcpjam tools list` shows one tool, `add(a, b)`, which returns `{sum}`.
> - `mcpjam tools call` with `add` and `{"a":2,"b":3}` returned `{"sum":5}`.
> - `mcpjam cloud whoami` authenticates as `user_fixture` on the team plan.
> - `mcpjam cloud eval validate` accepts the suite as valid, with one case and no findings.
> 
> **Files in `/workspace`**
> - `.mcpjam/evals/arith.yaml` is the suite. Its one case asks "What is 17 plus 25? Use the tool." and asserts that `add` was called at least once.
> - `.mcp.json` binds the suite's `arith` server name to `http://fixture:8765/mcp`.
> 
> **To rerun after the blockers are fixed:**
> `mcpjam test .mcpjam/evals/arith.yaml --inference mcpjam --project project_fixture --reporter junit-xml --out reports/arith.xml`
> 
> **Concern note**
> - **Expected:** `mcpjam test` would run the suite using MCPJam-hosted inference, since the account has synthetic credits.
> - **Observed with `--inference mcpjam`:** It failed with `OPTIONS_INVALID`. The CLI requires `https://` for the MCPJam API, with `http://` allowed only for loopback. `MCPJAM_API_URL` is `http://fixture:8765/api/v1`, which is neither. The self-hosted docs describe the same rule. `whoami` still worked over that URL, so only `test` enforces it.
> - **Observed with `--inference byok`:** It failed with `CREDENTIALS_MISSING`. The environment has no `ANTHROPIC_API_KEY`, and the suite's model is `anthropic/claude-haiku-4.5`. Three environment variables matched my search for `ANTHROPIC` or `OPENAI`. I didn't check which ones, so one may be an OpenAI key.
> - **Missing:** Either an `https://` or loopback MCPJam API URL, or a provider key for the model.
> - **Not tried:** I could have put a loopback port-forward in front of the fixture API, but that would bypass a deliberate guard on sending the API key over plain http. I didn't do it without your approval.
> - **Next options:**
>   - Get an `https://` or loopback `MCPJAM_API_URL`, then run the command above.
>   - If one of those variables is an OpenAI key, change `defaults.model` to an OpenAI model and run with `--inference byok`.
> 
> I used 8 of the 40 shell commands.

Source: [Published run evidence](../baseline-priority-v13--healthy__9e6btMY/index.md), public step 10.

## baseline-priority-v13 / credits__BkqRPJ9 (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 50.47176146507263, "credit_refusals": 2, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "API recovery confirmed, but no CLI Eval or recognized reproduction artifact.",
  "product_observations": [
    "Repeated same platform-credit request once before resolution despite no account-change signal (2 refusals).",
    "Correct owner/human boundary and unknown-cost statement."
  ],
  "fixture_observations": [
    "Usage/budget endpoints unavailable",
    "Initial unscoped polling path corrected to project-scoped public API path"
  ],
  "credits_cost_actor": {
    "balance": "unknown_acknowledged",
    "cost": "unknown_acknowledged",
    "cause": "platform credits",
    "actor": "paid-plan team owner, synthetic environment resolution",
    "handoff_correct": true
  },
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "Captured identical suiteId launch request before/after; persisted suite and raw response files. No runnable script saved.",
  "human_action": "Stopped after two refusals, resumed on explicit notice.",
  "duplicate_charge_interpretation": "Two refusals charged nothing; one accepted run/one unique charge after resolution.",
  "key_evidence_event_ids": [
    "228d0b2058714d79b715d6ffcb00db77",
    "606aa91ffae740be8990316910a70325",
    "1783dad8bedb46bfa826063ba46c11f8"
  ],
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> I'll start with the public docs and the account API, checking usage and credits before I run anything.

Source: [Published run evidence](../baseline-priority-v13--credits__BkqRPJ9/index.md), public step 2.

> The run is blocked with `PLATFORM_FEE_REQUIRED`. I'll check the error-code docs for the next step.

Source: [Published run evidence](../baseline-priority-v13--credits__BkqRPJ9/index.md), public step 10.

> The eval did not run. The hosted run request is still blocked, and nothing in this session has said the account issue is resolved.
> 
> **What I found**
> - **Account:** the organization is `org_fixture`, on the team plan, and I'm the owner. The project is `project_fixture`, and its one suite is `suite_fixture` ("Arithmetic smoke": add 2 and 3, expect 5).
> - **Usage, credits and cost:** I couldn't read any of these. `/usage`, `/credits`, `/billing` and `/organizations/org_fixture/spend-budget` all return NOT_FOUND from this fixture. The docs list a spend-budget endpoint, but it isn't available here. I have no cost estimate.
> - **Block:** `POST /projects/project_fixture/eval-runs` with `{"suiteId":"suite_fixture"}` returns 403 `PLATFORM_FEE_REQUIRED` ("This work requires platform credits"). I tried it twice, and the second response was identical. The responses are saved in `/workspace/run1.txt` and `/workspace/run2.txt`.
> - **Next action:** the error-code docs say a paid-plan owner can use **Buy credits** to add shared credits. Another option is to run the suite locally with your own model key (`mcpjam test`), though the docs say that doesn't cover MCPJam-billed features. I did neither, because buying anything is off-limits.
> 
> **Resuming:** when the environment says the issue is resolved, I'll resend the same request and poll `GET /eval-runs/{runId}` until the run reaches a final status. The docs say that a run that stopped for lack of credits doesn't restart on its own, so it has to be a new run.
> 
> **Concern:** I can't confirm the credit balance, and I have no signal that the block has been lifted. I'm not retrying in a loop. I'll retry once I'm told the issue is fixed.

Source: [Published run evidence](../baseline-priority-v13--credits__BkqRPJ9/index.md), public step 12.

> The eval ran and passed after the account issue was resolved.
> 
> - **Run:** I sent the same request as before, `POST /projects/project_fixture/eval-runs` with `{"suiteId":"suite_fixture"}`. It returned 202 and run `run_fixture_1`. The earlier 403 `PLATFORM_FEE_REQUIRED` is gone.
> - **Result:** `run_fixture_1` completed with result `passed`, 1 of 1 cases (pass rate 1.0). The case "add 2 and 3 returns 5" called `add(a=2, b=3)` and got `{"sum": 5}`.
> - **Simulated:** the run's own notes say "SIMULATED: deterministic fixture execution; no hosted model or live billing." The pass shows the workflow works end to end, not that the real server was evaluated by a live model.
> - **Saved files:** the original block is in `/workspace/run1.txt` and `run2.txt`. The successful launch is in `run3.txt`, and the status and iteration results are in `result.txt`.
> 
> **Concern:** I still couldn't read the balance, usage or cost, so I can't say how many credits the run used. I also first polled `/eval-runs/{runId}`, which this fixture doesn't implement, and the project-scoped path `/projects/{projectId}/eval-runs/{runId}` worked. If you need cost figures, someone will have to check the credit balance in the MCPJam app.

Source: [Published run evidence](../baseline-priority-v13--credits__BkqRPJ9/index.md), public step 17.

## baseline-priority-v13 / credits__pMa3zdp (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 206.7198987007141, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Normal public API recovery achieved; narrow CLI matcher misses API runner, raw reward remains0.",
  "credits_cost_actor": {
    "cause": "403 PLATFORM_FEE_REQUIRED identified",
    "knowledge": "Balance and expected cost unknown, not inferred zero; one rejected launch before change.",
    "actor": "Confirmed Team owner; documented Buy credits/Top up; trial waits orchestrator simulated resolution.",
    "handoff": "No purchase or live billing contact."
  },
  "fixture_observations": [
    "Account, model, disclosure/decision-summary routes unsupported; numeric balance/cost unavailable due bounded fixture."
  ],
  "same_work_preserved": "run-eval.py/api.py byte-identical across phases; saved launch.json and private suite_fixture/run_fixture_1 confirm original add2+3 task.",
  "duplicate_charge_interpretation": "One charged run; repeated identical idempotent request returns same run, no second charge.",
  "evidence_ids": [
    "8d45666c05864138ac8aaa6f1b7a0210"
  ]
}

> I’ll check the public docs and account’s usage and credits, then run a repeatable evaluation within the time budget. I’ll save the commands and results under `/workspace` and won’t buy credits or contact production billing.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 6.

> The saved suite checks that `add(2, 3)` returns `5`. I expected the documented account endpoints to provide spend and model information, but this environment returns “route not implemented.” Credits and expected cost are still unknown; I’ll check the normal account interface next.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 14.

> The evaluation was blocked before execution: HTTP 403 with `PLATFORM_FEE_REQUIRED`. I expected the saved suite to launch; the response says platform credits are required, but gives no balance or fee amount. As a Team owner, the documented next action is **Buy credits**. For this synthetic trial, I’ll wait for the environment to report the account issue resolved, then retry the saved request.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 17.

> The repeatable runner and evidence are saved in `/workspace/mcp-eval`. The launch was refused without a run ID. Balance and cost remain unavailable, and I haven’t received an account-resolution report yet; once it arrives, I’ll retry the same request using its idempotency key.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 24.

> Evaluation blocked before execution: `403 FORBIDDEN`, reason `PLATFORM_FEE_REQUIRED`.
> 
> - Confirmed Team owner account; suite tests `add(2, 3) → 5`.
> - Usage, available credits, and exact cost remain unknown: account endpoints returned 404.
> - Your documented account action is **Buy credits/Top up**. No purchase or billing contact was made.
> - Saved the [repeatable runner and evidence](/workspace/mcp-eval/README.md).
> 
> Awaiting the environment’s synthetic-credit resolution report; then I can retry the original request safely. [Billing documentation](https://docs.mcpjam.com/hosted/overview#billing).

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 25.

> I’ll retry the preserved evaluation request, then check its verdict, execution evidence, and any reported usage or cost.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 27.

> The resumed run completed: 1 of 1 cases passed, with `add(2, 3)` returning `{"sum": 5}`. The environment labels this simulated execution with no hosted model or live billing, and its decision-summary endpoint is unavailable. I’ll preserve that limitation and check the remaining evidence and account endpoints.
> 

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 28.

> Resumed successfully. Run `run_fixture_1` **passed 1/1 cases**: `add(2, 3)` returned `5`. Replaying the request returned the same run, confirming idempotency.
> 
> The environment reports simulated execution with no hosted model or live billing. Exact credits and cost remain unavailable.
> 
> Saved the [repeatable runner and evidence](/workspace/mcp-eval/README.md) and [result](/workspace/mcp-eval/result.json).

Source: [Published run evidence](../baseline-priority-v13--credits__pMa3zdp/index.md), public step 30.

## baseline-priority-v13 / credits__GNYWrm4 (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 62.96158742904663, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Saved shell script runs CLI successfully, but invocation-text predicate misses it. Private ledger and subsequent CLI status confirm passed run.",
  "product_observations": [
    "Baseline raw fee error reached tester; public note explicitly says exact billing page missing.",
    "Correct owner boundary, but repeats server fallback suggestion that admin can buy; actual permission not tested.",
    "Initial --server fixture=URL selection corrected to saved server ID."
  ],
  "fixture_observations": [
    "Usage/balance routes unavailable"
  ],
  "credits_cost_actor": {
    "balance": "unknown_acknowledged",
    "cost": "unknown_acknowledged",
    "cause": "platform credits",
    "actor": "team owner; generic billing settings, exact page unknown",
    "handoff_correct": true
  },
  "syntax_remedy_outcome": {
    "completed": true,
    "evidence_event_ids": [
      "f63e21af279048bb86e627534a5dcb7a"
    ],
    "interpretation": "Corrected server selector to server_fixture before account refusal; no patched help involved."
  },
  "same_work_preserved": "run_eval.sh byte-identical across phases; launch and status both confirmed run_fixture_1.",
  "human_action": "Waited after one fee refusal; resumed once notified.",
  "duplicate_charge_interpretation": "One refusal, one accepted run, one charge.",
  "key_evidence_event_ids": [
    "f63e21af279048bb86e627534a5dcb7a",
    "ff6ce67d7d8d4773be8ba5f392a57996",
    "3b21d47720c942acb504f1588171c6e8"
  ],
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "No source/private-path candidates in shell or ATIF tool-call scans."
  }
}

> I'll start by checking the public docs and the account API for usage and credits.

Source: [Published run evidence](../baseline-priority-v13--credits__GNYWrm4/index.md), public step 2.

> Credits and usage aren't exposed through the routes I tried. I'll run the existing suite against the MCP server and see whether billing blocks it.

Source: [Published run evidence](../baseline-priority-v13--credits__GNYWrm4/index.md), public step 8.

> The eval run is blocked: it needs platform credits, so no run happened and no cost was incurred. Nothing has told me the account issue is resolved, so I haven't retried.
> 
> **What I found**
> - **Account:** `user_fixture` on the `team` plan, in `org_fixture`, project `project_fixture`, authenticated with an API key.
> - **Eval target:** suite `suite_fixture` ("Arithmetic smoke": add 2 and 3, assert 5) and saved server `server_fixture` ("Arithmetic").
> - **Usage, credits and cost:** I couldn't get any of these. The `/usage`, `/credits` and `/billing` routes on the account API all returned NOT_FOUND. I found no CLI command that shows a balance. The docs say hosted runs spend model credits per target × iteration, but I found no per-run price or estimate.
> - **Block:** `cloud eval run` failed with `FORBIDDEN` and reason `PLATFORM_FEE_REQUIRED`: "This work requires platform credits."
> - **Next action:** as team owner, add credits (or have an org admin do it) in the hosted app's billing settings. I didn't buy anything.
> - **MCP server:** `http://fixture:8765/mcp` responds, but I could only confirm it with a plain GET, which returned 405.
> 
> **Concern note**
> - **Expected:** a visible credit balance and cost estimate before running.
> - **Observed:** no balance or cost information anywhere, and the run was refused for lack of credits.
> - **Missing:** the current balance, the price per run, and the exact billing page.
> - **Next:** once you tell me credits were added, I'll rerun `/workspace/run_eval.sh`.
> 
> My first attempt used `--server fixture=<url>`, which the CLI rejected. The saved server has to be passed by ID, as `run_eval.sh` does.
> 
> The rerun script is `/workspace/run_eval.sh`, and my findings are in `/workspace/NOTES.md`.

Source: [Published run evidence](../baseline-priority-v13--credits__GNYWrm4/index.md), public step 11.

> The evaluation ran and passed: 1 of 1 trial, pass rate 100%.
> 
> - **Run:** `run_fixture_1` of suite `suite_fixture` ("Arithmetic smoke") against server `server_fixture`. It started on the first retry and finished as completed, with verdict passed and no failure diagnostics.
> - **Repeat it:** run `/workspace/run_eval.sh`, then check the result with `npx -y @mcpjam/cli cloud eval status --run <runId>`.
> - **Saved output:** `run3.log` holds the start output and `status.log` holds the final status.
> - **Simulated result:** the status notes say "SIMULATED: deterministic fixture execution; no hosted model or live billing." So the pass shows the workflow works end to end, but it isn't evidence about a real model or real credit spend.
> 
> **Concern note**
> - **Expected:** the retry to work once credits were added, and some visible credit cost.
> - **Observed:** the retry worked on the first attempt. The run reported no credit cost, and I still never found a balance or per-run price.
> - **Missing:** the credit balance and per-run cost, which I couldn't read through any route or CLI command I tried.
> - **Next:** if you want the actual cost, check the billing page in the hosted app before and after a run.

Source: [Published run evidence](../baseline-priority-v13--credits__GNYWrm4/index.md), public step 16.

## baseline-auth-v13 / auth__DebKeUR (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 6, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 53.94046950340271, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 2, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "successful_recovery true, ledger authenticated calls and saved cli-add.json sum5; frozen invocation matcher misses CLI command through shell variable, raw0 unchanged.",
  "product_observations": [
    "Doctor before token reports oauth_required; after supplied token ready. Same original config preserved and reproduction scripts saved.",
    "Conformance wire-schema-valid grades JSON body of permitted GET405 as JSON-RPC; official 2025-11-25 transport spec permits GET405. Source responseMessages blindly includes response.json regardless HTTP status, making a likely checker false positive; left as unfixed backlog."
  ],
  "fixture_observations": [
    "Extra tool argument accepted despite additionalProperties false, genuine fixture validation defect.",
    "Suite PATCH returns success without persisting selection; trace/conformance upload/API tool-call routes unavailable."
  ],
  "same_work_preserved": "mcp.original.json preserved alongside current config; cli-add.json actualsum5; private six successful tool calls and two completed API Evals; reproduction shell saved.",
  "duplicate_charge_interpretation": "Two deliberate saved-suite tests, two unique charges.",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "conformance": {
    "executed": true,
    "event_id": "4041f55bce9447e79b26d4132ea0afc8",
    "exit_status": 1,
    "report": "validation/protocol-conformance.json",
    "applicable": 14,
    "passed": 13,
    "failed": 1,
    "not_applicable": 30,
    "failed_check": "wire-schema-valid",
    "official_spec": "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#listening-for-messages-from-the-server",
    "source": "sdk/src/mcp-conformance/wire-observations.ts responseMessages returns response.json without status filtering"
  },
  "human_action": "No account-owner action needed for token recovery; remaining fixture/checker changes outside tester scope."
}

> The smoke run passed, with a recorded `add(2, 3)` result of `5`; MCPJam labels it simulated execution. The tool-call, trace, and conformance API endpoints also returned 404, and the suite update returned success without reflecting the requested selection. I’ll use the local MCPJam CLI to check the server directly.
> 

Source: [Published run evidence](../baseline-auth-v13--auth__DebKeUR/index.md), public step 17.

> Validation results and reproduction scripts are saved in [validation/README.md](/workspace/validation/README.md).
> 
> - Authentication recovered using the supplied token.
> - Six arithmetic checks passed; extra fields are incorrectly accepted.
> - Conformance: 13/14 applicable checks passed. The remaining failure appears to be a checker false positive: HTTP 405 is [permitted by MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
> - Two simulated hosted smoke runs passed.
> - Several API routes are unavailable; suite updates did not persist.
> 
> Original configuration preserved. No account-owner action is needed. Remaining fixes require server and MCPJam maintainers; exact evidence and steps are documented.

Source: [Published run evidence](../baseline-auth-v13--auth__DebKeUR/index.md), public step 26.

## baseline-auth-v13 / auth__HzCGt8k (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": null,
  "outcome_class": "provider_blocked",
  "attribution_tags": [
    "provider"
  ],
  "strict_reward_caveat": "Harbor raw reward0 retained; exception policy has_valid_reward=false. Not an observed product failure or comparable auth outcome.",
  "provider_observation": "Claude first-party OAuth access token expired, HTTP401; no tester success claim accepted.",
  "product_observations": [
    "One fixture MCP_AUTH_REQUIRED refusal before provider failure; no authenticated tool or recovery completed."
  ],
  "same_work_preserved": "No completed recovery; no runnable task artifact.",
  "duplicate_charge_interpretation": "No product charges.",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "conformance": "No conformance execution observed."
}

> Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.

Source: [Published run evidence](../baseline-auth-v13--auth__HzCGt8k/index.md), public step 5.

## heldout-discovery-v13 / discovery__gvhHS8f (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 14, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": null,
  "discovery": {
    "entry": "Public MCPJam documentation",
    "installed_cli": true,
    "natural_eval_discovery_observed": false,
    "eval_run_observed": false,
    "first_value": "Doctor/tool calls; independently rerunnable Python script checks arithmetic and schema rejection."
  },
  "fixture_observations": [
    "AdditionalProperties false advertised but extra arguments accepted; saved result7/8 cases pass, overall script exit1 correctly preserves defect."
  ],
  "same_work_preserved": "mcp-check/check.py, README, results/summary.json and RPC traces saved; private calls confirm tests executed.",
  "conformance": "No MCPJam conformance invocation; custom arithmetic checks are not conformance.",
  "duplicate_charge_interpretation": "No hosted runs/charges; no credit claim inferred from private balance change.",
  "human_action": "Fixture maintainer needed for extra-argument enforcement, not account owner.",
  "build_delivery_caveat": {
    "assigned": "patched_cycle2",
    "observed": "public npm archives, not fixture pinned packages",
    "evidence_event_id": "bfb941bf7f244003a5caec7a7c2d7b4a",
    "lockfile": "artifacts/workspace/mcp-check/package-lock.json",
    "resolved_cli": "https://registry.npmjs.org/@mcpjam/cli/-/cli-6.2.2.tgz",
    "resolved_sdk": "https://registry.npmjs.org/@mcpjam/sdk/-/sdk-10.7.0.tgz",
    "interpretation": "Usable unguided discovery observation; exclude from pinned cycle2 treatment effect. npm --prefix plausibly changes global npmrc selection; cause inferred, not independently probed."
  }
}

> Tested using MCPJam’s [documented CLI](https://docs.mcpjam.com/cli/server-inspection). The server connects successfully; **7 of 8 checks passed**.
> 
> Found one issue: `add` accepts extra arguments despite declaring `additionalProperties: false`.
> 
> Saved [reproduction instructions](/workspace/mcp-check/README.md), [results](/workspace/mcp-check/results/summary.json), and RPC traces.
> 
> Rerun:
> 
> ```bash
> cd /workspace/mcp-check
> python3 check.py
> ```
> 
> It exits `1` while the schema mismatch remains. No credits were spent.

Source: [Published run evidence](../heldout-discovery-v13--discovery__gvhHS8f/index.md), public step 25.

## heldout-discovery-v13 / discovery__pXszNVb (claude-code)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 3, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "duplicate_charge_interpretation": "No hosted runs or product charges.",
  "conformance": "No actual conformance run observed; doctor and tool calls only.",
  "attribution_tags": [
    "fixture"
  ],
  "strict_reward_caveat": null,
  "discovery": {
    "entry": "public MCPJam docs",
    "installed_cli": true,
    "natural_eval_discovery_observed": false,
    "eval_run_observed": false,
    "first_value": "doctor ready and direct add calls, saved run.sh/results.txt"
  },
  "fixture_observations": [
    "Finite input1e308+1e308 overflows sum; fixture serializes Infinity, invalid JSON. CLI returns INTERNAL_ERROR with parse cause. No product parser defect established."
  ],
  "same_work_preserved": "Saved runnable run.sh and results.txt reproduce valid/invalid/overflow inputs; private successful calls confirm execution, though overflow counts as fixture success internally and must not count as valid output.",
  "human_action": "Maintainer change needed for fixture finite-result validation, beyond assigned tester surface.",
  "evidence_ids": [
    "e864742c2bac4d368d0058065236ffdf",
    "8a5b3f9f608b4a7c96ec93b7fffc6fcc"
  ]
}

> **Result: the server mostly works, but it has one bug.** I ran a handshake check and five `add` calls against it with the MCPJam CLI. The overflow case returns invalid JSON.
> 
> **Concern note:** I expected every call to return a valid result or a clean tool error. The overflow case did not. `add(1e308, 1e308)` overflows to infinity. The server sends the unquoted token `Infinity` in the response body, which is not valid JSON, and the client throws `INTERNAL_ERROR: Unexpected token 'I'`. The tool says it only accepts finite numbers, but it doesn't check that the sum is finite. Nothing was missing from the docs. Next I would reject non-finite results with `isError: true`, then re-run `bash /workspace/run.sh`.
> 
> **What I ran:** I followed the docs at docs.mcpjam.com, installed `@mcpjam/cli`, and used `mcpjam server doctor` and `mcpjam tools call`.
> 
> **Handshake check:** `mcpjam server doctor` reports status `ready`. The server is `arithmetic-fixture` 1.0.0 on streamable-http, protocol 2025-11-25. It exposes one tool, `add`, and no resources or prompts. There is no OAuth. The `skills` check was skipped because the server doesn't declare the extension, which is expected.
> 
> **`add` calls:**
> 
> | Input | Output |
> |---|---|
> | `{"a":2,"b":3}` | `{"sum":5}` (correct) |
> | `{"a":-1.5,"b":0.25}` | `{"sum":-1.25}` (correct) |
> | `{"a":"x","b":1}` | `isError: true`, "a and b must be finite numbers" (correct) |
> | `{"a":1}` (missing `b`) | `isError: true`, same message (correct) |
> | `{"a":1e308,"b":1e308}` | **fails**, see the concern note above |
> 
> **Reproduce:** run `bash /workspace/run.sh`. It writes the handshake report to `/workspace/doctor.json`. The call outputs from my run are in `/workspace/results.txt`.
> 
> I stayed within budget and did not use the MCPJam account API.

Source: [Published run evidence](../heldout-discovery-v13--discovery__pXszNVb/index.md), public step 6.

## patched-cycle2-auth-v13 / auth__3bkokhu (claude-code)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 2, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "duplicate_charge_interpretation": "No hosted runs or product charges.",
  "conformance": "No actual conformance run observed; doctor and tool calls only.",
  "attribution_tags": [
    "product"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Unauthenticated401 diagnosed, suppliedtoken yielded doctorready and two valid tool results. Original config unchanged and auth passed only through environment token.",
    "npx --no-install mcpjam --help attempted npm unscoped package and received E404; @mcpjam/cli worked. Distinguish command name from distribution name; fresh supplemental finding, no further fix cycle."
  ],
  "same_work_preserved": "mcp.json retained, doctor.json and tools-calls.log saved. No standalone runnable script saved; strict artifact matcher accepted original config.",
  "human_action": "None for recovered validation; other users of config must supply token.",
  "evidence_ids": [
    "7fd715c741394f89a0a9df60caf12af7",
    "6826495b452144d6ab3bca05e4115e35"
  ]
}

> Validation of the MCP server passed.
> 
> - **Connection:** `mcpjam server doctor` reported `ready`. The server is `arithmetic-fixture` 1.0.0, using streamable-http with protocol 2025-11-25. It has one tool, `add`, and no resources or prompts.
> - **Tool calls:**
>   - `add(2, 3)` returned `{"sum": 5}`.
>   - `add(1.5, -4)` returned `{"sum": -2.5}`.
>   - `add("x", 1)` returned `isError: true` with "a and b must be finite numbers", which is the right rejection.
> - **Saved work:** `/workspace/doctor.json` (full doctor report with RPC logs) and `/workspace/tools-calls.log`.
> 
> **Concern notes:**
> - **Missing auth in config:** `/workspace/mcp.json` has no auth header, and the server returns 401 without a token. I passed `MCP_SERVER_TOKEN` through `--access-token` instead, and did not change the config. Anyone reusing that config needs the token supplied the same way.
> - **Docs and package name:** the docs name the CLI `mcpjam`, but that name isn't on npm. I used `@mcpjam/cli` through `npx`, which worked.
> - **MCPJam account API:** I didn't use it, because the CLI checks needed no account actions. I haven't saved results to the MCPJam project (`project_fixture`).
> 
> I made no changes that need the account owner.

Source: [Published run evidence](../patched-cycle2-auth-v13--auth__3bkokhu/index.md), public step 7.

## patched-cycle2-auth-v13 / auth__MV27c9o (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 9, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 60.16257953643799, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "attribution_tags": [
    "fixture",
    "product"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Missing auth recovered with suppliedtoken; directCLI tests succeeded.",
    "Fresh cycle2 actual protocol conformance passed14/14 applicable,30N/A; wire-schema-valid passed with GET405 preserved on fixture. This directly exercises the corrected behavior."
  ],
  "fixture_observations": [
    "Initial existing hosted suite simulated; missing diagnostic APIs bypassed using normal local CLI."
  ],
  "same_work_preserved": "validation/validate.sh tested and saved alongside README, conformance.json, case reports; existing config retained; private directcalls and one hostedrun confirm task.",
  "conformance": {
    "executed": true,
    "event_id": "c6bcc98b46d84dfe9ac1927b2aece8ec",
    "exit_status": 0,
    "report": "validation/conformance.json",
    "applicable": 14,
    "passed": 14,
    "failed": 0,
    "not_applicable": 30,
    "wire_schema_status": "passed"
  },
  "duplicate_charge_interpretation": "One simulated hostedrun/uniquecharge; no repeated charge.",
  "human_action": "No human needed."
}

> The saved smoke suite passed: `add(2, 3)` returned `5`. Its run record explicitly labels the execution as simulated, so it does not establish live MCP connectivity. Several diagnostic routes are also unavailable. I’ll use MCPJam’s local CLI to check the server directly.
> 

Source: [Published run evidence](../patched-cycle2-auth-v13--auth__MV27c9o/index.md), public step 18.

> Validation completed using MCPJam.
> 
> - Authenticated connection succeeded.
> - Protocol checks: 14 passed, 30 not applicable.
> - Six arithmetic and invalid-input cases passed.
> - Recovered from missing authentication using `MCP_SERVER_TOKEN`, and bypassed unavailable API diagnostics with the local CLI.
> 
> Saved [results and limitations](/workspace/validation/README.md) and a tested [reproduction script](/workspace/validation/validate.sh). No credentials were stored. No human action is needed.

Source: [Published run evidence](../patched-cycle2-auth-v13--auth__MV27c9o/index.md), public step 28.

## patched-priority-v13 / credits__VeVnafu (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 55.160666704177856, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Public API recovery confirmed; no CLI launch criterion satisfied.",
  "product_observations": [
    "No patched CLI treatment exposure.",
    "BYOK-does-not-use-platform-credits statement overgeneralizes current platform-fee contract; alternative was not actually exercised.",
    "Public note invokes provider session $2 budget while deciding to launch unknown-cost product work; final notes separate session budget from unavailable product costs, so classify possible concept confusion, not measured overspend."
  ],
  "fixture_observations": [
    "Balance/budget/disclosure unavailable",
    "Initial unscoped status path404; corrected project-scoped route succeeded"
  ],
  "credits_cost_actor": {
    "balance": "unknown_acknowledged",
    "cost": "unknown_acknowledged",
    "cause": "platform fee identified",
    "actor": "owner; proposed add credits or raise allowance, broader than specific documented fee remedy",
    "handoff_correct": true,
    "remaining_confusion": [
      "BYOK/platform fees",
      "session budget versus product credits"
    ]
  },
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "Saved run-request.json reused; request identity hashes separately recorded.",
  "human_action": "Waited for explicit resolution and retried once; no purchase.",
  "duplicate_charge_interpretation": "One refusal then one accepted run/unique charge.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "No source/private-path candidates in shell or ATIF tool-call scans."
  }
}

> I'll start by checking the public docs and the account API for usage and credits.

Source: [Published run evidence](../patched-priority-v13--credits__VeVnafu/index.md), public step 2.

> Credits, budget and cost estimate aren't exposed by this fixture. The docs describe the run as a normal action on a synthetic account with a $2 budget, so I'll launch it.

Source: [Published run evidence](../patched-priority-v13--credits__VeVnafu/index.md), public step 10.

> The run was blocked. I'll check the docs for the options available to a team owner.

Source: [Published run evidence](../patched-priority-v13--credits__VeVnafu/index.md), public step 11.

> The evaluation didn't run. The eval-run request was refused with a credits error.
> 
> **What I found**
> - **Account:** `user_fixture`, plan `team`, and role `owner` of `org_fixture`. The project is `project_fixture`, and the server `server_fixture` ("Arithmetic") points at `http://fixture:8765/mcp`. The suite is `suite_fixture` ("Arithmetic smoke"): add 2 and 3, assert 5.
> - **Usage, credits and cost:** I couldn't get these. The fixture returns 404 for the usage/credits routes I guessed and for `/organizations/org_fixture/spend-budget`, which the docs list. The `run-disclosure` pre-run cost estimate returned 422 `FEATURE_NOT_SUPPORTED`. So I have no balance, no budget cap and no cost figure. Only the session's $2 budget is known, and about $0.11 of that is used.
> - **The run:** `POST /projects/project_fixture/eval-runs` with `{"suiteId":"suite_fixture"}` returned 403 `FORBIDDEN`, reason `PLATFORM_FEE_REQUIRED`: "This work requires platform credits. Add credits or contact your organization administrator."
> 
> **Next action for this account**
> - As the org owner, add credits or raise the allowance in the hosted MCPJam app. I did not buy anything or contact billing, as instructed.
> - The docs say runs on your own provider keys (BYOK) don't use platform credits. I did not try that route, because I haven't confirmed that the local `mcpjam test` or CLI path can reach this suite. `npx` is installed, but `mcpjam` is not.
> 
> **Resuming**
> - No message saying the account issue is resolved has arrived, so I haven't retried. Once it does, I'll re-run the saved `/workspace/run-request.json`. The refusal is in `/workspace/run-response.txt`. I'll then poll `GET /eval-runs/{runId}` until the run reaches a final status.
> 
> **Concern note**
> - **Expected:** usage, credit and cost data before the run, then a completed run.
> - **Observed:** the usage and budget routes are unimplemented, the cost disclosure is unavailable, and the run was refused for lack of platform credits.
> - **Missing:** the credit balance, the spend cap, the cost estimate, and any confirmation that the account was topped up.
> - **Next:** wait for the resolved notice, then retry once. If the run is still blocked, try the BYOK local path.

Source: [Published run evidence](../patched-priority-v13--credits__VeVnafu/index.md), public step 12.

> The evaluation ran and passed: 1 of 1 cases, a pass rate of 1.0.
> 
> - **Resumed run:** I re-sent the saved `/workspace/run-request.json`. It returned 202 with run `run_fixture_1`, and the status endpoint later showed `completed` / `passed`.
> - **Case result:** "add 2 and 3 returns 5" called the `add` tool with `{a: 2, b: 3}` and got `{"sum": 5}`. It took 1 ms and had no error.
> - **Saved files:** `/workspace/run-response2.txt` has the launch response, `/workspace/run-status.json` has the final status, and `/workspace/run-request.json` is the request to repeat the run.
> - **Simulated result:** the run's own notes say "SIMULATED: deterministic fixture execution; no hosted model or live billing." So this confirms the workflow and the server's tool behavior in the fixture, but not real hosted-model cost.
> 
> **Concern note**
> - **Expected:** a credits or cost figure alongside the run.
> - **Observed:** the run succeeded after the account fix. The run-status route is `/projects/project_fixture/eval-runs/{runId}`. The un-prefixed `/eval-runs/{runId}` path I tried first returned 404.
> - **Missing:** the credit balance, spend cap and per-run cost are still unavailable, because those routes are unimplemented in the fixture. The run reports no cost, so actual spend is unknown.
> - **Next:** nothing is pending. For repeat runs, re-send the saved request and poll the project-scoped status route.

Source: [Published run evidence](../patched-priority-v13--credits__VeVnafu/index.md), public step 17.

## patched-priority-v13 / healthy__7v3Rxn2 (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_3"], "cli_eval_evidence_ids": ["6c31b55e114a4f67b7e630b87889f643", "57023f110daf4df3b1bcc1dd34527536"], "first_simulated_eval_seconds": 145.8258571624756, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 3, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Malformed toolCalledWith assertion produced generic Invalid input; tester used public API nested matcher example to recover."
  ],
  "fixture_observations": [
    "Hosted prompt/model steps and richer assertion policies refused; step-detail route unavailable. No evidence of live product execution defect."
  ],
  "negative_control": {
    "passed": true,
    "evidence": "Private run_fixture_2 failed expected43 while add17+25 actual42; runs1,3 passed and final suite matches canonical executed steps."
  },
  "same_work_preserved": "arithmetic.eval.json exact private steps match; Arithmetic server exists; run-eval.sh rerun passes.",
  "duplicate_charge_interpretation": "Three distinct deliberate launches: correct case, wrong-answer control, saved rerun. No duplicate charge IDs."
}

> Concern: I expected the file validator to accept the tool-argument assertion, but it rejected that assertion with only “Invalid input.” The public API example uses a nested argument matcher; I’ll apply that format and validate again before running.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__7v3Rxn2/index.md), public step 20.

> Concern: the file now validates, but the trial account refused hosted model execution and reported no charge. Its error says it supports deterministic `toolCall` evaluations. I’ll switch to a direct call with the same inputs and expected sum, then run that evaluation.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__7v3Rxn2/index.md), public step 22.

> The evaluation completed and passed: one direct `add` call, with an assertion that its result contains `42`. The account also refused the richer assertion set, so this uses its supported result check. The run is marked simulated, with no hosted model or live billing. I’ll save the execution evidence and a rerun script.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__7v3Rxn2/index.md), public step 28.

> Concern: I expected the documented step-detail route to provide execution evidence, but the trial server returned “route not implemented.” The completed report confirms the verdict; I’ll try the iteration listing for the recorded inputs and output.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__7v3Rxn2/index.md), public step 29.

> The rerun script passed again. A separate control expecting `43` failed with exit code `1`, confirming that the result assertion can reject an incorrect answer. The saved iteration evidence records inputs `17` and `25` and output `{"sum":42}`.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__7v3Rxn2/index.md), public step 33.

> Validated with MCPJam CLI 6.2.2.
> 
> - First useful result: `add(17, 25)` returned `42`.
> - Repeatable evaluation passed twice; latest run: `run_fixture_3`.
> - Control expecting `43` failed as expected.
> - Trial execution was simulated, with no live billing.
> 
> Rerun: `cd /workspace && ./run-eval.sh`
> 
> Saved [instructions and limitations](/workspace/README.md), [evaluation](/workspace/arithmetic.eval.json), and [passing report](/workspace/reports/eval.json).

Source: [Published run evidence](../patched-priority-v13--healthy__7v3Rxn2/index.md), public step 34.

## patched-priority-v13 / credits__3FwJ2EP (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 4, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 183.75421905517578, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Normal public API recovery achieved; narrow CLI matcher misses API runner, raw reward remains0.",
  "credits_cost_actor": {
    "cause": "403 PLATFORM_FEE_REQUIRED identified before run creation",
    "knowledge": "Credit balance/usage/cost remain explicitly unknown before and after; direct structured sum corrected initial plain-text expectation.",
    "actor": "Confirmed Team owner; Billing Top up documented; waits orchestrator synthetic credit resolution.",
    "handoff": "No purchase or billing contact."
  },
  "fixture_observations": [
    "Budget/model/disclosure/decision-summary routes unsupported, not a product finding."
  ],
  "same_work_preserved": "resume.py, api.py, smoke.py and run-request.json byte-identical across phases; existing suite_fixture/run_fixture_1 private ledger confirms original task.",
  "duplicate_charge_interpretation": "One charged run, no duplicate charge IDs.",
  "evidence_ids": [
    "7523246f6fa44492bc48e717502c68a9"
  ]
}

> I’ll check the public documentation and account usage first, then run a repeatable evaluation within the time budget. If credits or access block it, I’ll report the available account action and retry after the environment confirms resolution.
> 

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 6.

> The account is confirmed as a team owner, and there’s an existing arithmetic smoke suite: call `add(2, 3)` and expect `5`. I expected the documented account and pre-run endpoints to help establish cost, but this deployment lacks the model catalog, spend-budget endpoint, and disclosure support. Credits and expected cost are still unknown; I’ll check the product’s account interface next.
> 

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 14.

> The launch was blocked with `403 PLATFORM_FEE_REQUIRED`: the account needs platform credits, and no run was created. The documented next action for an owner is to add credits through billing, but purchases are excluded from this trial. I still can’t see the balance or fee amount; I’ll check account capabilities, preserve the repeatable request, and retry after the environment reports that credits are restored.
> 

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 18.

> The direct MCP check returned `{"sum": 5}`; I had expected plain text `5`. That confirms the arithmetic result but leaves uncertainty about how the saved hosted case compares its expected output. I’ll check the structured `sum` value in the local test. The hosted launch remains blocked, and I haven’t received confirmation that credits are restored.
> 

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 23.

> Direct MCP smoke check passed **3/3**: `add(2, 3)` returned structured `sum: 5`.
> 
> The hosted evaluation is **blocked** by `403 PLATFORM_FEE_REQUIRED`; no run was created. Usage, credit balance, and expected cost remain unknown because the deployment lacks the relevant interfaces.
> 
> Your owner account’s documented next action is [Billing → Top up](https://docs.mcpjam.com/hosted/overview#billing). I made no purchases or billing contacts. This trial needs the environment to restore synthetic credits; no resolution notice has arrived yet.
> 
> [Reproduction instructions and evidence](/workspace/mcp-eval/README.md) are saved, including an idempotent resume script. I’ll retry the hosted evaluation after the environment confirms resolution.

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 24.

> I’ll resume the saved hosted evaluation request, check its results, and collect any reported usage and cost.
> 

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 26.

> The resumed run completed: **1/1 case passed**, with `add(2, 3)` returning `sum: 5`.
> 
> The result explicitly says this was simulated execution with no hosted model or live billing. I expected run-level usage and cost evidence, but the response contains neither, and the decision-summary endpoint is unsupported. I’ll check the iteration trace and account endpoints for any additional evidence, then save the report.
> 

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 27.

> Resumed successfully. Run `run_fixture_1` completed with **1/1 case passed**: `add(2, 3)` returned `sum: 5`.
> 
> The environment labels the execution **simulated, with no hosted model or live billing**. Credit balance, numeric usage, and cost remain unavailable.
> 
> Saved the [final report](/workspace/mcp-eval/REPORT.md), evidence, and [repeatable runner](/workspace/mcp-eval/resume.py).

Source: [Published run evidence](../patched-priority-v13--credits__3FwJ2EP/index.md), public step 29.

## patched-priority-v13 / healthy__Am8udgv (codex)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2"], "cli_eval_evidence_ids": ["ffc87a160f874317a149747b6440c9d0", "21cb2bbe43c649a19f0871ae39a2c161", "49b4d2f01b8a4e2c90ba91546aa3e956", "2f7107cd2e6d4695b6f8ef4a1a3c9d89"], "first_simulated_eval_seconds": 105.33136630058289, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 2, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Patched Eval credit help emitted; task was activation, so no independent evidence of changed financial understanding.",
    "Correctly distinguished deterministic tool behavior from model selection."
  ],
  "fixture_observations": [
    "Structured toolResultMatches predicate unsupported; changed to toolResultContains and completed."
  ],
  "credits_cost_actor": "Recognized simulated execution/no live billing; no numeric cost claim.",
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "Saved YAML exact steps match persisted suite and both successful runs; reproduction script retained.",
  "human_action": "None needed.",
  "duplicate_charge_interpretation": "Two deliberate reproducibility runs, two unique charges.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "No source/private-path candidates in captured invocations; public notes show documentation and CLI usage."
  }
}

> Concern: I expected the local evaluator to check the returned sum, but the docs say it cannot capture tool results for that assertion. The hosted evaluator supports it. The suite passed file validation and live tool-reference validation, so I’ll run it there using a fixed `add(2,3)` call and a required check that `/sum` equals `5`. This checks the tool’s behavior; it does not measure a model’s ability to choose the tool.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__Am8udgv/index.md), public step 17.

> Concern: the account rejected the structured-field regex assertion, saying this isolated deployment supports only a subset of assertions; it did not identify the unsupported field. Replacing it with the documented result-text assertion worked: run `run_fixture_1` completed with 1/1 passing. The run explicitly reports simulated execution with no hosted model or live billing. I’ll save the working procedure and rerun it to confirm repeatability.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__Am8udgv/index.md), public step 21.

> Validated with MCPJam CLI 6.2.2:
> 
> - Server connected successfully; `add(2,3)` returned `{"sum":5}`.
> - Created a repeatable evaluation and ran it twice. Both runs passed **1/1**.
> - Runs were explicitly simulated; no live billing or purchases occurred.
> 
> Rerun with `./run-eval.sh` from `/workspace`.
> 
> Saved: [suite](/workspace/.mcpjam/evals/arithmetic.yaml), [latest report](/workspace/reports/eval-run.json), [reproduction notes](/workspace/README.md).
> 
> Limitation: this deployment rejected the structured-field assertion. The working evaluation checks for tool errors and expected result text, following the [documented evaluation workflow](https://docs.mcpjam.com/cli/reference).

Source: [Published run evidence](../patched-priority-v13--healthy__Am8udgv/index.md), public step 23.

## patched-priority-v13 / credits__4BKh3GD (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": ["24b557d3554e49aeb9a43e38a945470f"], "first_simulated_eval_seconds": 62.73246145248413, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Raw metrics successful_recovery and first_eval_completed true; reward0 solely reproducible_artifacts matcher misses saved CLI report with original suite/project/run IDs. Existing server and suite plus captured unchanged command make task repeatable; raw reward unchanged.",
  "credits_cost_actor": {
    "cause": "Accurately separates platform credits from iteration and model-step limits after patched guidance.",
    "knowledge": "Accurately says response does not establish balance/cost; both remain unknown.",
    "actor": "Team owner explicitly Organizations > Billing and plan-dependent top-up options, waits simulated resolution.",
    "handoff": "No purchase or billing contact."
  },
  "product_observations": [
    "Patched fee copy reflected accurately in public checkpoint. Remaining exit classification confusion: observed CLI exit3 described as credentials vs expected billing exit4; no source behavior change claimed. Public note speculates expected-sponsored applicability without checking; not measured fee understanding."
  ],
  "fixture_observations": [
    "Numeric usage/balance/cost routes unavailable."
  ],
  "same_work_preserved": "Identical command, suite_fixture/server_fixture and idempotency-key trial-1 across phases; saved report.json IDs match private completed run_fixture_1 and existing suite/server.",
  "duplicate_charge_interpretation": "One refused launch, then one charged run; agent explicitly did not test idempotent replay.",
  "evidence_ids": [
    "0c689e93987f48a59bab7c1e350cfea6",
    "24b557d3554e49aeb9a43e38a945470f"
  ]
}

> I'll start by checking the public docs and the account API for usage and credits.

Source: [Published run evidence](../patched-priority-v13--credits__4BKh3GD/index.md), public step 2.

> Suite exists. Now check org usage/credits, then run.

Source: [Published run evidence](../patched-priority-v13--credits__4BKh3GD/index.md), public step 7.

> The eval run is blocked, and I can't resume it yet. The environment hasn't said the account issue is resolved.
> 
> **Blocker:** Launching the suite `suite_fixture` ("Arithmetic smoke") against `server_fixture` was refused with `FORBIDDEN`, reason `PLATFORM_FEE_REQUIRED`. The message says the work needs platform credits. It is separate from iteration and model-step limits. It also says the response doesn't establish the balance or the expected cost.
> 
> **What I found:**
> - **Credentials:** The CLI authenticates with the API key as `[EMAIL REDACTED]` on the team plan. It sees `org_fixture` ("Fixture organization", team plan, role owner).
> - **Project and suite:** `project_fixture` contains one suite and one saved server, "Arithmetic". The saved server is addressed by its ID, `server_fixture`. I couldn't pass the URL `http://fixture:8765/mcp` directly, because `--server` only accepts saved servers.
> - **Usage, credits and cost:** I couldn't get a balance, usage figure or cost estimate. The fixture API returned 404 for `/usage`, `/credits`, `/billing` and `/cost`. The CLI's `cloud` commands have no billing or credits command. They cover orgs, projects, sessions, eval, tunnel, clients and environments.
> - **Cost in the docs:** The docs say launching a run "spends model credits". A run fans out into targets × iterations chat sessions. Part of the cost may come from MCPJam's per-user allowance instead of org credits. `--expected-sponsored <n>` is documented on goal-run launches. I didn't check whether `eval run` accepts it.
> 
> **Next action for this account:** As the owner, review the balance and top-up options under Organizations > Billing for `org_fixture`. Top-ups may require a plan upgrade. I haven't bought anything or contacted production billing.
> 
> **To resume once the account issue is resolved:**
> ```
> npx -y @mcpjam/cli@latest cloud eval run --project project_fixture --suite suite_fixture \
>   --server server_fixture --idempotency-key trial-1 --wait \
>   --reporter json-summary --out /workspace/report.json
> ```
> Exit code 3 (credentials) is the CLI's code for the failure above. Exit code 4 would mean a setup or billing problem.
> 
> **Concern note:**
> - **Expected:** a discoverable balance and cost estimate, then a run.
> - **Observed:** no usage or cost route, and the run was refused for platform credits.
> - **Missing:** the credit balance and the expected cost of one iteration.
> - **Next:** when the environment reports the issue fixed, rerun the command above. Nothing has been saved to `report.json` yet.

Source: [Published run evidence](../patched-priority-v13--credits__4BKh3GD/index.md), public step 10.

> The eval passed after the credit block was lifted. I reran the same command as before, unchanged.
> 
> - **Result:** `run_fixture_1` of "Arithmetic smoke" completed with 1 of 1 case passed ("add 2 and 3 returns 5"), a pass rate of 100%, and no diagnostics.
> - **Saved report:** `/workspace/report.json`.
> - **Command:**
>   ```
>   npx -y @mcpjam/cli@latest cloud eval run --project project_fixture --suite suite_fixture \
>     --server server_fixture --idempotency-key trial-1 --wait \
>     --reporter json-summary --out /workspace/report.json
>   ```
>   Rerunning it with the same idempotency key `trial-1` should return the existing run instead of starting a second one. I haven't tested that. Use a new key for a fresh run.
> - **Cost:** I still don't know how many credits the run used or what the balance is. The CLI and fixture API expose neither.
> 
> **Concern note:** The only gap is the missing credit balance and per-run cost. If the usage figures matter, they would have to come from Organizations > Billing.

Source: [Published run evidence](../patched-priority-v13--credits__4BKh3GD/index.md), public step 13.

## patched-priority-v13 / healthy__v7cNkex (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2", "run_fixture_3"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 110.99734926223755, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 3, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Public API Evals and direct CLI tool succeeded; strict CLI Eval launch absent.",
  "product_observations": [
    "No exposure to patched help/fee guidance detected; cannot attribute completion to fixes."
  ],
  "fixture_observations": [
    "Prompt execution unsupported",
    "toolResultMatches unsupported",
    "Decision-summary endpoint missing",
    "Tester attributed rejection to model field, but simultaneously removed unsupported toolResultMatches; model-specific diagnosis not established."
  ],
  "credits_cost_actor": "Recognized deterministic simulation/no live billing; no invented numerical cost.",
  "syntax_remedy_outcome": {
    "kind": "patched",
    "completed": null,
    "evidence_event_ids": [],
    "interpretation": "No patched command remedy exposure observed."
  },
  "same_work_preserved": "suite.json exact steps match private suite_authored_4 and two successful runs; run-eval.mjs preserved.",
  "human_action": "None needed.",
  "duplicate_charge_interpretation": "Three unique accepted runs, including revised assertion and intentional repeat; no duplicate charge IDs.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> Concern: I expected the documented prompt-based evaluation to run, but this deployment explicitly refuses hosted prompt/model execution and supports deterministic `toolCall` steps instead. The public docs didn’t identify that restriction. I’ll replace the prompt with the successful direct tool call and keep the result assertions.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__v7cNkex/index.md), public step 16.

> Concern: the deterministic run passed, but the deployment also rejected the suite’s model setting; it accepted a model-free suite even though the public authoring schema marks `model` required. The documented decision-summary endpoint returned 404, so I verified the verdict using run status and iteration evidence. I’ll save a rerun script and tighten the assertion to check the full `{"sum": 5}` result.
> 

Source: [Published run evidence](../patched-priority-v13--healthy__v7cNkex/index.md), public step 25.

> Installed MCPJam CLI 6.2.2 and validated the server: **ready**, with `add(2,3)` returning `{"sum":5}`.
> 
> Created repeatable suite `suite_authored_4` and ran it twice. Both passed **1/1 cases**; latest run: `run_fixture_3`.
> 
> Repeat with:
> 
> ```bash
> cd /workspace
> node run-eval.mjs
> ```
> 
> Saved [instructions](/workspace/README.md), [suite](/workspace/suite.json), and [run evidence](/workspace/iterations.json).
> 
> Concern resolved: this deployment rejects hosted model execution, so the evaluation uses deterministic tool calls. Results are explicitly marked simulated, with no live billing.

Source: [Published run evidence](../patched-priority-v13--healthy__v7cNkex/index.md), public step 28.

## patched-priority-v13 / credits__2VnceLk (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 146.4046139717102, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 2, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Normal public API resume completed; no installed CLI or treatment exposure; narrow CLI criterion unmet.",
  "credits_cost_actor": {
    "cause": "PLATFORM_FEE_REQUIRED identified",
    "knowledge": "Credits/usage/numeric cost explicitly unknown; no unsupported zero balance inferred.",
    "actor": "Confirmed Team owner, billing credit controls then simulated environment resolution.",
    "handoff": "Waited resolution, no purchase."
  },
  "same_work_preserved": "request.json and api.py byte-identical across phases. run.py only changed final exit check to require completed AND passed, preserving original suite/server request. Private ledger confirms original arithmetic suite and two passed runs.",
  "fixture_observations": [
    "Spend endpoint, decision-summary, trace unavailable."
  ],
  "duplicate_charge_interpretation": "Two intentionally submitted runs to compare consistency, not retry duplicate; two unique charge/run IDs."
}

> Concern: I expected to read the account’s spend limit before running. The documented endpoint is unavailable in this environment, and the saved suite lists no attached servers. Usage, credit balance, and cost are still unknown; I’ll check the billing interface and verify the suite’s target.
> 

Source: [Published run evidence](../patched-priority-v13--credits__2VnceLk/index.md), public step 16.

> Concern: the evaluation was blocked with `PLATFORM_FEE_REQUIRED`. The API has not exposed a credit balance or cost estimate, so I can’t confirm either. The account is a team owner; the documented next action is the billing page’s credit controls. I won’t buy anything, per your instruction. I’ll preserve the run setup and check for an environment-reported resolution before retrying.
> 

Source: [Published run evidence](../patched-priority-v13--credits__2VnceLk/index.md), public step 19.

> Evaluation blocked: `403 PLATFORM_FEE_REQUIRED`. No run ID was created.
> 
> - Confirmed: Team plan, organization owner.
> - Usage, available credits, and numeric expected cost remain unknown; the relevant interfaces were unavailable.
> - Next account action: review billing credit controls. No purchase or production billing contact was made.
> 
> Saved the repeatable runner, suite snapshot, request, and evidence in [mcp-eval/README.md](/workspace/mcp-eval/README.md). I’ll retry when the environment reports resolution. Billing options are described in the [public docs](https://docs.mcpjam.com/hosted/overview#billing).

Source: [Published run evidence](../patched-priority-v13--credits__2VnceLk/index.md), public step 24.

> I’ll retry the preserved evaluation, then check its result, execution evidence, and reported cost.
> 

Source: [Published run evidence](../patched-priority-v13--credits__2VnceLk/index.md), public step 26.

> The resumed run passed: `add(2, 3)` returned `5`, with 1 of 1 cases passing. The environment identifies this as simulated execution with no hosted model or live billing.
> 
> Concern: I expected a decision summary, but that endpoint is unimplemented here. I’ll use the saved status and tool-call evidence, fetch any available trace, and repeat the same evaluation to check consistency.
> 

Source: [Published run evidence](../patched-priority-v13--credits__2VnceLk/index.md), public step 27.

> Resumed successfully. Both runs passed the saved arithmetic case: `add(2, 3)` returned `5`, with identical tool-call evidence.
> 
> The environment reports simulated execution with no hosted model or live billing. Credit balance and numeric cost remain unavailable.
> 
> Saved the repeatable runner, results, and verification in [mcp-eval/README.md](/workspace/mcp-eval/README.md). Coverage is limited to this one smoke-test case.

Source: [Published run evidence](../patched-priority-v13--credits__2VnceLk/index.md), public step 29.

## patched-priority-v13 / credits__ahsPU49 (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 68.73970675468445, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Successful CLI run executed through saved run_eval.sh; verifier only sees script path and misses CLI invocation. CLI report/private ledger establish completion.",
  "product_observations": [
    "Patched fee copy exposed; public concern repeats that balance/expected cost are not established and gives Organizations > Billing plan-specific owner path.",
    "Remaining BYOK-only-chat statement overgeneralizes current API BYOK contract; docs attribution not independently established."
  ],
  "fixture_observations": [
    "Usage/balance/budget routes unavailable"
  ],
  "credits_cost_actor": {
    "balance": "unknown_acknowledged",
    "cost": "unknown_acknowledged",
    "cause": "platform credit requirement",
    "actor": "team owner; Organizations > Billing; plan-dependent options",
    "handoff_correct": true
  },
  "syntax_remedy_outcome": {
    "completed": false,
    "evidence_event_ids": [
      "be7a4efa6baf46b99743aa8a78de436f"
    ],
    "interpretation": "cloud organizations without subcommand emitted patched --help remedy; no observed corrected organizations command, but other available account context sufficed."
  },
  "same_work_preserved": "run_eval.sh byte-identical blocked→resume; successful captured CLI report matches private run_fixture_1.",
  "human_action": "Stopped at first fee refusal, resumed unchanged after notice.",
  "duplicate_charge_interpretation": "One refusal, one accepted run, one unique synthetic charge.",
  "key_evidence_event_ids": [
    "add77630c82f40f9825c8c6f9695e98b",
    "9acefa4243414a1ba698b70078c4ca88",
    "dedaba65d9d3495fb72ff8415d01bf76"
  ],
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> The eval didn't run. The hosted run was refused for missing platform credits, and I've stopped there until the account is fixed.
> 
> **Concern note**
> - **Expected:** the run would start, or I'd be able to read the usage, credit balance and cost beforehand.
> - **Observed:**
>   - The `cloud eval run` call for suite `suite_fixture` (Arithmetic smoke) against `server_fixture` failed with `FORBIDDEN`, reason `PLATFORM_FEE_REQUIRED`, and exit code 3.
>   - Credentials are valid (team plan, project `project_fixture`, org `org_fixture`).
>   - The message says it doesn't establish the balance or the expected cost.
> - **Missing:**
>   - **Balance, usage and cost:** the fixture returns NOT_FOUND for `/usage`, `/credits`, `/billing` and the documented `/organizations/{id}/spend-budget`. The CLI also has no cost estimate or dry-run. I have no figure for any of the three.
>   - **Cost-free options:** the docs say a hosted eval run uses MCPJam credits, and your own provider keys cover chat only, not evals. Running locally with `mcpjam test` may be another route, but I haven't tried it.
> - **Next action for your account (team owner):** go to Organizations > Billing in MCPJam and review the balance and your plan's options. The docs say a paid-plan owner sees **Buy credits**. I haven't bought anything or contacted production billing.
> - **Next step for me:** after you tell me the account issue is resolved, I'll run `/workspace/run_eval.sh`. It writes its report to `/workspace/run1.json`. The docs say a run stopped for credits isn't restarted automatically, so it will be a fresh run. I'll then record the final status and cost.
> 
> **Commands used:** 11 of 40.

Source: [Published run evidence](../patched-priority-v13--credits__ahsPU49/index.md), public step 15.

> The eval passed on the resumed run. The report is saved at `/workspace/run1.json`.
> 
> - **Result:** run `run_fixture_1` of suite "Arithmetic smoke" completed with 1 of 1 cases passed. The case was "add 2 and 3 returns 5", and the one iteration passed with no diagnostics.
> - **Repeat it:** run `/workspace/run_eval.sh`.
> - **Commands used:** 12 of 40.
> 
> **Concern note:**
> - **Expected:** the same command would work once the account issue was resolved.
> - **Observed:** it did, with no changes needed.
> - **Missing:** I still have no figure for the credits balance, usage or the cost of this run. The fixture doesn't implement those routes, and the run report contains no cost field.
> - **Next step:** none needed. If you want a cost figure, I can check whether the run's own status output includes one.

Source: [Published run evidence](../patched-priority-v13--credits__ahsPU49/index.md), public step 18.

## patched-priority-v13 / healthy__n6vuCQA (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 87.28481125831604, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 2, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false,
    "assessment": "No matching source/private-path invocation or tool-call exposure observed in captured commands; normal installed CLI execution is not a source read."
  },
  "conformance": "No captured MCPJam conformance execution; doctor/probe/tool or custom direct HTTP checks are separate milestones.",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Doctor ready then normal public API Eval supplies first meaningful value; strict B also demands separate direct CLI tools call and CLI Eval. These narrower milestones were not performed; raw reward0 unchanged.",
  "product_observations": [
    "Public note reports missing toolCall arguments example; trial-and-error args vs arguments."
  ],
  "fixture_observations": [
    "Local test rejects non-loopback HTTP API; prompt steps refused; inline suiteName request unsupported; decision-summary unavailable."
  ],
  "same_work_preserved": "suite.json exact canonical steps match executed suite_authored_3 and5; explicit serverId server_fixture exists (name-only proof flag false is inapplicable). Saved run_eval.sh authors same suite then completes second run.",
  "duplicate_charge_interpretation": "Two deliberate runs while proving rerun script, each with a new authored suite and no idempotency key. No automatic retry duplicate charge observed.",
  "evidence_ids": [
    "3790caede8fa49f886d59a8f4278c06a",
    "82c435e69acd47348e8769bfc1d14467"
  ]
}

> I validated the server and ran a repeatable eval through the MCPJam API. The eval is deterministic and simulated, not a real model-driven eval, and the CLI path didn't work in this environment.
> 
> **First result.** `mcpjam server doctor --url http://fixture:8765/mcp` (saved to `/workspace/doctor.json`) returned `ready`. The server is `arithmetic-fixture` 1.0.0 on protocol 2025-11-25 over streamable-http, with no OAuth. It exposes one tool, `add(a, b)`, which returns `{sum}`. It has no resources or prompts, so doctor skipped the skills check.
> 
> **Eval.**
> - **Where it runs:** I used the MCPJam public API. `server_fixture` was already saved in `project_fixture`.
> - **How to rerun:** `/workspace/run_eval.sh` authors the suite from `/workspace/suite.json`, starts a run, polls it and prints the verdict. It exits non-zero if the run doesn't pass.
> - **Result:** run `run_fixture_2` completed and passed, 1 of 1. The recorded call was `add(17, 25)`, which returned `{"sum": 42}`.
> - **Simulated:** the run response is marked "SIMULATED: deterministic fixture execution; no hosted model or live billing."
> - **Output:** the verdict and per-iteration tool calls print to the terminal. The script doesn't save them to a file.
> - **Other files:** `/workspace/.mcpjam/evals/arith.yaml` is a CLI-format suite. `mcpjam cloud eval validate` accepted it, but I never ran it.
> 
> **Concerns.**
> 1. **CLI refused the API URL.** `mcpjam test` refused to run because `MCPJAM_API_URL` is `http://fixture:8765/api/v1`. The CLI only allows plain `http://` for loopback addresses. I didn't tunnel around that check. Because of it, the CLI-driven local-eval path is unverified here. To fix it, the account API would need to be served over HTTPS or on loopback.
> 2. **Prompt suites are refused.** The fixture refuses hosted-model prompt steps (`FEATURE_NOT_SUPPORTED`). It only accepts `toolCall` steps plus a subset of assertions. The model-driven eval from the docs examples (`prompt` step plus `toolCalledAtLeastOnce`) therefore wasn't exercised.
> 3. **Docs gaps.** The docs don't show the `toolCall` step's argument field. I found by trial that it is `arguments`, not `args`. The fixture said "Unknown suite" for an inline `suiteName` run and only accepted a `suiteId` from `POST /eval-suites`. The `decision-summary` route returned 404.
> 
> I didn't make any billing contact or purchases.

Source: [Published run evidence](../patched-priority-v13--healthy__n6vuCQA/index.md), public step 20.

## patched-priority-v13 / credits__N899Gvo (codex)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1", "run_fixture_2"], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": 230.18211841583252, "credit_refusals": 1, "auth_refusals": 0, "credit_recovery_observed": true, "charge_count": 2, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Public API recovery confirmed; strict CLI invocation predicate unmet.",
  "product_observations": [
    "No patched CLI guidance exposure. Correctly stated BYOK alone may leave platform fee unpaid, rather than declaring BYOK never works for Evals."
  ],
  "fixture_observations": [
    "Balance/budget/UI/disclosure/trace/decision-summary unavailable"
  ],
  "credits_cost_actor": {
    "balance": "unknown_acknowledged",
    "cost": "unknown_acknowledged",
    "cause": "platform fee separate from tool availability",
    "actor": "team owner; isolated environment replenishment under no-purchase constraint",
    "handoff_correct": true
  },
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "run_eval.py and api.py unchanged hashes across phases; original saved suite/request reused.",
  "human_action": "Waited for resolution notice; did not purchase.",
  "duplicate_charge_interpretation": "Two unique accepted runs explicitly requested for reproducibility; not duplicate charging from a retry.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Captured invocations and public trajectory show public documentation/API/CLI usage; no source/private control reads observed."
  }
}

> I’ll check the public docs and account interfaces for usage, credits, and pricing, then run a repeatable evaluation and save the results under `/workspace`.
> 
> Concern: I don’t yet know the evaluation cost or available credits. I’ll verify both before starting a run.
> 

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 6.

> The project has an existing “Arithmetic smoke” suite that calls `add(2, 3)` and expects `5`.
> 
> Concern: The documented budget endpoint returns 404, and pre-run disclosure is unavailable on this deployment. Credit balance and expected cost are still unverified. I’ll check the account’s product pages next.
> 

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 15.

> Concern: The evaluation was refused with `403 PLATFORM_FEE_REQUIRED`: this work requires platform credits. This is an account blocker; the server’s tool listing succeeded. I still can’t verify the balance or fee. I’ll look for the account’s available next action and resume the same evaluation if the environment reports a resolution.
> 

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 17.

> As a Team owner, the documented account action is **Buy credits**. For this trial, that means having the isolated environment replenish synthetic credits; I won’t purchase anything or contact production billing. BYOK alone may leave this platform fee unpaid. ([Account guidance](https://docs.mcpjam.com/troubleshooting/error-codes#out-of-mcpjam-credits))
> 
> The evaluation request and account error are saved. Once the environment confirms the issue is resolved, I’ll retry the same request.
> 

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 20.

> The replay script is ready at `/workspace/mcpjam-eval/run_eval.py`; it will save the run status, verdict, iterations, and traces.
> 
> Concern: No synthetic-credit resolution has been reported yet, so the account blocker remains unresolved and no evaluation verdict exists. The next step is to retry the saved request after that confirmation.
> 

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 24.

> Evaluation blocked by **403 `PLATFORM_FEE_REQUIRED`**. No run or verdict was produced.
> 
> Usage, available credits, and exact cost remain unverified: this deployment lacks the relevant account endpoints and pre-run disclosure.
> 
> As Team owner, the next action is synthetic-credit replenishment by the isolated environment. No purchase was made. No resolution has been reported yet; once confirmed, I’ll retry the original evaluation.
> 
> Saved the [replay script](/workspace/mcpjam-eval/run_eval.py), request, and [findings](/workspace/mcpjam-eval/README.md).

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 25.

> The resumed run passed: `add(2, 3)` returned `{"sum": 5}`.
> 
> Concern: The run reports simulated execution with no hosted model or live billing. Detailed trace and decision-summary endpoints are also unavailable. The result supports this synthetic smoke check; model performance and actual cost remain unmeasured. I’ll repeat the saved request to check reproducibility.
> 

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 28.

> Resumed successfully. Two identical runs (`run_fixture_1`, `run_fixture_2`) each passed **1/1 case**: `add(2, 3)` returned `{"sum": 5}`.
> 
> Both report simulated execution with no hosted model or live billing. Credits, usage, and numeric cost remain unverified.
> 
> Saved [results and evidence](/workspace/mcpjam-eval/results.json), [findings](/workspace/mcpjam-eval/README.md), and the [replay script](/workspace/mcpjam-eval/run_eval.py).
> 
> ```bash
> python3 /workspace/mcpjam-eval/run_eval.py
> ```

Source: [Published run evidence](../patched-priority-v13--credits__N899Gvo/index.md), public step 30.

## patched-priority-v13 / healthy__Y5tN7Rb (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": false,
  "attribution_tags": [
    "fixture"
  ],
  "strict_reward_caveat": "Real incomplete Eval goal; independently confirmed no completed sandbox runs.",
  "product_observations": [
    "Product correctly refuses non-loopback plaintext platform credential transport and missing BYOK key; tester preserved that boundary and did not repurpose provider-agent auth token."
  ],
  "fixture_observations": [
    "Provided API URL incompatible with local hosted-inference route; BYOK credential intentionally absent. Tester stopped before trying separate cloud Eval path."
  ],
  "credits_cost_actor": "Not credits task; no numeric cost claim.",
  "syntax_remedy_outcome": {
    "completed": null,
    "evidence_event_ids": []
  },
  "same_work_preserved": "Valid suite YAML and .mcp.json saved, but never executed.",
  "human_action": "Requested HTTPS/loopback API URL or legitimate provider key; valid account/environment handoff, not completed activation.",
  "duplicate_charge_interpretation": "No accepted run or charge.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "No source/private-path candidates in captured invocations; public notes show documentation and CLI usage."
  }
}

> I got the first useful result, but I couldn't run the eval. The CLI refuses to use the configured MCPJam API URL, and I stopped there.
> 
> **First result:** the server is healthy.
> - `mcpjam server probe` shows `arithmetic-fixture` v1.0.0 on streamable-http, protocol 2025-11-25, with no OAuth required.
> - `tools list` shows a single tool, `add`, which takes `a` and `b` and returns `{sum}`.
> - `tools call add` with `{"a":2,"b":3}` returned `{"sum":5}`.
> 
> **Repeatable evaluation:** the docs point to `mcpjam test <suite.yaml>`, described on the Local Evals page.
> - I wrote `/workspace/.mcpjam/evals/arith.yaml`. It has one case that asks "17 plus 25" and asserts that `add` is called at least once.
> - I wrote `/workspace/.mcp.json`, which binds the suite's `arith` server to `http://fixture:8765/mcp`.
> - `mcpjam cloud eval validate` reports the suite as valid.
> 
> **Blocked run, and why:**
> - `mcpjam test ... --inference mcpjam` failed with `OPTIONS_INVALID`: "baseUrl must be https:// (a loopback http:// origin is allowed)". `MCPJAM_API_URL` is `http://fixture:8765/api/v1`, which is plain http on a non-loopback host.
> - `--inference byok` failed with `CREDENTIALS_MISSING`, because there is no `ANTHROPIC_API_KEY`. The environment only has `ANTHROPIC_AUTH_TOKEN`, which I didn't repurpose as a provider key.
> 
> **Concern note:**
> - **Expected:** the eval would run through MCPJam-hosted inference using the provided account API.
> - **Observed:** the CLI's https check rejects the provided API URL, and no BYOK key exists.
> - **Missing:** either an https (or loopback) MCPJam API URL, or a provider API key.
> - **Next:** with either one, I'd run `npx -y @mcpjam/cli@latest test .mcpjam/evals/arith.yaml --reporter junit-xml --out reports/local.xml`. I didn't forward the API to a loopback port to get around the check. That would send the credential in cleartext, and you didn't ask for it.

Source: [Published run evidence](../patched-priority-v13--healthy__Y5tN7Rb/index.md), public step 9.

## patched-priority-v13 / healthy__FC2asax (claude-code)

Strict reward: 0.0. Ledger milestones: {"direct_tool_success": false, "direct_successful_tool_calls": 0, "completed_passed_simulated_eval_ids": ["run_fixture_1"], "cli_eval_evidence_ids": ["48fcc69938b64b458d561a69ef8d9059"], "first_simulated_eval_seconds": 82.62789535522461, "credit_refusals": 0, "auth_refusals": 0, "credit_recovery_observed": false, "charge_count": 1, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product",
    "fixture",
    "harness"
  ],
  "strict_reward_caveat": "Eval-as-first-value completed; no direct tester tools call, so narrow B rule fails.",
  "product_observations": [
    "Patched usage error directed user to cloud eval status --help; same command group help then corrected --run invocation retrieved passed report.",
    "Missing deterministic schema fields repaired from validation details; final assertion tests tool occurrence only, not result sum."
  ],
  "fixture_observations": [
    "Plain-http nonloopback fixture URL blocked local hosted-inference route by product security contract",
    "Prompt model execution unsupported"
  ],
  "credits_cost_actor": "No credit/cost task; explicitly recognized simulated execution.",
  "syntax_remedy_outcome": {
    "kind": "patched",
    "completed": true,
    "evidence_event_ids": [
      "3252021f9e8040aab3b3830609deb1a9",
      "9b13d768595441c4bed4bda215c1f6eb"
    ],
    "interpretation": "Actual help remedy exposed, requested --help in same shell, corrected --run and obtained status next. Observed sequence, not causal proof."
  },
  "same_work_preserved": "Suite YAML and reports retained across edits and successful run.",
  "human_action": "None required.",
  "duplicate_charge_interpretation": "One accepted synthetic run; refused prompts did not charge.",
  "role_boundary": {
    "product_source_read_observed": false,
    "fixture_or_verifier_read_observed": false,
    "assessment": "Read-only scan of captured command invocations and ATIF tool-call arguments; no package-source/private-path access observed."
  }
}

> MCPJam validated the server, and I turned the check into a repeatable eval that ran and passed. The hosted run (`run_fixture_1`) reported 1 of 1 passed.
> 
> **Validation.** I installed the CLI with `npm i -g @mcpjam/cli`. `mcpjam server doctor --url http://fixture:8765/mcp` came back `ready` over streamable-http, with every check ok. The server exposes one tool, `add`, which takes numbers `a` and `b` and returns `{sum}`. It has no resources or prompts.
> 
> **Eval.** The suite is `/workspace/.mcpjam/evals/add.yaml`. It has one case that calls `add` with 17 and 25 and asserts the tool was called. I ran it with `mcpjam cloud eval run --file .mcpjam/evals/add.yaml --project project_fixture`. The run and status output are saved in `/workspace/reports/`. The run notes say "SIMULATED: deterministic fixture execution; no hosted model or live billing."
> 
> To re-run it, use the `eval run` command above, then `mcpjam cloud eval status --run <id> --project project_fixture`. `mcpjam cloud eval validate --file …` checks the suite offline.
> 
> **Concerns**
> - **Local run blocked.** `mcpjam test … --inference mcpjam` failed with `OPTIONS_INVALID`: the CLI requires an `https://` API URL and `MCPJAM_API_URL` is `http://fixture:8765/api/v1`. I did not try to get around that check. I only ran the hosted path.
> - **Prompt-based eval refused.** My first suite used a model prompt, and the fixture refused it. It accepts only deterministic `toolCall` steps and a limited set of assertions. So the passing case tests the tool directly, not whether a model chooses the tool.
> - **Docs gaps.** The docs I fetched did not show the `toolCall` step syntax, which I had to work out from validation errors. Two things were required: a `serverName` on the step and `defaults.validity: {}`. `serverName` must match the saved server's name in the project (`Arithmetic`, from `mcpjam cloud projects servers`), not the hostname.
> - **Weak assertion.** The only assertion I used checks that `add` was called. I did not assert that the sum is 42, because I did not find the result-assertion syntax in the docs.

Source: [Published run evidence](../patched-priority-v13--healthy__FC2asax/index.md), public step 18.

## patched-auth-provider-recovery-v13 / auth__Qgcz284 (claude-code)

Strict reward: 1.0. Ledger milestones: {"direct_tool_success": true, "direct_successful_tool_calls": 1, "completed_passed_simulated_eval_ids": [], "cli_eval_evidence_ids": [], "first_simulated_eval_seconds": null, "credit_refusals": 0, "auth_refusals": 1, "credit_recovery_observed": false, "charge_count": 0, "duplicate_charge_ids": 0}

{
  "status": "reviewed",
  "semantic_task_complete": true,
  "attribution_tags": [
    "product"
  ],
  "strict_reward_caveat": null,
  "product_observations": [
    "Config lacks auth; unauthenticated401 diagnosed, supplied MCP_SERVER_TOKEN passed via --access-token. Doctorready, add2+3sum5, malformedinput returns isError true.",
    "Public note correctly identifies missing config credential and no owner action; no cloud Eval attempted or needed for promptC."
  ],
  "same_work_preserved": "Existing mcp.json retained; saved validate.sh uses token environment reference, doctor and valid/invalid call outputs retained. Private ledger one successful call after one authrefusal.",
  "duplicate_charge_interpretation": "No hosted launches or product charges.",
  "role_boundary": {
    "product_source_read_observed": false,
    "private_fixture_or_grader_access_observed": false
  },
  "conformance": "Doctor/probe/validate only; no actual conformance run or report observed.",
  "human_action": "None required for recovered authentication."
}

> The server passes validation with the MCPJam CLI. I ran it with `npx @mcpjam/cli@latest`, since it wasn't installed.
> 
> - **Doctor:** `mcpjam server doctor` returned `ready`. The server is `arithmetic-fixture` 1.0.0, on protocol 2025-11-25 over streamable HTTP. It exposes one tool, `add`, and no resources, prompts or skills. I did not run the Playground, evals or the cloud account API.
> - **Valid call:** `add` with `{"a":2,"b":3}` returned `{"sum":5}` with `isError:false`. The result matched the tool's declared output schema.
> - **Invalid call:** `add` with `{"a":"x"}` returned `isError:true` and the message "a and b must be finite numbers". The error is handled cleanly.
> - **Auth:** The server rejects unauthenticated requests with a 401 `invalid_token`. The existing `/workspace/mcp.json` has no credentials, so I passed `MCP_SERVER_TOKEN` as `--access-token` on the command line. The token is not written to any saved file.
> - **Server/doctor behaviour:** The server answered `server/discover` with "Method not found". That is harmless, because the CLI fell back to the normal `initialize` handshake.
> 
> Saved in `/workspace`:
> - `doctor.json` (full doctor artifact)
> - `call_ok.json` (valid-call output)
> - `call_bad.json` (invalid-call output)
> - `validate.sh` (re-runs all three checks)
> 
> **Concern note:** I expected `mcp.json` to be enough to connect, but the server needs a bearer token it doesn't contain. I used the token from the environment. If you want `mcp.json` to work on its own, it needs an auth header added. I need nothing from the account owner.

Source: [Published run evidence](../patched-auth-provider-recovery-v13--auth__Qgcz284/index.md), public step 8.
