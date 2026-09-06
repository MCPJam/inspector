import type { HostExecutor } from "./HostExecutor.js";
import type { PromptResult } from "./PromptResult.js";
import type { LatencyBreakdown } from "./types.js";
import type {
  EvalExpectedToolCall,
  EvalResultInput,
  MCPJamReportingConfig,
} from "./eval-reporting-types.js";
import type { Predicate, PredicateResult } from "./predicates/types.js";
import { requiresRenderObservations } from "./predicates/types.js";
import {
  assertValidMatchOptions,
  evaluateToolCalls,
  resolveMatchOptions,
  type EvalMatchOptions,
  type EvalToolCallMatchResult,
} from "./matchers.js";
import { evaluatePredicates } from "./predicates/evaluate.js";
import { buildIterationTranscript } from "./predicates/transcript.js";
import {
  buildEvaluationConfigSnapshot,
  errorScoreResult,
  notApplicableScoreResult,
} from "./contract/derive.js";
import {
  fromLegacyTestOutcome,
  fromToolMatchResult,
  legacyTestScoreDefinition,
  predicateScoreDefinition,
  scoreResultFromPredicateResult,
  toolMatchScoreDefinition,
} from "./contract/adapters.js";
import type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreResult,
  ScorerContextV1,
} from "./contract/types.js";
import {
  CASE_ID_PREFIX,
  mintCaseId,
  opaqueIdSchema,
} from "./contract/identity.js";
import {
  caseIntentSchema,
  normalizeIntent,
  type CaseIntent,
} from "./contract/stage-intent.js";
import type { IterationStatus } from "./contract/chain.js";
import { runScorers, scoresPassed } from "./scorers/run.js";
import { Semaphore } from "./scorers/concurrency.js";
import type { Scorer } from "./scorers/types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import { posthog } from "./telemetry.js";
import { reportEvalResultsSafely } from "./report-eval-results.js";
import {
  actualToolCallsFromPrompts,
  iterationsToEvalResultInputs,
  iterationTraceFromPrompts,
  traceMessagesFromPrompts,
} from "./eval-result-mapping.js";
import { resolveServerReplayConfigs } from "./server-replay-configs.js";
import { buildHostSnapshotMetadata } from "./host-config/internal.js";

/**
 * Reject predicates a local run can never satisfy.
 *
 * The widget predicates read `renderObservations`, which only the hosted
 * headless-browser runner produces, and they fail CLOSED — so accepting one
 * here would mean every iteration fails with "no render observations" and the
 * author has no way to tell a real regression from an unsupported check.
 * Failing at construction says exactly what is wrong, once.
 */
function assertLocallyEvaluablePredicates(
  predicates: Predicate[] | undefined
): void {
  const unsupported = (predicates ?? [])
    .map((predicate) => String(predicate?.type ?? ""))
    .filter((type) => requiresRenderObservations(type));
  if (unsupported.length === 0) return;
  throw new Error(
    `Predicate(s) ${[...new Set(unsupported)].join(", ")} need widget render ` +
      `observations, which only a hosted run captures. Remove them from this ` +
      `code-first test, or move the case to a hosted eval suite.`
  );
}

/**
 * An id to SUGGEST in the missing-`id` error.
 *
 * **A config that already carries `externalCaseId` is suggested THAT value**,
 * not a fresh mint. `externalCaseId` is the hosted join key: the backend keys
 * such a case as `external:<id>`, and the declared id is required to agree with
 * it (a `caseId` that differs from `externalCaseId` is a hard error at ingest,
 * because two identity claims on one result is not something to pick a winner
 * between). So `id := externalCaseId` is THE migration rule for existing
 * external-id users — it lands the declared id in the same join the case
 * already lives under, and its hosted history continues. Suggesting a fresh
 * mint here would walk people straight into that conflict error.
 *
 * Minting is still the suggestion when there is no `externalCaseId`, and
 * minting can fail in a runtime with no CSPRNG — an error about a missing id
 * must never be replaced by a secondary error about generating an example.
 */
function suggestedCaseId(config: EvalTestConfig): string {
  // Already normalized by the constructor, so what is suggested is exactly
  // what goes on the wire and exactly what the hosted key is derived from —
  // there is no second spelling for the suggestion to disagree with.
  const external = config.externalCaseId;
  // Suggested only when it can BE an id at all: `externalCaseId` was never
  // charset-bound, and suggesting a value the very next line rejects is worse
  // than suggesting a fresh one.
  if (external && opaqueIdSchema.safeParse(external).success) {
    return external;
  }
  try {
    return mintCaseId();
  } catch {
    return `${CASE_ID_PREFIX}<paste a unique id here>`;
  }
}

/**
 * The fix sentence for a config with no `id`. Three situations, three fixes —
 * and getting this wrong is not cosmetic.
 *
 * A pre-6 config carrying an `externalCaseId` that CANNOT be an id used to be
 * told "mint one and commit it", which is a complete instruction only until
 * `assertSingleCaseIdentity` exists. Followed verbatim it produces a minted id
 * beside an unchanged external id — a differing pair — so the very next run
 * throws again, and the whole migration is only revealed one error at a time.
 * An error that prescribes a change which cannot construct is worse than one
 * that says nothing, so that case states BOTH halves at once.
 */
function missingCaseIdFix(
  external: string | undefined,
  suggestion: string
): string {
  if (external === undefined) {
    return `Mint one once and commit it: id: "${suggestion}"`;
  }
  if (external === suggestion) {
    return (
      `This test already declares \`externalCaseId\`, which is the key its ` +
      `hosted history is joined on, so reuse it verbatim: id: "${suggestion}"`
    );
  }
  // `suggestedCaseId` only reuses an `externalCaseId` that can BE an id, so
  // reaching here means it cannot — and `id := externalCaseId`, the migration
  // every other external-id user gets, is simply unavailable.
  return (
    `Its \`externalCaseId\` (${JSON.stringify(
      external
    )}) cannot itself be an ` +
    `id — ids are 1-128 characters of letters, digits, '-' and '_' — so no id ` +
    `can agree with it, and a differing pair is refused here and at ingest. ` +
    `Rename the external id to a conforming value and declare that same value ` +
    `in BOTH fields: id: "${suggestion}", externalCaseId: "${suggestion}". An ` +
    `external id that was never charset-valid has no hosted history for the ` +
    `rename to strand.`
  );
}

/**
 * A case's identity must be DECLARED, and it must be usable in a URL, a file
 * path and a CLI argument.
 *
 * Deliberately NOT derived from `name` when absent: deriving it would recreate
 * exactly the bug the field exists to retire — rename the test, fork its
 * history — while looking like it worked. Failing at construction says what is
 * wrong once, at the line that is wrong, with the fix in the message.
 */
function assertDeclaredCaseId(config: EvalTestConfig): void {
  const label = config.name ? `"${config.name}"` : "(unnamed)";
  if (config.id === undefined || config.id === null || config.id === "") {
    const suggestion = suggestedCaseId(config);
    // `""` is absent here for the same reason it is in `assertSingleCaseIdentity`.
    const external =
      config.externalCaseId === "" ? undefined : config.externalCaseId;
    throw new Error(
      `EvalTest ${label} has no \`id\`. A case's identity is declared, not ` +
        `derived from its name — otherwise renaming the test forks its hosted ` +
        `history. ` +
        missingCaseIdFix(external, suggestion)
    );
  }
  const parsed = opaqueIdSchema.safeParse(config.id);
  if (!parsed.success) {
    throw new Error(
      `EvalTest ${label} has an invalid \`id\` (${JSON.stringify(
        config.id
      )}): ` +
        `${parsed.error.issues.map((issue) => issue.message).join("; ")}. ` +
        `Ids travel in URLs, file paths and CLI arguments.`
    );
  }
}

/**
 * One case, one identity.
 *
 * `id` and `externalCaseId` are two claims about WHICH case this is, and from
 * this step on both ride the wire. Picking a winner between them silently is
 * how one case's history gets cross-joined onto another's, so a differing pair
 * is a hard error — here at construction, and again in the backend's ingest
 * preflight for callers that never build an `EvalTest`. Failing here is the
 * kinder half of the same rule: it costs a stack trace instead of a rejected
 * upload at the end of a run.
 *
 * The migration is always `id := externalCaseId`, because `externalCaseId` is
 * the key the hosted case already lives under (`external:<id>`). The one case
 * where that is impossible is an `externalCaseId` outside the opaque-id charset
 * — never charset-bound, so values exist that no `id` can equal — and the
 * message says so rather than suggesting a fix that the next line rejects.
 */
function assertSingleCaseIdentity(config: EvalTestConfig): void {
  const external = config.externalCaseId;
  // `""` is absent, not present-and-conflicting. The constructor's
  // normalization above drops a whitespace-only value but leaves a literal
  // empty string, and `getCaseKey` reads both as "no external id" — so does
  // the backend's equality rule (`external.length > 0 && external !== declared`).
  // Throwing here would refuse a config the wire accepts.
  if (external === undefined || external === "" || config.id === external) {
    return;
  }
  const label = config.name ? `"${config.name}"` : "(unnamed)";
  const externalCanBeAnId = opaqueIdSchema.safeParse(external).success;
  throw new Error(
    `EvalTest ${label} declares two different identities: id ` +
      `${JSON.stringify(config.id)} and externalCaseId ` +
      `${JSON.stringify(external)}. ` +
      (externalCanBeAnId
        ? `The hosted case is keyed as external:${external}, so the migration ` +
          `is id: ${JSON.stringify(external)} — the declared id lands in the ` +
          `join the case already lives under and its history continues.`
        : `externalCaseId ${JSON.stringify(external)} cannot itself be an id ` +
          `(1-128 characters of letters, digits, '-' and '_'), so no id can ` +
          `agree with it. Rename the external id to a conforming value and ` +
          `declare that same value as \`id\`: an external id that was never ` +
          `charset-valid has no hosted history for the rename to strand.`) +
      ` A differing pair is rejected at ingest too, so shipping it would fail ` +
      `the upload rather than pick a winner.`
  );
}

/**
 * Configuration for an EvalTest
 *
 * All tests use the multi-turn pattern with a test function that receives a
 * `HostExecutor` (implemented by `HostRunner`, `HostRuntime`, and any custom
 * executor that mirrors the interface).
 */
export interface EvalTestConfig {
  /**
   * This case's DECLARED identity. Required.
   *
   * Identity is declared, never derived. It used to be the `name`, which meant
   * renaming a test forked its hosted history — the bug this field retires.
   * Mint one ONCE with `mintCaseId()` from `@mcpjam/sdk/contract` and commit
   * the literal beside the test; an id regenerated on every run is not an
   * identity. Any URL-safe string of 1..128 characters is accepted (see
   * `opaqueIdSchema`) — our `c_` prefix is a grep convenience, not a rule.
   *
   * Distinct from {@link EvalTestConfig.externalCaseId}, which is the hosted
   * JOIN key that predates the charset rule. Both ride the upload now, as
   * `caseId` and `externalCaseId`, and they must AGREE when both are set — a
   * differing pair throws at construction and is refused at ingest. The
   * migration for an existing `externalCaseId` user is `id := externalCaseId`.
   */
  id: string;
  name: string;
  test: (executor: HostExecutor) => boolean | Promise<boolean>;
  expectedToolCalls?: EvalExpectedToolCall[];
  /** Matcher policy for locally enforcing expectedToolCalls. */
  matchOptions?: EvalMatchOptions;
  /** Deterministic transcript predicates that gate each iteration. */
  predicates?: Predicate[];
  /**
   * Additional scorers run against each iteration.
   *
   * `test()`, `expectedToolCalls` and `predicates` are themselves projected
   * into scores — scoring is the ONE verdict path, not a fifth system beside
   * them — so these compose with the built-ins rather than replacing them.
   */
  scorers?: Scorer[];
  /**
   * Stable identity for a case that also exists somewhere else — today, a
   * hosted eval case materialized by `loadCorpus`.
   *
   * The backend derives `caseKey = "external:" + id` when this is present
   * (`convex/sdkEvals.ts`), which is what joins a local run to the hosted
   * case's history on the run page. Identity rides HERE, never on `name`:
   * display names collide and get renamed.
   *
   * Kept alongside the required {@link EvalTestConfig.id}: this one is the
   * `external:` join key a deployed backend depends on, while `id` is the
   * declared identity the contract requires. Both are uploaded, so a config
   * that sets both must set them to the SAME value — see
   * {@link EvalTestConfig.id}. Retiring this field is a later step; it has
   * live wire semantics until one is written to converge them.
   *
   * **NORMALIZED at construction**: surrounding whitespace is trimmed, and a
   * whitespace-only value is dropped as though it were absent. The value you
   * read back from `getConfig()` and the value uploaded are therefore the
   * trimmed one. This is not a wire change so much as the removal of a second
   * spelling: the hosted key has always been derived from
   * `externalCaseId.trim()`, so the trimmed form was already the identity —
   * it just used to travel beside a padded copy of itself, which also showed
   * up in the `[id]` suffix `@mcpjam/vitest` appends to a test name. An
   * unpadded value, which is every value anybody actually writes, is
   * byte-identical to before.
   */
  externalCaseId?: string;
  /**
   * Optional analytics grouping label for this case. It is forwarded with
   * every result but never participates in scoring or the verdict.
   */
  intent?: CaseIntent;
  /**
   * Hosted "negative case" semantics: the test passes iff NO tool was called.
   *
   * Not a per-tool `toolNeverCalled` translation — the matcher already
   * implements exactly this (`evaluateToolCalls(..., {isNegativeTest: true})`),
   * and re-expressing it as predicates would be a second implementation of a
   * rule that already exists.
   *
   * Three consequences, all deliberate: the empty-`expectedToolCalls` guard
   * FLIPS (a negative case with no expectations still asserts "no tools
   * fired", so tool-match becomes applicable and gating); `isNegativeTest`
   * joins the tool-match definition's `implementationHash` (a negative and a
   * positive tool-match are different scorers and must digest differently);
   * and `ScorerContextV1.scenario.isNegativeTest` is populated so custom and
   * judge scorers can see it.
   */
  isNegativeTest?: boolean;
  /**
   * Reference output for judge scorers (`ScorerContextV1.expectedOutput`).
   *
   * Threaded rather than dropped because `judge-scorer.ts` consumes it: a
   * hosted case with an expected output judged locally without one is a
   * different evaluation, and hosted↔local judge parity is the point of
   * materializing the case at all.
   */
  expectedOutput?: string;
}

/**
 * Options for running an EvalTest
 */
export interface EvalTestRunOptions {
  iterations: number;
  concurrency?: number; // default: 5
  retries?: number; // default: 0
  timeoutMs?: number; // default: 30000
  onProgress?: (completed: number, total: number) => void;
  /** Called with a failure report if any iterations fail */
  onFailure?: (report: string) => void;
  mcpjam?: MCPJamReportingConfig;
  /** Max scorers in flight per iteration. Default 4. */
  scorerConcurrency?: number;
  /** Fallback per-scorer hard timeout. Default 60000. */
  scorerTimeoutMs?: number;
  /** @internal used by EvalSuite to prevent duplicate per-test uploads */
  __suppressMcpjamAutoSave?: boolean;
}

/**
 * Result details for a single iteration
 */
export interface IterationResult {
  passed: boolean;
  /**
   * What happened to this iteration's EXECUTION, independent of `passed`.
   *
   * Always set on a terminal iteration: `completed` once the iteration ran and
   * was graded (including when it graded FAILED — that is the server's verdict,
   * not an execution failure), `timed_out` when the iteration budget expired,
   * and `failed` when it threw and retries were exhausted.
   *
   * Optional only because `IterationResult` is also constructed by callers
   * outside this file; consumers that need a status use
   * `resolveIterationLifecycleStatus`, which keeps the legacy inference in one
   * named place instead of re-deriving a status from a verdict.
   */
  status?: IterationStatus;
  latencies: LatencyBreakdown[];
  tokens: { total: number; input: number; output: number };
  error?: string;
  retryCount?: number;
  /** The prompt results from this iteration */
  prompts?: PromptResult[];
  /**
   * Host snapshot captured at the END of this iteration's execution.
   * Populated when the executor exposes `getHostSnapshot()`. For
   * `HostRunner`, this matches the construction-time snapshot (immutable).
   * For `HostRuntime`, this captures the live `Host` state at iteration
   * end so per-iteration metadata stamping reflects what THIS iteration
   * ran with, not the global state at upload time. (Mid-iteration host
   * mutations between turns are not separately captured — that would
   * require threading the snapshot into `PromptResult`.)
   */
  hostSnapshot?: import("./host-config/public-types.js").HostJson;
  /**
   * Deterministic predicate verdicts, in authored order.
   *
   * @deprecated as the verdict source — `passed` is now derived from
   * {@link scores}. Still populated (from the same single evaluation that feeds
   * the scores, so the two cannot disagree) and still on the wire at
   * `metadata.predicates` for existing readers.
   */
  predicateResults?: PredicateResult[];
  /**
   * Local expected/actual tool-call verdict, when expectations were configured.
   *
   * @deprecated as the verdict source — see {@link predicateResults}.
   */
  toolMatch?: EvalToolCallMatchResult;
  /**
   * Every scorer's verdict for this iteration, in the contract's one shape.
   * THE verdict source: `passed` is derived from the gating rows here.
   */
  scores?: ScoreResult[];
}

/**
 * Result of running an EvalTest
 */
export interface EvalRunResult {
  iterations: number;
  successes: number;
  failures: number;
  results: boolean[];
  iterationDetails: IterationResult[];
  tokenUsage: {
    total: number;
    input: number;
    output: number;
    perIteration: { total: number; input: number; output: number }[];
  };
  latency: {
    e2e: LatencyStats;
    llm: LatencyStats;
    mcp: LatencyStats;
    perIteration: LatencyBreakdown[];
  };
  /**
   * The scorer definitions this run graded with, plus their hash.
   *
   * Carried locally (not only on the wire) so `evaluateGates` can join results
   * to their definitions — role and error policies live here, and results alone
   * cannot tell a gating failure from an advisory one.
   */
  evaluationConfig?: EvaluationConfigSnapshot;
}

const ITERATION_ABORT_GRACE_MS = 1000;

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeAbortSignals(
  first?: AbortSignal,
  second?: AbortSignal
): AbortSignal | undefined {
  if (!first) {
    return second;
  }

  if (!second) {
    return first;
  }

  if (first.aborted) {
    return AbortSignal.abort(first.reason);
  }

  if (second.aborted) {
    return AbortSignal.abort(second.reason);
  }

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    cleanup();
    controller.abort(signal.reason);
  };
  const onFirstAbort = () => abort(first);
  const onSecondAbort = () => abort(second);
  const cleanup = () => {
    first.removeEventListener("abort", onFirstAbort);
    second.removeEventListener("abort", onSecondAbort);
  };

  first.addEventListener("abort", onFirstAbort, { once: true });
  second.addEventListener("abort", onSecondAbort, { once: true });

  return controller.signal;
}

function collectPromptMetrics(
  promptResults: PromptResult[]
): Pick<IterationResult, "latencies" | "tokens" | "prompts"> {
  const latencies = promptResults.map((result) => result.getLatency());

  return {
    latencies:
      latencies.length > 0 ? latencies : [{ e2eMs: 0, llmMs: 0, mcpMs: 0 }],
    tokens: {
      total: promptResults.reduce(
        (sum, result) => sum + result.totalTokens(),
        0
      ),
      input: promptResults.reduce(
        (sum, result) => sum + result.inputTokens(),
        0
      ),
      output: promptResults.reduce(
        (sum, result) => sum + result.outputTokens(),
        0
      ),
    },
    prompts: promptResults,
  };
}

function wrapAgentWithAbortSignal(
  agent: HostExecutor,
  abortSignal: AbortSignal
): HostExecutor {
  return {
    run: (message, options) =>
      agent.run(message, {
        ...options,
        abortSignal: mergeAbortSignals(options?.abortSignal, abortSignal),
      }),
    withOptions: (options) =>
      wrapAgentWithAbortSignal(agent.withOptions(options), abortSignal),
    getPromptHistory: () => agent.getPromptHistory(),
    resetPromptHistory: () => agent.resetPromptHistory(),
    // Forward host-introspection methods so per-iteration metadata
    // stamping can capture the live snapshot from a HostRuntime clone.
    getHostSnapshot: agent.getHostSnapshot
      ? () => agent.getHostSnapshot!()
      : undefined,
    getServerReplayConfigs: agent.getServerReplayConfigs
      ? () => agent.getServerReplayConfigs!()
      : undefined,
  };
}

/**
 * EvalTest - Runs a single test scenario with iterations
 *
 * Can be run standalone or as part of an EvalSuite.
 *
 * @example
 * ```ts
 * const test = new EvalTest({
 *   id: "c_addition",
 *   name: "addition",
 *   test: async (executor) => {
 *     const result = await executor.run("Add 2+3");
 *     return result.hasToolCall("add");
 *   },
 * });
 * await test.run(executor, { iterations: 30 });
 * console.log(test.accuracy()); // 0.97
 * ```
 */
export class EvalTest {
  private config: EvalTestConfig;
  private lastRunResult: EvalRunResult | null = null;
  private lastEvaluationConfig: EvaluationConfigSnapshot | null = null;

  constructor(config: EvalTestConfig) {
    if (!config.test) {
      throw new Error("Invalid config: must provide 'test' function");
    }
    // Normalize `externalCaseId` ONCE, here, so exactly one value is in play
    // for the rest of this object's life. The hosted key is derived from the
    // trimmed value (`external:` + `externalCaseId.trim()`), so a padded
    // config carried two spellings of one identity: the padded one on the
    // wire and in the `[id]` grep suffix, the trimmed one as the actual join
    // key. Whitespace-only is dropped rather than kept, matching the backend,
    // which treats an empty trimmed value as no external id at all.
    if (config.externalCaseId !== undefined) {
      const trimmed = config.externalCaseId.trim();
      if (trimmed !== config.externalCaseId) {
        const rest = { ...config };
        if (trimmed) {
          rest.externalCaseId = trimmed;
        } else {
          delete rest.externalCaseId;
        }
        config = rest;
      }
    }
    // Intent is authored metadata, normalized once at the authoring boundary
    // just like the hosted external id above. Absence stays absent locally;
    // the reporting identity sends an explicit null so the wire can preserve
    // the unlabelled slice.
    if (config.intent !== undefined) {
      const intent = normalizeIntent(config.intent);
      const rest = { ...config };
      if (intent === undefined) {
        delete rest.intent;
      } else {
        rest.intent = caseIntentSchema.parse(intent);
      }
      config = rest;
    }
    assertDeclaredCaseId(config);
    // After `assertDeclaredCaseId`, so a config with an `externalCaseId` and
    // no `id` gets the missing-id error that already names `id := externalCaseId`
    // as the fix, rather than a conflict error about a field it never set.
    assertSingleCaseIdentity(config);
    assertValidMatchOptions(config.matchOptions ?? {});
    assertLocallyEvaluablePredicates(config.predicates);
    // A negative case asserts "no tool was called", so `evaluateToolCalls`
    // returns before it ever reads `expected`. Declaring expectations here is
    // therefore a config that grades NOTHING — caught at construction rather
    // than left to look like it is being enforced.
    if (config.isNegativeTest && (config.expectedToolCalls?.length ?? 0) > 0) {
      throw new Error(
        `Test "${config.name}" is a negative test (passes only when NO tool ` +
          `is called) but also declares expectedToolCalls, which the matcher ` +
          `never reads. Drop one of the two.`
      );
    }
    this.config = config;
  }

  /**
   * Run this test with the given executor and options.
   */
  async run(
    executor: HostExecutor,
    options: EvalTestRunOptions
  ): Promise<EvalRunResult> {
    // Internal alias kept short so the iteration loop reads cleanly; the
    // public-facing parameter name is `executor`.
    const agent = executor;
    posthog.capture({
      distinctId: "anonymous",
      event: "eval_test_run_triggered",
      properties: {
        iterations: options.iterations,
        concurrency: options.concurrency ?? 5,
      },
    });
    const concurrency = options.concurrency ?? 5;
    const retries = options.retries ?? 0;
    const timeoutMs = options.timeoutMs ?? 30000;
    const onProgress = options.onProgress;

    const semaphore = new Semaphore(concurrency);
    let completedCount = 0;

    const testFn = this.config.test;
    const iterationResults: IterationResult[] = [];
    const total = options.iterations;
    // One snapshot per run: scorer definitions are configuration, not per-
    // iteration state, and the hash must be stable across every iteration of
    // the run so the backend can fold ONE value into the run fingerprint.
    const evaluationConfig = this.buildEvaluationConfig();
    this.lastEvaluationConfig = evaluationConfig;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;
        let lastAttemptTimedOut = false;
        let iterationAgent: HostExecutor | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          const abortController = new AbortController();
          const timeoutError = new Error(
            `Operation timed out after ${timeoutMs}ms`
          );
          let timeoutTriggered = false;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          let hardTimeoutId: ReturnType<typeof setTimeout> | undefined;

          try {
            // Create a fresh agent clone for this iteration to avoid race conditions
            // when multiple iterations run concurrently
            iterationAgent = wrapAgentWithAbortSignal(
              agent.withOptions({}),
              abortController.signal
            );
            const hardTimeoutPromise = new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timeoutTriggered = true;
                abortController.abort(timeoutError);
                hardTimeoutId = setTimeout(
                  () => reject(timeoutError),
                  ITERATION_ABORT_GRACE_MS
                );
              }, timeoutMs);
            });
            const passed = await Promise.race([
              Promise.resolve().then(() => testFn(iterationAgent!)),
              hardTimeoutPromise,
            ]);
            // Disarm BEFORE scoring. The iteration timeout bounds the agent
            // run; scorers carry their own per-scorer bound. Leaving it armed
            // meant a slow judge could trip it and stamp "Operation timed out"
            // on a test that had already finished.
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
            }
            const promptResults = iterationAgent.getPromptHistory();
            const promptMetrics = collectPromptMetrics(promptResults);
            const predicates = this.config.predicates ?? [];
            const graded = await this.scoreIteration({
              promptResults,
              tokens: promptMetrics.tokens,
              legacy: { kind: "returned", passed },
              evaluationConfig,
              options,
            });
            // Per-iteration host snapshot: for HostRuntime this captures
            // the live Host state at iteration end, so the metadata
            // stamp reflects what THIS iteration ran with — not the
            // global state at upload time, which can drift if the user
            // mutates the bound Host between iterations.
            const iterationHostSnapshot = iterationAgent.getHostSnapshot?.();

            return {
              // Derived exclusively from the gating scores. The legacy
              // expression `passed && predicatePassed && toolMatch.passed` is
              // now one projection among several rather than the verdict — and
              // it is equivalent by construction, because `test()`,
              // `expectedToolCalls` and each predicate each contribute one
              // gating score of exactly that value.
              passed: graded.passed,
              // The iteration RAN. `graded.passed === false` is the server
              // under test failing its task, which is not an execution
              // failure — only the timeout stopped execution short. Bound to
              // the same condition that stamps the timeout error, so a test
              // that finished DESPITE a fired abort is not retroactively
              // reclassified as stopped.
              status: timeoutTriggered && !passed ? "timed_out" : "completed",
              ...promptMetrics,
              ...(timeoutTriggered && !passed
                ? { error: timeoutError.message }
                : {}),
              retryCount: attempt,
              hostSnapshot: iterationHostSnapshot,
              ...(predicates.length > 0
                ? { predicateResults: graded.predicateResults }
                : {}),
              ...(graded.toolMatch ? { toolMatch: graded.toolMatch } : {}),
              scores: graded.scores,
            };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            lastAttemptTimedOut = timeoutTriggered;

            if (attempt < retries) {
              await sleep(100 * Math.pow(2, attempt));
            }
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (hardTimeoutId) {
              clearTimeout(hardTimeoutId);
            }
          }
        }

        const failedPromptResults = iterationAgent?.getPromptHistory() ?? [];
        const promptMetrics = collectPromptMetrics(failedPromptResults);
        const iterationHostSnapshot = iterationAgent?.getHostSnapshot?.();
        // Evaluate against what the iteration ACTUALLY did before it failed,
        // not an empty transcript. A retry-exhausted iteration may well have
        // called tools, and reporting fabricated verdicts against zeroed
        // signals would put wrong reasons on the dashboard's check chips.
        //
        // Deterministic scorers still say something true about that partial
        // transcript; non-deterministic ones are SKIPPED, because a judge's
        // number over a truncated run means nothing. A gating judge skipped
        // here fails closed by default, which is the correct reading of "the
        // gate never ran".
        const graded = await this.scoreIteration({
          promptResults: failedPromptResults,
          tokens: promptMetrics.tokens,
          legacy: { kind: "threw", error: lastError ?? "iteration failed" },
          evaluationConfig,
          options,
          skipNonDeterministic: "iteration errored before scoring",
        });

        return {
          passed: false,
          // Retries are exhausted: the EXECUTION failed rather than the task
          // being graded down. `timed_out` when the last attempt was stopped by
          // the iteration budget — the same distinction the run-level verdict
          // policy draws when it decides which trials it could measure.
          status: lastAttemptTimedOut ? "timed_out" : "failed",
          ...promptMetrics,
          error: lastError,
          retryCount: retries,
          hostSnapshot: iterationHostSnapshot,
          ...(graded.predicateResults.length > 0
            ? { predicateResults: graded.predicateResults }
            : {}),
          ...(graded.toolMatch ? { toolMatch: graded.toolMatch } : {}),
          scores: graded.scores,
        };
      } finally {
        semaphore.release();
        const completed = ++completedCount;
        if (onProgress) {
          onProgress(completed, total);
        }
      }
    };

    const promises = Array.from({ length: options.iterations }, () =>
      runSingleIteration()
    );
    const results = await Promise.all(promises);
    iterationResults.push(...results);

    const runResult = this.aggregateResults(iterationResults, evaluationConfig);

    // Call onFailure callback if there are any failures
    if (options.onFailure && runResult.failures > 0) {
      options.onFailure(this.getFailureReport());
    }

    await this.autoSaveRunIfConfigured(runResult, options, agent);

    return runResult;
  }

  private async autoSaveRunIfConfigured(
    runResult: EvalRunResult,
    options: EvalTestRunOptions,
    executor: HostExecutor
  ): Promise<void> {
    const agent = executor;
    if (options.__suppressMcpjamAutoSave) {
      return;
    }

    const config = options.mcpjam;
    if (config?.enabled === false) {
      return;
    }

    const apiKey = config?.apiKey ?? process.env.MCPJAM_API_KEY;
    if (!apiKey) {
      return;
    }

    const hostSnapshot = executor.getHostSnapshot?.();
    const hostExtras = hostSnapshot
      ? buildHostSnapshotMetadata(
          hostSnapshot as unknown as Record<string, unknown>
        )
      : undefined;
    const results = this.buildEvalResultInputs(
      runResult.iterationDetails,
      config,
      hostExtras
    );
    if (results.length === 0) {
      return;
    }

    await reportEvalResultsSafely({
      suiteName: config?.suiteName ?? `EvalTest: ${this.getName()}`,
      suiteDescription: config?.suiteDescription,
      serverNames: config?.serverNames,
      serverReplayConfigs: resolveServerReplayConfigs({
        serverReplayConfigs: config?.serverReplayConfigs,
        serverNames: config?.serverNames,
        agent,
      }),
      notes: config?.notes,
      passCriteria: config?.passCriteria,
      externalRunId: config?.externalRunId,
      framework: config?.framework,
      ci: config?.ci,
      apiKey,
      baseUrl: config?.baseUrl,
      strict: config?.strict,
      // Joins the run fingerprint on the backend: same externalRunId with a
      // different evaluation config is a conflict, not a duplicate upload.
      ...(this.lastEvaluationConfig
        ? { evaluationConfigHash: this.lastEvaluationConfig.hash }
        : {}),
      results,
    });
  }

  /**
   * The versioned input every scorer grades against, built ONCE per iteration.
   *
   * The transcript is built from the FULL trace — messages *and* spans — not a
   * bare message list: `buildIterationTranscript` derives tool errors from the
   * trace's spans, so a message-only trace leaves `noToolErrors` with nothing
   * to inspect and it passes vacuously even when every tool call failed.
   */
  private buildScorerContext(
    promptResults: PromptResult[],
    tokens: { input: number; output: number; total: number }
  ): ScorerContextV1 {
    const traceMessages = traceMessagesFromPrompts(promptResults);
    const trace = iterationTraceFromPrompts(promptResults, traceMessages);
    const usage = {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      totalTokens: tokens.total,
    };
    return {
      version: 1,
      scenario: {
        title: this.getName(),
        // Populated so custom and judge scorers can see the case's polarity;
        // without it a judge grades a negative case as though it were positive.
        ...(this.config.isNegativeTest ? { isNegativeTest: true } : {}),
      },
      transcript: buildIterationTranscript({
        trace,
        toolCalls: actualToolCallsFromPrompts(promptResults),
        usage,
      }),
      trace: {
        messages: traceMessages,
        // `iterationTraceFromPrompts` returns the widest wire shape (a string
        // and a bare message array are both legal traces); only the object form
        // carries spans, and only spans are useful to a scorer.
        ...(trace &&
        typeof trace === "object" &&
        !Array.isArray(trace) &&
        trace.spans
          ? { spans: trace.spans }
          : {}),
      },
      ...(this.config.expectedOutput !== undefined
        ? { expectedOutput: this.config.expectedOutput }
        : {}),
      ...(this.config.expectedToolCalls
        ? { expectedToolCalls: this.config.expectedToolCalls }
        : {}),
      usage,
    };
  }

  /**
   * Deterministic predicate verdicts for one iteration, in authored order.
   *
   * Called EXACTLY ONCE per iteration. Its results feed both the compat
   * `predicateResults` field and the predicate score rows — one evaluation,
   * two projections — so the legacy view and the contract view are the same
   * verdict rendered twice rather than two independent judgements that could
   * drift.
   */
  private evaluateIterationPredicates(
    context: ScorerContextV1
  ): PredicateResult[] {
    const predicates = this.config.predicates ?? [];
    if (predicates.length === 0) return [];
    return evaluatePredicates(context.transcript, predicates);
  }

  /**
   * The local expected/actual verdict, or undefined when the case configured no
   * expectations.
   *
   * The emptiness guard is load-bearing: `evaluateToolCalls` reports
   * `passed: false` when a POSITIVE test observed no calls — including the
   * both-empty case — so running it unconditionally would fail every test that
   * never declared `expectedToolCalls`.
   */
  private evaluateIterationToolCalls(
    context: ScorerContextV1
  ): EvalToolCallMatchResult | undefined {
    const expected = this.config.expectedToolCalls ?? [];
    // The guard FLIPS for a negative case. "No expectations" means "nothing to
    // check" for a positive test, but a negative case with no expectations is
    // still asserting something — that no tool fired — so skipping the matcher
    // here would make the whole point of the case `not_applicable`.
    if (expected.length === 0 && !this.config.isNegativeTest) return undefined;
    return evaluateToolCalls(
      expected.map((toolCall) => ({
        toolName: toolCall.toolName,
        arguments: toolCall.arguments ?? {},
      })),
      context.transcript.toolCalls,
      {
        ...resolveMatchOptions(this.config.matchOptions),
        ...(this.config.isNegativeTest ? { isNegativeTest: true } : {}),
      }
    );
  }

  /**
   * This test's resolved, hashed scorer definitions.
   *
   * Exposed so corpus tooling can record the SAME evaluation config the run
   * will report, rather than re-deriving it. A second derivation is a drift
   * factory: the lock would claim a hash the run never produces, and every
   * `--frozen` check would report a config change that never happened.
   */
  getEvaluationConfigSnapshot(): EvaluationConfigSnapshot {
    return this.buildEvaluationConfig();
  }

  /**
   * The scorer definitions for this test, resolved and hashed once.
   *
   * `test()`, `expectedToolCalls` and each predicate are each projected into
   * one definition here, which is what makes scoring the single verdict path
   * rather than a fifth system running alongside them.
   *
   * The tool-match definition is emitted even when the test configured no
   * expectations: its row is `not_applicable`, and a row with no definition to
   * join to would be unrenderable and — per the gate engine's fail-closed join
   * — indistinguishable from tampering.
   */
  private buildEvaluationConfig(): EvaluationConfigSnapshot {
    // Built-in projections own these ids. A custom scorer that reuses one would
    // shadow the built-in in the id→definition map, so the built-in's row would
    // be minted against the WRONG definition — carrying a definitionHash that
    // joins to nothing, which fails the gate closed with no explanation the
    // author can act on. Naming the collision is the whole fix.
    const reserved = new Set([
      legacyTestScoreDefinition().scorerId,
      toolMatchScoreDefinition({
        expectedToolCalls: this.config.expectedToolCalls ?? [],
        matchOptions: resolveMatchOptions(this.config.matchOptions),
        isNegativeTest: this.config.isNegativeTest,
      }).scorerId,
      ...(this.config.predicates ?? []).map(
        (predicate, index) =>
          predicateScoreDefinition(predicate, { ordinal: index }).scorerId
      ),
    ]);
    for (const scorer of this.config.scorers ?? []) {
      if (reserved.has(scorer.definition.scorerId)) {
        throw new Error(
          `Scorer id "${scorer.definition.scorerId}" is already used by this ` +
            `test's built-in scorers (test(), expectedToolCalls, and each ` +
            `predicate each contribute one). Give the custom scorer a ` +
            `different id.`
        );
      }
    }

    const definitions = [
      legacyTestScoreDefinition(),
      toolMatchScoreDefinition({
        expectedToolCalls: this.config.expectedToolCalls ?? [],
        matchOptions: resolveMatchOptions(this.config.matchOptions),
        isNegativeTest: this.config.isNegativeTest,
      }),
      ...(this.config.predicates ?? []).map((predicate, index) =>
        predicateScoreDefinition(predicate, { ordinal: index })
      ),
      ...(this.config.scorers ?? []).map((scorer) => scorer.definition),
    ];
    return buildEvaluationConfigSnapshot(definitions);
  }

  /**
   * Grade one iteration and derive its verdict.
   *
   * Ordering mirrors the config: `test()`, then `expectedToolCalls`, then
   * predicates in authored order, then custom scorers — so the dashboard list
   * reads the way the test does.
   */
  private async scoreIteration(params: {
    promptResults: PromptResult[];
    tokens: { input: number; output: number; total: number };
    legacy:
      | { kind: "returned"; passed: boolean }
      | { kind: "threw"; error: unknown };
    evaluationConfig: EvaluationConfigSnapshot;
    options: EvalTestRunOptions;
    skipNonDeterministic?: string;
  }): Promise<{
    scores: ScoreResult[];
    predicateResults: PredicateResult[];
    toolMatch: EvalToolCallMatchResult | undefined;
    passed: boolean;
  }> {
    const context = this.buildScorerContext(
      params.promptResults,
      params.tokens
    );
    const definitions = params.evaluationConfig.definitions;
    const byId = new Map(
      definitions.map((definition) => [definition.scorerId, definition])
    );
    const definitionFor = (scorerId: string): ResolvedScoreDefinition => {
      const definition = byId.get(scorerId);
      if (!definition) {
        // Unreachable: `buildEvaluationConfig` emits one definition per source.
        // Loud rather than silent — a missing definition would make its score
        // unjoinable, and an unjoinable score fails the gate closed.
        throw new Error(`No score definition registered for "${scorerId}"`);
      }
      return definition;
    };

    const scores: ScoreResult[] = [];

    // 1. test()
    const legacyDefinition = definitionFor(
      legacyTestScoreDefinition().scorerId
    );
    scores.push(
      params.legacy.kind === "returned"
        ? fromLegacyTestOutcome(legacyDefinition, params.legacy.passed)
        : // A thrown/timed-out test is an ERROR, not a `false`. It still fails
          // the iteration (gating, onError "fail"), but the row says why.
          errorScoreResult(legacyDefinition, params.legacy.error)
    );

    // 2. expectedToolCalls — ONE evaluation, two projections.
    const toolMatchDefinition = definitionFor(
      toolMatchScoreDefinition({
        expectedToolCalls: this.config.expectedToolCalls ?? [],
        matchOptions: resolveMatchOptions(this.config.matchOptions),
        isNegativeTest: this.config.isNegativeTest,
      }).scorerId
    );
    const toolMatch = this.evaluateIterationToolCalls(context);
    scores.push(
      toolMatch
        ? fromToolMatchResult(toolMatchDefinition, toolMatch)
        : notApplicableScoreResult(
            toolMatchDefinition,
            "no expected tool calls were configured"
          )
    );

    // 3. predicates — ONE evaluation, two projections.
    const predicateResults = this.evaluateIterationPredicates(context);
    predicateResults.forEach((result, index) => {
      const predicate = (this.config.predicates ?? [])[index];
      if (!predicate) return;
      scores.push(
        scoreResultFromPredicateResult(
          definitionFor(
            predicateScoreDefinition(predicate, { ordinal: index }).scorerId
          ),
          result
        )
      );
    });

    // 4. custom scorers, under the runner's bounds.
    const custom = this.config.scorers ?? [];
    if (custom.length > 0) {
      scores.push(
        ...(await runScorers(custom, context, {
          concurrency: params.options.scorerConcurrency,
          timeoutMs: params.options.scorerTimeoutMs,
          ...(params.skipNonDeterministic
            ? { skipNonDeterministicReason: params.skipNonDeterministic }
            : {}),
        }))
      );
    }

    return {
      scores,
      predicateResults,
      toolMatch,
      passed: scoresPassed(scores, definitions),
    };
  }

  private buildEvalResultInputs(
    iterations: IterationResult[],
    reporting?: MCPJamReportingConfig,
    hostExtras?: Record<string, string | number | boolean>
  ): EvalResultInput[] {
    return iterationsToEvalResultInputs(
      this.getName(),
      iterations,
      this.config.expectedToolCalls,
      reporting?.failOnToolError,
      hostExtras,
      this.config.predicates,
      this.config.matchOptions,
      this.lastEvaluationConfig ?? undefined,
      {
        // The standalone-run twin of `EvalSuite`'s identity object. A test run
        // directly with reporting enabled uploads through HERE, not through the
        // suite, so leaving `caseId` off this one would mean a renamed
        // standalone test still forks its hosted history — the exact bug the
        // declared id exists to retire, surviving on the path nobody looked at.
        caseId: this.config.id,
        // `null`, not omission, says this case is deliberately unlabelled on
        // the result wire. Omission is reserved for pre-intent reporters.
        intent: this.config.intent ?? null,
        ...(this.config.externalCaseId !== undefined
          ? { externalCaseId: this.config.externalCaseId }
          : {}),
        ...(this.config.isNegativeTest !== undefined
          ? { isNegativeTest: this.config.isNegativeTest }
          : {}),
        ...(this.config.expectedOutput !== undefined
          ? { expectedOutput: this.config.expectedOutput }
          : {}),
      }
    );
  }

  private aggregateResults(
    iterations: IterationResult[],
    evaluationConfig?: EvaluationConfigSnapshot
  ): EvalRunResult {
    const allLatencies = iterations.flatMap((r) => r.latencies);

    // Handle empty latencies array
    const defaultStats: LatencyStats = {
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      count: 0,
    };

    const e2eValues = allLatencies.map((l) => l.e2eMs);
    const llmValues = allLatencies.map((l) => l.llmMs);
    const mcpValues = allLatencies.map((l) => l.mcpMs);

    const successes = iterations.filter((r) => r.passed).length;
    const failures = iterations.filter((r) => !r.passed).length;

    this.lastRunResult = {
      iterations: iterations.length,
      successes,
      failures,
      results: iterations.map((r) => r.passed),
      iterationDetails: iterations,
      tokenUsage: {
        total: iterations.reduce((sum, r) => sum + r.tokens.total, 0),
        input: iterations.reduce((sum, r) => sum + r.tokens.input, 0),
        output: iterations.reduce((sum, r) => sum + r.tokens.output, 0),
        perIteration: iterations.map((r) => r.tokens),
      },
      latency: {
        e2e:
          e2eValues.length > 0
            ? calculateLatencyStats(e2eValues)
            : defaultStats,
        llm:
          llmValues.length > 0
            ? calculateLatencyStats(llmValues)
            : defaultStats,
        mcp:
          mcpValues.length > 0
            ? calculateLatencyStats(mcpValues)
            : defaultStats,
        perIteration: allLatencies,
      },
      ...(evaluationConfig ? { evaluationConfig } : {}),
    };

    return this.lastRunResult;
  }

  /**
   * Get the accuracy of the last run (success rate)
   */
  accuracy(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.iterations === 0
      ? 0
      : this.lastRunResult.successes / this.lastRunResult.iterations;
  }

  /**
   * Get the recall (true positive rate) of the last run
   */
  recall(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const { tp, fn } = this.toolCounts();
    return tp + fn === 0 ? 0 : tp / (tp + fn);
  }

  /**
   * Get the precision of the last run
   */
  precision(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const { tp, fp } = this.toolCounts();
    return tp + fp === 0 ? 0 : tp / (tp + fp);
  }

  /**
   * Get the true positive rate (same as recall)
   */
  truePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.recall();
  }

  /** @deprecated Use unexpectedToolCallRate(). */
  falsePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // Preserve the legacy failure-rate value for tests that never configured
    // expectedToolCalls; expectation-bearing runs use the honest extra-call
    // definition below.
    if (!this.config.expectedToolCalls?.length) {
      return this.lastRunResult.iterations === 0
        ? 0
        : this.lastRunResult.failures / this.lastRunResult.iterations;
    }
    return this.unexpectedToolCallRate();
  }

  /**
   * Rate of iterations that violated a forbidden-tool predicate. This keeps
   * false-positive semantics distinct from ordinary test failures; when no
   * such predicate is configured the denominator is still the run size and
   * the metric is zero.
   */
  unexpectedToolCallRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    if (this.lastRunResult.iterations === 0) return 0;
    const expectationIterations = this.lastRunResult.iterationDetails.filter(
      (iteration) => iteration.toolMatch
    );
    if (expectationIterations.length === 0) return 0;
    return (
      expectationIterations.filter(
        (iteration) => (iteration.toolMatch?.extra.length ?? 0) > 0
      ).length / expectationIterations.length
    );
  }

  private toolCounts(): { tp: number; fp: number; fn: number } {
    if (!this.config.expectedToolCalls?.length) {
      throw new Error("precision() requires expectedToolCalls");
    }
    const matches = this.lastRunResult!.iterationDetails.map(
      (iteration) => iteration.toolMatch
    ).filter((match): match is EvalToolCallMatchResult => Boolean(match));
    if (matches.length === 0) {
      throw new Error("precision() requires expectedToolCalls");
    }
    return matches.reduce(
      (totals, match) => {
        const mismatches = match.argumentMismatches.length;
        const tp = Math.max(
          0,
          this.config.expectedToolCalls!.length -
            match.missing.length -
            mismatches
        );
        return {
          tp: totals.tp + tp,
          fp: totals.fp + match.extra.length + mismatches,
          fn: totals.fn + match.missing.length + mismatches,
        };
      },
      { tp: 0, fp: 0, fn: 0 }
    );
  }

  /**
   * Get the average token use per iteration
   */
  averageTokenUse(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    if (this.lastRunResult.iterations === 0) {
      return 0;
    }
    return this.lastRunResult.tokenUsage.total / this.lastRunResult.iterations;
  }

  /**
   * Get the full results of the last run
   */
  getResults(): EvalRunResult | null {
    return this.lastRunResult;
  }

  /**
   * Get the name of this test
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * This case's declared identity.
   *
   * Read this — never `getName()` — when joining a case to anything that
   * outlives one run.
   */
  getId(): string {
    return this.config.id;
  }

  /**
   * Get the configuration of this test
   */
  getConfig(): EvalTestConfig {
    return this.config;
  }

  /** @internal Apply a suite-level matcher default without overriding a case. */
  setDefaultMatchOptions(matchOptions: EvalMatchOptions | undefined): void {
    if (this.config.matchOptions !== undefined || matchOptions === undefined) {
      return;
    }
    assertValidMatchOptions(matchOptions);
    this.config = { ...this.config, matchOptions };
  }

  /**
   * Get all iteration details from the last run
   */
  getAllIterations(): IterationResult[] {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return [...this.lastRunResult.iterationDetails];
  }

  /**
   * Get only the failed iterations from the last run
   */
  getFailedIterations(): IterationResult[] {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.iterationDetails.filter((r) => !r.passed);
  }

  /**
   * Get only the successful iterations from the last run
   */
  getSuccessfulIterations(): IterationResult[] {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.iterationDetails.filter((r) => r.passed);
  }

  /**
   * Get a failure report with traces from all failed iterations.
   * Useful for debugging why evaluations failed.
   *
   * @returns A formatted string with failure details
   */
  getFailureReport(): string {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }

    const failedIterations = this.getFailedIterations();
    if (failedIterations.length === 0) {
      return "No failures.";
    }

    const reports = failedIterations.map((iteration, index) => {
      const header = `=== Failed Iteration ${index + 1}/${
        failedIterations.length
      } ===`;
      const error = iteration.error ? `Error: ${iteration.error}` : "";
      const traces = (iteration.prompts ?? [])
        .map((p, i) => `--- Prompt ${i + 1} ---\n${p.formatTrace()}`)
        .join("\n\n");

      return [header, error, traces].filter(Boolean).join("\n");
    });

    return reports.join("\n\n");
  }
}
