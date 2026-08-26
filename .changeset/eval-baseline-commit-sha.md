---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

evals: pin an eval baseline by source commit SHA

`GET /eval-runs/:runId/compare` accepts `baseCommitSha`, resolved server-side
to the completed run in that suite recorded against the commit. The compare
DTO's `baseline` gains `commit_sha` as a policy, echoes the SHA back, and
reports `matchCount`/`matchCountTruncated` when uniqueness could not be
established — an absent count means the match was unambiguous, and a truncated
count is a floor rather than a total.

`mcpjam cloud eval gate` gains `--baseline-sha` and `eval compare` gains
`--base-sha`, each mutually exclusive with its run-id counterpart. The kind is
named by the flag rather than inferred: a Convex run id is an opaque string
with no documented format, and an abbreviated commit SHA is indistinguishable
from one, so a single guessing flag could silently compare against the wrong
run. A SHA passed to `--baseline` is rejected with a pointer to the right flag.

Gate provenance now records the requested selector and the run it resolved to,
so an archived report can answer which run a commit compared against. A SHA
that matches no completed run remains `incomplete` (exit 3), never a
regression.

Malformed baseline selections from the platform (`EVAL_COMPARE_BASELINE_CONFLICT`,
`EVAL_COMPARE_BASELINE_INVALID`) now answer 400 with the platform's own message
instead of a generic 500.
