# `@mcpjam/sdk` changelog

## 8.15.0

### Minor Changes

- [#5468](https://github.com/MCPJam/inspector/pull/5468) [`3860e31`](https://github.com/MCPJam/inspector/commit/3860e31683fcd1a940586d6433744afff0c861f7) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Add rubric checks, an advisory second judge for eval suites. Each grading criterion is asked on its own as a yes or no question with a probability, and a suite can add up to ten choice or score questions with a pass line each. Answers show on the trial scorecard under User value, and a criterion near even odds reads Uncertain. They never gate a run. Settings are edited in the app; the public API refuses `settings.judge.rubricChecks`. The SDK's run-disclosure types gain the `rubricChecks` touchpoint and the `typed_decision` rail routing, and `EVALUATOR_STAGE` gains `judge:rubricChecks`.

### Patch Changes

- [#5487](https://github.com/MCPJam/inspector/pull/5487) [`9f75d30`](https://github.com/MCPJam/inspector/commit/9f75d307d9e87eba261d962ee25dde6bfa110ea2) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Explain connection-refused and HTTP 404 failures with the MCP endpoint and a suggested next step. Preserve authentication handling and underlying transport errors, and omit credentials and query values from the displayed endpoint.

- [#5484](https://github.com/MCPJam/inspector/pull/5484) [`f5f03e1`](https://github.com/MCPJam/inspector/commit/f5f03e1f06c2b4f4b51ddeaa05fe77bdd36782cf) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Cut a fresh release of @mcpjam/inspector, @mcpjam/cli, and @mcpjam/sdk.

  This changeset carries no code changes. It ships the latest work on main and bumps all three packages in the same run so the published CLI depends on the new @mcpjam/sdk instead of the previous one.

## 8.14.0

### Minor Changes

- [#5429](https://github.com/MCPJam/inspector/pull/5429) [`afd161a`](https://github.com/MCPJam/inspector/commit/afd161a67a0f3226f016a078dec68e5af6b93a80) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Negotiate the public API's resource-noun **values** behind `x-mcpjam-api-vocabulary`.

  Three nouns were renamed at the API boundary: scenario → study, journey → goal, wave → swarm run. Operation names, routes, type names and field names could all move behind a deprecated alias, because a caller reaches them by a name it chose. A value cannot: `sourceType` is one field with one string in it, and a client switching on `"scenario"` has no second name to fall back to.

  So the values negotiate. `x-mcpjam-api-vocabulary: 2` asks for the canonical spellings; an absent header means vocabulary 1, byte-for-byte today's contract; anything else is a 400. A response that varies by vocabulary sends `Vary`.

  **What moves under vocabulary 2.** A session's `sourceType` reads `study`; its `parentRef.kind` reads `study` or `goalRun`, with `studyId` / `goalRunId` / `goalRefId` in place of `scenarioId` / `journeyRunId` / `journeyRefId`. A share's `resourceType` reads `study` — and because that value is also a path segment, `/shares/study/{id}` addresses the same rows `/shares/scenario/{id}` does. A trace destination's `sourceTypes` reads `study`.

  **What it accepts.** On the way in, a vocabulary-2 request may name a filter or a path segment by either spelling; a vocabulary-1 request may use only the legacy one. Widening vocabulary 1 to meet vocabulary 2 half way is exactly what makes a negotiation boundary undecidable. A trace destination's stored `sourceTypes` is the one place both are accepted at all times — it is stored configuration, so the vocabulary of the request that wrote it is a fact about that request, not about the row.

  **SDK.** `new PlatformApiClient({ apiVocabulary: 2 })`, or `client.withApiVocabulary(2)` on one you already hold. Separate from `evalVocabulary`, because the two negotiations are separate and a deployment may advertise one without the other — read `getProjectCapabilities()`, which now carries an `apiVocabulary` block beside `vocabulary`.

  **Permalinks** are the exception that proves the rule: `study` and `goal_run` are the canonical resource-type keys, `user_testing_scenario` and `journey_run` still resolve to the same routes, and which one a response carries follows the operation rather than the header. Both spellings stay in the table until general availability, because consumers outside this repo branch on them.

  Storage does not move. The stored literals are still `scenario`; every rename here is a projection at the boundary.

- [#5429](https://github.com/MCPJam/inspector/pull/5429) [`afd161a`](https://github.com/MCPJam/inspector/commit/afd161a67a0f3226f016a078dec68e5af6b93a80) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Rename the public `journey` surface to **goal**, and `sessionsPerTarget` to `iterations`.

  Swarms has called the thing a goal, and its per-target count Iterations, since the authoring flow was rebuilt; the API still said journey and `sessionsPerTarget`. It does not now. Storage is untouched — the Convex tables are still `journeys` and `journeyRuns`, and the stored config field is still `sessionsPerTarget`, exactly as the `scenarios` table stayed put when the public noun became study.

  **Operations.** The 12 journey operations become goal operations: `list_journeys` → `list_goals`, `launch_journey_run` → `launch_goal_run`, `generate_journeys` → `generate_goals`, and so on through the set. The selector is `goalId`, not `goal` — a goal's own task text is what `create_goal` writes, and one name cannot be both.

  **Routes.** `/projects/{id}/journeys` and `/journey-runs` become `/goals` and `/goal-runs`; `/journeys-overview` and `/journey-findings` follow the noun to `/goals-overview` and `/goal-findings`. Renamed responses say `goalId`, `iterations` and `swarmRunId` where they said `journeyId`, `sessionsPerTarget` and `waveId`.

  **SDK.** New `PlatformGoal*` types and `listGoals`…`generateGoals` client methods. `capabilities.can` gains `launchGoalRun` and `cancelGoalRun`.

  **CLI.** `cloud journeys` becomes `cloud goals`, which still answers to the old name. `--goal-id` takes the id, `--journey` still works, and passing both is refused rather than resolved by precedence. `--iterations` replaces `--sessions-per-target` on the same terms.

  **The operations that kept their names.** `get_swarms_overview`, `list_swarm_findings`, `create_swarm` and `update_swarm` did not rename, so they have no deprecated twin to hold the old field spellings. They emit both until general availability — `goalId`/`goalName`/`goalArchived`/`swarmRunId` beside `journeyId`/`journeyName`/`journeyArchived`/`waveId`, and `iterations` beside `sessionsPerTarget` — and accept either on input, never both in one request.

  Nothing is removed. Every old operation is still exported and still executable under its old name with its old input and its old DTO, calling its own old route — they are simply absent from the advertised catalog. Every old route still answers, with its original field spellings and a `Deprecation: true` header naming the successor. A body that mixes the two vocabularies is refused rather than guessed at. Both the operations and the routes go at general availability.

- [#5452](https://github.com/MCPJam/inspector/pull/5452) [`1094e68`](https://github.com/MCPJam/inspector/commit/1094e68843f600c8af5cb17fa7091be30630bf84) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Export `REGISTRATION_ENDPOINT_MISSING_NO_FALLBACK_CLIENT` and `REGISTRATION_ENDPOINT_MISSING_STRICT_CONFORMANCE` from `@mcpjam/sdk/browser`, the messages every OAuth state machine writes when an authorization server has no `registration_endpoint` (with no pre-registered client configured, or under strict conformance).

  The inspector's OAuth debugger now keeps those failures out of its error reporting. It is the server under test not offering dynamic client registration, not an MCPJam fault; the toast still shows it.

- [#5429](https://github.com/MCPJam/inspector/pull/5429) [`afd161a`](https://github.com/MCPJam/inspector/commit/afd161a67a0f3226f016a078dec68e5af6b93a80) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Rename the public `scenario` surface to **study**, and merge its two detail reads into one.

  The product has called this object a study since the create flow was rewritten; the API never followed. It does now, while the preview still makes a rename free. Storage is untouched — the Convex table is still `scenarios` and always will be, the way the `hosts` table stayed put when the public noun became `client`.

  **Operations.** 22 become 21. `list_scenarios` → `list_studies`, `publish_scenario` / `unpublish_scenario` → `publish_study` / `unpublish_study`, and every `*_user_testing_*` operation drops the prefix for `*_study*`. `get_scenario` and `get_user_testing_scenario` were two generations of one read and collapse into `get_study`, which returns the union: the execution settings the first served, plus the environment id and insights envelope the second added. Those last two depend on the caller, not the study, so a share-link visitor gets the settings without them — absent, never null.

  **Routes.** `/projects/{id}/scenarios` and `/projects/{id}/user-testing/scenarios/{scenarioId}` collapse into `/projects/{id}/studies` and `/projects/{id}/studies/{studyId}`; publishing moves to `/environments/{envId}/study`. Responses that named the owning id now say `studyId`.

  **SDK.** New `PlatformStudy*` types and `listStudies`…`rebindStudy` client methods.

  **CLI.** `cloud scenarios` and `cloud user-testing` merge into `cloud studies`, which answers to both old names. `--study` takes the id; `--scenario` still works and passing both is refused rather than resolved by precedence.

  Nothing is removed. Every old operation is still exported and still executable under its old name with its old input and its old DTO, calling its own old route — they are simply absent from the advertised catalog, so no surface can offer one. Every old route still answers, with its original body and a `Deprecation: true` header naming the successor. Both go at general availability.

  One behavior change worth calling out: `get_study` is no longer offered to the in-app assistant. `get_scenario` was, because it carried settings and no visitor content; the merged read carries an envelope that quotes real visitors, and the stricter half decides. `list_studies` is unaffected.

- [#5429](https://github.com/MCPJam/inspector/pull/5429) [`afd161a`](https://github.com/MCPJam/inspector/commit/afd161a67a0f3226f016a078dec68e5af6b93a80) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Rename the public `wave` noun to **swarm run**.

  The last of the three nouns the API never carried over from the product. A swarm run is the batch of sibling goal runs launched together — what the Swarms surface has called it since it shipped, and what its own `/swarms/:id` route already addresses. The API called it a wave.

  Storage does not move. The column is `swarmRunGroupId` and stays that; so does `swarmWaveInsights:*` upstream. Only the public name changes.

  **Operations.** `get_wave_insights`, `request_wave_insights` and `cancel_wave_insights` become `get_swarm_run_insights`, `request_swarm_run_insights` and `cancel_swarm_run_insights`. The selector is `swarmRun`, and `wave` is still accepted as its deprecated alias — passing both is refused rather than resolved by precedence.

  **Routes.** `/projects/{id}/waves/{waveId}/insights` becomes `/projects/{id}/swarm-runs/{swarmRunId}/insights` on all three methods. Responses say `swarmRunId`.

  **SDK.** New `PlatformSwarmRunInsights*` types and `getSwarmRunInsights` / `requestSwarmRunInsights` / `cancelSwarmRunInsights` client methods.

  **CLI.** `--swarm-run` replaces `--wave` on `cloud goals insights`, `request-insights` and `cancel-insights`; `--wave` still works, and passing both is refused.

  Nothing is removed. The old operations are still exported and still executable, calling their own old routes; the old routes still answer with `waveId` and a `Deprecation: true` header. Both go at general availability.

### Patch Changes

- [#5456](https://github.com/MCPJam/inspector/pull/5456) [`09814ca`](https://github.com/MCPJam/inspector/commit/09814cab7c0fd5c1b3ade2606499698214fb4f48) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Cut a fresh release of @mcpjam/inspector, @mcpjam/cli, and @mcpjam/sdk.

  This changeset carries no code changes. It ships the inspector and SDK work that has been waiting on main since the last release, and bumps @mcpjam/cli in the same run so the published CLI depends on the new @mcpjam/sdk instead of the previous one.

- [#5429](https://github.com/MCPJam/inspector/pull/5429) [`afd161a`](https://github.com/MCPJam/inspector/commit/afd161a67a0f3226f016a078dec68e5af6b93a80) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Rename the User Testing permalink's label from "Open scenario" to "Open study", matching what the product has called the object since the create flow was rewritten. The resource type key, the route it builds and every id stay exactly as they were, so a permalink minted before this change still resolves and any caller switching on the type is unaffected.

## 8.13.0

### Minor Changes

- [#5407](https://github.com/MCPJam/inspector/pull/5407) [`b0a1452`](https://github.com/MCPJam/inspector/commit/b0a1452e312b2f437012bddb728740e71db2a24c) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Report a rotated OAuth refresh token to the caller, via a new `onTokensRotated` option on an HTTP server config.

  Most authorization servers issue single-use refresh tokens, so the value passed as `refreshToken` is spent once it has been exchanged. The SDK kept the replacement in memory, which is invisible for the life of a connection and fatal beyond it: a CI job or any other long-lived caller configured from a secret authorized once and then failed, with nothing to say a credential had been silently replaced.

  `onTokensRotated` receives the replacement so it can be persisted back to wherever the original came from. It fires only when the token actually changed, and it is awaited before the connection completes, so a job that exits as soon as it is done still gets the write. A handler that throws or rejects never fails a connection that has already authorized.

  The documented behaviour in `docs/sdk/concepts/connecting-servers.mdx` was also corrected: it claimed the SDK "stores rotated refresh tokens" without saying that the store dies with the process.

## 8.12.0

### Minor Changes

- [#5338](https://github.com/MCPJam/inspector/pull/5338) [`331907a`](https://github.com/MCPJam/inspector/commit/331907a16a25617016f5e3743d48cee1bf6ddb63) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - `EvalSuite.runWithClient` accepts a list of saved clients. It runs the suite against each in parallel and uploads one run per client, grouped in MCPJam under one run number. Adds `runGroupId` to the reporting config. The evals GitHub Action now shows grouped runs as one table with a row per client and model.

- [#5359](https://github.com/MCPJam/inspector/pull/5359) [`2d59e6f`](https://github.com/MCPJam/inspector/commit/2d59e6ff815872a81070bcb8968e22ec146a29f8) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Swarm findings: add an `analysisUnavailable` coverage note, so a wave whose cause analysis never ran is distinguishable from one where the analysis ran and found nothing.

- [#5340](https://github.com/MCPJam/inspector/pull/5340) [`cc8f06a`](https://github.com/MCPJam/inspector/commit/cc8f06a844ee7243a6dbb2ac29bbc0a2b11bbf16) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Swarm findings: carry recorded session signals, a plain-language persona account and proposal verification counts on the wire. All three additions are optional, so existing payloads keep parsing unchanged.

### Patch Changes

- [#5390](https://github.com/MCPJam/inspector/pull/5390) [`99bc573`](https://github.com/MCPJam/inspector/commit/99bc573e213994c6aa46beb4dbf3ac88b56dfcf8) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Cut a fresh release of @mcpjam/inspector, @mcpjam/cli, and @mcpjam/sdk.

  This changeset carries no code changes. It ships the inspector and SDK work that has been waiting on main since the last release, and bumps @mcpjam/cli in the same run so the published CLI depends on the new @mcpjam/sdk instead of the previous one.

## 8.11.1

### Patch Changes

- [#5300](https://github.com/MCPJam/inspector/pull/5300) [`42c058f`](https://github.com/MCPJam/inspector/commit/42c058f0cd41078ee28533f0589bd0af3c7cbf7e) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Report the model on every iteration an `EvalSuite` or `EvalTest` run uploads. A run started with `runWithClient` showed an empty MODEL column, because only the `promptsToEvalResult` path stamped the provider and model that the run had already recorded. When a case fails in setup and never reaches the model, the run now names the model it was configured with — the saved client's, for a `runWithClient` run.

  Report per-step verdicts too (`metadata.stepResults`), the same rows the hosted runner writes. An SDK case whose tool call matched still read "0 of 1 assertion passed" on the Steps tab, with a grey unknown icon, because no step ever carried a verdict.

- [#5330](https://github.com/MCPJam/inspector/pull/5330) [`1ad2342`](https://github.com/MCPJam/inspector/commit/1ad2342d2c7bd7ec9ff4051ad1536dba1a37466f) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Cut a release of `@mcpjam/inspector`, `@mcpjam/cli`, and `@mcpjam/sdk` so the
  work already merged into main reaches npm. Version bump only — no code changes.

## 8.11.0

### Minor Changes

- [#5281](https://github.com/MCPJam/inspector/pull/5281) [`4311e1f`](https://github.com/MCPJam/inspector/commit/4311e1f0b008b28bb02405e9bc87ac5accd5cb6e) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Expose versioned, evidence-backed swarm journey findings through the SDK and API contract. Render persona and goal findings from the shared analysis output, disclose unread sessions, and avoid reassuring summaries when no model analysis ran.

## 8.10.1

### Patch Changes

- [#5290](https://github.com/MCPJam/inspector/pull/5290) [`dc212eb`](https://github.com/MCPJam/inspector/commit/dc212eb1b040c44e488203e2ef1a2bc8174e2876) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Keep a miscited Markdown case from failing the whole import, and give imported drafts their own review surface instead of listing them beside cases already in the suite. A blocked draft now names the missing field in a badge on its title, and importing clears a stale generation error that pointed at a setting import does not offer.

- [#5298](https://github.com/MCPJam/inspector/pull/5298) [`7032855`](https://github.com/MCPJam/inspector/commit/703285536746b2e05bc49e45dacabb3582e374e8) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Widget evidence too large to send inline now goes to storage, so an MCP Apps server can report its evals.

  Reporting a run embedded each widget snapshot's HTML in the request. A snapshot is a whole built app — a single-file bundle is commonly over half a megabyte — so one test case whose tool ran twice put more than 1MB on the wire and the upload failed with "Request body exceeds 1MB limit". Chunking could not save it: it splits between results, never inside one.

  Small widgets still ride along inline, in the one request they always did, because that is what lets a retry resend identical bytes. Only a result that would not fit offloads its HTML to blob storage first and sends the id instead. The offload happens once, before the retry loop, so retries stay byte-identical either way.

  The upload URL this path follows must now be https, or loopback — `npx convex dev` and a self-hosted deployment hand out `http://127.0.0.1`, and those still work. Anything else is refused rather than putting a built app on a cleartext wire.

## 8.10.0

### Minor Changes

- [#5264](https://github.com/MCPJam/inspector/pull/5264) [`07d7090`](https://github.com/MCPJam/inspector/commit/07d709022c9922891145ee14a9637e3f5b7461fd) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Tell agents and scripts when an included operation's usage limit lifts. The SDK adds `describePlatformRefusal` and `platformRefusalHint`, which read a `RATE_LIMITED` refusal's backend code, limit, retry time and whether credits would help. MCP tool errors, CLI errors and in-app agent tool errors now carry that and say when to retry, without suggesting a top-up. Generation copy now says the quota belongs to the organization, not the project, and description proposals no longer claim a generation quota. The insight getters explain `platform_cap_exceeded` and `platform_unavailable`.

- [#5248](https://github.com/MCPJam/inspector/pull/5248) [`b99eed6`](https://github.com/MCPJam/inspector/commit/b99eed6a297508c17f8fa19e78257d09361a9cb5) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Report swarm execution, goal grading, and advisory standard checks separately across the UI and platform API. Show shared run decisions, grading coverage, and session user-value chains while retaining persona-specific findings.

### Patch Changes

- [#5279](https://github.com/MCPJam/inspector/pull/5279) [`e059fd2`](https://github.com/MCPJam/inspector/commit/e059fd2d7bcc2753e2bbcc1ce004a824b009c320) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Stop an empty system prompt from failing every generation. A saved MCPJam client with no system prompt reads as `""`, and `runWithClient` passed it straight to the provider; Anthropic refuses an empty system block with `system: text content blocks must be non-empty`, so every case in the suite failed with a bare "Bad Request". `HostRunner` now treats an empty configured prompt as "none given" and uses its default, the same as it already did for a host snapshot.

## 8.9.0

### Minor Changes

- [#5102](https://github.com/MCPJam/inspector/pull/5102) [`930c5c8`](https://github.com/MCPJam/inspector/commit/930c5c8e6e17aa000e4c0eb99923b3447165000f) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Use one versioned goal-completion judge contract across hosted evals and the SDK, with complete recorded traces, tool catalogs, runtime context and supported captured media. Add optional grading instructions, unscored evidence errors, durable per-iteration recovery, provenance and failed-only retries. Preserve custom judge definitions and existing explicit manual/off settings.

  Expose bounded judge backtests through the SDK, CLI and MCP, with draft/source-bound continuation and cached page retries. Deploy the paired optional backend schema and handlers before publishing writers or enabling automatic grading. Grading is controlled by the suite's own settings.

  **Data-egress change:** hosted v4 grading sends full recorded conversations and traces, tool schemas, runtime context and supported media bytes through OpenRouter to the selected model provider, with existing credential redaction. Review provider/data policies before enabling; explicit manual/off settings remain available on every suite.

- [#5216](https://github.com/MCPJam/inspector/pull/5216) [`755ab24`](https://github.com/MCPJam/inspector/commit/755ab2472b34973441a1352f4e57e93e51d6d0db) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Ground swarm personas in observed workspace entities and add optional prerequisite setup. Both run in the background with no UI: journeys created in the app enable setup, and API callers opt in with `setupWrites`. Setup evidence and readiness are recorded on the run, separately from graded sessions.

- [#5182](https://github.com/MCPJam/inspector/pull/5182) [`b5a74d7`](https://github.com/MCPJam/inspector/commit/b5a74d7f023a81d93d79622424d3c2af764269a8) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Drop the goal-completion judge's two operator deployment controls. Grading is on by default and is turned off through a suite's own judge settings, which every caller can already read and write.

  `GoalJudgePolicy` no longer reports `executionPaused`, the resolved judge on a suite response no longer carries that field, and `judge_execution_paused` leaves the judge error code contract. Both were produced only by backend environment variables that were never set on any deployment, so no stored verdict or suite carries either value. Readers that treated the field as optional need no change.

- [#5166](https://github.com/MCPJam/inspector/pull/5166) [`92d52c6`](https://github.com/MCPJam/inspector/commit/92d52c62b4f1e4b2c58cebd28a6bdd2a247cdc6f) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Add a `mcpjam/…` model provider so an eval can run on MCPJam-hosted inference
  with no provider key: `model: "mcpjam/anthropic/claude-sonnet-4.5"` bills the
  organization's credits and needs only `MCPJAM_API_KEY`. Exports
  `releaseMcpjamModelLeases` for suites built by hand; `EvalSuite.run` already
  calls it at teardown.

- [#5183](https://github.com/MCPJam/inspector/pull/5183) [`e2f341a`](https://github.com/MCPJam/inspector/commit/e2f341a76eb7c0cf07d409407c47922ea182827c) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Say generation and insights are included with MCPJam, not billed to the customer.

  Eight operations run a model whose cost is MCPJam's, not the organization's —
  eval-case generation, the description-rewrite proposal, persona and journey
  drafting, swarm wave insights, user-testing insights, and the two directory
  readiness starts with `includeLlmObservations`. Every surface told the customer
  otherwise: the MCP tool descriptions carried "COSTS MONEY", the CLI said
  "spends credits", the approval cards warned about money, and the docs said
  "SPENDS ORG CREDITS". For swarm wave insights and session clustering that copy
  was already wrong today.

  `risk` on those operations moves from `"spend"` to `"none"`, which is the single
  lever for the MCP tool surface (`operationDescription` appends its spend warning
  off that facet). What they actually consume is a bounded daily REQUEST quota —
  `insightsPerDay` for the insight operations, a per-project generation quota for
  the rest — so the copy now says "Included with MCPJam — no credits are consumed"
  and names the quota instead.

  They all stay GATED on the agent surface rather than deriving `direct` from the
  new risk: the quota is shared across the organization, and an agent that
  exhausts today's slice on its own initiative has taken something a person was
  going to use. Each is a named `TIER_EXCEPTIONS` entry with its reason, and
  `confirmSeverity` drops to `"none"` so no approval card claims a charge.

  Still customer-paid and unchanged: eval suite/case runs, `request_eval_run_judge`,
  the judge backtest, `start_eval_description_experiment`, journey launches and
  chat.

- [#5144](https://github.com/MCPJam/inspector/pull/5144) [`f702e88`](https://github.com/MCPJam/inspector/commit/f702e88d9f33ef57cba7873890e8fffa6f360a1c) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Export `assertCallToolResult` and `isCallToolResult` so a TypeScript caller can
  narrow what `executeTool` returns, and fix the README's first example, which did
  not type-check and asserted a result the everything server never sends.

- [#5171](https://github.com/MCPJam/inspector/pull/5171) [`8441b80`](https://github.com/MCPJam/inspector/commit/8441b80d2d6274e4bc60710c3738d3e8c8b96ef8) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Export `STANDARD_CHECK_NAME_BY_KIND`, the name a reader recognises each standard
  check by, keyed by the predicate kind that implements it. Derived from the
  catalog rather than restated beside it, so a renamed check cannot leave a stale
  title behind.

### Patch Changes

- [#5141](https://github.com/MCPJam/inspector/pull/5141) [`3edb6c1`](https://github.com/MCPJam/inspector/commit/3edb6c142c3389530f149f24d40b8faec6228e86) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Error surface: classify the OAuth consent state, and restyle the error card.

  A server that needs OAuth consent rendered as "Unknown error" with the advice to file an issue. The client's OAuth orchestrator returned a hand-written sentence for its `reauth_required` result, the server-state hook dispatched that bare string, and the describer matched nothing in it, so an expected one-click state fell into the `internal/unknown` bucket and displayed copy written for MCPJam engineers.

  The SDK gains an `auth/consent_required` catalog entry, at `warning` severity with a `user_config` origin, plus a message fallback matching MCPJam's own consent and reauthenticate wording so strings already persisted in client state classify too. The orchestrator now attaches the typed block to `reauth_required` and the hook forwards it through the connect-failure dispatch, so a live consent state never depends on the wording at all. The server card offers a Reconnect button for it.

  `ErrorCard` is restyled across all of its call sites. Severity is carried by one accent — the icon and a hairline left rule — over a neutral surface, replacing the filled colour panel. The collapsed face keeps the title, the one-line explanation, the fix, and Copy; "Learn more" moves into the details panel with the rest of the evidence. Inside that panel a single likely cause renders as a sentence rather than a one-item bullet, the raw-error row is dropped when it only repeats the headline, a raw code shows as a chip, and long raw text wraps on word boundaries instead of mid-word. For `internal/unknown` only, the catalog's developer-facing causes and next steps are suppressed and the title reads "Connection error" whenever raw text is present.

  The server connection card drops the red "Error" pill, which was the fourth red element announcing one failure and only toggled a disclosure the card already owns. "Failed (0)" now reads "Failed" until something has actually been retried, the OAuth step-failure line is no longer red, and the generic "Check troubleshooting" footer is hidden when an error card is present, since that card carries a docs link aimed at the specific error.

- [#5240](https://github.com/MCPJam/inspector/pull/5240) [`0c3472a`](https://github.com/MCPJam/inspector/commit/0c3472adaa04293c4480cdde1bbeb2c74020d180) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Make the redesigned Evaluate experience public and use evaluate-enabled only for legacy Evaluate access. SDK links open the exact suite, case, or run in the new experience. Old commit links open the unfiltered project run table, while other legacy links preserve their artifact context.

- [#5254](https://github.com/MCPJam/inspector/pull/5254) [`5dc148d`](https://github.com/MCPJam/inspector/commit/5dc148d2559f67332e6bb60cdd6f3f8f0da66275) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Cut a release of `@mcpjam/inspector`, `@mcpjam/cli`, and `@mcpjam/sdk` so the
  work already merged into main reaches npm. Version bump only — no code changes.

- [#5245](https://github.com/MCPJam/inspector/pull/5245) [`318f5f5`](https://github.com/MCPJam/inspector/commit/318f5f590b59d18a74ce2403ba7ea6ae51693515) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Cut a release of `@mcpjam/inspector`, `@mcpjam/cli`, and `@mcpjam/sdk` so the
  work already merged into main reaches npm. Version bump only — no code changes.
- Updated dependencies [[`930c5c8`](https://github.com/MCPJam/inspector/commit/930c5c8e6e17aa000e4c0eb99923b3447165000f)]:
  - @mcpjam/evaluators@0.3.0

## 8.8.0

### Minor Changes

- [#5065](https://github.com/MCPJam/inspector/pull/5065) [`1b7705b`](https://github.com/MCPJam/inspector/commit/1b7705b754c6cc22391d6bf45387911b74ec6397) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Evaluator definitions now emit `role: "required"` — the canonical spelling — instead of the legacy `"gating"`. Every identity is unchanged: `definitionHash` digests the role through a frozen `hashSpelling`, so the golden fixture's 63 pinned hex values did not move when emission flipped; only its 24 `role` strings did.

  What reaches the WIRE is decided per path, because the two upload paths carry different risk.

  The primary iteration payload (`/report`, `/runs/iterations`) is written in the legacy spelling unconditionally. It carries each iteration's `evaluationConfig` through `scoreMetadata` and is the payload almost every run sends; a backend that does not accept `required` there does not reject the upload, it quarantines every iteration as `score_integrity_invalid` and leaves the dashboard looking empty rather than broken. The two repositories deploy independently and "merged" is not "deployed", so that payload does not depend on asking: it is a stored contract, and a reader on the canonical vocabulary gets `required` from the read projection regardless.

  The optional case-run evaluations payload (`/runs/evaluations`) negotiates instead, because it already handshakes with the target. `capabilityAcceptsCanonicalRole` reads `vocabulary.values.role` off the suite capability — the value itself, never a version number or a field beside it — and `definitionsForDeployment` downgrades when a backend does not advertise it.

  Both are hash-neutral, so a run against an older backend files its rows under exactly the same digests as one against a newer backend.

  Readers take both spellings forever: a stored contract is historical evidence and is never rewritten.

- [#5065](https://github.com/MCPJam/inspector/pull/5065) [`1b7705b`](https://github.com/MCPJam/inspector/commit/1b7705b754c6cc22391d6bf45387911b74ec6397) Thanks [@chelojimenez](https://github.com/chelojimenez)! - An assertion's or judge's policy role can now be authored as `"required"`, the canonical spelling of `"gating"`. `assertion({ role })`, `judge({ role })`, `predicateScorer(rule, { role })`, `judgeScorer({ role })`, the suite-file loader (both dialects) and `ScorerRole` all accept it; `"gating"` keeps working and is what stored contracts and dialect-1 suite files say. The published JSON Schema widens the enum additively, so a dialect-1 file that used `"gating"` still validates.

  Every identity is unchanged, by construction rather than by luck. `definitionHash` emits the role through a frozen `hashSpelling`, so a definition's digest does not depend on which word it carries — every stored score row still joins to its definition, and `eval gate --baseline <run>` still resolves the scorer set it was pinned against. An authored `"required"` on a rule canonicalizes to the ABSENT field before the rule is digested for an anonymous id, which is the form Gate has always been written in; an explicit `role: "gating"` keeps its own existing id, because rotating that would orphan exactly the rows this change promises not to touch.

  Builders EMIT `"required"` — one build constant, `EMIT_CANONICAL_ROLE` — but the two upload paths answer differently, and the difference is deliberate.

  The PRIMARY iteration payload (`/report`, `/runs/iterations`) is FROZEN at `"gating"` unconditionally. It carries each iteration's `evaluationConfig` through `scoreMetadata`, it is the payload almost every run sends, and a target that has not deployed the canonical spelling does not reject a `required` role there — it quarantines every iteration of the run as `score_integrity_invalid`, leaving the dashboard empty rather than broken. Negotiating that would mean probing `/capabilities` before the first upload of every run, and a run whose probe was slow, cached, or answered by the wrong deployment would be exactly the run that got quarantined. The payload needs no canonical word anyway: it is a stored contract, and a reader on the canonical vocabulary gets `required` from the read projection regardless.

  The OPTIONAL case-run evaluations payload (`/runs/evaluations`) DOES negotiate, keeping `"required"` only when the target advertises `vocabulary.values.role` and downgrading otherwise — it already handshakes with the target for its own reasons, and its rows are advisory by construction.

  Both are hash-neutral, so rows file under the same digests either way.

  Every `role === "gating"` reader now goes through `isRequiredRole`, so a reader that forgot the new spelling cannot silently drop a rule out of the gating set.

- [#5043](https://github.com/MCPJam/inspector/pull/5043) [`ec2e893`](https://github.com/MCPJam/inspector/commit/ec2e893bb587e09b555dd911462051dc2556bea7) Thanks [@chelojimenez](https://github.com/chelojimenez)! - A failed eval connection now says why. The setup signal carries the producer's one-line reason (`StageSetupPhaseSignal.reasons`), which the analyzer copies into the Connection / Tool discovery row's `predicateReasons` so it renders on the run page, in the decision summary, the API, and the CLI — without a new stage reason or analyzer version. `describeError` accepts the parsed `WWW-Authenticate` challenge (`summarizeBearerChallenge`) and a refresh outcome, and the catalog gains `oauth/no_bearer_challenge`, `oauth/non_compliant_challenge`, `auth/insufficient_scope`, `auth/authorization_server_unreachable`, and `auth/proxy_rejected`. A token refresh that failed because MCPJam could not reach the authorization server is now attributed to us, never to the MCP server.

  Setup attribution uses explicit provenance from OAuth refresh, XAA minting, and authorization-required boundaries. Parsed challenge capture is isolated per server, never reads response bodies, and omits ambiguous observations. Missing Bearer challenges and HTML denials report uncertainty rather than assuming a server or proxy defect. Setup metadata keeps a 4 KiB UTF-8 budget and drops reasons before span references; no duplicate failure audit or persisted error-details payload is added.

- [#5022](https://github.com/MCPJam/inspector/pull/5022) [`20bf8ac`](https://github.com/MCPJam/inspector/commit/20bf8ac475f5493d58f5225e30a39da1c5dfb638) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Bound eval execution, reporting bodies, retries and streaming queues; preserve unacknowledged results and expose validated persistence receipts separately from verdicts. Add canonical execute/evaluator defaults, reported measurements, case-run advisory evaluations, declared variants and explicit subset gate scope, CI/run metadata, summaries and native Vitest lifecycle helpers.

  Deploy the paired backend expansion before publishing the SDK or enabling hosted backtests and explicit partial-run terminalization. Old and default-off backends continue accepting core SDK results: unsupported metadata and advisory persistence produce structured warnings, including in strict mode, without erasing acknowledged run persistence. Stale metadata capabilities followed by validation refusal retry once with unchanged run identity, evidence and policy and without optional metadata; hosted subset certification remains unavailable. Widget evidence stays inline until authenticated backend storage so retries keep stable content; oversized evidence is rejected. Cancellation remains cooperative for arbitrary caller code. Existing test/scorer imports and historical hashes remain compatible.

- [#5044](https://github.com/MCPJam/inspector/pull/5044) [`e75fae8`](https://github.com/MCPJam/inspector/commit/e75fae8564e44ed7dc8a205d225833e48f580ad1) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Read and write eval suite files in `schemaVersion: "2"`, which spells the
  configured count `iterations` and the case's rules `assertions`.

  The suite-file validator is now a discriminated union over two dialects.
  Dialect `"1"` is frozen: its zod shape, its published JSON Schema
  (`…/eval-suite/v1.json`) and its `repetitions` / `checks` (alias `assertions`)
  spellings do not change, so an older strict reader keeps validating exactly what
  it always did. Dialect `"2"` publishes its own document at
  `…/eval-suite/v2.json` (`evalSuiteFileV2JsonSchema`), has one word per field
  and no aliases, and refuses the dialect-1 spellings as unknown keys — the
  loader's finding says which dialect spells the field that way and offers both
  fixes, instead of a bare "Unrecognized key".

  The loader reads both dialects into one resolved view, and that view now uses
  the canonical word: `ResolvedEvalSuiteFile.defaults.repetitions` and
  `ResolvedEvalSuiteFileCase.repetitions` are renamed to `iterations`. This is a
  breaking change for code that reads the resolved shape directly; the authored
  shape (`EvalSuiteFile`, now `EvalSuiteFileV1 | EvalSuiteFileV2`) is unchanged
  for dialect 1. `serializeEvalSuiteFile` writes a file back in its own dialect
  and never upgrades one on its author's behalf.

  The CLI follows the resolved-shape rename internally; nothing it sends on the
  wire changes, and `eval export` still writes dialect 1.

- [#5050](https://github.com/MCPJam/inspector/pull/5050) [`4b83944`](https://github.com/MCPJam/inspector/commit/4b83944b232b74a0011c83c08899d386ae64862a) Thanks [@chelojimenez](https://github.com/chelojimenez)! - `PlatformCapabilities.vocabulary` describes the eval vocabulary a deployment
  understands: the `version`, the evaluator and assertion kinds, and for each
  canonical field (`assertions`, `defaultAssertions`, `iterations`,
  `legacyIterations`) the legacy spellings a request sending
  `x-mcpjam-eval-vocabulary: 2` may still use. Absent on a deployment that
  predates the negotiation, which then speaks only vocabulary 1. Read the value;
  never infer support from a field's presence.

- [#4985](https://github.com/MCPJam/inspector/pull/4985) [`0be63d5`](https://github.com/MCPJam/inspector/commit/0be63d5a63c83fee879b414289e4d203a45fd27c) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Add the canonical evaluator contract beside the score contract.

  An evaluator is an assertion or a judge, and both report one result shape. The
  new names are additive: `ScoreResult`, `Scorer`, `PREDICATE_STAGE` and the rest
  keep working, and the definitions underneath are the same objects with the same
  hash payload — so adopting the canonical vocabulary does not change what any
  existing suite grades or what identity its evaluators carry.

  `EvaluatorDefinition` and friends are type aliases, deliberately. Their runtime
  keys are the `definitionHash` payload, and renaming one would rotate every
  evaluator identity in every stored run while looking exactly like a changed
  configuration. `EvaluatorResult` is the one shape that genuinely renames fields
  — `value` becomes `score`, `rationale` becomes `explanation` — so it is a
  versioned projection with an exact inverse rather than an alias over a
  differently-shaped object.

  Three rules survive intact: `passed` stays derived from
  `score >= passThreshold`, a result that was not scored carries no `score` at
  all, and role and error policy stay on the definition where there is one copy
  of them. The canonical schema enforces them by projecting onto the score
  schema rather than restating them, because two implementations of "did this
  pass" is the disagreement the contract exists to prevent.

  `EvaluatorKind` is derived from `deterministic` rather than stored — storing it
  would add a twelfth field to the hash payload for a value already implied by one
  that is there.

- [#4986](https://github.com/MCPJam/inspector/pull/4986) [`17c5095`](https://github.com/MCPJam/inspector/commit/17c5095e752e8cbc91470cd3205fb1dac97c75d0) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Add `assertion()`, `judge()` and `runEvaluators()`, plus the
  `@mcpjam/sdk/assertions` subpath.

  These are the canonical spellings of `predicateScorer`, `judgeScorer` and
  `runScorers`, and they build through the same functions rather than beside
  them. `assertion(rule)` produces the same definition as `predicateScorer(rule)`
  — same opaque id, same `implementationHash`, same `definitionHash` — which is
  what lets an author migrate one rule at a time without the run they compare
  against becoming a different run. The tests assert that equality directly
  rather than asserting the two look similar.

  `runEvaluators` accepts either vocabulary in one list and delegates to the
  existing bounded runner. It does not reimplement the per-evaluator timeout, the
  concurrency cap, or the rule that every failure lands as an error row rather
  than a low score: a second bounded runner would be a second place for "what
  happens when a judge hangs" to be answered, and the two answers would drift in
  the direction nobody tests.

  `@mcpjam/sdk/assertions` is a barrel over the existing library, not a move, and
  `@mcpjam/sdk/predicates` keeps working: the two subpaths are one library with
  two spellings. Imported from source they are the same module objects. In the
  published package they are not — `tsup` builds with `splitting: false`, so each
  subpath inlines its own copy and a consumer gets equal behaviour through
  separate function and schema instances. Import one subpath per consumer, and do
  not compare values across the two with `===` or `instanceof`.

  `assertion()` splits an `id` off before building the definition, so naming a
  rule does not change the digest of what that rule does. An unnamed assertion
  gets a content-derived id rather than a positional one, because a standalone
  evaluator has no position and two anonymous rules of the same type would
  otherwise collide in the snapshot.

- [#5070](https://github.com/MCPJam/inspector/pull/5070) [`bbfb7d2`](https://github.com/MCPJam/inspector/commit/bbfb7d2d4a43edb800ebf507b872c48bfd150281) Thanks [@chelojimenez](https://github.com/chelojimenez)! - One grading policy, read out of every contract that has ever expressed one.

  `@mcpjam/sdk/contract` gains `grading-policy.ts`: a canonical resolved model for what must pass, how much, how many times, and what counts as enough evidence to decide — plus pure adapters that normalize a suite file, a hosted suite (either storage shape) or a reported run onto it, and one write adapter that turns an edit back into the PATCH `settings` the hosted API already accepts. No wire field, enum or stored shape changes.

  The model carries the criterion **scope**, because `minimumAccuracy` and `passThreshold` are not one number in two units. Ten cases, nine always passing and one always failing: a 90% suite-wide threshold passes that run and a 0.9 per-case threshold fails it. Dividing the percent by 100 moves the bar for every suite with more than one case, so the scope travels with the threshold and `evalPassCriterionFraction` is the only conversion on the read path.

  A suite-wide criterion also carries its **population** and its **empty-population rate**, because there is no single legacy producer. Three ship, and they disagree in ways that decide runs: the hosted run finalizer measures iterations and rates an empty run `1`; the SDK ingestion path measures cases with a fan-out run's provider/model rows collapsed into one bucket, and rates an empty run `0`; the reporter's local fallback measures the results it was handed and also rates an empty run `0`. A new shared fixture corpus pins all three against the same runs, alongside the counterexample, the floor-versus-default-count contrast, omitted-versus-explicit-zero validity, held, cancelled and timed-out iterations, and every write-adapter refusal.

  `planEvalGradingPolicyEdit` is built for three properties. A threshold edit writes `minimumAccuracy` on a suite-wide policy and `passThreshold` on a per-case one, and never the `repetitions` + `passThreshold` pair that the route reads as an upgrade — so no edit migrates a suite as a side effect. An edit that restates what is already stored produces an empty patch, so a read-edit-write round trip cannot rotate a suite's `configRevision`. And an edit carrying a field the stored contract cannot express is refused whole, naming the operation that would express it, rather than dropping the field and reporting success.

  `SUITE_FILE_VALIDITY_DEFAULTS` and `SUITE_FILE_DEFAULT_COVERAGE` move into the contract layer and are re-exported from `suite-file-loader` under the same names and the same object identity. The loader now resolves validity through the shared resolver, so the file path and the hosted path cannot drift on the one rule that matters most here: omitting `minEligibleTrials` selects a STRICTER coverage rule, not a weaker one.

- [#5070](https://github.com/MCPJam/inspector/pull/5070) [`bbfb7d2`](https://github.com/MCPJam/inspector/commit/bbfb7d2d4a43edb800ebf507b872c48bfd150281) Thanks [@chelojimenez](https://github.com/chelojimenez)! - One authoring vocabulary for grading, shared by the app, the CLI and the docs.

  `@mcpjam/sdk/contract` gains `suite-grading-labels.ts`: the words every surface uses for the grading policy, following `decision-labels.ts` exactly — one `Object.freeze({…} satisfies Record<Enum, string>)` per vocabulary, so a member added to `grading-policy.ts` without words breaks the build rather than rendering a wire spelling in front of somebody about to edit a threshold. Four label tables used to disagree: the settings manifest, the review dialog's diff labels, revision history's unlisted-field labels and the rail. "Quality gate" named three different storage keys between them, and `matchOptions` read one way in the manifest and another in the dialog.

  **No label names a policy version, and a test asserts it on the strings themselves.** `legacy`, `v2`, `upgrade`, `migrate` and `deprecated` are all forbidden in the rendered words. A suite-wide suite is measured differently, not obsolete, and "legacy" told its owner a fact they cannot act on while hiding the one they must: a suite-wide threshold is one percentage over the whole run and a per-case threshold is a fraction over each case's own iterations. Ten cases, nine always passing and one always failing, passes a 90% suite-wide bar and fails a 0.9 per-case one.

  `EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS` changes with it: `policyV2` renders as **per-case grading** and `legacy` as **suite accuracy threshold** — the criterion that decided the run, which is what a reader needs in order to trust the counts beside it. The wire spellings are untouched. This is a visible change to `decisionSummary` rendering in the CLI, the HTML report and the app, and to the `verdictSummaryUnavailable` sentence.

  Two composers, `describeEvalPassCriterion` and `describeEvalIterationRule`, exist because the facts are only meaningful together: a threshold without its units is ambiguous between the two scopes, and a suite-wide percentage without its population is ambiguous by a factor of the iteration count. Every surface that renders a criterion in prose goes through them rather than concatenating its own.

  `PlatformEvalSuiteSettings`'s documentation now says what each field measures rather than which policy version it belongs to, and `minimumIterations` is documented as a FLOOR that raises a case's own count where `verdictPolicyDefaults.repetitions` REPLACES it — a case at 7 resolves to 7 under a floor of 3 and to 3 under a default count of 3. The MCP tool descriptions for `update_eval_suite` and `get_eval_run` carry the same distinction, including the counterexample, because an agent reading "the v2 replacement for minimumAccuracy" would divide by 100.

- [#5070](https://github.com/MCPJam/inspector/pull/5070) [`bbfb7d2`](https://github.com/MCPJam/inspector/commit/bbfb7d2d4a43edb800ebf507b872c48bfd150281) Thanks [@chelojimenez](https://github.com/chelojimenez)! - The SDK reads one grading policy from a loaded suite file, a hosted suite, or a reported run.

  `grading-policy.ts` is the model and the pure adapters; it knows nothing about the suite-file loader's resolved view, the platform DTO, or what a PATCH body looks like. `eval-grading-policy.ts` is the seam that connects them, and it is where the two rules the contract cannot enforce on its own live: **reading a configuration never switches it**, and **an answer we cannot establish is refused rather than guessed**.

  `gradingPolicyFromLoadedSuiteFile` takes both halves of a load result, and the split is the point. Defaults come from the resolved view, because the documented defaults are part of the policy a run is decided against — validity going back through the loader's own `declareEvalSuiteFileValidity` so an omitted `minEligibleTrials` stays omitted and keeps selecting the stricter all-configured-attempted rule. Case overrides come from the **authored** file, because a resolved case always carries a count and a threshold: reading overrides from there would report every case as overriding and make a suite file's policy incomparable with a hosted suite's. Both suite-file dialects are read, so `repetitions` and `iterations` produce the same canonical count and the dialect-1 word never reaches the model. A disabled case keeps its override, because dropping it would change the policy the moment somebody re-enables the case.

  `gradingPolicyFromPlatformSuiteSettings` **refuses** a response from a deployment that reports neither `settings.policy` nor `settings.verdictPolicyVersion`. Such a deployment omits both on every suite, per-case ones included, so a suite-wide suite and a per-case suite are indistinguishable in its response — and reporting the suite-wide reading there would describe a stored `passThreshold: 0.9` as a 0.9% suite-wide bar, which an editor built on that reading would then write back as a percent. `GRADING_POLICY_READ_REFUSALS` names it as a capability answer ("this deployment cannot say"), never as a scope.

  `planPlatformSuiteGradingUpdate` is the only sanctioned way an edit reaches the hosted API from the SDK. It reads the current scope, preserves it, and writes the field and units that scope already uses, so editing an old suite's threshold needs no policy toggle and cannot migrate it. It always carries the `expectedRevisionNumber` it read when the deployment records revisions — even though the route only mandates a precondition for a quality-gate edit — because a threshold read, edited and written back without one silently overwrites whatever landed in between.

  `buildLocalFallbackResult` in the eval run reporter is now named as one of the three suite-wide producers, and spells `LEGACY_SUITE_WIDE_THRESHOLD_PERCENT` instead of a bare `?? 100`. Its arithmetic is deliberately unchanged: it still counts the results it was handed, one per iteration, and still rates an empty run `0` where the hosted finalizer rates the same empty run `1`. `gradingPolicyForReportedRun` requires the caller to say which producer it is holding, because the same `minimumPassRate` decides a three-case suite run five times each differently depending on whether the population is 3 or 15.

  `update_eval_suite` reads the current grading criterion before grading-field writes and uses the canonical planner’s refusals for incompatible iteration fields. It refuses implicit scope changes without rewriting callers’ wire fields. Scope changes remain API-only pending an explicit operation.

- [#5022](https://github.com/MCPJam/inspector/pull/5022) [`20bf8ac`](https://github.com/MCPJam/inspector/commit/20bf8ac475f5493d58f5225e30a39da1c5dfb638) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Extract the shared assertion, matcher and evaluator contracts into the dependency-light @mcpjam/evaluators package. Preserve SDK imports and historical definition hashes through compatibility exports. Add explicit message capture normalization and result adapters that preserve unscored outcomes.

- [#5022](https://github.com/MCPJam/inspector/pull/5022) [`20bf8ac`](https://github.com/MCPJam/inspector/commit/20bf8ac475f5493d58f5225e30a39da1c5dfb638) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Add responseCloseTo, a bounded Unicode code point edit-distance assertion. Case and whitespace normalization are explicit; missing evidence and computation limits remain unscored errors. Hosted authoring must wait for the corresponding backend capability and runner deployment.

- [#5091](https://github.com/MCPJam/inspector/pull/5091) [`eeb5cfa`](https://github.com/MCPJam/inspector/commit/eeb5cfa33522128efd59f25fce1f42faf087613f) Thanks [@chelojimenez](https://github.com/chelojimenez)! - `ExecutionBudgets`: one clock vocabulary for evals and swarms, plus the run-supervisor utilities that will consume it.

  Every timeout on the eval and swarm paths is a module constant today — the eval iteration cap, the eval run cap, the swarm's absence of any cap at all — and none of them is tunable or even _named_, so a timed-out unit can only report "aborted" and a reader cannot tell which clock fired. `@mcpjam/sdk/contract` now exports the shapes that fix that: an AUTHORED budget object where every field is optional, a RESOLVED one with the active runtime clocks and per-field provenance, and one pure `resolveExecutionBudgets` between them.

  Two rules the rest of the work leans on. **Refuse, don't clamp** — an authored value above its ceiling comes back as a violation naming the field, the value and the ceiling, so a run never executes with a different number from the one its author wrote. **One decision, persisted** — resolution happens once, at launch, and the result is frozen into the run snapshot, so editing a suite mid-run cannot move the clocks of a run already in flight. `{ authored: undefined }` yields the platform defaults, which is exactly what a run launched before budgets existed resolves to; no consumer needs a legacy branch.

  `composeAbortSignals` and `isNonRetryableMarkedError` are now exported too. The first is the signal plumbing the inspector's deadline helper composes with (and replaces a hand-rolled twin in the swarm runner); the second is the other half of the retry contract — `isRetryableTransientError` already consults that marker, and anything classifying on top of it must consult it on the ORIGINAL error, because the marking is a WeakSet keyed on object identity.

  The calibrated defaults are 6 minutes per turn and 30 minutes per eval run. Eval iteration remains 10 minutes. The resolved runtime shape omits the reserved `toolCallTimeoutMs` field until MCP manager integration is available; authored budgets and policy ceilings still validate it, and legacy snapshots remain readable.

- [#5015](https://github.com/MCPJam/inspector/pull/5015) [`27fcf49`](https://github.com/MCPJam/inspector/commit/27fcf497e4df2cfd46623a2b506df76b6dda2eff) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Automatically attach CI metadata to SDK eval uploads in GitHub Actions, GitLab CI, CircleCI, Buildkite, Jenkins, Vercel, and Netlify. Preserve explicit CI settings, support opting out with `ci: {}`, and retain the CI provider in incremental reporters.

- [#4984](https://github.com/MCPJam/inspector/pull/4984) [`5024abe`](https://github.com/MCPJam/inspector/commit/5024abe5999787203180b6d89c27f9dc0352dc37) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Identify the SDK in every platform request, and record the caller's user-agent.

  The SDK sent a `user-agent` only when the caller supplied one, and most callers
  do not — so the request logs cannot answer "who is on the SDK, and on which
  version?". That is not a gap in the telemetry: Axiom carries every request. It
  is a field nobody populated, and the cost is that decisions about this surface
  get argued from reasoning instead of settled from data.

  Outside a browser, `PlatformApiClient` now sends `mcpjam-sdk/<version>` by
  default, and the new `DEFAULT_PLATFORM_USER_AGENT` export holds that value.

  **This changes what goes on the wire for callers that already set `userAgent`.**
  ` mcpjam-sdk/<version>` is now appended to the value they supply, so the CLI
  sends `mcpjam-cli/5.7.1 mcpjam-sdk/8.7.1` instead of `mcpjam-cli/5.7.1`, and the
  MCP worker sends `mcpjam-mcp-worker/0.2.0 mcpjam-sdk/8.7.1` instead of
  `mcpjam-mcp-worker/0.2.0`. Any filter that matches the old string exactly, or
  anchors it at the end, stops matching. A consumer that bundles the SDK from
  source with no version injected reports `mcpjam-sdk/unknown`.

  In a browser page (a global `window` and `document`) nothing changes: no default
  is sent, and a supplied `userAgent` goes out unchanged. Chromium drops a
  script-set `User-Agent`, but Firefox sends it, and a page usually bundles the
  SDK from source, so a default there would log browser users as
  `mcpjam-sdk/unknown`. Node, Bun, Deno and Cloudflare Workers still send the
  default; they have `navigator` but no `document`.

  The inspector records the header on its request-log rows, sanitized and capped
  at 256 characters. It is a log field and nothing may branch on it: a user-agent
  is caller-supplied text, and this server already removed UA-derived attribution
  once for exactly that reason.

- [#5052](https://github.com/MCPJam/inspector/pull/5052) [`c0d47dc`](https://github.com/MCPJam/inspector/commit/c0d47dca5272a20da213fbde8f77786ee50168f7) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Let `PlatformApiClient` speak eval vocabulary 2.

  `new PlatformApiClient({ evalVocabulary: 2 })` sends `x-mcpjam-eval-vocabulary: 2`
  on every request, under which a case spells its rules `assertions`, its exact
  count `iterations` and the legacy floor `legacyIterations`, and the eval
  responses come back in the same spelling. `client.withEvalVocabulary(2)`
  derives that client from one you already hold — same credential, same base
  URL, same launch declaration, one header more — which is the step from
  "asked the deployment what it speaks" (`getProjectCapabilities().vocabulary`)
  to "speaks it". Opt in only when the deployment advertises version 2: a
  deployment that predates the negotiation ignores the header and answers in
  vocabulary 1. `extraHeaders` can neither set nor clear the header.

  The vocabulary-2 result shapes are typed: `PlatformEvalCaseV2`,
  `PlatformEvalSuiteSettingsV2`, `PlatformEvalSuiteDetailV2` and
  `PlatformEvalVerdictPolicyDefaultsV2`, each built on a shared `…Base` with
  the vocabulary-1 type. The eval methods keep their vocabulary-1 return types;
  a caller that opted in narrows. `EVAL_VOCABULARY_HEADER` is exported from
  `@mcpjam/sdk/platform`.

- [#5048](https://github.com/MCPJam/inspector/pull/5048) [`1722731`](https://github.com/MCPJam/inspector/commit/172273129dee99839cf7b26bbec5a091deb5ad56) Thanks [@chelojimenez](https://github.com/chelojimenez)! - `run_eval_suite` and `run_eval_case` now document `iterations` as the per-run
  count knob and `repetitions` as its legacy spelling.

  Both spellings were already accepted and both still fold onto the wire's
  `iterationOverride`, so no run behaves differently. What changes is the
  contract's own words: `iterations` is the canonical name of the configured
  count (`docs/evals-vocabulary-consolidation.md`), so it is declared first and
  carries the full description, and `repetitions` is described as its legacy
  spelling. Sending both is still a refusal rather than a precedence rule, now
  reported on the canonical path with one sentence shared by every surface:
  `Send iterations or repetitions, not both — they are two spellings of one field.`

- [#5088](https://github.com/MCPJam/inspector/pull/5088) [`e1e1954`](https://github.com/MCPJam/inspector/commit/e1e1954bbbd7d16446530cd371a7445e22568a14) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Add short display names to the standard check catalog while preserving criterion labels.

- [#5021](https://github.com/MCPJam/inspector/pull/5021) [`a108aa4`](https://github.com/MCPJam/inspector/commit/a108aa47c585e3f8f39b19120dcd5ae939dd4ec7) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Make standard UVC checks author real assertions, including six discovery checks over complete raw tool catalogs. Preserve duplicate declarations and output schemas before client filtering. Customized criteria remain enabled; cases can suppress inherited standard check families while preserving explicit case and step assertions.

  The analyzer advances to version 12. Deploy backend reader 12 before releasing the runner; deploy family-suppression writes and execution support before enabling inherited-family toggles.

- [#5022](https://github.com/MCPJam/inspector/pull/5022) [`20bf8ac`](https://github.com/MCPJam/inspector/commit/20bf8ac475f5493d58f5225e30a39da1c5dfb638) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Preview deterministic assertion and matcher changes against bounded stored run evidence, with authenticated API, SDK, CLI, MCP, and settings surfaces. Preserve original verdicts and identify missing evidence without scoring it as failure.

### Patch Changes

- [#5046](https://github.com/MCPJam/inspector/pull/5046) [`bd62190`](https://github.com/MCPJam/inspector/commit/bd62190692fb1ed9e665d8616c61d823a93ceedc) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Let the MCPJam GitHub Action identify SDK eval runs exactly so it can publish
  their stored case results without requiring run ids or comment code from users.

- [#5042](https://github.com/MCPJam/inspector/pull/5042) [`6b8a1fd`](https://github.com/MCPJam/inspector/commit/6b8a1fd20d7c0909dea78ea7e0bff316474d3581) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Display persisted eval execution clients across run history and comparisons, retain historical client/model matrix columns, and read models from persisted case snapshots. Expose client descriptors and case model attribution in the public API and SDK types, and accept host attachments when creating inline eval suites.

- [#5037](https://github.com/MCPJam/inspector/pull/5037) [`8007c4c`](https://github.com/MCPJam/inspector/commit/8007c4cd6c59e304b648cb43e5afa2b0bdd291cc) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Preserve Node 20.0–20.2 support when composing suite cancellation signals, clean up suite state after setup failures, and keep reporting cancellation independent from case execution.

- [#5010](https://github.com/MCPJam/inspector/pull/5010) [`8d91432`](https://github.com/MCPJam/inspector/commit/8d9143212768064412f8d35c7a7816df7159fe92) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Say "assertion" and "iteration" in two decision labels.

  `STAGE_REASON_LABELS.predicateFailed` was "a check on the result did not hold"
  and `FRICTION_NOT_MEASURED_REASON_LABELS.evidenceIncomplete` was "the evidence
  for this trial has a known hole". They are now "an assertion on the result did
  not hold" and "the evidence for this iteration has a known hole", which is the
  vocabulary the SDK itself already uses for `assertion()` and the one
  `EVAL_RUN_MEASUREMENT_UNIT_LABELS` already renders `measurementUnit: "trial"`
  as.

  Display strings only. The wire values `predicateFailed`, `evidenceIncomplete`
  and `measurementUnit: "trial"` are unchanged, and nothing that reads them
  changes behaviour.

  These labels are printed by every surface, so the forks pinned to them move in
  the same commit: `surface-core/src/copy.js`, the `user-value-chain-glossary`
  skill and its generated worker bundle, and the `openapi.json` descriptions the
  spec ratchet requires to quote them verbatim.

- [#5070](https://github.com/MCPJam/inspector/pull/5070) [`bbfb7d2`](https://github.com/MCPJam/inspector/commit/bbfb7d2d4a43edb800ebf507b872c48bfd150281) Thanks [@chelojimenez](https://github.com/chelojimenez)! - Document the eval-suite grading settings as named OpenAPI schemas, and the quality gate for the first time.

  `EvalSuiteDetail.settings` was an inline object, which put it out of reach of the spec↔SDK parity ratchet — that guard pairs SCHEMAS, so the one block describing how a suite is graded was described twice by hand with nothing comparing the two descriptions. It is now `EvalSuiteSettings` and `EvalSuiteSettingsV2`, paired against `PlatformEvalSuiteSettings` and `PlatformEvalSuiteSettingsV2`.

  The extraction immediately found the gap it exists to find: **`settings.qualityGate` has been on the SDK type and absent from the spec since it shipped.** It is now documented, with `SuiteGatePolicyV1` as its own schema — the baseline selector's three variants (including the reserved one, marked as reserved rather than looking available), the four conditions, and the note that an omitted condition is not evaluated at all rather than being a condition set to zero. `SuiteGatePolicyV1` is deliberately unpaired: its SDK twin is a zod-inferred type in the contract layer, not an interface in `platform/types.ts`, which is what the parity parser reads.

  Requiredness came out of the same pass. The extracted schemas now declare the four fields the DTO always emits, which the inline block never said, so a caller reading the spec learns that `judge` is always present and fully resolved rather than optional.

  Twenty-one field descriptions across the eval schemas move off "verdict policy v2" and onto what each field measures — which criterion decides a suite, which population a count is in, and the counterexample that stops the conversion: ten cases, nine always passing and one always failing, passes a 90% suite-wide bar and fails a 0.9 per-case one.

- [#5092](https://github.com/MCPJam/inspector/pull/5092) [`501b03e`](https://github.com/MCPJam/inspector/commit/501b03e9421366082db6582f71a2406def5231c3) Thanks [@ignaciojimenezr](https://github.com/ignaciojimenezr)! - Infer omitted eval reporting server names from resolved server replay configs, including connected MCP managers and agents. Preserve explicit server names and empty lists across one-shot, chunked, and streaming reports.

- Updated dependencies [[`20bf8ac`](https://github.com/MCPJam/inspector/commit/20bf8ac475f5493d58f5225e30a39da1c5dfb638), [`20bf8ac`](https://github.com/MCPJam/inspector/commit/20bf8ac475f5493d58f5225e30a39da1c5dfb638)]:
  - @mcpjam/evaluators@0.2.0

## Unreleased — Stage 5 Step 3 (eval reporter wire-sends hostConfig)

- Eval reporter now sends `{ hostConfig, hostConfigHash }` on `POST /sdk/v1/evals/runs/start` and `POST /sdk/v1/evals/report` when the backend advertises `evalsHostConfig` at `GET /sdk/v1/info`. Lazy capability probe is cached per `baseUrl` and **fail-safe to "no capability"** — any error (network / 404 / timeout / parse) makes the reporter omit `hostConfig` rather than fail the report.
- Source order for the run-level host snapshot: `iteration.hostSnapshot` → `executor.getHostSnapshot?.()` → `MCPJamReportingConfig.host`. Pass-1 homogeneity gate: send run-level only when all available iteration snapshots canonicalize to the same hash; heterogeneous runs omit the field (per-iteration wire support is a later stage).
- Old backends without the capability are unaffected — body shape stays the same.

## 1.12.0

### Stage 5 Step 1 — SDK helper for backend ingestion

- New helper `normalizeSdkEvalHostConfigForWire` exported from `@mcpjam/sdk/host-config/internal` (not the public barrel). Strips runtime-manager identifiers (`serverIds`, `optionalServerIds`, `serverConnectionOverrides`) so the SDK reporter and the `/sdk/v1/evals/*` ingestion route hash byte-identical wire shapes. Accepts both canonical `HostConfigInputV2` and public `HostJson` from `Host.toJSON()`. Pure, browser-safe, idempotent.

### Stage B — Canonicalizer tightening

- Deep-sort nested `clientCapabilities` / `hostContext` records (matches `*Override` + `mcpProfile`).
- Drop empty `allowFeatures` from canonical (matches sibling `openaiAppsOverrides`).
- `requireRecord` helper fails fast on missing required `clientCapabilities` / `hostContext` (replaces `?? {}` coalescing — surfaces caller bugs at canonicalize time).
- Drop `openaiAppsOverrides` when `compatRuntime.openaiApps === false` (the resolver ignores them anyway).
- Tightened the shared `isPlainObject` predicate with a prototype guard (`Object.prototype` or `null`) so `Date` / `Map` / `Set` / class instances no longer canonicalize to `{}`.
- Hash-neutral against all 15,389 prod `hostConfigs` rows at the time of release. Backend consumers should bump to `^1.12.0` to pick up the tightened behavior.

## 1.11.0 — Stage 4 (HostRunner rename + HostRuntime binding)

**Breaking changes** — major-style rename shipped under 1.11.0 because there were no public adopters at the time.

### Renamed surface

- `TestAgent` → `HostRunner` (class) and `TestAgentConfig` → `HostRunnerConfig`.
- `EvalAgent` → `HostExecutor` (interface). `HostRunner` and `HostRuntime` both implement it.
- `.prompt(message, options)` → `.run(message, options)` on `HostRunner`, `HostRuntime`, and the `HostExecutor` interface.
- `Host.addServer(id)` → `Host.requireServer(id)`.
- `Host.removeServer(id)` → `Host.removeRequiredServer(id)`.
- `EvalTest.run(agent, options)` / `EvalSuite.run(agent, options)` now take a `HostExecutor` (parameter renamed to `executor`).

No deprecation aliases. Pre-Stage-4 names are removed.

### `Host` becomes the primary spec

- `HostRunnerConfig.host` accepts `Host | HostInit | HostJson`. When supplied, the runner derives defaults for `model`, `systemPrompt`, `temperature`, and `injectOpenAiCompat` from the host snapshot (explicit fields still win).
- `HostRunnerConfig` is now a discriminated union: callers supply either a `host` (with optional `model`) **or** an explicit `model`. A config missing both is a compile-time error.
- `HostRunner` snapshots the host once at construction via `snapshotHostSource(...)`. A pre-snapshotted `HostJson` (e.g. one produced by `HostRuntime.run()`) passes through untouched — no double-snapshot. Post-construction mutations to the original `Host` do NOT affect the runner.
- New public accessors on `HostRunner`: `getHostSnapshot()`, `getHostPolicy()`.

### New: `HostRuntime` — live binding of a `Host` to a manager

- `host.withManager(manager, { apiKey, ...defaults })` returns a `HostRuntime`. `apiKey` lives on the runtime, not per-call.
- `HostRuntime.run(input, options?)`:
  - Snapshots the live `Host` on every call.
  - Validates required server ids against the manager (`assertHostServersKnown`).
  - Resolves the active tool set via `manager.getToolsForAiSdk(serverIds, { includeAppOnly: policy.respectToolVisibility === false })`.
  - Dynamically imports `HostRunner` and delegates execution.
- **Stateless across turns**: prior `PromptResult`s accumulate in `getPromptHistory()` for inspection but are NOT auto-replayed into the next turn. Multi-turn continuity stays explicit via `PromptOptions.context`.
- The `HostRuntimeManager` shape is structural (`hasServer` + `getToolsForAiSdk`); `MCPClientManager` satisfies it without a static dependency from the `host-config` bundle.
- `HostRuntime` lives in `sdk/src/host-config/` and stays browser-safe — the `HostRunner` import is dynamic, so bundlers can split it into a separate chunk.

### New: `host.run()` one-shot sugar

```ts
await host.run("write me a haiku", {
  apiKey: process.env.ANTHROPIC_API_KEY!,
  mcpClientManager,
});
```

Internally constructs a throwaway `HostRuntime` and delegates. No shared state across calls.

### New: `EvalTest` / `EvalSuite` stamp host-derived metadata

- When the executor implements `getHostSnapshot?.()`, `EvalTest` and `EvalSuite` derive a host metadata stamp (`buildHostSnapshotMetadata`) and additively merge it into each `EvalResultInput.metadata`. Existing keys (`retryCount`, `iterationNumber`, …) are never overwritten — conflicting host keys are namespaced under `host.<key>`.
- `MCPJamReportingConfig.host?: Host` field added. Wire-level `hostConfigHash` propagation is deferred to a follow-up stage; the field is accepted but not yet sent.

### Single-gated app-only filter + SDK-owned OpenAI-compat injection

- SEP-1865 `_meta.ui.visibility = ["app"]` filtering happens once at `HostRunner`'s tool-prep step, gated by `hostPolicy.respectToolVisibility !== false` (default = filter). The inline drop inside `convertToToolSet` is removed.
- The OpenAI Apps compat decision (`resolveOpenAiCompatForHostConfig`) is derived from the host snapshot by default and applied via the existing SDK `injectOpenAICompat` primitive on captured widget snapshots.

### Codemod for callers

```sh
sd 'TestAgent' 'HostRunner' $(rg -l 'TestAgent' sdk examples)
sd 'EvalAgent' 'HostExecutor' $(rg -l 'EvalAgent' sdk examples)
sd '\.prompt\(' '.run(' $(rg -l '\.prompt\(' sdk examples)
sd 'prompt: \(' 'run: (' $(rg -l 'prompt: \(' sdk examples)
```

(Object-literal mocks that wrote `prompt: async (...) => ...` need the same `prompt:` → `run:` rename; bare `prompt(` method declarations on interfaces likewise.)

### Inspector

No behavior changes. Imports of the Stage 3 helpers (`extractHostExecutionPolicy`, `applyVisibilityPolicyAndCountSignals`, `resolveOpenAiCompatForHostConfig`) move from the inspector's local re-export files to `@mcpjam/sdk/host-config/internal`. The inspector-only `host-execution-policy.ts` shim is deleted; `compat-runtime.ts` keeps only the Convex-bound `loadSuiteHostConfig`.
