import {
  createSavedClientRunner,
  type EvalSuiteClientOptions,
} from "./saved-client-runner.js";
export type { EvalSuiteClientOptions } from "./saved-client-runner.js";
import { composeAbortSignals } from "./compose-abort-signals.js";
import { formatRunSummaryTable } from "./eval-summary.js";
import type { EvalSelectionManifest } from "./eval-selection.js";
import { canonicalJson, sha256Hex } from "./contract/canonical.js";
import type { HostExecutor } from "./HostExecutor.js";
import type { AnyEvaluator } from "./evaluators/types.js";
import { prepareReportingConfig } from "./eval-reporting-config.js";
import type { LatencyBreakdown } from "./types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import type {
  EvalReportingReceipt,
  EvalExpectedToolCall,
  EvalResultInput,
  MCPJamReportingConfig,
} from "./eval-reporting-types.js";
import { EvalTest } from "./EvalTest.js";
import type {
  EvalTestRunOptions,
  EvalRunResult,
  IterationResult,
} from "./EvalTest.js";
import {
  captureEvalReporting,
  notRequestedReceipt,
} from "./eval-reporting-receipt.js";
import { McpjamModelLeaseScope } from "./mcpjam-model-lease.js";
import {
  suiteTestResultsToEvalResultInputs,
  variantFromExecutor,
} from "./eval-result-mapping.js";
import { aggregateEvaluationConfigHash } from "./contract/derive.js";
import { resolveServerReplayConfigs } from "./server-replay-configs.js";
import { buildHostSnapshotMetadata } from "./host-config/internal.js";
import type { EvalToolCallMatchResult } from "./matchers.js";
import { assertValidMatchOptions, type EvalMatchOptions } from "./matchers.js";

/**
 * Configuration for an EvalSuite
 */
export interface EvalSuiteConfig {
  name?: string;
  defaults?: { iterations?: number; evaluators?: readonly AnyEvaluator[] };
  mcpjam?: MCPJamReportingConfig;
  /** Default matcher policy for expectation-bearing tests in this suite. */
  matchOptions?: EvalMatchOptions;
}

/**
 * Result for a single test within the suite
 */
export interface TestResult {
  name: string;
  result: EvalRunResult;
}

/**
 * Result of running an EvalSuite
 */
export interface EvalSuiteResult {
  selection?: EvalSelectionManifest;
  runEvaluationsByCase?: Record<
    string,
    import("./run-evaluators.js").CaseRunEvaluation
  >;
  tests: Map<string, EvalRunResult>;
  aggregate: {
    iterations: number;
    successes: number;
    failures: number;
    accuracy: number;
    tokenUsage: {
      total: number;
      perTest: number[];
    };
    latency: {
      e2e: LatencyStats;
      llm: LatencyStats;
      mcp: LatencyStats;
    };
  };
}

/**
 * EvalSuite - Groups multiple EvalTests and provides aggregate metrics
 *
 * @example
 * ```ts
 * const suite = new EvalSuite({ name: "Math" });
 * suite.add(new EvalTest({
 *   id: "c_addition",
 *   name: "addition",
 *   test: async (executor) => {
 *     const r = await executor.run("Add 2+3");
 *     return r.hasToolCall("add");
 *   },
 * }));
 * suite.add(new EvalTest({
 *   id: "c_multiply",
 *   name: "multiply",
 *   test: async (executor) => {
 *     const r = await executor.run("Multiply 4*5");
 *     return r.hasToolCall("multiply");
 *   },
 * }));
 *
 * await suite.run(executor, { iterations: 30 });
 * console.log(suite.accuracy());                 // Aggregate: 0.95
 * console.log(suite.get("addition").accuracy()); // Individual: 0.97
 * ```
 */
export class EvalSuite {
  private running = false;
  private name: string;
  private sourceCases?: EvalTest[];
  private lastSelection?: EvalSelectionManifest;
  private mcpjamConfig?: MCPJamReportingConfig;
  private matchOptions?: EvalMatchOptions;
  private defaults: NonNullable<EvalSuiteConfig["defaults"]>;
  private tests: Map<string, EvalTest> = new Map();
  private lastReportingReceipt: EvalReportingReceipt =
    notRequestedReceipt("disabled");

  getLastReport() {
    return this.lastReportingReceipt.report
      ? structuredClone(this.lastReportingReceipt.report)
      : null;
  }

  getReportingReceipt(): EvalReportingReceipt {
    return structuredClone(this.lastReportingReceipt);
  }

  private lastRunResult: EvalSuiteResult | null = null;

  constructor(config?: EvalSuiteConfig) {
    this.defaults = {
      ...config?.defaults,
      evaluators: [...(config?.defaults?.evaluators ?? [])],
    };
    if (
      this.defaults.iterations !== undefined &&
      (!Number.isSafeInteger(this.defaults.iterations) ||
        this.defaults.iterations < 1)
    )
      throw new TypeError("defaults.iterations must be a positive integer");
    this.name = config?.name ?? "EvalSuite";
    this.mcpjamConfig = config?.mcpjam;
    this.matchOptions =
      config?.matchOptions === undefined
        ? undefined
        : structuredClone(config.matchOptions);
    assertValidMatchOptions(this.matchOptions ?? {});
  }

  /**
   * Add a test to the suite.
   *
   * Duplicate IDS are rejected for the same reason duplicate names always were,
   * only more so: the suite keys results by name, but everything that outlives
   * the run — hosted history, a lock file, a report row — joins on the declared
   * id. Two cases sharing one id do not collide visibly; they silently merge
   * into one case's history.
   */
  add(test: EvalTest): void {
    if (this.running)
      throw new Error("Cannot add cases while the suite is running");
    const name = test.getName();
    if (this.tests.has(name)) {
      throw new Error(`Test with name "${name}" already exists in suite`);
    }
    const id = test.getId();
    for (const existing of this.tests.values()) {
      if (existing.getId() === id) {
        throw new Error(
          `Test with id "${id}" already exists in suite (as ` +
            `"${existing.getName()}"). A case id is its identity — give this ` +
            `one its own.`
        );
      }
    }
    test.setDefaultMatchOptions(this.matchOptions);
    test.setDefaultEvaluators(this.defaults.evaluators ?? []);
    this.tests.set(name, test);
  }

  /** Select declared case IDs. The source suite and its cases remain unchanged. */
  subset(caseIds: readonly string[]): EvalSuite {
    const wanted = new Set(caseIds);
    if (wanted.size !== caseIds.length)
      throw new TypeError("Duplicate selected case ID");
    const available = new Map(
      this.getAll().map((test) => [test.getId(), test])
    );
    for (const id of wanted)
      if (!available.has(id))
        throw new TypeError(`Unknown selected case ID: ${id}`);
    const selected = new EvalSuite({
      name: this.name,
      defaults: this.defaults,
      mcpjam: this.mcpjamConfig,
      matchOptions: this.matchOptions,
    });
    selected.sourceCases = (this.sourceCases ?? this.getAll()).map(
      (test) =>
        new EvalTest(test.getConfig(), { evaluators: this.defaults.evaluators })
    );
    for (const test of this.getAll())
      if (wanted.has(test.getId()))
        selected.add(new EvalTest(test.getConfig()));
    return selected;
  }

  getSelectionManifest(): EvalSelectionManifest | undefined {
    return this.lastSelection ? structuredClone(this.lastSelection) : undefined;
  }

  private freezeSelection(iterations: number): EvalSelectionManifest {
    const source = this.sourceCases ?? this.getAll();
    const selected = new Set(this.getAll().map((test) => test.getId()));
    const fingerprint = (tests: EvalTest[]) =>
      sha256Hex(
        canonicalJson(
          tests
            .map((test) => ({
              id: test.getId(),
              name: test.getName(),
              evaluationConfig: test.getEvaluationConfigSnapshot().hash,
              expectedToolCalls: test.getConfig().expectedToolCalls ?? null,
              expectedOutput: test.getConfig().expectedOutput ?? null,
              intent: test.getConfig().intent ?? null,
              negative: test.getConfig().isNegativeTest ?? false,
              matchOptions: test.getConfig().matchOptions ?? null,
              iterations,
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
        )
      );
    return {
      schemaVersion: 1,
      sourceSuite: this.name,
      sourceCaseIds: source.map((test) => test.getId()),
      selectedCaseIds: [...selected],
      cases: source.map((test) => ({
        caseId: test.getId(),
        plannedIterations: selected.has(test.getId()) ? iterations : 0,
        ...(!selected.has(test.getId())
          ? { excludedReason: "not_selected" as const }
          : {}),
      })),
      sourceConfigHash: fingerprint(source),
      selectedConfigHash: fingerprint(this.getAll()),
      scope: selected.size === source.length ? "full" : "selected",
    };
  }

  /**
   * Get a test by name
   */
  get(name: string): EvalTest | undefined {
    return this.tests.get(name);
  }

  /**
   * Get all tests in the suite
   */
  getAll(): EvalTest[] {
    return Array.from(this.tests.values());
  }

  /**
   * Resolve the latest saved client once, then run against its frozen settings.
   */
  async runWithClient(
    client: EvalSuiteClientOptions,
    options: Omit<EvalTestRunOptions, "iterations"> & {
      iterations?: number;
    } = {}
  ): Promise<EvalSuiteResult> {
    const selection = {
      ...client,
      baseUrl:
        client.baseUrl ?? options.mcpjam?.baseUrl ?? this.mcpjamConfig?.baseUrl,
    };
    return this.runPrepared(async (signal) => {
      const resolved = await createSavedClientRunner(selection, signal);
      return {
        executor: resolved.executor,
        reporting: {
          ...(options.mcpjam ?? this.mcpjamConfig),
          apiKey: selection.apiKey,
          project: selection.projectId,
          baseUrl: selection.baseUrl,
          selectedClient: resolved.selectedClient,
        },
      };
    }, options);
  }

  async run(
    executor: HostExecutor,
    options: Omit<EvalTestRunOptions, "iterations"> & {
      iterations?: number;
    } = {}
  ): Promise<EvalSuiteResult> {
    return this.runPrepared(executor, options);
  }

  private async runPrepared(
    source:
      | HostExecutor
      | ((signal: AbortSignal) => Promise<{
          executor: HostExecutor;
          reporting: MCPJamReportingConfig;
        }>),
    options: Omit<EvalTestRunOptions, "iterations"> & {
      iterations?: number;
    } = {}
  ): Promise<EvalSuiteResult> {
    if (this.running)
      throw new Error(
        "This EvalSuite is already running; create a separate suite for concurrent runs"
      );
    if (
      options.runTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.runTimeoutMs) ||
        options.runTimeoutMs < 1 ||
        options.runTimeoutMs > 2_147_483_647)
    )
      throw new TypeError(
        "runTimeoutMs must be a positive timer-sized integer"
      );
    this.validateRunOptions(options);
    this.running = true;
    const leaseScope = new McpjamModelLeaseScope();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispose: (() => void) | undefined;
    try {
      const controller = new AbortController();
      if (options.runTimeoutMs !== undefined)
        timer = setTimeout(
          () => controller.abort(new Error("Suite deadline exceeded")),
          options.runTimeoutMs
        );
      let reporting = options.mcpjam ?? this.mcpjamConfig;
      const composed = composeAbortSignals(
        [controller.signal, options.signal].filter(
          (signal): signal is AbortSignal => !!signal
        )
      );
      dispose = composed.dispose;
      const signal = composed.signal;
      let executor: HostExecutor;
      if (typeof source === "function") {
        signal.throwIfAborted();
        const prepared = await source(signal);
        reporting = prepared.reporting;
        executor = prepared.executor;
        signal.throwIfAborted();
      } else {
        executor = source;
      }
      return await this.runInternal(
        executor.withOptions({ mcpjamLeaseScope: leaseScope }),
        {
          ...options,
          signal,
          // Execution cancellation must still allow its evidence to be persisted.
          // Only an explicitly authored transport signal cancels reporting.
          mcpjam: reporting,
        }
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      dispose?.();
      this.running = false;
      await leaseScope.release();
    }
  }

  private validateRunOptions(
    options: Omit<EvalTestRunOptions, "iterations"> & { iterations?: number }
  ): void {
    const iterations = options.iterations ?? this.defaults.iterations;
    if (!Number.isSafeInteger(iterations) || iterations! < 1)
      throw new TypeError(
        "iterations must be a positive integer (or configure suite defaults.iterations)"
      );
    for (const [key, value] of Object.entries({
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      runTimeoutMs: options.runTimeoutMs,
      scorerConcurrency: options.scorerConcurrency,
      scorerTimeoutMs: options.scorerTimeoutMs,
      evaluatorConcurrency: options.evaluatorConcurrency,
      evaluatorTimeoutMs: options.evaluatorTimeoutMs,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new TypeError(`${key} must be a positive integer`);
    }
    if (
      options.retries !== undefined &&
      (!Number.isSafeInteger(options.retries) || options.retries < 0)
    )
      throw new TypeError("retries must be a non-negative integer");
    if (
      options.evaluatorConcurrency !== undefined &&
      options.scorerConcurrency !== undefined
    )
      throw new TypeError(
        "Choose evaluatorConcurrency or scorerConcurrency, not both"
      );
    if (
      options.evaluatorTimeoutMs !== undefined &&
      options.scorerTimeoutMs !== undefined
    )
      throw new TypeError(
        "Choose evaluatorTimeoutMs or scorerTimeoutMs, not both"
      );
  }

  private async runInternal(
    executor: HostExecutor,
    options: Omit<EvalTestRunOptions, "iterations"> & {
      iterations?: number;
    } = {}
  ): Promise<EvalSuiteResult> {
    this.lastReportingReceipt = notRequestedReceipt("disabled");
    const iterations = options.iterations ?? this.defaults.iterations;
    this.lastSelection = this.freezeSelection(iterations!);
    const plannedIterations = this.tests.size * iterations!;
    const suiteReportingConfig = await prepareReportingConfig(
      options.mcpjam ?? this.mcpjamConfig ?? {}
    );
    if (
      suiteReportingConfig.expectedIterations !== undefined &&
      suiteReportingConfig.expectedIterations !== plannedIterations
    )
      throw new TypeError(
        "expectedIterations must match the suite execution plan"
      );
    suiteReportingConfig.expectedIterations = plannedIterations;
    if (
      this.lastSelection.scope === "selected" &&
      suiteReportingConfig.enabled !== false &&
      (suiteReportingConfig.apiKey ?? process.env.MCPJAM_API_KEY)
    )
      throw new Error(
        "Hosted subset reporting requires persisted selection support; use mcpjam.enabled=false for a local selected-scope run"
      );
    const testResults = new Map<string, EvalRunResult>();

    // Track total progress across all tests
    const totalIterations = plannedIterations;
    let completedIterations = 0;

    // Run each test sequentially to avoid overwhelming the system
    for (const [name, test] of this.tests) {
      const testOptions: EvalTestRunOptions = {
        ...options,
        iterations: iterations!,
        mcpjam: suiteReportingConfig
          ? {
              ...suiteReportingConfig,
              enabled: false,
            }
          : undefined,
        __suppressMcpjamAutoSave: true,
        onProgress: options.onProgress
          ? (completed, _total) => {
              // Calculate overall progress
              const overallCompleted = completedIterations + completed;
              return options.onProgress!(overallCompleted, totalIterations);
            }
          : undefined,
      };

      const result = await test.run(executor, testOptions);
      testResults.set(name, result);
      completedIterations += iterations!;
    }

    // Aggregate results
    this.lastRunResult = {
      ...this.aggregateResults(testResults),
      selection: structuredClone(this.lastSelection),
    };
    const runEvaluationsByCase = Object.fromEntries(
      [...this.tests].flatMap(([name, test]) => {
        const envelope = testResults.get(name)?.runEvaluation;
        return envelope ? [[test.getId(), envelope]] : [];
      })
    );
    if (Object.keys(runEvaluationsByCase).length)
      this.lastRunResult.runEvaluationsByCase = runEvaluationsByCase;
    try {
      await this.autoSaveSuiteRunIfConfigured(
        testResults,
        suiteReportingConfig,
        executor
      );
    } finally {
      if (options.summary === "table") {
        try {
          console.log(
            formatRunSummaryTable(this.lastRunResult, this.lastReportingReceipt)
          );
        } catch {
          /* Formatting is observational. */
        }
      }
    }
    return this.lastRunResult;
  }

  private async autoSaveSuiteRunIfConfigured(
    testResults: Map<string, EvalRunResult>,
    config: MCPJamReportingConfig | undefined,
    executor: HostExecutor
  ): Promise<void> {
    if (config?.enabled === false) {
      return;
    }
    const apiKey = config?.apiKey ?? process.env.MCPJAM_API_KEY;
    if (!apiKey?.trim()) {
      this.lastReportingReceipt = notRequestedReceipt("missing_api_key");
      if (config?.strict) {
        const error = new Error("Strict eval reporting requires an API key");
        this.lastReportingReceipt = {
          schemaVersion: 1,
          state: "failed",
          acceptedIterations: 0,
          acknowledgedIterations: 0,
          pendingIterations: 0,
          error: { code: "MISSING_API_KEY", message: error.message },
        };
        throw error;
      }
      return;
    }

    const hostSnapshot = executor.getHostSnapshot?.();
    const hostExtras = hostSnapshot
      ? buildHostSnapshotMetadata(
          hostSnapshot as unknown as Record<string, unknown>
        )
      : undefined;
    const results = this.buildEvalResultInputs(
      testResults,
      config,
      hostExtras,
      variantFromExecutor(executor)
    );
    if (results.length === 0) {
      return;
    }

    this.lastReportingReceipt = {
      schemaVersion: 1,
      state: "pending",
      acceptedIterations: results.length,
      acknowledgedIterations: 0,
      pendingIterations: results.length,
    };
    const reporting = await captureEvalReporting({
      ...config,
      executor,
      runEvaluations: this.lastRunResult?.runEvaluationsByCase
        ? Object.values(this.lastRunResult.runEvaluationsByCase)
        : undefined,
      expectedIterations:
        config?.expectedIterations ??
        Array.from(testResults.values()).reduce(
          (count, result) => count + result.iterations,
          0
        ),
      suiteName: config?.suiteName ?? this.name,
      suiteDescription: config?.suiteDescription,
      serverNames: config?.serverNames,
      serverReplayConfigs: resolveServerReplayConfigs({
        serverReplayConfigs: config?.serverReplayConfigs,
        serverNames: config?.serverNames,
        agent: executor,
      }),
      notes: config?.notes,
      passCriteria: config?.passCriteria,
      externalRunId: config?.externalRunId,
      framework: config?.framework,
      ci: config?.ci,
      apiKey,
      baseUrl: config?.baseUrl,
      strict: config?.strict,
      // One fingerprint for a run that graded each case with its own scorer
      // set; see `aggregateEvaluationConfigHash`.
      ...(() => {
        const hashes = Array.from(testResults.values())
          .map((result) => result.evaluationConfig?.hash)
          .filter((hash): hash is string => Boolean(hash));
        return hashes.length > 0
          ? { evaluationConfigHash: aggregateEvaluationConfigHash(hashes) }
          : {};
      })(),
      results,
    });
    this.lastReportingReceipt = reporting.receipt;
    if (reporting.receipt.state === "failed" && config?.strict)
      throw reporting.error;
  }

  private buildEvalResultInputs(
    testResults: Map<string, EvalRunResult>,
    reporting?: MCPJamReportingConfig,
    hostExtras?: Record<string, string | number | boolean>,
    variant?: { provider?: string; model?: string }
  ): EvalResultInput[] {
    // Null prototype on ALL FOUR of these: they are keyed by test NAME in the
    // same loop, so a test called `__proto__` would run the prototype setter
    // instead of creating an own property and vanish from every one of them.
    // Fixing one and leaving three is worse than fixing none — it reads as
    // handled.
    const expectedToolCallsByTest: Record<string, EvalExpectedToolCall[]> =
      Object.create(null);
    const predicatesByTest: Record<
      string,
      import("./predicates/types.js").Predicate[]
    > = Object.create(null);
    const matchOptionsByTest: Record<
      string,
      import("./matchers.js").EvalMatchOptions | undefined
    > = Object.create(null);
    const caseIdentityByTest: Record<
      string,
      import("./eval-result-mapping.js").EvalCaseIdentity | undefined
    > = Object.create(null);
    for (const [name, test] of this.tests) {
      const expected = test.getConfig().expectedToolCalls;
      if (expected) {
        expectedToolCallsByTest[name] = expected;
      }
      const predicates = test.getConfig().predicates;
      if (predicates && predicates.length > 0)
        predicatesByTest[name] = predicates;
      matchOptionsByTest[name] = test.getConfig().matchOptions;
      const config = test.getConfig();
      const identity = {
        // Unconditional, unlike its three siblings: `id` is required, so
        // there is no absent case to spread around. `identity` is therefore
        // always non-empty and `caseIdentityByTest` goes from sparse to dense
        // — safe because every reader looks the record up by test NAME and
        // none of them branches on how many entries it holds.
        caseId: config.id,
        // Preserve the unlabelled slice on every modern SDK result. An
        // omitted field means an older producer did not speak to intent.
        intent: config.intent ?? null,
        ...(config.externalCaseId !== undefined
          ? { externalCaseId: config.externalCaseId }
          : {}),
        ...(config.isNegativeTest !== undefined
          ? { isNegativeTest: config.isNegativeTest }
          : {}),
        ...(config.expectedOutput !== undefined
          ? { expectedOutput: config.expectedOutput }
          : {}),
      };
      if (Object.keys(identity).length > 0) {
        caseIdentityByTest[name] = identity;
      }
    }
    return suiteTestResultsToEvalResultInputs(
      testResults,
      Object.keys(expectedToolCallsByTest).length > 0
        ? expectedToolCallsByTest
        : undefined,
      reporting?.failOnToolError,
      hostExtras,
      Object.keys(predicatesByTest).length > 0 ? predicatesByTest : undefined,
      matchOptionsByTest,
      Object.keys(caseIdentityByTest).length > 0
        ? caseIdentityByTest
        : undefined,
      variant
    );
  }

  private aggregateResults(
    testResults: Map<string, EvalRunResult>
  ): EvalSuiteResult {
    const results = Array.from(testResults.values());

    // Aggregate iterations
    const allIterations: IterationResult[] = results.flatMap(
      (r) => r.iterationDetails
    );
    const totalIterations = allIterations.length;
    const totalSuccesses = allIterations.filter((r) => r.passed).length;
    const totalFailures = totalIterations - totalSuccesses;

    // Aggregate latencies
    const allLatencies: LatencyBreakdown[] = results.flatMap(
      (r) => r.latency.perIteration
    );

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

    // Token usage
    const totalTokens = results.reduce((sum, r) => sum + r.tokenUsage.total, 0);
    const perTestTokens = results.map((r) => r.tokenUsage.total);

    return {
      tests: testResults,
      aggregate: {
        iterations: totalIterations,
        successes: totalSuccesses,
        failures: totalFailures,
        accuracy: totalIterations > 0 ? totalSuccesses / totalIterations : 0,
        tokenUsage: {
          total: totalTokens,
          perTest: perTestTokens,
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
        },
      },
    };
  }

  /**
   * Get the aggregate accuracy across all tests
   */
  accuracy(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.aggregate.accuracy;
  }

  /** Get aggregate recall across expectation-bearing iterations. */
  recall(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const { tp, fn } = this.toolCounts();
    return tp + fn === 0 ? 0 : tp / (tp + fn);
  }

  /** Get aggregate precision across expectation-bearing iterations. */
  precision(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const { tp, fp } = this.toolCounts();
    return tp + fp === 0 ? 0 : tp / (tp + fp);
  }

  /**
   * Get the aggregate true positive rate (same as recall)
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
    const hasExpectations = Array.from(this.tests.values()).some(
      (test) => (test.getConfig().expectedToolCalls?.length ?? 0) > 0
    );
    if (!hasExpectations) {
      const { failures, iterations } = this.lastRunResult.aggregate;
      return iterations > 0 ? failures / iterations : 0;
    }
    return this.unexpectedToolCallRate();
  }

  /** Fraction of expectation-bearing iterations containing an extra call. */
  unexpectedToolCallRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const matches = Array.from(this.lastRunResult.tests.values())
      .flatMap((result) => result.iterationDetails)
      .map((iteration) => iteration.toolMatch)
      .filter((match): match is EvalToolCallMatchResult => Boolean(match));
    if (matches.length === 0) return 0;
    return (
      matches.filter((match) => match.extra.length > 0).length / matches.length
    );
  }

  private toolCounts(): { tp: number; fp: number; fn: number } {
    const perTest = Array.from(this.tests.entries());
    let sawExpected = false;
    const totals = perTest.reduce(
      (totals, [name, test]) => {
        const expectedCount = test.getConfig().expectedToolCalls?.length ?? 0;
        if (expectedCount === 0) return totals;
        sawExpected = true;
        const result = this.lastRunResult!.tests.get(name);
        for (const iteration of result?.iterationDetails ?? []) {
          const match = iteration.toolMatch;
          if (!match) continue;
          const mismatches = match.argumentMismatches.length;
          totals.tp += Math.max(
            0,
            expectedCount - match.missing.length - mismatches
          );
          totals.fp += match.extra.length + mismatches;
          totals.fn += match.missing.length + mismatches;
        }
        return totals;
      },
      { tp: 0, fp: 0, fn: 0 }
    );
    if (!sawExpected) {
      throw new Error("precision() requires expectedToolCalls");
    }
    return totals;
  }

  /**
   * Get the average token use per iteration across all tests
   */
  averageTokenUse(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const { total } = this.lastRunResult.aggregate.tokenUsage;
    const { iterations } = this.lastRunResult.aggregate;
    return iterations > 0 ? total / iterations : 0;
  }

  /**
   * Get the full suite results
   */
  getResults(): EvalSuiteResult | null {
    return this.lastRunResult;
  }

  /**
   * Get the name of the suite
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get the number of tests in the suite
   */
  size(): number {
    return this.tests.size;
  }
}
