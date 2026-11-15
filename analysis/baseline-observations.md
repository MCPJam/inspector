> Preliminary, noncomparative v1.2 observations; excluded from improvement denominators.

# Baseline semantic observations (Harbor 1.2)

All six completed trials are retained. Strict Harbor reward passes 1/6; this does not mean five product failures. Healthy Eval completion through a normal public surface is 2/2; credit recovery after simulated resolution is 2/2; auth recovery is observed in 1/2, with preemptive successful authentication in the other trial. No live billing or human-prevalence claim.

**Treatment exposure:** Both baseline credit testers used API scripts, so neither saw the CLI error adapter. Their successful recoveries cannot establish the effect of the CLI guidance patch. Both explicitly kept numeric balance and expected cost unknown.

## healthy__dyyzkKT — codex

Strict reward: **0.0**. Direct MCPJam tool success and two completed public-API sandbox Evals; strict CLI Eval criterion unmet.

- **diagnosis cause action actor:** {"cause": "Understood CLI authoring schema mismatch; recovered using public create API. Unsupported predicate error was fixture-only.", "action": "Changed to supported fixture assertion and saved/reran Python script.", "actor": "Tester acted without human help."}
- **credits cost understanding:** Not requested; explicitly identified simulated execution, no real cost claim.
- **handoff:** None needed.
- **preserved work:** suite-create.json, reproduce.py, reports retained; second deliberate run confirmed.

Fixture/measurement limits: Cloud connect route missing; toolResultMatches is supported product predicate but unimplemented fixture branch; Strict verifier excludes public API launch.

Public excerpts (verified exact substrings, never private reasoning):

> Concern: I expected `cloud eval create --file` to accept the documented create-API JSON, but CLI 6.2.2 rejected its fields and requested `servers` and `cases`. I’ll submit the saved request directly to the documented public API.

Source: [Published run evidence](../baseline-six-v12--healthy__dyyzkKT/index.md), step 20.

> The report labels execution as simulated, with no hosted model or live billing.

Source: [Published run evidence](../baseline-six-v12--healthy__dyyzkKT/index.md), step 26.

Command evidence IDs: [91c71adbe58b4b4ca34598940f2dc65f](../baseline-six-v12--healthy__dyyzkKT/commands/0034-91c71adbe58b4b4ca34598940f2dc65f/event.json), [ef796275148a47058fd7ecb1a1d5a2fa](../baseline-six-v12--healthy__dyyzkKT/commands/0071-ef796275148a47058fd7ecb1a1d5a2fa/event.json), [5717171c5b2d4d038a2e6a5c2f87a8db](../baseline-six-v12--healthy__dyyzkKT/commands/0019-5717171c5b2d4d038a2e6a5c2f87a8db/event.json), [cc1b6ee7388948e3a1b1ec9182a8158f](../baseline-six-v12--healthy__dyyzkKT/commands/0060-cc1b6ee7388948e3a1b1ec9182a8158f/event.json).

## healthy__nn7HFaC — claude-code

Strict reward: **0.0**. CLI sandbox Eval completed/passed; no direct tester tool call, so strict B reward0.

- **diagnosis cause action actor:** {"cause": "Recognized positional-argument usage failures; did not consult help to correct them. Recognized empty suite server list uncertainty.", "action": "Ran existing suite; proposed checking binding next.", "actor": "Tester; no human-only action identified."}
- **credits cost understanding:** Not requested; no numeric cost claim.
- **handoff:** None requested.
- **preserved work:** run1.json and run_eval.sh saved; reproduction script not rerun.

Fixture/measurement limits: Default suite environment.servers empty despite fixture engine executing arithmetic; Strict B rejects Eval-as-first-value.

Public excerpts (verified exact substrings, never private reasoning):

> **Two commands failed:** `tools call add ...` and `cloud projects servers list` both returned "too many arguments". I didn't look up the right syntax, so I didn't call `add` directly or list the project's saved servers.

Source: [Published run evidence](../baseline-six-v12--healthy__nn7HFaC/index.md), step 10.

> The run passed anyway, so I can't confirm it actually exercised that server. I didn't find out which server it used.

Source: [Published run evidence](../baseline-six-v12--healthy__nn7HFaC/index.md), step 10.

Command evidence IDs: [2a1cc7d9fd4c496ca1014daa401a114b](../baseline-six-v12--healthy__nn7HFaC/commands/0005-2a1cc7d9fd4c496ca1014daa401a114b/event.json).

## auth__E5Qeyba — codex

Strict reward: **0.0**. Authenticated validation succeeded preemptively; auth-failure recovery unexercised.

- **diagnosis cause action actor:** {"cause": "Token supplied on first direct connection; no observed401 to diagnose. Diagnosed unsupported hosted diagnosis routes.", "action": "Used CLI direct doctor/tool calls; preserved conformance failure.", "actor": "No owner action required; deferred fixture routes/checker question to maintainers."}
- **credits cost understanding:** Not requested; recognized sandbox Eval simulation.
- **handoff:** No owner handoff needed; checker concern remains hypothesis, not proven product defect.
- **preserved work:** mcp.json unchanged; validation/reproduce.sh, REPORT.md, tool outputs retained.

Fixture/measurement limits: Hosted doctor/validate/report upload routes unavailable; Conformance GET405 body classification unverified; do not call proven product bug.

Public excerpts (verified exact substrings, never private reasoning):

> The CLI recovered successfully: initialization and tool discovery passed, and a live `add(2, 3)` call returned `5`.

Source: [Published run evidence](../baseline-six-v12--auth__E5Qeyba/index.md), step 20.

> No account-owner action is currently needed. Deployment and checker maintainers would need to resolve the remaining limitations.

Source: [Published run evidence](../baseline-six-v12--auth__E5Qeyba/index.md), step 32.

Command evidence IDs: [ab65a27fa7c14e7387b19bd551ab167b](../baseline-six-v12--auth__E5Qeyba/commands/0055-ab65a27fa7c14e7387b19bd551ab167b/event.json), [261e0b69919840c186ad67c788a100e7](../baseline-six-v12--auth__E5Qeyba/commands/0011-261e0b69919840c186ad67c788a100e7/event.json), [a52683cbe6114bf0a3cc1bd85ccbabeb](../baseline-six-v12--auth__E5Qeyba/commands/0051-a52683cbe6114bf0a3cc1bd85ccbabeb/event.json).

## auth__Tx2qPDy — claude-code

Strict reward: **1.0**. One auth refusal then successful authenticated MCPJam doctor/tool calls; strict reward1.

- **diagnosis cause action actor:** {"cause": "Correctly found missing credential in saved config and401 response.", "action": "Passed provided token through --access-token, preserving config without writing token into it.", "actor": "Tester could recover; owner unnecessary."}
- **credits cost understanding:** Not requested.
- **handoff:** Correctly no owner assistance needed.
- **preserved work:** mcp.json preserved; doctor.json and validate.sh saved and executed.

Fixture/measurement limits: No material fixture block to scoped auth goal.

Public excerpts (verified exact substrings, never private reasoning):

> `/workspace/mcp.json` has no credential, and an unauthenticated request gets a 401. I passed `MCP_SERVER_TOKEN` with `--access-token` instead.

Source: [Published run evidence](../baseline-six-v12--auth__Tx2qPDy/index.md), step 7.

> I did not edit the config, because I did not want to write the secret to disk.

Source: [Published run evidence](../baseline-six-v12--auth__Tx2qPDy/index.md), step 7.

> Nothing needs the account owner.

Source: [Published run evidence](../baseline-six-v12--auth__Tx2qPDy/index.md), step 7.

Command evidence IDs: [ef22902c9a034eb0833ae4d5cbf8e5c0](../baseline-six-v12--auth__Tx2qPDy/commands/0018-ef22902c9a034eb0833ae4d5cbf8e5c0/event.json), [1bb9ea85954e44c09bb033882019728c](../baseline-six-v12--auth__Tx2qPDy/commands/0006-1bb9ea85954e44c09bb033882019728c/event.json), [244180658daa4c188a40e5d970c231d7](../baseline-six-v12--auth__Tx2qPDy/commands/0008-244180658daa4c188a40e5d970c231d7/event.json).

## credits__cVKVZ3s — claude-code

Strict reward: **0.0**. Correct fee-block diagnosis and handoff; resumed same suite via public API after private resolution. Strict CLI-specific reward0.

- **diagnosis cause action actor:** {"cause": "Correct PLATFORM_FEE_REQUIRED diagnosis, not rate/step limit. Numeric balance unknown.", "action": "Stopped without buying; reran preserved script after resolution notice.", "actor": "Identified team owner path and human/orchestrator action; no unauthorized account mutation."}
- **credits cost understanding:** Balance and expected cost explicitly unknown. Explicitly separated provider session budget from MCPJam credits. BYOK-only-chat claim overgeneralizes current API modelApiKeys/BYOK contracts; owner-or-admin purchase wording not established by this trial.
- **handoff:** Correct bounded handoff before resolution; observed completed recovery after notice.
- **preserved work:** {"script": "run_eval.sh", "byte_identical_across_phases": true, "sha256": "7d8b99386dc88a477904547244de2541ede4a855da372029d8d96b76a28501e4", "charges_after_resolution": 1, "duplicate_charge_ids": 0}

Fixture/measurement limits: Usage/balance/budget/UI/disclosure unavailable in fixture, not proof of live product absence; Both agents bypass CLI; CLI fee-guidance treatment exposure absent; Pure API reproduction scripts not recognized by strict artifact matcher.

Public excerpts (verified exact substrings, never private reasoning):

> I have no per-run cost estimate or credit balance. The $2 figure in my session header is my own session budget, not MCPJam credits.

Source: [Published run evidence](../baseline-six-v12--credits__cVKVZ3s/index.md), step 13.

> Bring-your-own-key only covers chat, not evals.

Source: [Published run evidence](../baseline-six-v12--credits__cVKVZ3s/index.md), step 13.

> The run returned no cost or credits-consumed figure, so I still can't say what a run costs or how much credit remains.

Source: [Published run evidence](../baseline-six-v12--credits__cVKVZ3s/index.md), step 16.

Command evidence IDs: [69d590d3e40f47b7857d70ed2c589645](../baseline-six-v12--credits__cVKVZ3s/commands/0009-69d590d3e40f47b7857d70ed2c589645/event.json), [9a279ff0a5ae4e62878b7b02a228cd22](../baseline-six-v12--credits__cVKVZ3s/commands/0047-9a279ff0a5ae4e62878b7b02a228cd22/event.json).

## credits__nSYKqAf — codex

Strict reward: **0.0**. Correct fee-block diagnosis and handoff; resumed same suite via public API after private resolution. Strict CLI-specific reward0.

- **diagnosis cause action actor:** {"cause": "Correct PLATFORM_FEE_REQUIRED diagnosis, not rate/step limit. Numeric balance unknown.", "action": "Stopped without buying; reran preserved script after resolution notice.", "actor": "Identified team owner path and human/orchestrator action; no unauthorized account mutation."}
- **credits cost understanding:** Balance and expected cost explicitly unknown. No invented balance or numeric price; simulation explicitly acknowledged.
- **handoff:** Correct bounded handoff before resolution; observed completed recovery after notice.
- **preserved work:** {"script": "mcp-eval/run.py", "byte_identical_across_phases": true, "sha256": "df03fb3be60b3ae78d8093253a1ac0b4dd4815e09975687e6874e87c696f0744", "charges_after_resolution": 1, "duplicate_charge_ids": 0}

Fixture/measurement limits: Usage/balance/budget/UI/disclosure unavailable in fixture, not proof of live product absence; Both agents bypass CLI; CLI fee-guidance treatment exposure absent; Pure API reproduction scripts not recognized by strict artifact matcher; Blocked collected ledger already contains private resolution; use refusal timestamp, not snapshot balance, to describe starting block.

Public excerpts (verified exact substrings, never private reasoning):

> The API supplied neither a balance nor a fee amount.

Source: [Published run evidence](../baseline-six-v12--credits__nSYKqAf/index.md), step 17.

> I’ve saved the runner and refusal, and will retry once the environment reports that the account issue is resolved.

Source: [Published run evidence](../baseline-six-v12--credits__nSYKqAf/index.md), step 17.

> The run also identifies itself as simulated, with no hosted model or live billing.

Source: [Published run evidence](../baseline-six-v12--credits__nSYKqAf/index.md), step 21.

Command evidence IDs: [9b09613da29c4563b28a50f3ef1026e4](../baseline-six-v12--credits__nSYKqAf/commands/0025-9b09613da29c4563b28a50f3ef1026e4/event.json), [50c684259d394e44ae001861d9e77b33](../baseline-six-v12--credits__nSYKqAf/commands/0065-50c684259d394e44ae001861d9e77b33/event.json).

## Interpretation and next experiments

- Freeze rewards. Dual-report strict reward and independent completion; future criterion corrections require a new version and comparable reruns.
- Test CLI-specific error guidance with normal product entry surfaces that actually reach the CLI adapter; do not infer an effect from API-only runs.
- The Claude credit note that BYOK covers only chat is broader than current modelApiKeys/BYOK contracts. This is a terminology concern in one credit trial, with documentation attribution unverified. The observation is the statement, not proof that public docs caused it.
- Keep unsupported-route and unsupported-predicate notes as fixture limitations. The GET405 conformance concern remains an unverified checker hypothesis.
- The Claude healthy suite binding concern is fixture-induced: its environment.servers is empty while private sandbox execution calls the arithmetic helper.
- Do not count nested shell events or repeated resume-history notes twice. Raw environment captures contain tokens; publish sanitized derivatives only.
