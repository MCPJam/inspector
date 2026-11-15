# Harbor activation evidence

All screenshots are rendered from captured transcripts. They are not native terminal photographs. Recorded outcomes reflect Harbor errors and frozen strict rewards; zero reward is not proof of a product failure. Per-run assessment flags expose known construct limits without changing rewards.

[Task instructions/configuration/hashes](task-metadata/index.md) · [Orchestrator preflight events](preflight/index.md) · [Version and starting-state record](versions.json) · [Independent analysis](analysis/index.md) · [Baseline/patched comparison](comparison/index.md) · [Observed errors and before/after](gallery/representative-error-gallery.md)

## Capture limits

Separate stdout/stderr pipes preserve each stream. Cross-stream ordering is recorder observation order. Events correspond to shell tool invocations; compound-command child exit statuses are not separately observed. Redirected output is present only when subsequently observed or explicitly collected. Missing exit metadata remains incomplete. No PTY was used for these noninteractive trials. Private reasoning, native sessions, authentication stores and sensitive values are excluded from publishable evidence. This inventory covers observed output, not every possible product state.

| Run | Agent | Outcome | Capture events | Agent shell invocations | Concerns |
| --- | --- | --- | ---: | ---: | ---: |
| [baseline-auth-provider-recovery-v13--auth__DDRa9aF](baseline-auth-provider-recovery-v13--auth__DDRa9aF/index.md) | claude-code | passed | 20 | 8 | 1 |
| [baseline-auth-v13--auth__DebKeUR](baseline-auth-v13--auth__DebKeUR/index.md) | codex | failed | 73 | 27 | 0 |
| [baseline-auth-v13--auth__HzCGt8k](baseline-auth-v13--auth__HzCGt8k/index.md) | claude-code | provider-blocked | 15 | 3 | 0 |
| [baseline-claude-auth-v11--baseline-auth-v11__bVF8dkf](baseline-claude-auth-v11--baseline-auth-v11__bVF8dkf/index.md) | claude-code | harness-invalid | 20 | 8 | 1 |
| [baseline-codex-healthy-smoke--smoke-healthy__esC2H66](baseline-codex-healthy-smoke--smoke-healthy__esC2H66/index.md) | codex | harness-invalid | 0 | 0 | 0 |
| [baseline-codex-healthy-v1--smoke-healthy-v1__Z4eU7EV](baseline-codex-healthy-v1--smoke-healthy-v1__Z4eU7EV/index.md) | codex | harness-invalid | 80 | 32 | 5 |
| [baseline-priority-v12--credits__5u9gdM8](baseline-priority-v12--credits__5u9gdM8/index.md) | claude-code | harness-invalid | 63 | 13 | 2 |
| [baseline-priority-v12--credits__Pdxefqz](baseline-priority-v12--credits__Pdxefqz/index.md) | codex | harness-invalid | 122 | 18 | 3 |
| [baseline-priority-v12--healthy__ApzP8X2](baseline-priority-v12--healthy__ApzP8X2/index.md) | claude-code | harness-invalid | 17 | 5 | 0 |
| [baseline-priority-v12--healthy__c2DiAmK](baseline-priority-v12--healthy__c2DiAmK/index.md) | codex | harness-invalid | 68 | 25 | 5 |
| [baseline-priority-v12--healthy__qAWEduZ](baseline-priority-v12--healthy__qAWEduZ/index.md) | claude-code | harness-invalid | 33 | 21 | 0 |
| [baseline-priority-v12--healthy__tehtdW6](baseline-priority-v12--healthy__tehtdW6/index.md) | codex | harness-invalid | 39 | 10 | 0 |
| [baseline-priority-v13--credits__8FQyeMP](baseline-priority-v13--credits__8FQyeMP/index.md) | codex | failed | 106 | 14 | 4 |
| [baseline-priority-v13--credits__BkqRPJ9](baseline-priority-v13--credits__BkqRPJ9/index.md) | claude-code | failed | 63 | 14 | 2 |
| [baseline-priority-v13--credits__GNYWrm4](baseline-priority-v13--credits__GNYWrm4/index.md) | claude-code | failed | 60 | 12 | 2 |
| [baseline-priority-v13--credits__pMa3zdp](baseline-priority-v13--credits__pMa3zdp/index.md) | codex | failed | 118 | 17 | 2 |
| [baseline-priority-v13--credits__qc4mKtM](baseline-priority-v13--credits__qc4mKtM/index.md) | claude-code | failed | 59 | 12 | 3 |
| [baseline-priority-v13--credits__xT9JB9X](baseline-priority-v13--credits__xT9JB9X/index.md) | codex | failed | 156 | 27 | 4 |
| [baseline-priority-v13--healthy__8heHuhR](baseline-priority-v13--healthy__8heHuhR/index.md) | codex | passed | 75 | 28 | 3 |
| [baseline-priority-v13--healthy__9ZDP5bv](baseline-priority-v13--healthy__9ZDP5bv/index.md) | claude-code | failed | 27 | 15 | 0 |
| [baseline-priority-v13--healthy__9e6btMY](baseline-priority-v13--healthy__9e6btMY/index.md) | claude-code | failed | 20 | 8 | 1 |
| [baseline-priority-v13--healthy__Vju72to](baseline-priority-v13--healthy__Vju72to/index.md) | claude-code | passed | 26 | 14 | 0 |
| [baseline-priority-v13--healthy__YYqEMAi](baseline-priority-v13--healthy__YYqEMAi/index.md) | codex | passed | 44 | 21 | 3 |
| [baseline-priority-v13--healthy__aNWS6j4](baseline-priority-v13--healthy__aNWS6j4/index.md) | codex | passed | 63 | 22 | 3 |
| [baseline-six-v11--v11-auth__J2ocbRr](baseline-six-v11--v11-auth__J2ocbRr/index.md) | claude-code | harness-invalid | 19 | 7 | 1 |
| [baseline-six-v11--v11-auth__VnurQ2L](baseline-six-v11--v11-auth__VnurQ2L/index.md) | codex | harness-invalid | 68 | 25 | 0 |
| [baseline-six-v11--v11-credits__GfAaPew](baseline-six-v11--v11-credits__GfAaPew/index.md) | codex | harness-invalid | 64 | 22 | 2 |
| [baseline-six-v11--v11-credits__rRzz8xe](baseline-six-v11--v11-credits__rRzz8xe/index.md) | claude-code | harness-invalid | 26 | 12 | 2 |
| [baseline-six-v11--v11-healthy__3YCuNWF](baseline-six-v11--v11-healthy__3YCuNWF/index.md) | codex | harness-invalid | 86 | 34 | 4 |
| [baseline-six-v11--v11-healthy__UqHeqxP](baseline-six-v11--v11-healthy__UqHeqxP/index.md) | claude-code | harness-invalid | 37 | 25 | 2 |
| [baseline-six-v12--auth__E5Qeyba](baseline-six-v12--auth__E5Qeyba/index.md) | codex | harness-invalid | 73 | 27 | 3 |
| [baseline-six-v12--auth__Tx2qPDy](baseline-six-v12--auth__Tx2qPDy/index.md) | claude-code | harness-invalid | 18 | 5 | 1 |
| [baseline-six-v12--credits__cVKVZ3s](baseline-six-v12--credits__cVKVZ3s/index.md) | claude-code | harness-invalid | 64 | 12 | 2 |
| [baseline-six-v12--credits__nSYKqAf](baseline-six-v12--credits__nSYKqAf/index.md) | codex | harness-invalid | 108 | 14 | 4 |
| [baseline-six-v12--healthy__dyyzkKT](baseline-six-v12--healthy__dyyzkKT/index.md) | codex | harness-invalid | 76 | 29 | 4 |
| [baseline-six-v12--healthy__nn7HFaC](baseline-six-v12--healthy__nn7HFaC/index.md) | claude-code | harness-invalid | 21 | 9 | 0 |
| [heldout-discovery-v13--discovery__gvhHS8f](heldout-discovery-v13--discovery__gvhHS8f/index.md) | codex | passed | 56 | 19 | 1 |
| [heldout-discovery-v13--discovery__pXszNVb](heldout-discovery-v13--discovery__pXszNVb/index.md) | claude-code | passed | 17 | 4 | 2 |
| [patched-auth-provider-recovery-v13--auth__Qgcz284](patched-auth-provider-recovery-v13--auth__Qgcz284/index.md) | claude-code | passed | 18 | 6 | 1 |
| [patched-auth-v13--auth__GiXEbFi](patched-auth-v13--auth__GiXEbFi/index.md) | codex | passed | 56 | 19 | 0 |
| [patched-auth-v13--auth__UifmxRq](patched-auth-v13--auth__UifmxRq/index.md) | claude-code | provider-blocked | 10 | 0 | 0 |
| [patched-cycle2-auth-v13--auth__3bkokhu](patched-cycle2-auth-v13--auth__3bkokhu/index.md) | claude-code | passed | 17 | 5 | 1 |
| [patched-cycle2-auth-v13--auth__MV27c9o](patched-cycle2-auth-v13--auth__MV27c9o/index.md) | codex | passed | 71 | 26 | 1 |
| [patched-priority-v12--credits__dgE22DX](patched-priority-v12--credits__dgE22DX/index.md) | codex | harness-invalid | 0 | 0 | 0 |
| [patched-priority-v12--healthy__HKPw54D](patched-priority-v12--healthy__HKPw54D/index.md) | codex | harness-invalid | 44 | 13 | 1 |
| [patched-priority-v12--healthy__tWN9K4n](patched-priority-v12--healthy__tWN9K4n/index.md) | claude-code | harness-invalid | 21 | 9 | 0 |
| [patched-priority-v13--credits__2VnceLk](patched-priority-v13--credits__2VnceLk/index.md) | codex | failed | 126 | 19 | 3 |
| [patched-priority-v13--credits__3FwJ2EP](patched-priority-v13--credits__3FwJ2EP/index.md) | codex | failed | 130 | 20 | 3 |
| [patched-priority-v13--credits__4BKh3GD](patched-priority-v13--credits__4BKh3GD/index.md) | claude-code | failed | 55 | 9 | 2 |
| [patched-priority-v13--credits__N899Gvo](patched-priority-v13--credits__N899Gvo/index.md) | codex | failed | 122 | 18 | 5 |
| [patched-priority-v13--credits__VeVnafu](patched-priority-v13--credits__VeVnafu/index.md) | claude-code | failed | 63 | 14 | 2 |
| [patched-priority-v13--credits__ahsPU49](patched-priority-v13--credits__ahsPU49/index.md) | claude-code | failed | 66 | 14 | 2 |
| [patched-priority-v13--healthy__7v3Rxn2](patched-priority-v13--healthy__7v3Rxn2/index.md) | codex | passed | 81 | 31 | 3 |
| [patched-priority-v13--healthy__Am8udgv](patched-priority-v13--healthy__Am8udgv/index.md) | codex | passed | 69 | 25 | 2 |
| [patched-priority-v13--healthy__FC2asax](patched-priority-v13--healthy__FC2asax/index.md) | claude-code | failed | 26 | 14 | 0 |
| [patched-priority-v13--healthy__Y5tN7Rb](patched-priority-v13--healthy__Y5tN7Rb/index.md) | claude-code | failed | 19 | 7 | 1 |
| [patched-priority-v13--healthy__n6vuCQA](patched-priority-v13--healthy__n6vuCQA/index.md) | claude-code | failed | 31 | 18 | 0 |
| [patched-priority-v13--healthy__v7cNkex](patched-priority-v13--healthy__v7cNkex/index.md) | codex | failed | 70 | 26 | 3 |
