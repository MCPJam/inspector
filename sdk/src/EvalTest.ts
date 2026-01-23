import type { TestAgent } from "./TestAgent.js";
import type { PromptResult } from "./PromptResult.js";
import type { LatencyBreakdown } from "./types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import {
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchNoToolCalls,
} from "./validators.js";

/**
 * Base configuration shared by all EvalTest types
 */
interface EvalTestConfigBase {
  name: string;
}

/**
 * Configuration for a single-turn EvalTest (requires prompt)
 */
export interface SingleTurnEvalTestConfig extends EvalTestConfigBase {
  /** The prompt to send to the agent */
  prompt: string;
  /** Expected tools to be called (subset match) */
  expectTools?: string[];
  /** Expected tools to be called (exact match) */
  expectExactTools?: string[];
  /** Expected any of these tools to be called */
  expectAnyTool?: string[];
  /** Expect no tools to be called */
  expectNoTools?: boolean;
  /** Optional custom validator for single-turn tests */
  test?: (result: PromptResult) => boolean | Promise<boolean>;
}

/**
 * Configuration for a multi-turn EvalTest (no prompt, requires test function)
 */
export interface MultiTurnEvalTestConfig extends EvalTestConfigBase {
  /** Multi-turn tests don't use a prompt - the test function handles the conversation */
  prompt?: never;
  /** Multi-turn tests don't use declarative expectations */
  expectTools?: never;
  expectExactTools?: never;
  expectAnyTool?: never;
  expectNoTools?: never;
  /** Test function that receives the agent and handles the multi-turn conversation */
  test: (agent: TestAgent) => boolean | Promise<boolean>;
}

/**
 * Configuration for a single EvalTest
 *
 * Two modes:
 * - Single-turn: Provide `prompt` and optionally `expectTools`/`test`
 * - Multi-turn: Provide `test` function only (no `prompt`)
 */
export type EvalTestConfig = SingleTurnEvalTestConfig | MultiTurnEvalTestConfig;

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
  tokens: { total: number; input: number; output: number };
  error?: string;
  retryCount?: number;
  /** The prompt results from this iteration (multi-turn tests only) */
  prompts?: PromptResult[];
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
    "expectTools" | "expectExactTools" | "expectAnyTool" | "expectNoTools"
  >
): (result: PromptResult) => boolean | Promise<boolean> {
  return (result: PromptResult) => {
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
 *   prompt: "Add 2+3",
 *   expectTools: ["add"],
 * });
 * await test.run(agent, { iterations: 30 });
 * console.log(test.accuracy()); // 0.97
 * ```
 */
export class EvalTest {
  private config: EvalTestConfig;
  private lastRunResult: EvalRunResult | null = null;

  /**
   * Create a single-turn eval test.
   * Requires a `prompt` string. Optionally accepts `test` function for custom validation.
   */
  constructor(config: SingleTurnEvalTestConfig);

  /**
   * Create a multi-turn eval test.
   * Requires a `test` function that receives a TestAgent for multi-step conversations.
   */
  constructor(config: MultiTurnEvalTestConfig);

  // Implementation
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

    // Single-turn: has prompt string
    // Multi-turn: has test function but no prompt
    if (this.config.prompt) {
      return this.runSingleTurn(
        agent,
        options.iterations,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else if (this.config.test) {
      return this.runConversation(
        agent,
        options.iterations,
        semaphore,
        retries,
        timeoutMs,
        onProgress,
        () => ++completedCount
      );
    } else {
      throw new Error("Invalid config: must provide 'prompt' or 'test'");
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
    const promptMsg = this.config.prompt!;
    // Use config.test as validator if provided, otherwise use declarative expectations
    const validator = this.config.test
      ? (this.config.test as (
          result: PromptResult
        ) => boolean | Promise<boolean>)
      : createValidator(this.config);
    const iterationResults: IterationResult[] = [];
    const total = iterations;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const result = await withTimeout(
              agent.prompt(promptMsg),
              timeoutMs
            );

            const passed = await validator(result);
            const latency = result.getLatency();
            const tokens = {
              total: result.totalTokens(),
              input: result.inputTokens(),
              output: result.outputTokens(),
            };

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
          tokens: { total: 0, input: 0, output: 0 },
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
    const testFn = this.config.test! as (
      agent: TestAgent
    ) => boolean | Promise<boolean>;
    const iterationResults: IterationResult[] = [];
    const total = iterations;

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            // Create a fresh agent clone for this iteration to avoid race conditions
            // when multiple iterations run concurrently
            const iterationAgent = agent.withOptions({});

            const passed = await withTimeout(
              Promise.resolve(testFn(iterationAgent)),
              timeoutMs
            );

            // Get metrics from this iteration's prompt history
            const promptResults = iterationAgent.getPromptHistory();
            const latencies = promptResults.map((r) => r.getLatency());
            const tokens = {
              total: promptResults.reduce((sum, r) => sum + r.totalTokens(), 0),
              input: promptResults.reduce((sum, r) => sum + r.inputTokens(), 0),
              output: promptResults.reduce(
                (sum, r) => sum + r.outputTokens(),
                0
              ),
            };

            return {
              passed,
              latencies:
                latencies.length > 0
                  ? latencies
                  : [{ e2eMs: 0, llmMs: 0, mcpMs: 0 }],
              tokens,
              retryCount: attempt,
              prompts: promptResults,
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
          tokens: { total: 0, input: 0, output: 0 },
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
}
