import type { EvalAgent } from "./EvalAgent.js";
import type { PromptResult } from "./PromptResult.js";
import type { LatencyBreakdown } from "./types.js";
import type {
  EvalExpectedToolCall,
  EvalResultInput,
  MCPJamReportingConfig,
} from "./eval-reporting-types.js";
import { calculateLatencyStats, type LatencyStats } from "./percentiles.js";
import { posthog } from "./telemetry.js";
import { reportEvalResultsSafely } from "./report-eval-results.js";
import { iterationsToEvalResultInputs } from "./eval-result-mapping.js";

/**
 * Configuration for an EvalTest
 *
 * All tests use the multi-turn pattern with a test function that receives an EvalAgent.
 */
export interface EvalTestConfig {
  name: string;
  test: (agent: EvalAgent) => boolean | Promise<boolean>;
  expectedToolCalls?: EvalExpectedToolCall[];
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
  /** @internal used by EvalSuite to prevent duplicate per-test uploads */
  __suppressMcpjamAutoSave?: boolean;
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
  /** The prompt results from this iteration */
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
  agent: EvalAgent,
  abortSignal: AbortSignal
): EvalAgent {
  return {
    prompt: (message, options) =>
      agent.prompt(message, {
        ...options,
        abortSignal: mergeAbortSignals(options?.abortSignal, abortSignal),
      }),
    withOptions: (options) =>
      wrapAgentWithAbortSignal(agent.withOptions(options), abortSignal),
    getPromptHistory: () => agent.getPromptHistory(),
    resetPromptHistory: () => agent.resetPromptHistory(),
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
 *   name: "addition",
 *   test: async (agent) => {
 *     const result = await agent.prompt("Add 2+3");
 *     return result.hasToolCall("add");
 *   },
 * });
 * await test.run(agent, { iterations: 30 });
 * console.log(test.accuracy()); // 0.97
 * ```
 */
export class EvalTest {
  private config: EvalTestConfig;
  private lastRunResult: EvalRunResult | null = null;

  constructor(config: EvalTestConfig) {
    if (!config.test) {
      throw new Error("Invalid config: must provide 'test' function");
    }
    this.config = config;
  }

  /**
   * Run this test with the given agent and options
   */
  async run(
    agent: EvalAgent,
    options: EvalTestRunOptions
  ): Promise<EvalRunResult> {
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

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;
        let iterationAgent: EvalAgent | undefined;

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
            const promptResults = iterationAgent.getPromptHistory();
            const promptMetrics = collectPromptMetrics(promptResults);

            return {
              passed,
              ...promptMetrics,
              ...(timeoutTriggered && !passed
                ? { error: timeoutError.message }
                : {}),
              retryCount: attempt,
            };
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);

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

        const promptMetrics = collectPromptMetrics(
          iterationAgent?.getPromptHistory() ?? []
        );

        return {
          passed: false,
          ...promptMetrics,
          error: lastError,
          retryCount: retries,
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

    const runResult = this.aggregateResults(iterationResults);

    // Call onFailure callback if there are any failures
    if (options.onFailure && runResult.failures > 0) {
      options.onFailure(this.getFailureReport());
    }

    await this.autoSaveRunIfConfigured(runResult, options);

    return runResult;
  }

  private async autoSaveRunIfConfigured(
    runResult: EvalRunResult,
    options: EvalTestRunOptions
  ): Promise<void> {
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

    const results = this.buildEvalResultInputs(runResult.iterationDetails);
    if (results.length === 0) {
      return;
    }

    await reportEvalResultsSafely({
      suiteName: config?.suiteName ?? `EvalTest: ${this.getName()}`,
      suiteDescription: config?.suiteDescription,
      serverNames: config?.serverNames,
      notes: config?.notes,
      passCriteria: config?.passCriteria,
      externalRunId: config?.externalRunId,
      framework: config?.framework,
      ci: config?.ci,
      apiKey,
      baseUrl: config?.baseUrl,
      strict: config?.strict,
      results,
    });
  }

  private buildEvalResultInputs(
    iterations: IterationResult[]
  ): EvalResultInput[] {
    return iterationsToEvalResultInputs(
      this.getName(),
      iterations,
      this.config.expectedToolCalls
    );
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
      const header = `=== Failed Iteration ${index + 1}/${failedIterations.length} ===`;
      const error = iteration.error ? `Error: ${iteration.error}` : "";
      const traces = (iteration.prompts ?? [])
        .map((p, i) => `--- Prompt ${i + 1} ---\n${p.formatTrace()}`)
        .join("\n\n");

      return [header, error, traces].filter(Boolean).join("\n");
    });

    return reports.join("\n\n");
  }
}
