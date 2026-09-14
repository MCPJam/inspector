---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

Read and write eval suite files in `schemaVersion: "2"`, which spells the
configured count `iterations` and the case's rules `assertions`.

The suite-file validator is now a discriminated union over two dialects.
Dialect `"1"` is frozen: its zod shape, its published JSON Schema
(`…/eval-suite/v1.json`) and its `repetitions` / `checks` (alias `assertions`)
spellings do not change, so an older strict reader keeps validating exactly what
it always did. Dialect `"2"` publishes its own document at
`…/eval-suite/v2.json` (`evalSuiteFileV2JsonSchema`), has one word per field
and no aliases, and refuses the dialect-1 spellings as unknown keys — the
loader's finding says which dialect spells the field that way and offers both
fixes, instead of a bare "Unrecognized key".

The loader reads both dialects into one resolved view, and that view now uses
the canonical word: `ResolvedEvalSuiteFile.defaults.repetitions` and
`ResolvedEvalSuiteFileCase.repetitions` are renamed to `iterations`. This is a
breaking change for code that reads the resolved shape directly; the authored
shape (`EvalSuiteFile`, now `EvalSuiteFileV1 | EvalSuiteFileV2`) is unchanged
for dialect 1. `serializeEvalSuiteFile` writes a file back in its own dialect
and never upgrades one on its author's behalf.

The CLI follows the resolved-shape rename internally; nothing it sends on the
wire changes, and `eval export` still writes dialect 1.
