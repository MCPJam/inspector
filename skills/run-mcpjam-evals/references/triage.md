# Triaging a run that did not pass

The order matters. Each step narrows what you are looking at by roughly an order of magnitude, and skipping one means reading the next level's rows without knowing which of them matter.

## 1. `get_eval_run` — what decided this?

Start here, always. The `decisionSummary` carries the verdict and **`verdictSource`**: what actually produced it. That single field redirects the whole investigation, because the causes are unrelated to each other:

| `verdictSource` says | You are looking at | Go to |
|---|---|---|
| a pass-rate threshold | cases that failed on their assertions | §2 |
| an LLM judge | grading, not assertions | §4 |
| a gate or waiver | policy, not test results | §5 |
| an error / infrastructure failure | the run never really executed | §6 |

Reporting "the evals failed" without naming the source is the most common way to send someone debugging the wrong layer.

## 2. `list_eval_run_iterations` — which cases, and how consistently?

One row per iteration: pass/fail, expected vs actual tool calls, token usage, latency.

**Paginated.** Pass `nextCursor` back as `cursor` until it comes back absent. A pass rate computed from page one is not the run's pass rate.

What to look for, in order:

- **A case that fails every iteration** is deterministic — a real disagreement between the case and the server. Go to §3.
- **A case that fails some iterations** is non-determinism, and the case may be at fault rather than the server: an ambiguous prompt that lets the model pick either of two reasonable tools will fail intermittently forever. Prefer reporting the rate over declaring a bug.
- **Expected vs actual tool calls** is usually the whole answer for a tool-selection eval. If the actual call is a *reasonable* response to the prompt, the case's expectation is the thing to question.
- **Latency or token outliers** alongside failures often mean the model ran out of steps rather than chose wrong.

## 3. `get_eval_run_steps` — which step, and what evidence?

Needs `runId` **and** an `iterationId` from §2. Returns one row per authored step, in order, each with a status (`ok` / `fail` / `skipped` / `pending`), a reason, and evidence — screenshot and video URLs, widget tool calls.

- **The first `fail` is the one to read.** Everything after it is downstream, and a cascade of failures usually has one cause.
- **`skipped` after a `fail`** confirms the cascade; it is not additional information.
- **`pending` on a terminal run** means the run ended before that step — look for a timeout or a cancellation, not a wrong answer.
- Follow the evidence URLs before theorising. A screenshot settles in one look what a reason string can only describe.

## 4. When a judge decided it

`request_eval_run_judge` scores each case's final answer against its expected output. If the verdict came from grading:

- The tool calls may all be correct and the run still fail — the disagreement is about the *answer*, not the behaviour.
- Check the judge `threshold` and `model` before concluding the implementation is wrong. A threshold set for one model is not automatically right for another.
- Re-running the judge **spends budget again**. Do it because a setting was wrong, not to see whether the score moves.

## 5. When a gate or waiver decided it

`get_eval_gate_waiver` explains a run whose verdict came from policy rather than results. A waived or gated run can show passing cases and still not pass, and vice versa. Say so explicitly — this is the case people most often misread as a broken test.

## 6. When the run never really executed

Infrastructure failures look like test failures in a summary and are nothing like them. Signals: every case failing identically, zero token usage, steps stuck `pending`, a `failed` status with no per-case detail.

`get_eval_run` takes `diagnosticsCursor` and `diagnosticsLimit` for exactly this — page through the diagnostics rather than inferring from case results. Do not report a server bug on the strength of a run that never called a model.

## 7. Was it a regression?

`compare_eval_run` against `baseRunId` (or `baseCommitSha`) is what separates "this is broken" from "this was always broken":

- **`regressed`** — the only status that means your change did it.
- **`unchanged_failed`** — failing before and after. Real, but not new, and not what the person asking about their change wants triaged first.
- **`new_case`** — a case that did not exist in the baseline. It cannot be a regression, whatever its result.
- **`changed`** — the case itself was edited, so the two results are not comparable. Say so rather than counting it either way.

Per-scorer pass-rate and mean deltas come back too; a small mean drop across many cases is a different problem from one case flipping, and they call for different responses.
