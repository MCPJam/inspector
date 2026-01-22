import type { TestAgent } from "./TestAgent.js";
import type { QueryResult } from "./QueryResult.js";
import type { LatencyBreakdown } from "./types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import {
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchNoToolCalls,
} from "./validators.js";

export interface EvalsSuiteConfig {
  name?: string;
}

/**
 * Result of a multi-turn conversation evaluation
 */
export interface ConversationResult {
  pass: boolean;
  results: QueryResult[];
}

/**
 * A single test case for multi-case batch testing
 */
export interface TestCase {
  name?: string;
  query: string;
  expectTools?: string[];
  expectExactTools?: string[];
  expectAnyTool?: string[];
  expectNoTools?: boolean;
  validator?: (result: QueryResult) => boolean | Promise<boolean>;
}

/**
 * Result details for a single iteration
 */
export interface IterationResult {
  passed: boolean;
  latencies: LatencyBreakdown[];
  tokens: number;
  error?: string;
  retryCount?: number;
}

/**
 * Result details for a single test case
 */
export interface CaseResult {
  name?: string;
  query: string;
  iterations: IterationResult[];
  successes: number;
  failures: number;
  accuracy: number;
}

/**
 * Configuration for running an eval suite
 */
export interface RunConfig {
  agent: TestAgent;
  iterations: number;

  // === Single-turn ===
  query?: string;
  expectTools?: string[];
  expectExactTools?: string[];
  expectAnyTool?: string[];
  expectNoTools?: boolean;
  validator?: (result: QueryResult) => boolean | Promise<boolean>;

  // === Multi-turn ===
  conversation?: (agent: TestAgent) => Promise<ConversationResult>;

  // === Multi-case ===
  cases?: TestCase[];

  // === DX options ===
  concurrency?: number;
  retries?: number;
  timeoutMs?: number;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Result of an eval run
 */
export interface EvalRunResult {
  iterations: number;
  successes: number;
  failures: number;
  results: boolean[];
  iterationDetails: IterationResult[];
  caseResults?: CaseResult[];
  tokenUsage: {
    total: number;
    perIteration: number[];
  };
  latency: {
    e2e: LatencyStats;
    llm: LatencyStats;
    mcp: LatencyStats;
    perIteration: LatencyBreakdown[];
  };
}

/**
 * Semaphore for controlling concurrency
 */
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

/**
 * Create a validator function from config expectations
 */
function createValidator(
  config: Pick<
    RunConfig | TestCase,
    | "expectTools"
    | "expectExactTools"
    | "expectAnyTool"
    | "expectNoTools"
    | "validator"
  >
): (result: QueryResult) => boolean | Promise<boolean> {
  if (config.validator) {
    return config.validator;
  }

  return (result: QueryResult) => {
    const toolsCalled = result.toolsCalled();

    if (config.expectTools) {
      return matchToolCallsSubset(config.expectTools, toolsCalled);
    }
    if (config.expectExactTools) {
      return matchToolCalls(config.expectExactTools, toolsCalled);
    }
    if (config.expectAnyTool) {
      return matchAnyToolCall(config.expectAnyTool, toolsCalled);
    }
    if (config.expectNoTools) {
      return matchNoToolCalls(toolsCalled);
    }

    // Default: pass if no error
    return !result.hasError();
  };
}

/**
 * Check if config is for conversation mode
 */
function isConversationConfig(config: RunConfig): boolean {
  return "conversation" in config && typeof config.conversation === "function";
}

/**
 * Check if config is for multi-case mode
 */
function isMultiCaseConfig(config: RunConfig): boolean {
  return "cases" in config && Array.isArray(config.cases);
}

/**
 * Check if config is for single-turn mode
 */
function isSingleTurnConfig(config: RunConfig): boolean {
  return "query" in config && typeof config.query === "string";
}

/**
 * Timeout wrapper for promises
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EvalsSuite {
  private name: string;
  private lastRunResult: EvalRunResult | null = null;

  constructor(config?: EvalsSuiteConfig) {
    this.name = config?.name ?? "EvalsSuite";
  }

  async run(config: RunConfig): Promise<EvalRunResult> {
    const concurrency = config.concurrency ?? 5;
    const retries = config.retries ?? 0;
    const timeoutMs = config.timeoutMs ?? 30000;
    const onProgress = config.onProgress;

    const semaphore = new Semaphore(concurrency);
    let completedCount = 0;

    if (isMultiCaseConfig(config)) {
      return this.runMultiCase(
        config,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else if (isConversationConfig(config)) {
      return this.runConversation(
        config,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else if (isSingleTurnConfig(config)) {
      return this.runSingleTurn(
        config,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else {
      throw new Error(
        "Invalid config: must provide 'query', 'conversation', or 'cases'"
      );
    }
  }

  private async runSingleTurn(
    config: RunConfig,
    semaphore: Semaphore,
    retries: number,
    timeoutMs: number,
    onProgress: ((completed: number, total: number) => void) | undefined,
    incrementCompleted: () => number
  ): Promise<EvalRunResult> {
    const query = config.query!;
    const validator = createValidator(config);
    const iterations: IterationResult[] = [];
    const total = config.iterations;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = await withTimeout(
              config.agent.query(query),
              timeoutMs
            );

            const passed = await validator(result);
            const latency = result.getLatency();
            const tokens = result.totalTokens();

            return {
              passed,
              latencies: [latency],
              tokens,
              error: result.hasError() ? result.getError() : undefined,
              retryCount: attempt,
            };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);

            if (attempt < retries) {
              // Exponential backoff: 100ms, 200ms, 400ms, ...
              await sleep(100 * Math.pow(2, attempt));
            }
          }
        }

        // All retries exhausted
        return {
          passed: false,
          latencies: [{ e2eMs: 0, llmMs: 0, mcpMs: 0 }],
          tokens: 0,
          error: lastError,
          retryCount: retries,
        };
      } finally {
        semaphore.release();
        const completed = incrementCompleted();
        if (onProgress) {
          onProgress(completed, total);
        }
      }
    };

    // Run iterations in parallel (limited by semaphore)
    const promises = Array.from({ length: config.iterations }, () =>
      runSingleIteration()
    );
    const results = await Promise.all(promises);
    iterations.push(...results);

    return this.aggregateResults(iterations);
  }

  private async runConversation(
    config: RunConfig,
    semaphore: Semaphore,
    retries: number,
    timeoutMs: number,
    onProgress: ((completed: number, total: number) => void) | undefined,
    incrementCompleted: () => number
  ): Promise<EvalRunResult> {
    const conversation = config.conversation!;
    const iterations: IterationResult[] = [];
    const total = config.iterations;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const convResult = await withTimeout(
              conversation(config.agent),
              timeoutMs
            );

            const latencies = convResult.results.map((r) => r.getLatency());
            const tokens = convResult.results.reduce(
              (sum, r) => sum + r.totalTokens(),
              0
            );

            return {
              passed: convResult.pass,
              latencies,
              tokens,
              retryCount: attempt,
            };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);

            if (attempt < retries) {
              await sleep(100 * Math.pow(2, attempt));
            }
          }
        }

        return {
          passed: false,
          latencies: [{ e2eMs: 0, llmMs: 0, mcpMs: 0 }],
          tokens: 0,
          error: lastError,
          retryCount: retries,
        };
      } finally {
        semaphore.release();
        const completed = incrementCompleted();
        if (onProgress) {
          onProgress(completed, total);
        }
      }
    };

    const promises = Array.from({ length: config.iterations }, () =>
      runSingleIteration()
    );
    const results = await Promise.all(promises);
    iterations.push(...results);

    return this.aggregateResults(iterations);
  }

  private async runMultiCase(
    config: RunConfig,
    semaphore: Semaphore,
    retries: number,
    timeoutMs: number,
    onProgress: ((completed: number, total: number) => void) | undefined,
    incrementCompleted: () => number
  ): Promise<EvalRunResult> {
    const cases = config.cases!;
    const caseResults: CaseResult[] = [];
    const allIterations: IterationResult[] = [];
    const total = cases.length * config.iterations;

    for (const testCase of cases) {
      const validator = createValidator(testCase);
      const caseIterations: IterationResult[] = [];

      const runSingleIteration = async (): Promise<IterationResult> => {
        await semaphore.acquire();
        try {
          let lastError: string | undefined;

          for (let attempt = 0; attempt <= retries; attempt++) {
            try {
              const result = await withTimeout(
                config.agent.query(testCase.query),
                timeoutMs
              );

              const passed = await validator(result);
              const latency = result.getLatency();
              const tokens = result.totalTokens();

              return {
                passed,
                latencies: [latency],
                tokens,
                error: result.hasError() ? result.getError() : undefined,
                retryCount: attempt,
              };
            } catch (error) {
              lastError =
                error instanceof Error ? error.message : String(error);

              if (attempt < retries) {
                await sleep(100 * Math.pow(2, attempt));
              }
            }
          }

          return {
            passed: false,
            latencies: [{ e2eMs: 0, llmMs: 0, mcpMs: 0 }],
            tokens: 0,
            error: lastError,
            retryCount: retries,
          };
        } finally {
          semaphore.release();
          const completed = incrementCompleted();
          if (onProgress) {
            onProgress(completed, total);
          }
        }
      };

      const promises = Array.from({ length: config.iterations }, () =>
        runSingleIteration()
      );
      const results = await Promise.all(promises);
      caseIterations.push(...results);
      allIterations.push(...results);

      const successes = caseIterations.filter((r) => r.passed).length;
      const failures = caseIterations.filter((r) => !r.passed).length;

      caseResults.push({
        name: testCase.name,
        query: testCase.query,
        iterations: caseIterations,
        successes,
        failures,
        accuracy: successes / config.iterations,
      });
    }

    return this.aggregateResults(allIterations, caseResults);
  }

  private aggregateResults(
    iterations: IterationResult[],
    caseResults?: CaseResult[]
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
      caseResults,
      tokenUsage: {
        total: iterations.reduce((sum, r) => sum + r.tokens, 0),
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
    };

    return this.lastRunResult;
  }

  accuracy(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.successes / this.lastRunResult.iterations;
  }

  recall(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // In a basic eval context, recall equals accuracy
    // For more complex scenarios, this would need ground truth labels
    return this.accuracy();
  }

  precision(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // In a basic eval context, precision equals accuracy
    // For more complex scenarios, this would need ground truth labels
    return this.accuracy();
  }

  truePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // TPR = TP / (TP + FN) = same as recall in basic context
    return this.recall();
  }

  falsePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // FPR = FP / (FP + TN)
    // In basic eval context, we consider failures as false positives
    return this.lastRunResult.failures / this.lastRunResult.iterations;
  }

  averageTokenUse(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    if (this.lastRunResult.iterations === 0) {
      return 0;
    }
    return this.lastRunResult.tokenUsage.total / this.lastRunResult.iterations;
  }

  getResults(): EvalRunResult | null {
    return this.lastRunResult;
  }

  getName(): string {
    return this.name;
  }
}
