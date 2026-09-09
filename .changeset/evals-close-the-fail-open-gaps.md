---
"@mcpjam/sdk": minor
---

Evals: close the gaps where a gate could pass on absent evidence.

Four changes, three of which alter identifiers you may have stored. None of
them changes what a rule MEANS — but a comparison against a baseline recorded
before this release will report the scorer as CHANGED rather than matching.

- **Anonymous predicate scorer ids lengthen.** A predicate scorer created
  without an explicit id now derives its id from the full content digest
  instead of an 8-character prefix. Ids of the form `predicate:<type>#<8 hex>`
  become `predicate:<type>#<64 hex>`.
- **The judge template version moves from 2 to 3**, so every judge's
  `implementationHash` and `definitionHash` changes. The rubric now rides the
  system channel and `promptHash` digests both channels.
- **Gate rows join on `definitionHash` rather than `scorerId`.** A scorer id
  that resolves to more than one definition in a run is now a loud
  `usage_error` instead of an arbitrary pick.
- **`maximumTotalTokens` becomes `non_gateable` on a run with no usable
  iterations**, where it previously read an absent total as `0` and passed.

If you pin baselines by scorer id or compare `definitionHash` across releases,
re-record them after upgrading.
