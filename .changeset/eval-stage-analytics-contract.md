---
"@mcpjam/sdk": patch
---

Freeze the stage-analytics contract: case intent, per-trial stage measurements, and the run-level funnel

Contract only. Nothing in the runtime accepts, sends or persists any of these
fields yet — the suite-file validator, `EvalTest` authoring, the serializers, the
reporters and the Platform mappings are all unchanged. This lands the vocabulary
first so the backend that stores it can be written against a fixed target, and
so no released CLI or SDK ever accepts a nonempty `intent` and silently drops it.
A field that validates and then disappears is worse than a field that does not
exist, because the author believes it was saved.

Three new modules in `@mcpjam/sdk/contract`:

- **`intent`** — the optional label a case's analytics group under.
  `caseIntentSchema` is the stored form (trimmed, 1..64 chars);
  `caseIntentUpdateSchema` is the wire form, the only place `null` is legal.
  `resolveIntentUpdate` applies the three-way rule that the two spellings of
  "nothing" are opposites: **omitted preserves** (so an older client
  round-tripping a suite cannot strip labels), **`null` clears**, a string sets.
  Historical absence stays absent and renders as `UNLABELED_INTENT_LABEL` —
  nothing manufactures a `general` bucket that would silently absorb every
  untagged case. Intent participates in authored-config fingerprinting
  (`intentFingerprintValue`) and is explicitly excluded from import
  semantic-exactness, so retagging a funnel cannot downgrade a converter's
  claim that it mapped a suite exactly.

- **`StageMeasurementsV1`** — how long each stage took and whether it was
  reached, for one trial. Kept OFF `StageResultRow` deliberately: the decision
  contract is what gates a run, and no verdict may ever be derived from a
  duration. Latency is the union of the complete intervals of the spans a stage
  actually cited (`basis: evidence_span_union`), so two concurrent 500ms calls
  report 500ms rather than 1000ms; missing, non-finite or inverted timestamps
  yield NO SAMPLE, never a zero. Only `selection`, `call` and `response` carry
  per-trial latency — `connection`/`discovery` timing is a run-level setup fact
  measured once per run+phase, and `userValue` has no grader timer yet.
  `StageSetupPhaseSignal` gains an optional `durationMs` for that phase envelope;
  `deriveStageResults` does not read it, so timing cannot move a stage's state.

- **`EvalStageAnalyticsV1`** — one run's funnel, plus the reference aggregation
  and a golden fixture. Counts are stored and rates are derived: a stored rate
  cannot be re-sliced or told apart from the very different claims `4/5` and
  `800/1000`. `measurementCoverageRate`, `measuredPassRate` and `reachRate` each
  return numerator, eligible denominator, exclusions and state, and a zero
  denominator is `notMeasured` with a `null` value rather than a `0` that reads
  as "everything failed". Slices are marginal — overall, intent, model, host —
  never an intent×model×host cube. `measurementUnit` is the literal `"trial"`,
  carried rather than assumed, so merging a funnel with a UT or swarm
  denominator fails loudly.

The rules the shapes exist to enforce:

- **Unknown is not a drop-off.** A stage that captured nothing is `reachUnknown`
  and is excluded from the reach denominator by name, never counted as a
  confirmed fall-out. Broken instrumentation must not read as a broken server.
- **Nothing unreadable is ever a passing observation.** Missing, unverified and
  version-ahead chains, invalid measurements and analyzer mismatches are each
  excluded and counted separately — never coerced, and never partially read.
  Absent integrity is not verified integrity.
- **Setup is counted once per run+phase; impact is counted per trial.** The
  signal is copied onto every iteration, so N copies yield one attempt, one
  latency sample, and N distinct impacted trials. Server attribution requires
  `theirs` *and* a positive egress canary, so our own network is never billed to
  a server.
- **A cap that bites is recorded.** `sliceTruncation` names any dimension whose
  values were dropped; a truncated slice array that looked complete would read
  as "these are all the models".
- **A provisional row says so.** A judge second pass can rewrite stage
  attribution after a run first goes terminal, so the summary is `provisional`
  until every applicable fanout completes, and `stageAnalyticsParityBlockers`
  refuses to call two rows comparable across run-group, analyzer version,
  measurement version or unit — a comparison against a row still being rebuilt
  can invert between two page loads.

`aggregateStageAnalytics` is pure and deterministic (all timestamps are passed
in), and its golden fixture is the conformance target for the backend
materializer, which is hand-written because Convex functions cannot import
`@mcpjam/sdk`. A second implementation of these semantics is acceptable; a
second, unpinned semantics is not.

No backfill and no migration: runs from before this ships carry no measurements
and no summary row, and absence renders as unmeasured rather than as zero.
