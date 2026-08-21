---
"@mcpjam/inspector": patch
---

Harness evals: stop requiring a pinned computer image

A harness eval run needs a machine per iteration, and until now the only
machine it was allowed to use was a **custom pinned image**. On a deployment
whose image builder is the inert `stub` — the default, because
`COMPUTERS_ENV_BUILDER` is deliberately separate from `COMPUTERS_PROVIDER` and
the E2B build API is still unverified — every image such a deployment can build
boots a template the model broker then refuses to lease against. So harness
evals had no working road at all, while chat harness turns worked fine on the
same deployment by booting the personal computer's default template.

An unpinned harness run now boots the **deployment-default template**: the same
real image chat gets, still one fresh disposable box per iteration, still
released after. What the old rule actually protected — never borrowing the
acting member's personal computer, which is shared and stateful — is preserved
by always provisioning a box, not by demanding an image. (Requires the backend
counterpart; deploy that first.)

**Closes a gap where that protection did not hold.** The two single-case
surfaces never ran the harness gate at all, so a harness host there passed
admission, booted no box (both provisioning sites require a run), and fell
through to `resolveHarnessSandbox` — the personal computer, the one fallback
eval execution must never take. Single-case runs now refuse a harness host and
say to run the case as part of a suite.

The `bash`-without-a-computer refusal stays exactly as it is for **emulated**
runs, which still boot nothing. A harness run is exempt because its premise —
"there will be no computer" — is simply false for it.

Which iterations get a box is now `needsEphemeralEvalSandbox`, its own module
with its own tests. As an inline condition it could only be exercised by
driving a whole iteration, which is how the harness half of the rule went
missing: a harness run that boots no box does not fail loudly, it quietly runs
on someone's personal computer.
