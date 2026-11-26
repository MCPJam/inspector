# Definition of done for agent PRs

Draft for the Poteto pilot. An engineer is ready to request review when they can show that the PR meets its acceptance criteria and a reviewer can reproduce the result from the evidence in the PR.

## Evidence for every PR

- Fill in the task, spec, and plan in the [PR template](pull_request_template.md). State the behavior the change is meant to preserve or improve, including the failure path when it matters.
- List the applicable commands from [AGENTS.md](../AGENTS.md) and their outcomes in the PR. Link to the CI run or include the relevant output. If a required check is blocked, name it and state what still needs verification.
- Tie each acceptance criterion to a test, capture, or check result. For a bug fix, show the failure before the change and the same check passing after it when the original failure is reproducible.

## Evidence by change type

| Change | Evidence to attach |
| --- | --- |
| Static UI or copy | Before and after screenshots of the same screen and state. For a new screen, say it is new and attach the after screenshot. Include other viewport sizes when the layout changes at those sizes. |
| Interactive UI | A recording under 60 seconds of the changed flow in the running app. Show the relevant loading, error, or retry state. Include the verification command and setup needed to replay it. |
| API, server, CLI, or SDK behavior | A real request or command and its observed result. Include a regression check for the changed behavior and a representative error response when the contract covers one. |
| Stateful or cross-boundary flow | A small statechart or flow diagram of the changed boundary, with a trace or test result for the transitions at risk. If a model checker was used, link the model, command, and result. |
| Performance change | Before and after measurements from the same workload and environment. Include the input, command, and metric so a reviewer can repeat the comparison. |
| CI, lint, or architectural guard | A passing example and a known violation that the guard rejects. Include the diagnostic and the command that produced it. |
| Refactor or dependency change | Targeted test results for the consumers or behavior most likely to regress. |
| Documentation only | `git diff --check origin/main...HEAD` and confirmation that the changed links and commands resolve or run as written. |

Use the rows that apply to the change. One artifact can cover several criteria if the PR points reviewers to the relevant steps or timestamps. For a generated test, record the seed and replay command for any failure used as evidence. Use sanitized captures and logs so the evidence can be shared with reviewers.
