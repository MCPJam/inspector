---
"@mcpjam/inspector": patch
---

Say what connecting a repository to PR checks authorizes, at the moment it is
authorized (Evals v2, Lane G, step G4e — inspector half).

A pull-request check has no pre-run human moment. Nobody approves the run a
push triggers; it starts, calls models with that pull request's contents, and
concludes on the pull request minutes later. `connect_eval_check_repo` is
therefore the consent moment for the data handling of every run that follows
it, and until now it described only the outage policy.

- `ConnectRepoDataHandlingNote` — one visible line, specifics behind an
  expand — beside `OutagePolicyExplainer` at both connect affordances
  (Settings → Integrations → GitHub, and the suite's own "run this on every
  pull request" section). It lives in one module for the same reason the
  policy explainer does: two surfaces grant this authorization, and two
  wordings of the same grant is the failure worth preventing.
- The `connect_eval_check_repo` prompt note and its workspace-exclusion
  reason carry the same facts, so an agent proposing the connect says them
  too. The registry's pinning test is updated in the same commit.

Copy discipline, which is the whole difficulty of the change: every sentence
is a fact the platform enforces today, and the two that a friendlier rewrite
would soften first are exactly the two that would then be false —

- redaction is credential-shaped pattern matching and **not** a DLP system,
  a limitation `evalIngestRedaction` documents about itself; and
- retention is **not enforced yet** (`effectiveToday` is `kept-indefinitely`
  until the sweep gate opens), so the honest sentence is that evidence is
  retained under the plan's policy once enforcement is enabled and kept until
  then.

Per-run facts — which models a run called, where they routed, which analyzers
fired — are not knowable at connect time, so the note points at the run's own
disclosure rather than guessing. A missing fact must never become a
reassuring sentence: tests pin both the copy and a list of promises it must
never make.

Copy and tests only; no SDK type change and no backend call.
