---
"@mcpjam/sdk": minor
---

`run_eval_suite` and `run_eval_case` now document `iterations` as the per-run
count knob and `repetitions` as its legacy spelling.

Both spellings were already accepted and both still fold onto the wire's
`iterationOverride`, so no run behaves differently. What changes is the
contract's own words: `iterations` is the canonical name of the configured
count (`docs/evals-vocabulary-consolidation.md`), so it is declared first and
carries the full description, and `repetitions` is described as its legacy
spelling. Sending both is still a refusal rather than a precedence rule, now
reported on the canonical path with one sentence shared by every surface:
`Send iterations or repetitions, not both — they are two spellings of one field.`
