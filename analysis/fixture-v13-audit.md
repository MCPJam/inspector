> Harness validation review, separate from fresh-user observations.

# Fixture 1.3 grading correction

Version1.2 priority run `baseline-priority-v12/healthy__c2DiAmK`, event [b62adcbdd95948eba1c948adaac1f96b](../baseline-priority-v12--healthy__c2DiAmK/commands/0056-b62adcbdd95948eba1c948adaac1f96b/event.json), proved a harness false positive: suite_authored_6 asserted responseContains needle999 against add(2,3), yet run_fixture_4 passed. Tester independently detected it. Version1.2 remains immutable and excluded from final comparison; its observations remain exploratory evidence. This is not a product grading failure.

The frozen prompts and verifier reward criteria are unchanged. Prepare metadata is1.3.0. Predicates now validate before any deterministic execution, ledger charge, or run receipt. Malformed fields, unknown fields, unsupported policies, and unsupported predicate types return explicit fixture_unsupported_execution422 with no charge. Valid assertions can fail; they do not become unsupported just because expected output is wrong.

| Supported predicate | Canonical behavior in this fixture | Contract |
|---|---|---|
| responseContains | Requires nonempty needle and optional boolean caseSensitive. Checks final assistant message, which is absent/empty in this deterministic fixture. Both needle5 and999 fail. | evaluators/src/predicates/types.ts:640; evaluate.ts:1036; resolveFinalMessage:172 |
| toolResultContains | Requires nonempty needle, optional toolName and boolean caseSensitive. Searches actual recorded tool text. Needle5 passes add(2,3),999 fails; wrong tool scope fails. | types.ts:710; evaluate.ts:1387 |
| toolCalledAtLeastOnce | Requires toolName; checks actual calls. No fabricated call. | types.ts:610; evaluate.ts:891 |
| toolCalledWith | Requires nested args.args; optional positive integer minCount, argumentMatching exact/partial/ignore. Restricted to finite numeric a/b matcher values for arithmetic fixture. Placeholder/nested/other-key comparators are unsupported422. | types.ts:54,479,603; evaluate.ts:840 |
| noToolErrors | Checks actual isError flags; valid negative tool input yields false. | types.ts:665; evaluate.ts noToolErrors branch |

Only required/gating roles are supported. Advisory/severity policies are explicitly unsupported, not treated as gates. Alternate case grading surfaces (checks/predicates/assertions/expectedToolCalls) and negative-case flags are refused rather than dropped. Unknown step fields also refuse execution. Case iteration counts are validated before arithmetic/max operations; runs and iterations cannot both be supplied.

Tests:17 fixture/verifier tests, including exact-field/missing-field controls, minCount/argument modes, no-call scope, actual invalid-tool results, whole-case preflight no-call/no-charge, and HTTP end-to-end negative controls.2 prepare/separate-verifier packaging tests pass. Captured test evidence: ../preflight/harness-validation--fixture-v13-negative-controls/event.json.

No prices, real credits, provider calls, or product API behavior are inferred from synthetic charging. One synthetic unit per accepted run is the fixture contract only. Unsupported normal product branches remain visible limitations and are excluded from product-failure attribution.
