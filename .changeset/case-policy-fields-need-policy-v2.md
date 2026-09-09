---
"@mcpjam/inspector": patch
---

Per-case `repetitions` / `passThreshold` are refused on a legacy suite, not stored inert

Both are verdict-policy-2 fields: the backend reads them only when the suite
carries `verdictPolicyVersion: 2`. On a legacy suite the trial count comes from
`runs` and `minimumIterations`, so both sat inert — accepted, forwarded,
stored, and echoed back by a `GET`, which is exactly the evidence a caller uses
to conclude the value landed.

The case write paths now reject them with a 400 that names the policy and the
upgrade. The two create paths already read the suite for their scope guard; the
PATCH path did not, and was the one door an inert value could still get
through, so it now reads the suite — but only when the body actually carries
one of these fields, so an ordinary title edit costs no extra round trip.

`repetitions` also allowed up to 100 — the suite-file contract's
`MAX_REPETITIONS` — while `iterations` allowed 10 and the CLI refuses anything
above 10 against this same API. Both are capped at 10 now, so the ceiling no
longer depends on which client is asking.
