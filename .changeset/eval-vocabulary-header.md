---
"@mcpjam/sdk": minor
---

`PlatformCapabilities.vocabulary` describes the eval vocabulary a deployment
understands: the `version`, the evaluator and assertion kinds, and for each
canonical field (`assertions`, `defaultAssertions`, `iterations`,
`legacyIterations`) the legacy spellings a request sending
`x-mcpjam-eval-vocabulary: 2` may still use. Absent on a deployment that
predates the negotiation, which then speaks only vocabulary 1. Read the value;
never infer support from a field's presence.
