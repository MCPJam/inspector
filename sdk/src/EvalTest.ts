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
import {
  allPredicatesPassed,
  evaluatePredicates,
} from "./predicates/evaluate.js";
import { buildIterationTranscript } from "./predicates/transcript.js";
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
 * Configuration for an EvalTest
 *
 * All tests use the multi-turn pattern with a test function that receives a
 * `HostExecutor` (implemented by `HostRunner`, `HostRuntime`, and any custom
 * executor that mirrors the interface).
 */
export interface EvalTestConfig {
  name: string;
  test: (executor: HostExecutor) => boolean | Promise<boolean>;
  expectedToolCalls?: EvalExpectedToolCall[];
  /** Matcher policy for locally enforcing expectedToolCalls. */
  matchOptions?: EvalMatchOptions;
  /** Deterministic transcript predicates that gate each iteration. */
  predicates?: Predicate[];
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
  /** Deterministic predicate verdicts, in authored order. */
  predicateResults?: PredicateResult[];
  /** Local expected/actual tool-call verdict, when expectations were configured. */
  toolMatch?: EvalToolCallMatchResult;
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

  constructor(config: EvalTestConfig) {
    if (!config.test) {
      throw new Error("Invalid config: must provide 'test' function");
    }
    assertValidMatchOptions(config.matchOptions ?? {});
    assertLocallyEvaluablePredicates(config.predicates);
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

    const runSingleIteration = async (): Promise<IterationResult> => {
      await semaphore.acquire();
      try {
        let lastError: string | undefined;
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
            const promptResults = iterationAgent.getPromptHistory();
            const promptMetrics = collectPromptMetrics(promptResults);
            const predicates = this.config.predicates ?? [];
            const predicateResults = this.evaluateIterationPredicates(
              promptResults,
              promptMetrics.tokens
            );
            const predicatePassed = allPredicatesPassed(predicateResults);
            const toolMatch = this.evaluateIterationToolCalls(promptResults);
            // Per-iteration host snapshot: for HostRuntime this captures
            // the live Host state at iteration end, so the metadata
            // stamp reflects what THIS iteration ran with — not the
            // global state at upload time, which can drift if the user
            // mutates the bound Host between iterations.
            const iterationHostSnapshot = iterationAgent.getHostSnapshot?.();

            return {
              passed: passed && predicatePassed && (toolMatch?.passed ?? true),
              ...promptMetrics,
              ...(timeoutTriggered && !passed
                ? { error: timeoutError.message }
                : {}),
              retryCount: attempt,
              hostSnapshot: iterationHostSnapshot,
              ...(predicates.length > 0 ? { predicateResults } : {}),
              ...(toolMatch ? { toolMatch } : {}),
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

        const failedPromptResults = iterationAgent?.getPromptHistory() ?? [];
        const promptMetrics = collectPromptMetrics(failedPromptResults);
        const iterationHostSnapshot = iterationAgent?.getHostSnapshot?.();
        // Evaluate against what the iteration ACTUALLY did before it failed,
        // not an empty transcript. A retry-exhausted iteration may well have
        // called tools, and reporting fabricated verdicts against zeroed
        // signals would put wrong reasons on the dashboard's check chips.
        const failedPredicateResults = this.evaluateIterationPredicates(
          failedPromptResults,
          promptMetrics.tokens
        );
        const failedToolMatch =
          this.evaluateIterationToolCalls(failedPromptResults);

        return {
          passed: false,
          ...promptMetrics,
          error: lastError,
          retryCount: retries,
          hostSnapshot: iterationHostSnapshot,
          ...(failedPredicateResults.length > 0
            ? { predicateResults: failedPredicateResults }
            : {}),
          ...(failedToolMatch ? { toolMatch: failedToolMatch } : {}),
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
      results,
    });
  }

  /**
   * Deterministic predicate verdicts for one iteration, in authored order.
   *
   * The transcript is built from the FULL trace — messages *and* spans — not a
   * bare message list: `buildIterationTranscript` derives tool errors from the
   * trace's spans, so a message-only trace leaves `noToolErrors` with nothing
   * to inspect and it passes vacuously even when every tool call failed.
   */
  private evaluateIterationPredicates(
    promptResults: PromptResult[],
    tokens: { input: number; output: number; total: number }
  ): PredicateResult[] {
    const predicates = this.config.predicates ?? [];
    if (predicates.length === 0) return [];
    const traceMessages = traceMessagesFromPrompts(promptResults);
    return evaluatePredicates(
      buildIterationTranscript({
        trace: iterationTraceFromPrompts(promptResults, traceMessages),
        toolCalls: actualToolCallsFromPrompts(promptResults),
        usage: {
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          totalTokens: tokens.total,
        },
      }),
      predicates
    );
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
    promptResults: PromptResult[]
  ): EvalToolCallMatchResult | undefined {
    const expected = this.config.expectedToolCalls ?? [];
    if (expected.length === 0) return undefined;
    return evaluateToolCalls(
      expected.map((toolCall) => ({
        toolName: toolCall.toolName,
        arguments: toolCall.arguments ?? {},
      })),
      actualToolCallsFromPrompts(promptResults),
      resolveMatchOptions(this.config.matchOptions)
    );
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
      this.config.matchOptions
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
