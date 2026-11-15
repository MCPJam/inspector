# Baseline versus patched evidence

[Complete machine-readable comparison](results.json)

Each rate shows positive/observed with unknown values separately. Cohorts include failed, timed-out and provider-blocked runs when not harness-invalid. A successful task can still have friction.

| Cohort | Agent | Scenario | usable n / attempts | Strict reward pass | Direct tool success | Simulated Eval (any public surface) | Recovery | Concern note |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| baseline | claude-code | auth | 1/2 | 1/1 | 1/1 | 0/1 | 1/1 | 1/1 |
| baseline | claude-code | credits | 3/3 | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 |
| baseline | claude-code | healthy | 3/3 | 1/3 | 3/3 | 2/3 | 0/0; 3 unknown | 1/3 |
| baseline | codex | auth | 1/1 | 0/1 | 1/1 | 1/1 | 1/1 | 0/1 |
| baseline | codex | credits | 3/3 | 0/3 | 1/3 | 3/3 | 3/3 | 3/3 |
| baseline | codex | healthy | 3/3 | 3/3 | 3/3 | 3/3 | 0/0; 3 unknown | 3/3 |
| patched | claude-code | auth | 1/2 | 1/1 | 1/1 | 0/1 | 1/1 | 1/1 |
| patched | claude-code | credits | 3/3 | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 |
| patched | claude-code | healthy | 3/3 | 0/3 | 1/3 | 2/3 | 0/0; 3 unknown | 1/3 |
| patched | codex | auth | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 0/1 |
| patched | codex | credits | 3/3 | 0/3 | 1/3 | 3/3 | 3/3 | 3/3 |
| patched | codex | healthy | 3/3 | 2/3 | 3/3 | 3/3 | 0/0; 3 unknown | 3/3 |

## Supplemental experiments

These samples are separate from primary cycle-1 comparison denominators. [Detailed supplemental results](supplemental.json).

| Experiment | Agent | Scenario | Usable / attempts | Strict pass | Direct tool | Simulated Eval | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cycle_2_targeted | claude-code | auth | 1/1 | 1/1 | 1/1 | 0/1 | 1/1 |
| cycle_2_targeted | codex | auth | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |

- [patched-cycle2-auth-v13--auth__3bkokhu](../patched-cycle2-auth-v13--auth__3bkokhu/index.md): passed.
- [patched-cycle2-auth-v13--auth__MV27c9o](../patched-cycle2-auth-v13--auth__MV27c9o/index.md): passed.

| heldout_discovery | claude-code | healthy | 1/1 | 1/1 | 1/1 | 0/1 | 0/0; 1 unknown |
| heldout_discovery | codex | healthy | 1/1 | 1/1 | 1/1 | 0/1 | 0/0; 1 unknown |

- [heldout-discovery-v13--discovery__gvhHS8f](../heldout-discovery-v13--discovery__gvhHS8f/index.md): passed.
- [heldout-discovery-v13--discovery__pXszNVb](../heldout-discovery-v13--discovery__pXszNVb/index.md): passed.


## Run evidence

- [baseline-auth-provider-recovery-v13--auth__DDRa9aF](../baseline-auth-provider-recovery-v13--auth__DDRa9aF/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-auth-v13--auth__DebKeUR](../baseline-auth-v13--auth__DebKeUR/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-auth-v13--auth__HzCGt8k](../baseline-auth-v13--auth__HzCGt8k/index.md): provider-blocked; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-priority-v13--credits__8FQyeMP](../baseline-priority-v13--credits__8FQyeMP/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [baseline-priority-v13--credits__BkqRPJ9](../baseline-priority-v13--credits__BkqRPJ9/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [baseline-priority-v13--credits__GNYWrm4](../baseline-priority-v13--credits__GNYWrm4/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [baseline-priority-v13--credits__pMa3zdp](../baseline-priority-v13--credits__pMa3zdp/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [baseline-priority-v13--credits__qc4mKtM](../baseline-priority-v13--credits__qc4mKtM/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [baseline-priority-v13--credits__xT9JB9X](../baseline-priority-v13--credits__xT9JB9X/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [baseline-priority-v13--healthy__8heHuhR](../baseline-priority-v13--healthy__8heHuhR/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-priority-v13--healthy__9ZDP5bv](../baseline-priority-v13--healthy__9ZDP5bv/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-priority-v13--healthy__9e6btMY](../baseline-priority-v13--healthy__9e6btMY/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-priority-v13--healthy__Vju72to](../baseline-priority-v13--healthy__Vju72to/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-priority-v13--healthy__YYqEMAi](../baseline-priority-v13--healthy__YYqEMAi/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [baseline-priority-v13--healthy__aNWS6j4](../baseline-priority-v13--healthy__aNWS6j4/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-auth-provider-recovery-v13--auth__Qgcz284](../patched-auth-provider-recovery-v13--auth__Qgcz284/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-auth-v13--auth__GiXEbFi](../patched-auth-v13--auth__GiXEbFi/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-auth-v13--auth__UifmxRq](../patched-auth-v13--auth__UifmxRq/index.md): provider-blocked; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-priority-v13--credits__2VnceLk](../patched-priority-v13--credits__2VnceLk/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [patched-priority-v13--credits__3FwJ2EP](../patched-priority-v13--credits__3FwJ2EP/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [patched-priority-v13--credits__4BKh3GD](../patched-priority-v13--credits__4BKh3GD/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [patched-priority-v13--credits__N899Gvo](../patched-priority-v13--credits__N899Gvo/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [patched-priority-v13--credits__VeVnafu](../patched-priority-v13--credits__VeVnafu/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [patched-priority-v13--credits__ahsPU49](../patched-priority-v13--credits__ahsPU49/index.md): failed; strict reward `{'reward': 0.0}`; final phase `resume`; metric source `steps/resume/verifier/metrics.json`.
- [patched-priority-v13--healthy__7v3Rxn2](../patched-priority-v13--healthy__7v3Rxn2/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-priority-v13--healthy__Am8udgv](../patched-priority-v13--healthy__Am8udgv/index.md): passed; strict reward `{'reward': 1.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-priority-v13--healthy__FC2asax](../patched-priority-v13--healthy__FC2asax/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-priority-v13--healthy__Y5tN7Rb](../patched-priority-v13--healthy__Y5tN7Rb/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-priority-v13--healthy__n6vuCQA](../patched-priority-v13--healthy__n6vuCQA/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.
- [patched-priority-v13--healthy__v7cNkex](../patched-priority-v13--healthy__v7cNkex/index.md): failed; strict reward `{'reward': 0.0}`; final phase `trial`; metric source `verifier/metrics.json`.

## Excluded observations

Preserved and visible, outside valid comparison denominators.

- [baseline-claude-auth-v11--baseline-auth-v11__bVF8dkf](../baseline-claude-auth-v11--baseline-auth-v11__bVF8dkf/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-codex-healthy-smoke--smoke-healthy__esC2H66](../baseline-codex-healthy-smoke--smoke-healthy__esC2H66/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-codex-healthy-v1--smoke-healthy-v1__Z4eU7EV](../baseline-codex-healthy-v1--smoke-healthy-v1__Z4eU7EV/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-priority-v12--credits__5u9gdM8](../baseline-priority-v12--credits__5u9gdM8/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-priority-v12--credits__Pdxefqz](../baseline-priority-v12--credits__Pdxefqz/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-priority-v12--healthy__ApzP8X2](../baseline-priority-v12--healthy__ApzP8X2/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-priority-v12--healthy__c2DiAmK](../baseline-priority-v12--healthy__c2DiAmK/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-priority-v12--healthy__qAWEduZ](../baseline-priority-v12--healthy__qAWEduZ/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-priority-v12--healthy__tehtdW6](../baseline-priority-v12--healthy__tehtdW6/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v11--v11-auth__J2ocbRr](../baseline-six-v11--v11-auth__J2ocbRr/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v11--v11-auth__VnurQ2L](../baseline-six-v11--v11-auth__VnurQ2L/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v11--v11-credits__GfAaPew](../baseline-six-v11--v11-credits__GfAaPew/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v11--v11-credits__rRzz8xe](../baseline-six-v11--v11-credits__rRzz8xe/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v11--v11-healthy__3YCuNWF](../baseline-six-v11--v11-healthy__3YCuNWF/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v11--v11-healthy__UqHeqxP](../baseline-six-v11--v11-healthy__UqHeqxP/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v12--auth__E5Qeyba](../baseline-six-v12--auth__E5Qeyba/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v12--auth__Tx2qPDy](../baseline-six-v12--auth__Tx2qPDy/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v12--credits__cVKVZ3s](../baseline-six-v12--credits__cVKVZ3s/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v12--credits__nSYKqAf](../baseline-six-v12--credits__nSYKqAf/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v12--healthy__dyyzkKT](../baseline-six-v12--healthy__dyyzkKT/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [baseline-six-v12--healthy__nn7HFaC](../baseline-six-v12--healthy__nn7HFaC/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [heldout-discovery-v13--discovery__gvhHS8f](../heldout-discovery-v13--discovery__gvhHS8f/index.md): Outside explicitly selected comparison jobs; passed.
- [heldout-discovery-v13--discovery__pXszNVb](../heldout-discovery-v13--discovery__pXszNVb/index.md): Outside explicitly selected comparison jobs; passed.
- [patched-cycle2-auth-v13--auth__3bkokhu](../patched-cycle2-auth-v13--auth__3bkokhu/index.md): Outside explicitly selected comparison jobs; passed.
- [patched-cycle2-auth-v13--auth__MV27c9o](../patched-cycle2-auth-v13--auth__MV27c9o/index.md): Outside explicitly selected comparison jobs; passed.
- [patched-priority-v12--credits__dgE22DX](../patched-priority-v12--credits__dgE22DX/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [patched-priority-v12--healthy__HKPw54D](../patched-priority-v12--healthy__HKPw54D/index.md): Outside explicitly selected comparison jobs; harness-invalid.
- [patched-priority-v12--healthy__tWN9K4n](../patched-priority-v12--healthy__tWN9K4n/index.md): Outside explicitly selected comparison jobs; harness-invalid.

## Interpretation limits

- All Eval/credit outcomes are deterministic sandbox simulations, not live billing.
- Final-phase metrics are selected once; blocked-step snapshots never count as separate trials.
- Strict frozen reward and ledger-confirmed public-surface milestones are separate; no retrospective regrading.
- Provider-blocked attempts remain visible but are excluded from usable product-trial rates. Null metrics are unknown, not failures; unknown counts are explicit.
- Time begins at fixture initialization; it is descriptive and includes variable provider/container delays.
- Native command counts include tester installation and compound shell invocations once; exclude Harbor startup and nested wrapper captures.
- A concern note count measures observed statements, not severity, unique issue count, or human prevalence.
- No statistical significance or causal improvement is inferred from these small samples.
