# Public API vocabulary consolidation — the pinned contract

Status: **pinned**. Every later step in this program implements what is written here. A change to this
file is a change to the contract and needs its own review; implementation PRs cite it rather than
re-deciding it.

Companion to [`evals-vocabulary-consolidation.md`](./evals-vocabulary-consolidation.md), which
pinned the *authoring* vocabulary. This one pins the **public surface**: MCP tool names, REST
paths, SDK exported types and response field names, for three nouns the product renamed in the UI
and never carried to the API.

`trial` is deliberately **not** one of them. See "Handed back: trial" below — it was in the first
draft of this document and the evals contracts refused it.

## Why now

`docs/reference/public-api.mdx` says it plainly:

> During the preview, breaking changes to v1 may still happen.
> When it reaches general availability, breaking changes will require a new version path.

The API is tagged `Preview` today. Every rename below costs a `/v2` after GA. This is the last
cheap moment, and the MCP server launch is what closes it.

## The one rule

**The public name changes. Storage does not.**

No table is renamed, no column is renamed, no stored value changes spelling, no index is
rebuilt, no migration runs. Every name below is a projection applied at the API boundary.

This is not a compromise, it is the proven path: `hosts` → `clients` shipped exactly this way.
The Convex table is still `hosts`, the public noun has been `client` for months, and nobody has
asked why. See `sdk/src/platform/operations.ts:10102`.

The counter-example is in the same schema. `chatbox` → `scenario` renamed the storage, and
`origin/main` still carries the wreckage: 14 orphan `chatbox*` tables, `v.union(v.id('chatboxes'),
v.id('scenarios'))` on six foreign keys, dead `chatboxId` columns commented *"declared so they keep
validating. Nothing writes it"*, legacy `v.literal('chatbox')` wire values, plus
`lib/legacyScenarioIds.ts` and `migrations/normalizeLegacyScenarioValues.ts`. 222 occurrences
across 17 files, none of it written by anything.

A storage rename of `scenarios` would make `study` the **third** name for one object with the
first still load-bearing in the validators. We are not doing that.

## The target model

| Public noun | Means | Stored as | Replaces |
|---|---|---|---|
| study | one project environment published for outside testers | `scenarios` | `scenario` |
| swarm | the authoring container a set of goals was created in | `swarms` | unchanged |
| swarm run | one co-launched set of goal runs | `journeyRuns.swarmRunGroupId` | `wave` |
| goal | one persona + one task, run against targets | `journeys` | `journey` |
| goal run | one goal executing in one swarm run | `journeyRuns` | `journeyRun` |
| session | one conversation | `chatSessions` | unchanged |
| client | a named connection configuration | `hosts` | `host` (already shipped) |

### Why "swarm run" and not "swarm"

`swarm` is taken, and renaming the wave onto it would ratify a collision that is already shipped:
`get_swarm`'s own title is *"Get one MCPJam **swarm container**"*, while the app's `/swarms/:id`
route resolves a **wave** (`swarmWaveRouteId`). Today the word means two different things
depending on which surface you are on.

"Run" resolves it, and three independent pieces of the system already agree:

- the stored field is `journeyRuns.swarmRunGroupId` — *run group*, named before anyone said "wave"
- the overview panel renders *"a newest-first list of **Swarm Runs**"*
- the DTO is already `PlatformSwarmOverviewRun`

"Wave" only ever existed in prose and in three tool names. Nothing renders it.

### Why the whole User Testing family moves to `study`

Every one of the 18 `*_user_testing_*` operations is scoped to a single study — each takes a
`scenarioId`. The scope is the object, not the product. Leaving `user_testing` on fifteen of them
while three become `study` would create a third generation of names inside one family, which is
precisely the failure this document exists to end. "User Testing" survives as the tab name and the
product name; it stops being an operation-name prefix.

## What does not change, ever

A PR that trips one of these has found a defect in itself, not in the contract.

1. **No storage identifier moves.** Table names, column names, index names, and Convex document
   ids are out of scope. `scenarioId` stays `scenarioId` in the database and becomes `studyId`
   only in the projection.
2. **No stored value changes spelling.** The 13 `v.literal('scenario')` declarations, the 10
   `scenario.*` audit event names, `sourceType: "scenario"`, and the legacy `chatbox` values are
   frozen. Where a public enum must read `study`, it is mapped at the boundary, the way the evals
   program froze `role` at `gating` through `hashSpelling`.
3. **User-facing URLs are untouched.** The app route is `/user-testing/:scenarioId` and the tester
   share link is `/user-testing/<slug>/<token>` — the token is opaque and carries no noun. No link
   anyone holds breaks. (The bare `/scenarios` redirect stays too.)
4. **Error codes are renamed additively or not at all.** `docs/reference/public-api.mdx` promises
   codes are stable identifiers. `SCENARIO_ACCESS_DENIED`, `SCENARIO_ACCESS_STALE` and
   `SCENARIO_SIGN_IN_REQUIRED` keep their spelling through the preview; a `STUDY_*` alias may be
   emitted alongside, never instead. All three are `/api/web` codes and are deliberately absent
   from the public `/api/v1` code union, so nothing in this program has to touch them.
5. **Deprecated operations stay executable and stay unadvertised.** Verbatim the host→client rule
   at `operations.ts:10102` — old names keep working for embedders holding a reference, and are
   absent from `ALL_OPERATIONS` so the MCP catalog, agent registry, in-app toolset and CLI
   bindings can never advertise one or persist a proposal under one. Each deprecated op calls its
   own old route rather than delegating, because the shapes differ and a delegate would change
   what an existing caller receives.
6. **Nothing in this document touches an eval contract.** No scorer id, definition hash,
   `evaluationConfigHash`, verdict-policy field, verdict reason value, stage-analytics schema
   version, or billing term. If an implementation PR finds itself editing
   `sdk/src/contract/eval-*`, it has left this contract's scope.
7. **These further values are frozen**, added after the survey that preceded implementation:
   - `SWARM_FINDING_SCOPE_LEVELS`'s `"wave"` member (`sdk/src/contract/swarm-finding.ts`). It
     belongs to a versioned, backend-mirrored finding contract; renaming it is a contract version
     bump, which invariant 6's reasoning forbids here.
   - The `goal` **field** on a goal (`PlatformJourney.goal` → `PlatformGoal.goal`). The entity
     becomes "goal"; the free-text task it holds keeps the field name it already has.
   - The in-app WebMCP tool names `ui_publish_scenario` and `ui_delete_scenario`. That is the
     in-app agent surface, not the public API; only its copy changes.
   - The MCP Apps widget view keys and `ui://mcpjam/*.html` resource URIs. Worker-internal.

**The one deliberate exception to invariant 2**, decided when this document was pinned: permalink
resource `type` values DO move. `user_testing_scenario` becomes `study` and `journey_run` becomes
`goal_run`, with the old keys kept as deprecated entries resolving to the same app routes so
`isPlatformResourceType` keeps accepting both. This overrides the `host` precedent knowingly,
because these values are read by the Slack and Discord apps, which must ship their tolerance for
the new spelling before the API emits it. The projection is part of the wire-value step below.

## The renames

### 1. scenario → study

All 22 operations in the family. Old names deprecated per invariant 5.

| Now | Becomes |
|---|---|
| `list_scenarios` | `list_studies` |
| `get_scenario` | `get_study` |
| `get_user_testing_scenario` | `get_study` |
| `publish_scenario` | `publish_study` |
| `unpublish_scenario` | `unpublish_study` |
| `update_user_testing_scenario` | `update_study` |
| `rebind_user_testing_scenario` | `rebind_study` |
| `list_user_testing_sessions` | `list_study_sessions` |
| `get_user_testing_session` | `get_study_session` |
| `list_user_testing_findings` | `list_study_findings` |
| `dismiss_user_testing_finding` | `dismiss_study_finding` |
| `undismiss_user_testing_finding` | `undismiss_study_finding` |
| `get_user_testing_metrics` | `get_study_metrics` |
| `get_user_testing_usage` | `get_study_usage` |
| `get_user_testing_signals` | `get_study_signals` |
| `get_user_testing_insights` | `get_study_insights` |
| `request_user_testing_insights` | `request_study_insights` |
| `cancel_user_testing_insights` | `cancel_study_insights` |
| `upsert_user_testing_member` | `upsert_study_member` |
| `remove_user_testing_member` | `remove_study_member` |
| `rotate_user_testing_link` | `rotate_study_link` |
| `set_user_testing_guest_execution` | `set_study_guest_execution` |

22 in, 21 out: `get_scenario` and `get_user_testing_scenario` are two generations of the same read,
which `operations.ts:12582` acknowledges (*"The older `list_scenarios` / `get_scenario` operations
still work and still point at the old routes until GA"*). GA is the moment to have one. The merged
`get_study` returns the UNION of the two shapes: the settings the older read served, plus the
environment id and the insights envelope the newer one added. The envelope is present only when
the caller may have it, exactly as the user-testing read already degrades.

**REST — 19 paths collapse to one family.** Today there are two, `/projects/{id}/scenarios` and
`/projects/{id}/user-testing/scenarios/{scenarioId}`. Both become `/projects/{id}/studies` and
`/projects/{id}/studies/{studyId}`, and the `/user-testing/` segment disappears along with the
operation prefix. The subtree keeps its shape: `findings`, `findings/{id}/dismiss`,
`findings/{id}/undismiss`, `guest-execution`, `insights`, `members`,
`members/{memberIdOrEmail}`, `metrics`, `rebind`, `rotate-link`, `sessions`,
`sessions/{sessionId}`, `signals`, `usage`, `windows/{windowId}/insights`. Plus
`/projects/{id}/environments/{envId}/scenario` → `.../study`.

**SDK types (8):** `PlatformScenario`, `PlatformScenarioSummary`, `PlatformScenarioDetail`,
`PlatformScenarioServer`, `PlatformScenarioLink`, `PlatformScenarioDeleted`,
`PlatformUserTestingScenario`, `PlatformUserTestingScenarioDetail` → `PlatformStudy*`. Also
`PlatformUserTestingSession`, `PlatformUserTestingSessionDetail`,
`PlatformUserTestingInsightsRequested` → `PlatformStudy*`. Two of these collide on one target:
the publish receipt takes `PlatformStudy` and the update receipt takes `PlatformStudyUpdated`.

**Capability flags:** `publishUserTestingScenario` / `unpublishUserTestingScenario` →
`publishStudy` / `unpublishStudy`.

### 2. wave → swarm run

| Now | Becomes |
|---|---|
| `get_wave_insights` | `get_swarm_run_insights` |
| `request_wave_insights` | `request_swarm_run_insights` |
| `cancel_wave_insights` | `cancel_swarm_run_insights` |

The operation's input selector is `wave`, and it becomes `swarmRun`, accepted under both names
during the preview with the "pass either, not both" validation the host→client aliases already
use. The response field and the route parameter are `waveId`, and both become `swarmRunId`.

REST: `/projects/{id}/waves/{waveId}/insights` → `/projects/{id}/swarm-runs/{swarmRunId}/insights`.

SDK types: `PlatformWaveInsights`, `PlatformWaveInsightsRequested`,
`PlatformWaveInsightsCanceled` → `PlatformSwarmRunInsights*`.

`get_swarm`, `list_swarms`, `create_swarm`, `update_swarm`, `archive_swarm` and
`get_swarms_overview` are already correct and do not move.

### 3. journey → goal

Operations (12):

| Now | Becomes |
|---|---|
| `create_journey` | `create_goal` |
| `get_journey` | `get_goal` |
| `list_journeys` | `list_goals` |
| `update_journey` | `update_goal` |
| `archive_journey` | `archive_goal` |
| `generate_journeys` | `generate_goals` |
| `launch_journey_run` | `launch_goal_run` |
| `cancel_journey_run` | `cancel_goal_run` |
| `get_journey_run` | `get_goal_run` |
| `list_journey_runs` | `list_goal_runs` |
| `list_journey_run_sessions` | `list_goal_run_sessions` |
| `get_journey_run_scorecard` | `get_goal_run_scorecard` |

REST — 12 paths: `/projects/{id}/journeys`, `/journeys/{journeyId}`,
`/journeys/{journeyId}/runs`, `/journeys/generate`, `/journey-runs/{runId}`,
`/journey-runs/{runId}/cancel`, `/journey-runs/{runId}/scorecard`,
`/journey-runs/{runId}/sessions`, `/journey-findings`,
`/journey-findings/{findingId}/dismiss`, `/journey-findings/{findingId}/undismiss`,
`/journeys-overview`.

Two of these already drift from their own operation names: `/journeys-overview` is
`get_swarms_overview` and `/journey-findings` is `list_swarm_findings`. Renaming the routes to
`/goals-overview` and `/goal-findings` leaves the op names right and the routes right for the
first time.

SDK types (8): `PlatformJourney`, `PlatformJourneyArchived`, `PlatformJourneyRun`,
`PlatformJourneyRunAttempt`, `PlatformJourneyRunCanceled`, `PlatformJourneyRunLaunched`,
`PlatformJourneyRunSession`, `PlatformJourneyRunTarget` → `PlatformGoal*`.

Also: the swarm execution config field `sessionsPerTarget` is what the UI's per-persona
**Iterations** stepper writes. Publicly it is `iterations`. Storage keeps `sessionsPerTarget`
(and its own unfinished `sessionsPerHost` fallback, which this document does not touch). The
rename covers the swarm CONTAINER as well as the goal — `create_swarm`, `update_swarm` and
`PlatformSwarm` carry the same field, and leaving them on the old spelling would put two names for
one number on one surface.

### An op that is not renamed but carries a renamed field

`get_swarms_overview` keeps its name and returns `PlatformSwarmOverviewRun`, which spells
`journeyId`, `journeyName`, `journeyArchived` and `waveId`. `create_swarm` and `update_swarm` keep
their names and take `sessionsPerTarget`. Neither has a deprecated twin to hold the old shape, so
for the length of the preview both spellings are emitted on reads and either is accepted on
writes, never both in one body. The exclusivity is expressed in the published schema, not only in
the validator. GA deletes the old spelling.

## The wire-value projection

The three renames above leave the old nouns spelled in enum VALUES and cross-resource reference
fields on routes that are not themselves renamed: `sourceType: "scenario"` on sessions and trace
destinations, `resourceType: "scenario"` on shares, the sessions DTO's `parentRef.kind` with its
`scenarioId` / `journeyRunId` / `journeyRefId` members, and the permalink resource types above.

A value cannot be emitted twice in one field, so these negotiate rather than dual-emit, exactly as
the evals program's `x-mcpjam-eval-vocabulary` does for `role`:

```
x-mcpjam-api-vocabulary: 2
```

Absent means 1, byte-for-byte today's values. Under 2 the canonical spellings are emitted and the
legacy spellings are still accepted on input, never together with the canonical one in one field.
Any other header value is a 400. A response that varies by vocabulary sends
`Vary: x-mcpjam-api-vocabulary`. Renamed routes and new operations are vocabulary 2 by
construction; deprecated aliases are vocabulary 1 by construction. It is a distinct header from
the eval one, which is eval-scoped by name, but the two share one reader implementation. A
deployment advertises what it speaks through `GET /projects/{id}/capabilities`; a client reads the
capability rather than inferring support from a field.

This step is the only part of the program that changes a file in the backend repository, and what
it changes is a DTO projection, not storage.

## Handed back: trial

**`trial` → `iteration` was rename #4 in the first draft of this document. It is withdrawn.** The
word is not drift; it is load-bearing in four separate ways, each verified against `origin/main`.
Recorded here so nobody re-adds it.

1. **`measurementUnit: "trial"` is a deliberate legacy marker, not a stale one.**
   `sdk/src/contract/decision-summary.ts:164` defines
   `EVAL_RUN_MEASUREMENT_UNITS = ["caseVariant", "trial"]` as a discriminated union, and its own
   doc comment reads *"`trial` — one iteration. What a **legacy** run's stored `summary`
   counted."* The D9 contract requires that legacy runs say so out loud. Renaming the value to
   `iteration` erases exactly the distinction it exists to carry.
2. **The verdict-policy count fields feed configuration identity.** `configuredTrials`,
   `eligibleTrials`, `minEligibleTrials` and `minGradeableTrials` live in
   `sdk/src/contract/eval-verdict-policy.schema.json` and its generated twin. The
   evaluator-vocabulary program froze this exact class of key because renaming a configuration key
   rotates configuration identity, after which `eval gate --baseline` reports every scorer as
   removed and re-added — indistinguishable from a regression.
3. **Four of them are verdict reason enum values.** `configuredTrialsNotAttempted`,
   `eligibleTrialsBelowMinimum`, `noGradeableTrials` and `caseHasNoEligibleTrials` are wire
   members the CLI gate, the reporters and the Slack/Discord surfaces branch on.
4. **`includedTrials` / `excludedTrials` are inside materialized documents.** They belong to
   `EvalStageAnalyticsV1`, which is written once per run and **never backfilled**, and whose
   `measurementsSchemaVersion` and `stageAnalyzerVersion` partition trend comparability. Renaming
   them either bumps a version — severing every stored run from every new one — or needs its own
   read-time projection.

Separately, the evals codemod's protected-term list includes **billing trials**: a careless `trial`
sweep changes who gets charged.

The rename is not abandoned, it is **owned elsewhere**. `evals-vocabulary-consolidation.md` already
pins `iteration` as the target and shipped Waves 0, 1 and half of 2; its remaining "count family"
step is explicitly blocked on a data migration (backfilling the legacy floor out of `iterations`
into `legacyIterations`) with its own deploy window. This document must not front-run it.

**What this program may do about `trial`, and it is the whole of it:** no NEW public field,
operation, route or type introduced by the renames above may be named `trial*`. Stop the bleeding;
leave the cleanup to the program that owns the hashes.

## Not in scope

Deliberately excluded, recorded so they are not re-litigated:

- **`testSuite` / `testCase` / `testIteration` → eval suite / case / iteration.** Storage only;
  the public ops already say `eval_*`. 3,286 occurrences buying nothing at the boundary.
- **`computerEnvironments` → sandbox image.** Storage only; public ops already say
  `sandbox_image`. 265 occurrences, same reasoning.
- **`hosts` → `clients`.** Done. Listed here only as the template.
- **The `chatbox*` orphan tables.** Dead weight, but deleting them is a storage migration with
  its own risk and no public effect. Separate program, if ever.
- **`evalCase.scenario`** — the free-text context note on an eval case. It keeps the word
  `scenario`, which is correct English for what it holds and, once User Testing vacates the term,
  stops being a collision.

## Sequencing

One step per PR, each merged before the next starts.

1. **Settle the UI copy first.** The rename to "study" is half-applied: the create flow, share
   dialog, overview empty state and task editor say *study*, while `UserTestingTab.tsx` still
   renders "Scenario not found", "Scenarios belong to a project…", "Sign in to open this
   scenario", "Loading scenario…", and the tester-facing `ScenarioChatPage.tsx` says "Sign in to
   preview this scenario". Copy-only PR, no API. Cheapest possible reversal point if `study`
   turns out to be wrong.
2. **scenario → study** across all 22 operations, the collapsed route family, DTOs and docs, with
   deprecated aliases.
3. **journey → goal**, same mechanism.
4. **wave → swarm run**, same mechanism.
5. **Project the wire values** behind `x-mcpjam-api-vocabulary`, in three ordered parts: the
   backend DTO projection, then the Slack and Discord apps' tolerance for the new permalink
   spelling, then the inspector and SDK. The apps deploy independently of the API, so their
   tolerance must be live before the API emits the new spelling.
6. **Reconcile `docs/reference/openapi.json`** — it is hand-authored, not generated, so each step
   edits it and this one is the consistency pass — and write one changelog entry covering all
   three renames, as the preview policy requires.
7. **At GA: delete every deprecated alias in one PR**, along with vocabulary 1. If this does not
   happen, the program has failed in the same way `chatbox` failed, and the next reader inherits
   two live vocabularies instead of one.

Each of steps 2–4 trips the same ratchets a new `PlatformOperation` always trips, and all are
test-enforced: `MINIMAL_INPUTS` exact-set equality, permalink coverage, `CLI_BINDINGS` totality
plus the bound command resolving in the real Commander tree, the `AGENT_OP_REGISTRY` partition and
its byte-for-byte `EXPECTED_PROMPT_NOTES` snapshot, the MCP catalog's module-load throw, ordered-
name test and README table row, and the workspace built-ins partition. Budget for them; they are
the reason a rename PR is never as small as it looks.
