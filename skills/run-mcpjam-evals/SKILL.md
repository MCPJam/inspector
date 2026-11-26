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

**4. Poll.** `get_eval_run` with `project` and `runId` until `status` is terminal: `completed`, `failed`, `cancelled`, or `timed_out`. Anything else means still running; wait and ask again. Do not re-launch because a result is not ready.

**5. Read the verdict.** On anything other than a pass, **start at `get_eval_run`'s `decisionSummary`** — it carries the verdict and `verdictSource`, which tells you what actually decided the outcome. Do not jump straight to iterations; you will read a lot of rows without knowing what you are looking for. `references/triage.md` is the decision tree from here. A diagnostic's `nextAction` can say to check the server connection when the cause was a model or credit failure, even with the `connection` and `discovery` stages `passed`. Trust the stage states and the iteration's error over that line. This is a known bug, fixed by https://github.com/MCPJam/inspector/pull/7873.

**6. Compare, when there is a baseline.** `compare_eval_run` with `baseRunId` (or `baseCommitSha`) classifies each case as `regressed`, `fixed`, `new_case`, `removed_case`, `changed`, `unchanged_passed`, or `unchanged_failed`. This is the tool that answers "did my change break anything", which a single run's pass rate cannot.

## Money

Two tools spend the organization's model budget. Both are marked `COSTS MONEY` in their descriptions, and neither is reversible once started.

- **`run_eval_suite`** — every iteration of every case is a model call.
- **`request_eval_run_judge`** — LLM-as-judge grading over a finished run.

Rules:

- **Confirm before the first spend in a conversation.** Say which suite, how many cases, and — if the user set `iterations` (or its legacy spelling `repetitions`) — what that multiplies out to. "Run the evals?" is not a confirmation if the user has not been told it bills.
- **Never call either in a loop, or to poll.** Polling is `get_eval_run`, which is free.
- **Pass `idempotencyKey` when a launch might be retried, and reuse it while the outcome is unknown.** A transport error is not proof the run did not start; retrying without the key, or with a new one, can bill the same run twice. Use a new key only when the user asks to relaunch a run you know stopped.
- **A failed run has already been paid for.** Re-running to "see if it passes this time" spends again and is rarely the right next step — triage first.
- **A run that stops for credits** (`user_rate_limit`, a daily or monthly MCPJam model limit, a spend budget, a required platform fee): read the refusal's `recovery` first — `creditRecovery` on `get_eval_run`, or `infraError.recovery` on the refused iteration. Give the user the step its `action` names and its `url`, copied exactly, and nothing else; when `actor` is `owner_or_admin`, the user has to send that link to an organization owner or admin. The run's `notes` and the diagnostic's `nextAction` give the same sentence. `resetAt` is for your records: don't suggest waiting for it, and don't offer BYOK instead, because BYOK does not remove platform fees. Unless the only step is to `wait` for a reset, this is a **block**: a person must act (the CLI surfaces it as exit `6`). Without a `recovery` (an older deployment), relay the one step the refusal's message names, with its link copied exactly, and nothing else. Results the run completed are saved. **Do not relaunch on your own.** When the user says they have done the step, make the `resume` call the refusal or `get_eval_run` returned **once**. For a stopped run it is `run_eval_suite` with `resumeFromRunId` and no target (it reruns only the unfinished cases on that run's own target) — never the old `idempotencyKey`, which returns the stopped run. For a refused launch it replays the same launch with the same `idempotencyKey`, which starts only the targets that did not start. If that is refused again, stop and tell the user it is still blocked; do not retry. Never pay, upgrade, or buy credits yourself.

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
