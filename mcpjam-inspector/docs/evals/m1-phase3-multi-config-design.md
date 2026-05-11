# M1 Phase 3 — Multi-config eval runs (design RFC)

Status: design — gating implementation per the M1 plan.

## Why this is its own design pass

Phase 3 is the architectural piece of M1. It touches run identity, iteration identity, the host-config materialization pipeline, the SSE event shape, and the run-detail UI all at once. The plan calls out that this is where bad assumptions get expensive, so the implementation is gated on agreement here. Phases 1, 2, 4, and 5 do not need this design.

## What changes

Today a suite run executes against one client config. Phase 3 lets a single run target up to **3** client configs concurrently, and surfaces the per-config results side by side. A "client config" maps to the same data model as the chatbox (model + provider + system prompt + temperature + tool choice + servers).

## Decisions (locked)

- **Cap:** up to 3 client configs per request, enforced both at Zod (`clientConfigs.length <= 3`) and post-parse via the cap formula already in `server/routes/shared/evals.ts` (`Math.max(clientConfigs.length, 1)`).
- **Iteration identity:** reuse the existing `hostConfigId` on `testIteration` (already persisted and indexed per `mcpjam-backend/convex/schema.ts:614`). No new Convex field.
- **Grouping disambiguator:** `HostConfigInputV2` does not include `provider` or `toolChoice` (`mcpjam-backend/convex/lib/hostConfigV2.ts:31`), so two configs that differ only in those fields could share a `hostConfigId`. To keep the cross-run comparison key correct, compute `executionConfigKey = hash(hostConfigId, provider, toolChoice)` at runtime in the runner/recorder and use it as the grouping key for Phase 4 regression detection.
- **Run identity:** one `testSuiteRun` row with up to 3 config branches keyed by `(hostConfigId, executionConfigKey)`. Not 3 sibling runs. Preserves run numbering, `latestRun` semantics, and lets the UI group by `(testCaseId, executionConfigKey)` inside one run.
- **Fail isolation:** `Promise.allSettled` per config — one config's MCP server crashing must not poison another's tool registry. Per-config errors land on the per-iteration record; the suite run itself still completes.
- **SSE shape:** every event payload carries `hostConfigId`. The client-side `eval-stream-reducer.ts` buckets by `hostConfigId`.
- **Transport DTO:** chat-box / project config is NOT lifted into `shared/`. A dedicated `ClientConfigDto` lives in `shared/eval-config.ts` (this PR). UI converts chatbox state → DTO at the boundary.
- **Pinned baseline:** out of scope for M1. Comparison source is most-recent-prior only.

## ClientConfigDto

```ts
type ClientConfigDto = {
  id: string;             // stable, client-supplied; same id across reruns of the same picked config
  model: string;          // e.g. "claude-3-7-sonnet"
  provider: string;       // e.g. "anthropic"
  systemPrompt?: string;
  temperature?: number;
  toolChoice?: ToolChoice;
  serverRefs: ServerRef[]; // resolvable to MCP server identities; NOT raw chatbox state
};
```

The shape mirrors the runtime resolved execution config — not the chatbox UI state. The chatbox picker UI emits this DTO via a thin adapter at the boundary; the backend never sees chatbox-only fields.

## Worked example — 2 configs × 3 iterations × 2 cases

A suite run with `clientConfigs.length = 2`, two test cases, each with `runs: 3`, produces **1** `testSuiteRun` row and **12** `testIteration` rows. The pseudo-shape, illustrative only:

```
testSuiteRun {
  _id: "run_42",
  suiteId: "ts_abc",
  runNumber: 17,
  status: "completed",
  // existing fields...
}

testIteration[0] { suiteRunId: "run_42", testCaseId: "tc_A", iterationNumber: 1, hostConfigId: "hc_haiku_default", ... }
testIteration[1] { suiteRunId: "run_42", testCaseId: "tc_A", iterationNumber: 2, hostConfigId: "hc_haiku_default", ... }
testIteration[2] { suiteRunId: "run_42", testCaseId: "tc_A", iterationNumber: 3, hostConfigId: "hc_haiku_default", ... }
testIteration[3] { suiteRunId: "run_42", testCaseId: "tc_A", iterationNumber: 1, hostConfigId: "hc_sonnet_default", ... }
testIteration[4] { suiteRunId: "run_42", testCaseId: "tc_A", iterationNumber: 2, hostConfigId: "hc_sonnet_default", ... }
testIteration[5] { suiteRunId: "run_42", testCaseId: "tc_A", iterationNumber: 3, hostConfigId: "hc_sonnet_default", ... }
testIteration[6..11]  // same for tc_B
```

The run-detail UI queries iterations by `suiteRunId`, groups by `(testCaseId, executionConfigKey)`, and renders one column per config. Per-config p50/p95 reuse the helpers from Phase 1.

`iterationNumber` is **per (testCase, config)**, not global within the run. So `(tc_A, hc_haiku_default, iter 1..3)` and `(tc_A, hc_sonnet_default, iter 1..3)` coexist with overlapping iteration numbers. This matches today's invariant for single-config runs (iteration number is per case).

## Runner pseudocode

```ts
const configs = request.clientConfigs ?? [defaultConfigFromSuite(suite)];

for (const test of tests) {
  await Promise.allSettled(
    configs.map(async (config) => {
      for (let i = 0; i < test.runs; i++) {
        const hostConfigId = await resolveHostConfig({ suite, test, config });
        const executionConfigKey = hashExecutionConfig({
          hostConfigId,
          provider: config.provider,
          toolChoice: config.toolChoice,
        });
        const iter = await precreateIteration({
          suiteRunId,
          testCaseId: test._id,
          iterationNumber: i + 1,
          hostConfigId,
        });
        try {
          await runOneIteration(iter, config, hostConfigId);
        } catch (err) {
          await markIterationFailed(iter, err); // does NOT abort siblings
        }
        emitSseEvent({ type: "iteration:done", hostConfigId, ... });
      }
    }),
  );
}
```

Key invariants:
1. `Promise.allSettled` at the config level. A thrown config does not block siblings.
2. Inside each config, iterations run sequentially (matches today).
3. Each iteration is recorded with the resolved `hostConfigId`. The runtime-only `executionConfigKey` is attached to SSE events for client-side grouping but does not need to be persisted (Phase 4 recomputes it at comparison time).

## SSE event shape

Today's events carry an iteration identity. Phase 3 adds `hostConfigId` to every event payload that already carries `iterationId` or `testCaseId`:

```ts
type EvalStreamEvent =
  | { type: "iteration:started"; iterationId; testCaseId; hostConfigId }
  | { type: "tool:called";       iterationId; testCaseId; hostConfigId; toolName; arguments }
  | { type: "iteration:done";    iterationId; testCaseId; hostConfigId; result }
  | ...
```

`eval-stream-reducer.ts` keys its per-iteration accumulators by `(iterationId)` already; for multi-config display we add a derived bucket keyed by `hostConfigId` so the UI can render N columns without re-querying.

## Concurrency caps

The Phase 2 ceiling already accounts for multi-config: `MAX_TOTAL_LLM_CALLS = 300`, with `totalCalls = sum(test.runs) * Math.max(clientConfigs.length, 1)`. No new cap logic required; the post-parse check in `runEvalsWithManager` already takes a `configCount` parameter and will pick it up once the request carries `clientConfigs[]`.

## UI changes

- Generalize `compare-run-chat-surface.tsx` (currently 2-up for runs) into N-up (1..3) keyed by `executionConfigKey`. Reuse `trace-viewer.tsx` per column.
- Add a "Pick up to 3 client configs" affordance on the run surface that reuses the existing chatbox config picker components but emits `ClientConfigDto[]`.
- Run-detail KPIs (Phase 1's p50/p95 helpers) compute per config.

## Out of scope for Phase 3

- Pinned baseline. Most-recent-prior only.
- More than 3 configs.
- Extending `HostConfigInputV2` to include `provider` / `toolChoice`. That's a backend schema change; defer past M1. Until it lands, `executionConfigKey` carries the disambiguator.
- Cross-suite comparison.

## Open questions before implementation

1. Should `serverRefs` on `ClientConfigDto` be allowed to differ from the suite environment's `servers`? If yes, the runner must merge per-config server overrides into the host-config resolver. If no (default), all configs share the suite's `environment.servers` and `serverRefs` is purely informational.
2. When a user picks 3 configs from chatboxes that already exist as named entities (e.g. "Sonnet w/ careful tool choice"), should we surface those names in the run-detail column headers? Likely yes — the DTO's `id` can carry an optional `label`.
3. Hash function for `executionConfigKey` — SHA-256 over a canonicalized JSON shape, or a smaller FNV-1a / xxhash? Stable across server restarts is the only hard requirement. Defaulting to a tiny pure-JS FNV-1a in `shared/` to avoid a node-crypto dependency in the inspector client.

## Sequencing after this RFC

- **Phase 3b**: implement the runner fan-out, SSE multiplexing, N-up UI, and `ClientConfigDto[]` plumbing in `RunEvalsRequest` / `RunTestCaseRequest`. Land behind a feature flag if practical.
- **Phase 4**: regression detection keyed by `(testCaseId, executionConfigKey)`. Schema-only change in `mcpjam-backend`: add `regressionThresholdPct?: number` to the `testSuite` table.
- **Phase 5**: strip host chrome from test-case detail views.
