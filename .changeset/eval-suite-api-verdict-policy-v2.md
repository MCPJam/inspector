---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

The suite API learns the v2 verdict policy, the revision, and the schedule's state

**A settings row nothing could drive.** The suite settings sheet is about to
grow controls for verdict policy v2 — repetitions, a pass threshold, and the
three validity ceilings — but the public PATCH accepted none of them. An agent
or the CLI would have been looking at a settings page with fields they had no
way to write, which is the exact gap the settings manifest exists to catch.
`PATCH /v1/projects/{p}/eval-suites/{id}` now takes `settings.repetitions`,
`settings.passThreshold` and `settings.validity`, in the same shapes a suite
file declares them.

**Upgrading is explicit; editing merges.** On a legacy suite the two halves
travel together or not at all — a v2 policy with a repetition count and no
threshold is not a partial answer to "what is my case graded against", it is an
unanswerable one, and the platform refuses it — so sending one alone is a 400
that names the other rather than a rejected mutation. On a suite already on v2,
a partial edit merges over what is stored, `validity` field by field, because
someone raising one ceiling did not ask to clear the other two.

**The two thresholds are alternatives, never layers.** `minimumAccuracy` is a
PERCENT against a legacy trial resolver; `passThreshold` is a FRACTION against
each case's own repetitions. Sending both is refused, sending the percent to a
v2 suite is refused with a message pointing at the fraction, and nothing on this
path divides by 100 — a silent conversion would move every bar by a factor of a
hundred while reporting success.

**One PATCH was several edits in the history.** This handler applies up to four
mutations, and each records its own suite revision, so one request that renamed
a suite and re-attached its environments read back as unrelated edits a
millisecond apart. Every write in a request now shares one revision group.

**A stale precondition read as a platform failure.** `expectedRevisionNumber`
turns a PATCH into a compare-and-set, and the platform refuses a stale one
having written nothing — but it spells that refusal `EVAL_SUITE_REVISION_CONFLICT`,
which fell through to the generic 500 fallback. A caller who supplied a correct
precondition was told the platform had broken. It is now a 409 `CONFLICT`
carrying the current revision number, because "reload and retry" is only
actionable if you learn what to retry against.

**A paused schedule looked healthy.** The suite DTO reported `schedule.enabled`
and nothing else, and a schedule that pauses itself — on exhausted quota, on its
owner losing access, after repeated failures — keeps `enabled: true`. A caller
reading only that field reported a working automation that had not run in a
week. The DTO now carries `state`, `createdBy`, `nextDueAt` and
`consecutiveFailures`, plus the suite's `revisionNumber` and a one-word
`settings.policy` so nobody has to infer the policy from a field's absence.
