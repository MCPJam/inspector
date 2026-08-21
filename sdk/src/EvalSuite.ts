import type { HostExecutor } from "./HostExecutor.js";
import type { LatencyBreakdown } from "./types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import type {
  EvalExpectedToolCall,
  EvalResultInput,
  MCPJamReportingConfig,
} from "./eval-reporting-types.js";
import type {
  EvalTest,
  EvalTestRunOptions,
  EvalRunResult,
  IterationResult,
} from "./EvalTest.js";
import { reportEvalResultsSafely } from "./report-eval-results.js";
import { suiteTestResultsToEvalResultInputs } from "./eval-result-mapping.js";
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
  private name: string;
  private mcpjamConfig?: MCPJamReportingConfig;
  private matchOptions?: EvalMatchOptions;
  private tests: Map<string, EvalTest> = new Map();
  private lastRunResult: EvalSuiteResult | null = null;

  constructor(config?: EvalSuiteConfig) {
    this.name = config?.name ?? "EvalSuite";
    this.mcpjamConfig = config?.mcpjam;
    this.matchOptions = config?.matchOptions;
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
    this.tests.set(name, test);
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
   * Run all tests in the suite with the given executor and options.
   */
  async run(
    executor: HostExecutor,
    options: EvalTestRunOptions
  ): Promise<EvalSuiteResult> {
    const testResults = new Map<string, EvalRunResult>();
    const suiteReportingConfig = options.mcpjam ?? this.mcpjamConfig;

    // Track total progress across all tests
    const totalIterations = this.tests.size * options.iterations;
    let completedIterations = 0;

    // Run each test sequentially to avoid overwhelming the system
    for (const [name, test] of this.tests) {
      const testOptions: EvalTestRunOptions = {
        ...options,
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
              options.onProgress!(overallCompleted, totalIterations);
            }
          : undefined,
      };

      const result = await test.run(executor, testOptions);
      testResults.set(name, result);
      completedIterations += options.iterations;
    }

    // Aggregate results
    this.lastRunResult = this.aggregateResults(testResults);
    await this.autoSaveSuiteRunIfConfigured(
      testResults,
      suiteReportingConfig,
      executor
    );
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
    if (!apiKey) {
      return;
    }

    const hostSnapshot = executor.getHostSnapshot?.();
    const hostExtras = hostSnapshot
      ? buildHostSnapshotMetadata(
          hostSnapshot as unknown as Record<string, unknown>
        )
      : undefined;
    const results = this.buildEvalResultInputs(testResults, config, hostExtras);
    if (results.length === 0) {
      return;
    }

    await reportEvalResultsSafely({
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
  }

  private buildEvalResultInputs(
    testResults: Map<string, EvalRunResult>,
    reporting?: MCPJamReportingConfig,
    hostExtras?: Record<string, string | number | boolean>
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
        : undefined
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
