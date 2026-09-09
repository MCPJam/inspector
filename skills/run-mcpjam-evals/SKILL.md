---
name: run-mcpjam-evals
description: Drive MCPJam's hosted eval tools end to end — check what a run will cost and disclose, launch it, poll it to a verdict, and triage a failure down to the step that failed. Use when connected to MCPJam's MCP server and asked to run, re-run, investigate, or compare eval results, rather than to author eval files locally.
---

# run-mcpjam-evals

You have MCPJam's hosted eval tools. This is the order to call them in, and the two places calling them wrong costs real money.

**This skill is about running evals that already exist.** To *write* eval files, use `create-mcp-eval` (SDK tests) or `mcpjam-eval-import` (convert an existing corpus). To author suites through these tools instead, see `references/authoring.md`.

## Reference map

| You are about to… | Read |
|---|---|
| Work out why a run did not pass | `references/triage.md` |
| Create a suite or add cases through the tools | `references/authoring.md` |

## The loop

```
list_eval_suites → get_eval_run_disclosure → run_eval_suite → get_eval_run (poll)
                                                                    ↓
                                          list_eval_run_iterations → get_eval_run_steps
                                                                    ↓
                                                            compare_eval_run
```

**1. Orient.** `list_eval_suites` returns suites with latest-run summaries and pass-rate trends. With no `project` it uses the most recently updated accessible one — fine for a quick look, but pass `project` explicitly the moment you are about to change or spend anything, or you may act on a project the user did not mean.

**2. Disclose before you spend.** `get_eval_run_disclosure` answers what a run does *before* it happens: which models it calls and where they route, which judges can fire, and what is captured or retained. Call it when a user has not run this suite before, when the suite has changed, or whenever they ask what a run will do. It is read-only and free.

**3. Launch.** `run_eval_suite` is **asynchronous** — it returns a `runId` immediately and the work continues server-side.

**4. Poll.** `get_eval_run` with `project` and `runId` until `status` is terminal: `completed`, `failed`, or `cancelled`. Anything else means still running; wait and ask again. Do not re-launch because a result is not ready.

**5. Read the verdict.** On anything other than a pass, **start at `get_eval_run`'s `decisionSummary`** — it carries the verdict and `verdictSource`, which tells you what actually decided the outcome. Do not jump straight to iterations; you will read a lot of rows without knowing what you are looking for. `references/triage.md` is the decision tree from here.

**6. Compare, when there is a baseline.** `compare_eval_run` with `baseRunId` (or `baseCommitSha`) classifies each case as `regressed`, `fixed`, `new_case`, `removed_case`, `changed`, `unchanged_passed`, or `unchanged_failed`. This is the tool that answers "did my change break anything", which a single run's pass rate cannot.

## Money

Two tools spend the organization's model budget. Both are marked `COSTS MONEY` in their descriptions, and neither is reversible once started.

- **`run_eval_suite`** — every iteration of every case is a model call.
- **`request_eval_run_judge`** — LLM-as-judge grading over a finished run.

Rules:

- **Confirm before the first spend in a conversation.** Say which suite, how many cases, and — if the user set `repetitions` or `iterations` — what that multiplies out to. "Run the evals?" is not a confirmation if the user has not been told it bills.
- **Never call either in a loop, or to poll.** Polling is `get_eval_run`, which is free.
- **Pass `idempotencyKey` when a launch might be retried.** A transport error is not proof the run did not start; retrying without the key can bill the same run twice.
- **A failed run has already been paid for.** Re-running to "see if it passes this time" spends again and is rarely the right next step — triage first.

## Polling without being a nuisance

`get_eval_run` is free, but it is not free of latency, and a tight loop reads as a hung agent.

- Wait between polls, and lengthen the wait as the run goes on. A suite with many cases takes minutes, not seconds.
- Say what you are waiting for the first time; do not narrate every poll.
- `list_eval_run_iterations` is **paginated** — pass the returned `nextCursor` back as `cursor` until it is absent. A first page is not the whole run, and treating it as one will make you report a pass rate that is not the run's.
- To stop a run: `cancel_eval_run` with `project` and `runId`. It terminates in-flight work, so confirm first.

## Getting the arguments right

- **`project` is the first argument of every one of these tools.** Resolve it once, explicitly, and reuse it. A `runId` from one project is meaningless in another.
- **`runId` comes from `run_eval_suite`'s result**, and from `list_eval_suites`' latest-run summaries for runs you did not start.
- **`iterationId` comes from `list_eval_run_iterations`.** `get_eval_run_steps` needs both `runId` and `iterationId`; there is no way to guess one.
- Read the tool description before passing an option this skill does not mention. `run_eval_suite` takes many (`environments`, `hosts`, `compose`, `matchOptions`, `minPassRate`, …) and each changes what the run means.
