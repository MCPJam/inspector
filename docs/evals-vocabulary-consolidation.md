# Evals vocabulary consolidation — the pinned contract

Status: **pinned**. Every later step in this program implements what is written here. A change to
this file is a change to the contract and needs its own review; implementation PRs cite it rather
than re-deciding it.

## Why

The eval authoring surface exposes its own development history rather than one model.

One deterministic grading rule is spelled three ways: `checks` (public API, UI, and the SDK suite
file since #4774), `predicates` (Convex storage and the SDK's evaluator library), and `assertions`
(the backend's suite-file contract, `convex/lib/evalSuiteFile.ts`). The two halves of the suite-file
contract already disagree with each other.

One configured execution count is spelled three ways: `repetitions` (suite file, CLI flag, Convex
verdict-policy v2), `runs` (Convex legacy, still required storage), and `iterations` (SDK run options,
public API case field). And the word for ONE execution is itself split: eval code says `trial` where
the product already says "iteration".

Four authoring entry points — `test`, `expectedToolCalls`, `predicates`, `scorers` — converge on one
`ScoreResult`, but an author has to learn all four to know that.

## The target model

| Concept | Meaning | Consolidates |
|---|---|---|
| suite | cases with shared defaults and an acceptance policy | unchanged |
| case | an authored scenario with stable identity | unchanged |
| iteration | one execution instance of a case under one execution variant | the eval sense of `trial` |
| repetitions | the configured number of iterations of a case | `runs`, and `iterations` wherever it names the configured count (SDK run options, public API case field) |
| trace | captured evidence of that execution | unchanged |
| evaluator | an assertion or a judge | `Scorer`, `grader`, umbrella uses of `check` |
| assertion | a deterministic rule | `Predicate`, `check`, matcher-backed rules |
| judge | a model-based rubric | unchanged |
| evaluator result | what one evaluator observed | `ScoreResult`, through a versioned projection |
| verdict | the policy-derived decision | unchanged |

`EvaluatorKind` has exactly two members, `assertion` and `judge`. Tool/trajectory matching is an
assertion implementation, not a third kind. A rendering component may keep a matcher-specific
presentation variant without changing the domain enum.

## What does not change, ever

These are the invariants. A PR that trips one has found a defect in itself, not in the ratchet.

1. **Evaluator identity.** Every `scorerId` value stays byte-for-byte: the positional
   `predicate:<type>#<ordinal>`, the content-derived `predicate:<type>#<sha256>`, the platform's
   `predicate:<criterionId>`, `tool-match`, `legacy:test`, and every explicit author id. Nothing in
   this program mints a new id for an existing definition.
2. **Hash payloads.** `definitionHash` digests exactly the eleven fields
   `sdk/src/contract/derive.ts` names today (`scorerId`, `idSource`, `scorerVersion`,
   `implementationHash`, `deterministic`, `passThreshold`, `role`, `onError`, `onSkipped`, `model`,
   `scope`). `evaluationConfigHash`, `PREDICATES_VERSION` (`"1"`) and `JUDGE_TEMPLATE_VERSION`
   (`"3"`) are unchanged. The canonical public names are a projection **over** this payload, never a
   new payload.
3. **Backend configuration identity.** `convex/lib/evalConfigRevision.ts` keeps serializing the keys
   `predicates`, `defaultPredicates`, `repetitions` and `runs`, and keeps its legacy escape hatch
   that fires only when all eight suite fields are absent. Canonical arguments are normalized to the
   legacy variables **before** anything hashes them, so an identical configuration authored either
   way produces an identical revision string. The same holds for case fingerprints
   (`convex/lib/testCaseBatch.ts`), rubric and judge-template hashes, and verdict-policy signatures.
4. **`measurementUnit: "trial"`.** The wire value is frozen.
   `EVAL_RUN_MEASUREMENT_UNIT_LABELS` already renders it as "iteration"/"iterations", so the
   user-visible word is correct today. Changing the enum member would buy a versioned storage union
   and a published-schema change for no visible gain. Rename the label vocabulary around it, not the
   value.
5. **Verdict-policy counters.** `configuredTrials`, `attemptedTrials`, `eligibleTrials`,
   `passedTrials`, `failedTrials`, `minEligibleTrials`, `allConfiguredTrialsAttempted` and
   `minGradeableTrials` stay as they are in policy schema v2. An iteration-named counter set is a
   future schema version with its own readers, not an edit to the meaning of v2.
6. **Historical evidence.** `schemaVersion: "1"` suite files, `testIteration.metadata.predicates`,
   `promptTurns[].checks`, `testCaseSnapshot`, `configSnapshot`, revision snapshots, stage analytics
   and route rollups keep their shape, their validators and their readers. Nothing rewrites
   immutable history for a word.
7. **The SDK reporter's upload body.** Unchanged by this program.

## Protected vocabularies

These words mean something else. A codemod that proposes to mutate one fails the run.

- **GitHub Checks.** `server/routes/v1/eval-checks.ts`, `server/services/github-checks/**`,
  `server/routes/web/checks.ts`, `checkRunId` outside `chatSessionChecks`, `checksEnabled`,
  `githubCheck*`, `EvalCheckRepo*`, the `connect_eval_check_repo` / `list_eval_check_repos`
  operations, the deprecated `mcpjam cloud eval checks` alias, and the `checks:` key in `mcpjam.yml`.
- **Protocol and conformance checks.** `ServerDoctorCheck*`, `CheckOAuthResult`,
  `--conformance-checks`, readiness and probe lists, `benchmarkProbeRuns.checks`.
- **XAA, SAML and OIDC identity assertions.** `client/src/components/xaa/**`,
  `cli/src/commands/xaa.ts`, `--assertion-format`, `IdentityAssertionFormat`,
  `convex/lib/serverAuthFields.ts`.
- **Billing trials.** `trialEndsAt`, `trialStartedAt`, `trialDays`, `trialing`, `trialEndSeconds`,
  `trial_period_days`, `resetTrialsForBillingLaunch.ts`, the `billing:org-team-trials:*` scripts.
- **The existing evaluator-error family**, which already means the right thing:
  `maxEvaluatorErrorRate`, `evaluatorError`, `evaluatorErrorRate`, `evaluatorErrored`,
  `failureCategory: "evaluator"`, `SUITE_GATE_EVALUATOR_VERSION`, `qualityGate.evaluator`.
- **`sdk/src/host-compat/evaluator.ts`**, an unrelated evaluator (host compatibility).
- **`steps[].assertion`**, which is kept. Its type is genuinely broader than a transcript rule, and
  only the transcript half can be re-derived from a persisted trace.
- **Benchmark and description-experiment `repetitions`** (`convex/schema.ts` benchmark tables,
  `evalDescriptionExperiments.plan.repetitions`).
- **Description-experiment `iterationOverride`** (`convex/descriptionExperiments.ts`), the experiment's
  own override beside `maxTrials`. It is not folded into `iteration`. `--max-trials`, `maxTrials` and
  `plannedTrials` cap the product of cases and repetitions and are out of scope for this program.
- Generic verbs and helpers: `assertValid*`, vitest `expect`, prose "check that", mathematical
  predicates.

Files under `github-checks/**` are not categorically denied — they may legitimately import the eval
SDK. Protect the unrelated identifiers, and review eval imports there by hand.

## The public symbol map

| Existing | Canonical | Kind of change |
|---|---|---|
| `Scorer` | `Evaluator` | new runtime shape (`evaluate`), legacy `Scorer` still accepted |
| `ScoreDefinition` / `ResolvedScoreDefinition` | `EvaluatorDefinition` / `ResolvedEvaluatorDefinition` | **type alias** — runtime keys unchanged |
| `ScorerContextV1` | `EvaluatorContextV1` | type alias |
| `ScoreStatus`, `ScorerRole`, `ScorerErrorPolicy`, `ScorerIdSource` | `EvaluatorStatus`, `EvaluatorRole`, `EvaluatorErrorPolicy`, `EvaluatorIdSource` | type aliases |
| `ScoreRawOutcome` | `EvaluatorRawOutcome` | renamed member field `value` → `score` |
| `ScoreResult` | `EvaluatorResult` | **versioned projection**, not an alias |
| `runScorers`, `scoresPassed` | `runEvaluators`, `evaluatorsPassed` | new functions delegating to the old |
| `predicateScorer`, `judgeScorer` | `assertion()`, `judge()` | new constructors, identical definitions |
| `scorerConcurrency`, `scorerTimeoutMs` (run options) | `evaluatorConcurrency`, `evaluatorTimeoutMs` | additive option aliases |
| `DEFAULT_SCORER_CONCURRENCY` / `_TIMEOUT_MS` | `DEFAULT_EVALUATOR_CONCURRENCY` / `_TIMEOUT_MS` | same values |
| `GRADER_STAGE`, `PREDICATE_STAGE`, `GRADER_PRESENTATION_GROUP` | `EVALUATOR_STAGE`, `ASSERTION_STAGE`, `EVALUATOR_PRESENTATION_GROUP` | same objects, new module |
| `PREDICATE_KINDS`, `PredicateKind` | `ASSERTION_KINDS`, `AssertionKind` | same values |
| `RECOMMENDED_DEFAULT_PREDICATES` | `RECOMMENDED_DEFAULT_ASSERTIONS` | re-export; **the literal does not move** (see below) |
| `Predicate`, `PredicateResult`, `PredicateScope` | `Assertion`, `AssertionResult`, `AssertionScope` | type aliases from a new subpath |
| `@mcpjam/sdk/predicates` | `@mcpjam/sdk/assertions` | new subpath; the old one keeps working |
| `EvalTestConfig.predicates` / `.scorers` / `.test` | `.evaluators` / `.execute` | additive |
| `EvalSuite.run({ iterations })` | `EvalSuite.run({ repetitions })` | additive; `iterations` stays as a deprecated alias |

`RECOMMENDED_DEFAULT_PREDICATES` stays declared in `sdk/src/contract/grader-stage.ts`, byte for byte.
The backend pins it through a whole-file capture of the three `{type, role, severity}` triples
(`convex/lib/mirrors.json`, pair `recommended-default-predicates`). Moving the literal to another
file would make that capture match nothing, and a capture that matches nothing is a pin that goes
green forever. The stage tables move; the seed does not.

## `EvaluatorResult`

```ts
export const EVALUATOR_RESULT_SCHEMA_VERSION = 1 as const;

export type EvaluatorResult = {
  schemaVersion: 1;
  evaluatorId: string;
  evaluatorVersion: string;
  definitionHash: string;
  kind: EvaluatorKind;
  status: EvaluatorStatus;
  score?: number;
  passThreshold: number;
  passed?: boolean;
  explanation?: string;
  evidence?: string[];
  deterministic: boolean;
  model?: string;
  promptHash?: string;
  error?: string;
  scope?: AssertionScope;
};
```

| `ScoreResult` | `EvaluatorResult` | Rule |
|---|---|---|
| — | `schemaVersion: 1` | added; discriminates a future version rather than being sniffed |
| — | `kind` | added; derived from `deterministic`, never stored on the definition |
| `scorerId` | `evaluatorId` | value unchanged |
| `scorerVersion` | `evaluatorVersion` | value unchanged |
| `value?` | `score?` | present if and only if `status === "scored"` |
| `rationale?` | `explanation?` | value unchanged |
| everything else | same name | unchanged |

`toEvaluatorResult` and `fromEvaluatorResult` are inverses: `fromEvaluatorResult` drops the two added
fields and reproduces the original object. A test proves the round trip over every accept row of the
shared score-contract parity corpus.

Three rules survive the rename intact. `passed` is derived as `score >= passThreshold` and is never
asserted by a model or a custom evaluator. An error, skipped or not-applicable result carries **no**
`score` — a fabricated zero would put a defect on the dashboard that nobody observed. Role and error
policy are not repeated on the result; consumers join to the config snapshot on `definitionHash`,
because two copies of "does this gate" is precisely the disagreement you cannot afford.

`EvaluatorKind` is derived rather than stored:

```ts
export function evaluatorKindOf(d: { deterministic: boolean }): EvaluatorKind {
  return d.deterministic ? "assertion" : "judge";
}
```

Tool matching and the legacy boolean are assertions by this rule, which is the intended answer: they
are deterministic authored rules. Adding a required `kind` to the definition would change the hash
payload, which invariant 2 forbids.

## Authoring

```ts
const suite = new EvalSuite({
  name: "Support workflows",
  defaults: {
    repetitions: 5,
    evaluators: [assertion({ type: "noToolErrors", role: "advisory" })],
  },
});

suite.add(new EvalTest({
  id: "c_explain_refund_policy",
  name: "Explains the refund policy",
  execute: async (executor) => {
    await executor.run("Explain the refund policy.");
  },
  evaluators: {
    mode: "extend",
    list: [
      assertion({ id: "nonempty-answer", type: "finalAssistantMessageNonEmpty" }),
      judge({
        id: "policy-grounding",
        model: configuredJudgeModel,
        apiKey,
        rubric: ["The answer is supported by the retrieved policy."],
        role: "advisory",
      }),
    ],
  },
}));

const result = await suite.run(executor);
```

### Types

```ts
export type EvaluatorOverride = { mode: "inherit" | "extend" | "replace"; list: Evaluator[] };
export interface EvalSuiteDefaults { repetitions?: number; evaluators?: Evaluator[] }
// EvalTestConfig gains: execute?, evaluators?: EvaluatorOverride; `test` becomes optional.
// EvalSuite.run options gain: repetitions?; the existing `iterations` stays as its deprecated alias.
```

### Resolution

Suite defaults and case evaluators resolve through exactly the three rules the backend's
`resolvePredicates` (`convex/lib/predicates.ts`) implements, and no others, so a code-first case and a
hosted case with the same configuration grade the same way:

- an absent case override, or `mode: "inherit"`, takes the suite defaults, or an empty list when the
  suite has none. Under `inherit` the case's `list` is ignored, not refused, exactly as the backend
  ignores it;
- `mode: "replace"` takes the case list verbatim, ignoring the suite defaults entirely, and
  `{ mode: "replace", list: [] }` is how an author explicitly disables an inherited default;
- `mode: "extend"` is suite defaults followed by the case list, suite first.

A case override is always the `{ mode, list }` object. There is no bare-array shorthand: the backend's
stored override has no such form, so a shorthand would be a code-first-only rule with no hosted
equivalent.

### Equivalence

The effective assertion list is `config.predicates` followed by the assertions in the resolved
evaluator list. Ordinals are positions in that combined list. `assertion()` builds its definition
through the same `predicateScoreDefinition` the legacy path uses, with the same `{id, ordinal, role}`
inputs; `judge()` returns `judgeScorer`'s definition unchanged; `execute` reuses the `legacy:test`
definition. Therefore:

```
{ predicates: [a, b] }
  ≡ { evaluators: { mode: "extend", list: [assertion(a), assertion(b)] } }
  ≡ { predicates: [a], evaluators: { mode: "extend", list: [assertion(b)] } }
```

with no suite defaults, all produce the same `EvaluationConfigSnapshot` — the same definitions in the same order, the same
`scorerId` and `idSource` on each, the same `definitionHash`, the same aggregate hash. A golden
fixture captured from unchanged code pins this, and asserts each id literally so an ordinal shift
fails even if the hash coincidentally matched.

Suite-default assertions come first and shift case ordinals, exactly as the backend's `extend` shifts
the effective list. That is a real consequence of inheritance, not an accident: a generated id is
positional and documented as unstable, which is why a gate may not select one.

A case is evaluated **once**. Projecting a rule's verdict into several compatibility shapes never
re-runs it.

### Definition order

`legacy:test`, then tool-match, then the effective assertions in authored order, then `config.scorers`,
then the remaining evaluators. The hash is order-independent; the order is what a dashboard reads.

### `execute` versus `test`

Exactly one. `execute` may return nothing and lets the evaluators decide; `test` returns the boolean
it always did. The `legacy:test` definition is emitted either way, so the two forms hash identically:
an `execute` that completes scores 1 on that row, and one that throws produces an error row that
fails the iteration closed, exactly as a throwing `test` does today.

### Refusals

| Condition | Message |
|---|---|
| both `test` and `execute` | ``EvalTest "<name>" sets both `execute` and its legacy `test` alias — set one. They are two spellings of the case's driver; `execute` may return nothing and lets the evaluators decide.`` |
| neither | ``Invalid config: must provide 'execute' (or the legacy 'test') function`` |
| duplicate evaluator id, including against a suite default | ``EvalTest "<name>": duplicate evaluator id "<id>". Evaluator ids must be unique within a case, and suite defaults.evaluators count too — rename one, or use mode "replace" to drop the suite's.`` |
| a widget assertion in a code-first case | ``Assertion <type> needs widget render observations, which only a hosted run captures. Remove it from this code-first evaluator, or move the case to a hosted eval suite.`` |
| `EvalSuite.run` with no count | ``EvalSuite "<name>" has no repetitions count: pass { repetitions } to run(), or set defaults.repetitions on the suite.`` |
| both spellings of the count | ``Set repetitions or its deprecated alias iterations, not both.`` |
| both spellings of a bound | ``Set evaluatorConcurrency or its legacy alias scorerConcurrency, not both.`` |

`predicates` alongside `evaluators`, and `scorers` alongside `evaluators`, are **additive** rather
than refused: they compose into one list, and an id collision is already caught above. This is what
makes migration incremental.

Two evaluators with the same id and identical content collapse into one definition, as the snapshot
builder already does. That is not an error; it is one definition named once.

That collapse is narrower than it sounds, and the order matters. Three cases, three outcomes:

| Case | Outcome |
|---|---|
| the same id on two definitions that differ | refused by the snapshot builder — one id cannot mean two evaluations |
| the same id on two IDENTICAL definitions | collapses to one row |
| an id already owned by a built-in (`legacy:test`, `tool-match`, a positional `predicate:<type>#<n>`) | refused **before** the builder runs, whether or not the content matches |

The third is the one a reader would otherwise get wrong. `EvalTest` builds its reserved-id set first
and refuses a custom evaluator that reuses one, because a built-in row minted against the wrong
definition would carry a hash that joins to nothing — and the gate engine's fail-closed join reads
an unjoinable row as tampering. So "identical content collapses" holds only outside the reserved
set, and a suite default counts toward the case's ids for the same reason.

## The wire

Requests and responses negotiate with a header rather than a version path:

```
x-mcpjam-eval-vocabulary: 2
```

Absent means 1, which is byte-for-byte today's contract: the same request fields, the same refusals,
the same response projection. A response that varies by vocabulary sends
`Vary: x-mcpjam-eval-vocabulary`. Any value other than `"1"` or `"2"` is a 400.

Under **both** vocabularies every spelling of a field is accepted and any two of them together is a
refusal, reported with the conflicting paths and decided by presence rather than truthiness so an
explicit `null` clear still reaches storage:

```
Send <canonical> or <legacy>, not both — they are two spellings of one field.
```

Under vocabulary 2 the canonical spellings are `assertions` and `repetitions`; the read projection
renames `checks` to `assertions` and reports the configured count as `repetitions`. Under vocabulary 1
nothing moves. A canonical client must project a GET result into a valid write request rather than
echoing both spellings back into a PATCH.

The count family is the one place where meaning, not just spelling, differs, because the legacy API
carries two counts with different semantics on the same object: `iterations` (a spelling of `runs`)
and the verdict-policy-v2 `repetitions`. Under vocabulary 1 that object is unchanged, both counts
included. Under vocabulary 2 `repetitions` is the one configured count and `iterations` and `runs` are
its legacy spellings; the adapter writes the legacy `runs` and, on a verdict-policy-v2 suite, the v2
`repetitions` as well, keeping both stored spellings equal. `iterations` never names the configured
count in vocabulary 2: an iteration is one execution.

### Capability

A deployment advertises what it understands rather than being guessed at:

```ts
vocabulary: {
  version: 2,
  evaluatorKinds: ["assertion", "judge"],
  assertionKinds: PREDICATE_KINDS,
  fields: { assertions: ["checks", "predicates"], defaultAssertions: ["defaultPredicates"], repetitions: ["iterations", "runs"] },
}
```

`scorers.predicateKinds` is retained for existing consumers. Absence of `vocabulary` selects the
existing contract. A client reads the capability value; it never infers support from the presence of
a field on an unrelated object.

## The suite file

Dialect `"2"` uses `assertions`; the count is `repetitions` in both dialects. Dialect `"1"` is
untouched — its `repetitions` stays required and its published JSON Schema keeps its contract, so an older strict reader can never
misread a new file under its existing version.

The loader accepts both. The writer emits the file's own dialect, and a new dialect is written only
when the author asks for it. An offline tool has no capability handshake, so the conservative default
is what keeps an export loadable by whatever is installed on the other side.

## UVC is unchanged

The chain stays `connection → discovery → selection → call → response → userValue`. Evaluator results
plus captured evidence feed the existing derivation; results plus the pinned policy feed the
authoritative verdict. The differences between `failed`, `notMeasured`, `notReached` and
`notApplicable` are preserved, including the rule that no inspected evidence cannot establish a
passing stage. An evaluator error does not establish a server defect. Stage attribution says where
evidence is filed, not what caused a failure. `StageMeasurementsV1`, measurement coverage and
persisted measurement units are real evidence contracts and do not change because evaluator outputs
are now called results.

## Compatibility posture

Transitional, not permanent. Deploys are not atomic across two repositories, Convex argument objects
are closed, and the inspector calls Convex through untyped strings, so old and new spellings coexist
for the length of the rollout. Expand, migrate, contract applies in full.

Installed-client compatibility is not a permanent commitment for this surface: the public API is
documented as preview, and the eval commands are a ~100-person population with essentially no pinned
CI. The old spellings are deleted at the end of the rollout, not carried indefinitely.

Two things that look like compatibility are not, and both stay regardless: historical rows remain
readable in the shape they were written, and evaluator identities and hash payloads stay frozen.
Neither is about who is calling us.
