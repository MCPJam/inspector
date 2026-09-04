---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

A gating judge can hold a run, and every surface knows what holding looks like

**The judge's role was hard-coded advisory in the projection.** A suite could
earn the gate and the backend could hold its run, and this repo would still
write a score row the gate arithmetic never reads — structurally powerless, with
nothing to notice it. The role now travels on `metadata.judgeVerdict.role`,
stamped by the backend from the run's frozen config snapshot rather than from
the suite's settings as they stand today, so a run decides by the rules it
started under. The read is closed and fails closed: only the literal `"gating"`
gates, and absent, `"advisory"`, a future spelling or the wrong case are all
advisory, because the default here decides whether a judge may fail somebody's
build. `implementationHash` does not move — same judge, same template, same
arithmetic — and the advisory `definitionHash` stays byte-identical, which is
what keeps every hosted iteration ever recorded joined to its stored definition.

**A held run is not a finished run, and `grading` is the word for it.** A run
whose gating judge has not answered yet is neither running nor done: its
execution is over, its verdict is not. The run status vocabulary gains exactly
one member. It is deliberately absent from every terminal set — a caller that
polls for terminality keeps waiting, which is the correct behavior — so the
places that had conflated "past execution" with "terminal" now ask
`isRunPastExecution`, and the ones that mean "finished" are unchanged.

**Every surface that reports a run had to learn the word, or lie.** A status it
does not know renders as a fallback, and the fallbacks were wrong in different
ways on each surface: the runs list showed a held run as still running, the CLI
gave up at its wait deadline and exited non-zero, the GitHub check went red, and
Slack posted an outcome for a run that had none. So: the run badges gain a
`grading` state that reads as held rather than passed or failed; `mcpjam cloud
eval run` and `eval gate` extend their own wait by the backend's 30-minute hold
when the caller did not pin `--wait-timeout` (an explicit budget is still
honoured exactly); the GitHub check worker waits out the hold while it still
holds its lease, and stops waiting the moment it does not; and the Slack watcher
extends its own deadline through the hold instead of posting an outcome for a
run that has none (it posts nothing until the verdict lands).

**Nothing about the exit-code contract changed.** A run that finishes grading
exits on its real result, and a run still grading when an explicit deadline
expires still times out. `sdk/src/gates.ts`, `runReachedAVerdict`,
`effectiveRunResult` and `toRunDto` are untouched.

Requires the backend change that stamps the resolved role and lets the finalizer
own a held run's judge disagreement. Until that deploys, every judge is advisory
and nothing here does anything.
