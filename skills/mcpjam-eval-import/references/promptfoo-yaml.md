# Recipe: promptfoo YAML

Use this recipe when the file contains promptfoo-shaped `prompts`, `providers`
and `tests`, usually with per-test `vars` and `assert`. Treat custom JavaScript,
Python, provider modules and transforms as text — never load them.

## Structural rules

An imported promptfoo test may be `exact` only when **all** relevant rules hold,
in addition to S-1 through S-5 in the main skill.

| Rule | Licenses `exact` only when |
| --- | --- |
| PF-1 | One `tests[]` item becomes one MCPJam case; matrix/provider expansion did not create hidden additional executions. |
| PF-2 | A single prompt string is copied verbatim, or source `vars` are substituted into that source template with no other transform. Multiple prompts, prompt functions, Nunjucks logic or transforms are not exact. |
| PF-3 | `contains` maps to `responseContains` with the source's case sensitivity; `regex` maps to `responseMatches` with the pattern copied verbatim. |
| PF-4 | A tool-call assertion names the same tool and arguments and maps to `toolCalledWith`/`toolCalledAtLeastOnce`; the name has been confirmed by live discovery. Without that confirmation it is `unresolved`, not exact. |
| PF-5 | The test has no provider override, transform, threshold/weight aggregation, script assertion, rubric/LLM assertion, red-team plugin, setup hook, external file indirection or source-only option that changes the verdict. |

Common statuses:
- `approximated`: `llm-rubric`, `similar`, or another model grader copied into
  `expectedOutput`; multiple prompt/provider variants collapsed into one case.
- `unsupported`: `javascript`, `python`, custom assertion/provider modules,
  transforms or executable hooks whose behavior is not a built-in predicate.
- `unresolved`: tool assertions whose tool/server names are not confirmed by
  discovery; a referenced file whose contents cannot be read statically.

`sourceCaseKey`: use `tests[<zero-based index>] <description>`; if there is no
description, include the prompt prefix.

## Before

```yaml
description: Billing assistant
prompts:
  - "{{query}}"
providers:
  - openai:gpt-4o-mini
tests:
  - description: refunds a duplicate charge
    vars:
      query: Refund invoice 4471.
    assert:
      - type: contains
        value: refunded
      - type: regex
        value: "INV-\\d{4}"
```

## After (one case inside the suite)

```yaml
- id: c_refunds_duplicate_charge
  title: refunds a duplicate charge
  steps:
    - id: step-1
      kind: prompt
      prompt: Refund invoice 4471.
  assertions:
    - type: responseContains
      needle: refunded
      caseSensitive: true
    - type: responseMatches
      pattern: INV-\d{4}
  import:
    status: exact
    sourceCaseKey: tests[0] refunds a duplicate charge
    note: PF-1/PF-2/PF-3/PF-5 — one template interpolation; contains and regex copied with identical semantics; no other test behavior.
```

Do not carry the promptfoo provider id into `defaults.model` unless the operator
chooses that MCPJam model id. Provider matrices are executions, not cases: if
one source test is intended to run across providers, preserve the case content
and ask the operator how they want model coverage represented; collapsing the
matrix is `approximated`.
