---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Stop counting checks that never ran as passes, in the protocol and apps suites.

Both runners computed their verdict as
`checks.every(check => check.status !== "failed")`, so a run where twenty
checks never executed still reported `passed: true`. The tasks suite fixed this
long ago — after a run where six of eight checks silently skipped and the suite
still reported success — and OAuth gained it recently. Protocol and apps were
the two holdouts.

They now speak the same vocabulary, extracted into one canonical module rather
than a fourth copy:

- **`skipReason`** on every skipped check: `"not-applicable"` (the requirement
  cannot apply to this server, so nothing is left unverified) versus
  `"could-not-run"` (it applies, but the run could not exercise it, so the
  obligation is untested). Every existing skip site is now classified — an
  era-gated check or an unadvertised capability is not-applicable; a broken
  session, a missing probe, or a walk that could not enumerate every tool is
  could-not-run.
- **`outcome`**: `"passed" | "failed" | "incomplete"`, with `passed` true only
  for `"passed"`.
- **`categorySummary.couldNotRun`** alongside the existing `skipped` total, and
  a summary line that reads `N/M checks passed, X failed, Y could not run,
  Z not applicable`.

The subscription probes needed care: one call site funnels three different
unavailable reasons, and only "server advertises nothing subscribable" is
genuinely inapplicable — the probe now carries its own classification rather
than the call site guessing.

**The CLI benefits too.** `protocol conformance` and `apps conformance` (and
their `conformance-suite` forms) now use the exit-code mapping tasks already
had: `3` for incomplete, `1` for failed, `0` for passed, with a suite taking
the worst of its runs and a failure outranking an incomplete. The reason a run
established nothing is written to stderr instead of having to be dug out of the
JSON. The reporters (`--reporter json-summary` / `junit-xml`) now carry
`skipReason` and `outcome`, which they previously dropped for **every** suite,
tasks included.

**This changes CI exit codes.** A protocol or apps run whose applicable checks
could not be exercised previously exited `0`; it now exits `3`. That is the
point — those runs were never establishing conformance — but pipelines that
treated a green exit as proof will start failing, and should.
