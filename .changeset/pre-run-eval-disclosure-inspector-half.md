---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Add the pre-run disclosure surface — what a run's content will touch,
disclosed before you launch it (Evals v2, Lane G, step G4b).

The backend contract (`testSuites:getRunDisclosure`, g4a) computes the whole
disclosure: which models a run calls and where they route, which LLM
analyzers/judges can fire and where their evidence goes, capture/retention/
region facts, and the subprocessors engaged. This adds the inspector-side
projection and every surface that reads it:

- a new `GET /v1/projects/:projectId/eval-suites/:suiteId/run-disclosure`
  route that composes `execution.locus` (MCPJam-hosted vs. the caller's own
  machine — a fact only the inspector process can answer) onto the backend's
  contract, and answers an explicit `FEATURE_NOT_SUPPORTED` /
  `contract_unavailable` on a backend that predates the query rather than a
  partial payload;
- `@mcpjam/sdk/platform`: `PlatformEvalRunDisclosure` and its sub-types,
  `PlatformApiClient.getEvalRunDisclosure`, and a read-only
  `get_eval_run_disclosure` operation. `run_eval_suite` now fetches the
  disclosure for its frozen launch plan and fires the new
  `PlatformOperationContext.onDisclosure` callback before it creates the run,
  and returns it on the receipt's `disclosure` field — one resolution, so
  what is disclosed is exactly what runs;
- `mcpjam eval run` prints the disclosure in human mode, before the run link;
  `--format json` carries it inside the single receipt document, unchanged;
- a read-only disclosure hint beside "Run all" in the eval suite header, and
  a threaded (never self-fetching) slot in the suite-creation review step.
  Purely informational — it never gates, disables, or delays a run.

Guests can already launch a run (`POST /eval-suites/:id/runs`), so the new
route joins the guest allowlist and the hosted-auth bearer-scope patterns —
denying them the disclosure that describes what their own run does would be
the one gap that actually mattered.

The backend half (mcpjam-backend #1119) is merged and deployed to staging;
the production promote is still owed, so this surface is inert in production
until it fires there.
