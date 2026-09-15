---
"@mcpjam/sdk": patch
---

Document the eval-suite grading settings as named OpenAPI schemas, and the quality gate for the first time.

`EvalSuiteDetail.settings` was an inline object, which put it out of reach of the spec↔SDK parity ratchet — that guard pairs SCHEMAS, so the one block describing how a suite is graded was described twice by hand with nothing comparing the two descriptions. It is now `EvalSuiteSettings` and `EvalSuiteSettingsV2`, paired against `PlatformEvalSuiteSettings` and `PlatformEvalSuiteSettingsV2`.

The extraction immediately found the gap it exists to find: **`settings.qualityGate` has been on the SDK type and absent from the spec since it shipped.** It is now documented, with `SuiteGatePolicyV1` as its own schema — the baseline selector's three variants (including the reserved one, marked as reserved rather than looking available), the four conditions, and the note that an omitted condition is not evaluated at all rather than being a condition set to zero. `SuiteGatePolicyV1` is deliberately unpaired: its SDK twin is a zod-inferred type in the contract layer, not an interface in `platform/types.ts`, which is what the parity parser reads.

Requiredness came out of the same pass. The extracted schemas now declare the four fields the DTO always emits, which the inline block never said, so a caller reading the spec learns that `judge` is always present and fully resolved rather than optional.

Twenty-one field descriptions across the eval schemas move off "verdict policy v2" and onto what each field measures — which criterion decides a suite, which population a count is in, and the counterexample that stops the conversion: ten cases, nine always passing and one always failing, passes a 90% suite-wide bar and fails a 0.9 per-case one.
