---
"@mcpjam/sdk": minor
---

Let `PlatformApiClient` speak eval vocabulary 2.

`new PlatformApiClient({ evalVocabulary: 2 })` sends `x-mcpjam-eval-vocabulary: 2`
on every request, under which a case spells its rules `assertions`, its exact
count `iterations` and the legacy floor `legacyIterations`, and the eval
responses come back in the same spelling. `client.withEvalVocabulary(2)`
derives that client from one you already hold — same credential, same base
URL, same launch declaration, one header more — which is the step from
"asked the deployment what it speaks" (`getProjectCapabilities().vocabulary`)
to "speaks it". Opt in only when the deployment advertises version 2: a
deployment that predates the negotiation ignores the header and answers in
vocabulary 1. `extraHeaders` can neither set nor clear the header.

The vocabulary-2 result shapes are typed: `PlatformEvalCaseV2`,
`PlatformEvalSuiteSettingsV2`, `PlatformEvalSuiteDetailV2` and
`PlatformEvalVerdictPolicyDefaultsV2`, each built on a shared `…Base` with
the vocabulary-1 type. The eval methods keep their vocabulary-1 return types;
a caller that opted in narrows. `EVAL_VOCABULARY_HEADER` is exported from
`@mcpjam/sdk/platform`.
