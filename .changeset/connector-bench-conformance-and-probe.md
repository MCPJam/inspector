---
"@mcpjam/inspector": patch
---

Connector Bench: the conformance and auth-probe children

The bench worker gains the two children that cost no model credits, and runs both **before** the eval matrix — a cancellation or an exhausted budget should never be what throws away the cheapest, most reusable evidence.

**The auth probe is an observation, not a receipt.** v1's auth evidence was `client_reported`: a number the submitter computed about their own server, which nobody outside MCPJam has any reason to believe. The probe child makes one bounded, unauthenticated request from our own infrastructure through the same `probeThroughEgressGuard` wiring the connection preflight uses — DNS-pinned, redirect-revalidating, refusal-ordered — and files what a stranger sees. A probe that could not run reports `failed` or `refused` with a reason and **no checks**, so the backend records the roster row unavailable rather than stamping it verified: a completed probe with nothing in it reads, downstream, as a server that had nothing wrong with it. `nonCompliantChallengeStatus` is recorded as the number it was, because a 403, a 200 and a 500 in place of the 401 the spec requires have three different remediations.

**OAuth runs as a pinned headless exam instead of being excluded.** `executePersistedConformanceRun` accepts a `source: 'benchmark'` origin and an `oauth` config, and the definition pins — by id — exactly which OAuth checks the headless exam grades. A check that **applies but cannot run headlessly is recorded `could-not-run`, never `not-applicable`**: `not-applicable` means the requirement cannot apply to this server and a score drops it from the denominator entirely, so collapsing the two is precisely how a run that reached a third of the suite comes to print full marks. The one signal allowed to mean "the target genuinely does not advertise this" is the suite's own unauthenticated pre-flight — a server that serves without challenging has no authorization obligations, because authorization is OPTIONAL in every MCP revision. Checks outside the pinned scope keep their verdicts verbatim and are marked `pending`: reported, not graded. Interactive-flow support is a future track and is not faked.

**Redaction happens before the write, not at projection time.** A completed OAuth run carries a live access token, a refresh token, the client secret and the `Authorization` header of every request it made. `redactConformanceReportForSharing` now runs inside the executor, before `upsertReportAction` persists any OAuth report — redacting when the report is later projected into benchmark evidence would mean the credentials were already at rest in `conformanceRuns`, readable by every surface that reads a run and un-recallable once written.

Also: a requested OAuth suite with no auth strategy is now recorded as an explicit incomplete suite rather than being allowed to refuse the whole run, which used to take the protocol/apps/tasks reports down with it.
