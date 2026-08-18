---
"@mcpjam/sdk": major
---

The eval step union rejects unknown fields.

`promptStepSchema`, `toolCallStepSchema`, `interactStepSchema`,
`assertStepSchema`, `elementLocatorSchema` (including its nested `role` object),
every `interactActionSchema` member and every `widgetAssertionSchema` member are
now `.strict()`. A key none of them declares is an error rather than a silently
stripped field.

5.0.0 closed every object the suite file itself declares and left this union
open, which was a real asymmetry rather than a stylistic one. The Convex mirror
of the union is built from `v.object` and has always rejected unknown fields, so
the same step payload was quietly trimmed by one validator and refused by the
other — a disagreement that surfaced at ingest, far from whatever wrote the
step. Step level is also where a mis-mapped *import* field actually lands: an
agent converting an upstream suite gets step fields wrong more often than
top-level ones, and "succeeded, dropped half of what it read" is the failure the
closed-schema rule exists to prevent.

If you generate steps programmatically, a step object carrying anything outside
the contract now fails to parse instead of being trimmed. Two things stay open,
deliberately:

- `toolCallStep.arguments` — the tool's own argument object. Its keys come from
  the server's input schema, not from this contract.
- A `Predicate` inside an `assert` step. That union is a separate contract
  module (`@mcpjam/sdk/predicates`) with its own Convex mirror, its own parity
  fixtures and many more authoring surfaces. Closing it is a change made there,
  with its own consumer audit.

The generated JSON Schema follows: step objects now carry
`additionalProperties: false`, because that is the validator's real behaviour
rather than an artifact of the output projection.

## `externalCaseId` is normalized, and suggested when an `id` is missing

`EvalTest` now trims `externalCaseId` at construction (dropping a
whitespace-only value entirely). The hosted key has always been derived from the
trimmed value — `external:` + `externalCaseId.trim()` — so a padded config
carried two spellings of one identity: the padded one on the wire and in the
`[id]` grep suffix, the trimmed one as the actual join key.

With one spelling in play, the missing-`id` error can suggest it:

```text
EvalTest "refunds a duplicate charge" has no `id`. A case's identity is
declared, not derived from its name — otherwise renaming the test forks its
hosted history. This test already declares `externalCaseId`, which is the key
its hosted history is joined on, so reuse it verbatim: id: "case_123"
```

`id := externalCaseId` is the migration rule for existing external-id users: the
two are one identity, and a backend that accepts both requires them to agree, so
minting a fresh id beside an existing `externalCaseId` is a conflict by
construction. Mint-fresh remains the suggestion when there is no
`externalCaseId`, and also when the one in hand falls outside the opaque-id
charset — suggesting a value the next line rejects would be worse than
suggesting a new one.
