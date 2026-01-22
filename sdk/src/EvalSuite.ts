import type { TestAgent } from "./TestAgent.js";
import type { LatencyBreakdown } from "./types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import type {
  EvalTest,
  EvalTestRunOptions,
  EvalRunResult,
  IterationResult,
} from "./EvalTest.js";

/**
 * Configuration for an EvalSuite
 */
export interface EvalSuiteConfig {
  name?: string;
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
 * suite.add(new EvalTest({ name: "addition", prompt: "Add 2+3", expectTools: ["add"] }));
 * suite.add(new EvalTest({ name: "multiply", prompt: "Multiply 4*5", expectTools: ["multiply"] }));
 *
 * await suite.run(agent, { iterations: 30 });
 * console.log(suite.accuracy());                 // Aggregate: 0.95
 * console.log(suite.get("addition").accuracy()); // Individual: 0.97
 * ```
 */
export class EvalSuite {
  private name: string;
  private tests: Map<string, EvalTest> = new Map();
  private lastRunResult: EvalSuiteResult | null = null;

  constructor(config?: EvalSuiteConfig) {
    this.name = config?.name ?? "EvalSuite";
  }

  /**
   * Add a test to the suite
   */
  add(test: EvalTest): void {
    const name = test.getName();
    if (this.tests.has(name)) {
      throw new Error(`Test with name "${name}" already exists in suite`);
    }
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
   * Run all tests in the suite with the given agent and options
   */
  async run(
    agent: TestAgent,
    options: EvalTestRunOptions
  ): Promise<EvalSuiteResult> {
    const testResults = new Map<string, EvalRunResult>();

    // Track total progress across all tests
    const totalIterations = this.tests.size * options.iterations;
    let completedIterations = 0;

    // Run each test sequentially to avoid overwhelming the system
    for (const [name, test] of this.tests) {
      const testOptions: EvalTestRunOptions = {
        ...options,
        onProgress: options.onProgress
          ? (completed, _total) => {
              // Calculate overall progress
              const overallCompleted = completedIterations + completed;
              options.onProgress!(overallCompleted, totalIterations);
            }
          : undefined,
      };

      const result = await test.run(agent, testOptions);
      testResults.set(name, result);
      completedIterations += options.iterations;
    }

    // Aggregate results
    this.lastRunResult = this.aggregateResults(testResults);
    return this.lastRunResult;
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

  /**
   * Get the aggregate recall (same as accuracy in basic context)
   */
  recall(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.accuracy();
  }

  /**
   * Get the aggregate precision (same as accuracy in basic context)
   */
  precision(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.accuracy();
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

  /**
   * Get the aggregate false positive rate
   */
  falsePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    const { failures, iterations } = this.lastRunResult.aggregate;
    return iterations > 0 ? failures / iterations : 0;
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
