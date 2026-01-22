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

/**
 * Configuration for a single EvalTest
 */
export interface EvalTestConfig {
  name: string;
  query?: string;
  expectTools?: string[];
  expectExactTools?: string[];
  expectAnyTool?: string[];
  expectNoTools?: boolean;
  validator?: (result: QueryResult) => boolean | Promise<boolean>;
  conversation?: (agent: TestAgent) => Promise<ConversationResult>;
}

/**
 * Result of a multi-turn conversation evaluation
 */
export interface ConversationResult {
  pass: boolean;
  results: QueryResult[];
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
    EvalTestConfig,
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

/**
 * EvalTest - Runs a single test scenario with iterations
 *
 * Can be run standalone or as part of an EvalSuite.
 *
 * @example
 * ```ts
 * const test = new EvalTest({
 *   name: "addition",
 *   query: "Add 2+3",
 *   expectTools: ["add"],
 * });
 * await test.run(agent, { iterations: 30 });
 * console.log(test.accuracy()); // 0.97
 * ```
 */
export class EvalTest {
  private config: EvalTestConfig;
  private lastRunResult: EvalRunResult | null = null;

  constructor(config: EvalTestConfig) {
    this.config = config;
  }

  /**
   * Run this test with the given agent and options
   */
  async run(
    agent: TestAgent,
    options: EvalTestRunOptions
  ): Promise<EvalRunResult> {
    const concurrency = options.concurrency ?? 5;
    const retries = options.retries ?? 0;
    const timeoutMs = options.timeoutMs ?? 30000;
    const onProgress = options.onProgress;

    const semaphore = new Semaphore(concurrency);
    let completedCount = 0;

    if (this.config.conversation) {
      return this.runConversation(
        agent,
        options.iterations,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else if (this.config.query) {
      return this.runSingleTurn(
        agent,
        options.iterations,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else {
      throw new Error("Invalid config: must provide 'query' or 'conversation'");
    }
  }

  private async runSingleTurn(
    agent: TestAgent,
    iterations: number,
    semaphore: Semaphore,
    retries: number,
    timeoutMs: number,
    onProgress: ((completed: number, total: number) => void) | undefined,
    incrementCompleted: () => number
  ): Promise<EvalRunResult> {
    const query = this.config.query!;
    const validator = createValidator(this.config);
    const iterationResults: IterationResult[] = [];
    const total = iterations;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = await withTimeout(agent.query(query), timeoutMs);

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
    const promises = Array.from({ length: iterations }, () =>
      runSingleIteration()
    );
    const results = await Promise.all(promises);
    iterationResults.push(...results);

    return this.aggregateResults(iterationResults);
  }

  private async runConversation(
    agent: TestAgent,
    iterations: number,
    semaphore: Semaphore,
    retries: number,
    timeoutMs: number,
    onProgress: ((completed: number, total: number) => void) | undefined,
    incrementCompleted: () => number
  ): Promise<EvalRunResult> {
    const conversation = this.config.conversation!;
    const iterationResults: IterationResult[] = [];
    const total = iterations;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const convResult = await withTimeout(
              conversation(agent),
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

    const promises = Array.from({ length: iterations }, () =>
      runSingleIteration()
    );
    const results = await Promise.all(promises);
    iterationResults.push(...results);

    return this.aggregateResults(iterationResults);
  }

  private aggregateResults(iterations: IterationResult[]): EvalRunResult {
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

  /**
   * Get the accuracy of the last run (success rate)
   */
  accuracy(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.successes / this.lastRunResult.iterations;
  }

  /**
   * Get the recall (true positive rate) of the last run
   */
  recall(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // In a basic eval context, recall equals accuracy
    return this.accuracy();
  }

  /**
   * Get the precision of the last run
   */
  precision(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    // In a basic eval context, precision equals accuracy
    return this.accuracy();
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

  /**
   * Get the false positive rate
   */
  falsePositiveRate(): number {
    if (!this.lastRunResult) {
      throw new Error("No run results available. Call run() first.");
    }
    return this.lastRunResult.failures / this.lastRunResult.iterations;
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
   * Get the configuration of this test
   */
  getConfig(): EvalTestConfig {
    return this.config;
  }
}
