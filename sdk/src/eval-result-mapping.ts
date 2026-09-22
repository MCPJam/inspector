/**
 * Shared utilities for converting iteration results to EvalResultInput payloads.
 * Used by EvalTest, EvalSuite, and EvalRunReporter helpers.
 */

import type { IterationResult } from "./EvalTest.js";
import type { EvalRunResult } from "./EvalTest.js";
import type {
  EvalResultInput,
  EvalExpectedToolCall,
  EvalTraceSpanInput,
} from "./eval-reporting-types.js";
import type { Predicate } from "./predicates/types.js";
import type { IterationStatus } from "./contract/chain.js";
import type { EvaluationConfigSnapshot } from "./contract/types.js";
import type { PromptResult } from "./PromptResult.js";
import { finalizePassedForEval } from "./eval-tool-execution.js";
import {
  evaluateToolCalls,
  resolveMatchOptions,
  type EvalMatchOptions,
} from "./matchers.js";
import { buildHostSnapshotMetadata } from "./host-config/internal.js";
import {
  deriveStageResults,
  isPositiveToolCallPredicateKind,
  isSelectionPredicateKind,
  stageDerivationToMetadata,
} from "./contract/stage-derivation.js";
import { attachStageMeasurements } from "./contract/stage-measurements.js";

/**
 * Per-iteration host-extras lookup:
 *
 *   - If the iteration captured its own `hostSnapshot` (HostRuntime path
 *     where the live `Host` could differ between iterations), build the
 *     stamp from that snapshot — the per-iteration value wins.
 *   - Otherwise fall back to the global `hostExtras` derived once from
 *     `executor.getHostSnapshot()` (HostRunner path, where the snapshot
 *     is immutable across iterations).
 */
function resolveIterationHostExtras(
  iteration: IterationResult,
  fallback: Record<string, string | number | boolean> | undefined
): Record<string, string | number | boolean> | undefined {
  if (iteration.hostSnapshot) {
    return buildHostSnapshotMetadata(
      iteration.hostSnapshot as unknown as Record<string, unknown>
    );
  }
  return fallback;
}

type PromptTurnLike = {
  prompt: string;
  expectedToolCalls: EvalExpectedToolCall[];
  expectedOutput?: string;
};

type PromptTraceSummaryLike = {
  promptIndex: number;
  prompt: string;
  expectedToolCalls: EvalExpectedToolCall[];
  actualToolCalls: EvalExpectedToolCall[];
  expectedOutput?: string;
  passed: boolean;
  missing: EvalExpectedToolCall[];
  unexpected: EvalExpectedToolCall[];
  argumentMismatches: Array<{
    toolName: string;
    expectedArgs: Record<string, unknown>;
    actualArgs: Record<string, unknown>;
  }>;
};

function normalizeExpectedToolCalls(value: unknown): EvalExpectedToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as { toolName?: unknown }).toolName === "string"
    )
    .map((item) => {
      const call = item as {
        toolName: string;
        arguments?: Record<string, unknown>;
      };
      return {
        toolName: call.toolName,
        arguments:
          call.arguments && typeof call.arguments === "object"
            ? call.arguments
            : {},
      };
    });
}

/**
 * Project an authored `TestStep[]` (the new unified test-step model — see the
 * inspector's `shared/steps.ts`) onto the per-prompt summary shape this
 * reporter groups by. Each `prompt` step opens a turn; the `assert` steps that
 * follow it (until the next `prompt`) supply that turn's expected tool calls
 * (the `toolCalledWith` predicates). `interact` / widget asserts / non-tool
 * predicates are not reflected in this per-turn projection.
 *
 * BREAKING (Phase 2.5): this REPLACES reading `advancedConfig.promptTurns`. The
 * old per-turn authoring model (`promptTurns` with inline `expectedToolCalls`)
 * is gone; the authoring contract is now `advancedConfig.steps`. No users
 * existed for the old field, so this is a deliberate clean break.
 */
function extractTurnsFromSteps(
  steps: unknown[],
  overrides: PromptsToEvalResultOverrides
): PromptTurnLike[] | undefined {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const turns: PromptTurnLike[] = [];
  let current: PromptTurnLike | undefined;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const s = step as {
      kind?: unknown;
      prompt?: unknown;
      assertion?: unknown;
    };
    if (s.kind === "prompt") {
      current = {
        prompt: typeof s.prompt === "string" ? s.prompt : "",
        expectedToolCalls: [],
        expectedOutput: undefined,
      };
      turns.push(current);
    } else if (
      s.kind === "assert" &&
      s.assertion &&
      typeof s.assertion === "object"
    ) {
      const a = s.assertion as {
        type?: unknown;
        toolName?: unknown;
        args?: unknown;
      };
      // Only `toolCalledWith` predicate asserts carry an expected tool call.
      // (Widget assertions key on `kind`, not `type`, and are skipped here.)
      if (a.type === "toolCalledWith" && typeof a.toolName === "string") {
        const target =
          current ??
          (() => {
            // An assert before any prompt belongs to an implicit first turn
            // seeded from the case query.
            const seeded: PromptTurnLike = {
              prompt: overrides.query ?? "",
              expectedToolCalls: [],
              expectedOutput: undefined,
            };
            turns.push(seeded);
            current = seeded;
            return seeded;
          })();
        const argMatcher = a.args as { args?: unknown } | undefined;
        target.expectedToolCalls.push({
          toolName: a.toolName,
          arguments:
            argMatcher?.args && typeof argMatcher.args === "object"
              ? (argMatcher.args as Record<string, unknown>)
              : {},
        });
      }
    }
  }
  return turns.length > 0 ? turns : undefined;
}

function extractPromptTurns(
  overrides: PromptsToEvalResultOverrides
): PromptTurnLike[] {
  const steps = (overrides.advancedConfig as { steps?: unknown } | undefined)
    ?.steps;
  const fromSteps = Array.isArray(steps)
    ? extractTurnsFromSteps(steps, overrides)
    : undefined;
  if (fromSteps) return fromSteps;

  return [
    {
      prompt: overrides.query ?? "",
      expectedToolCalls: normalizeExpectedToolCalls(
        overrides.expectedToolCalls
      ),
      expectedOutput: undefined,
    },
  ];
}

/**
 * Per-turn summary rendered in the trace timeline.
 *
 * Delegates to `evaluateToolCalls` — the canonical matcher — rather than
 * re-deriving pairings here. The hand-rolled version this replaced was
 * order-agnostic with partial argument matching hardcoded and ignored
 * `matchOptions` entirely, so under any non-default policy the timeline could
 * show a turn as passing while the iteration verdict said it failed.
 *
 * `expectedToolCalls: []` still short-circuits to a pass: the matcher fails a
 * positive test that observed nothing, including the both-empty case, which is
 * right for a whole-iteration verdict but wrong for a turn that simply declared
 * no expectations.
 */
function evaluatePromptSummary(params: {
  promptIndex: number;
  prompt: string;
  expectedToolCalls: EvalExpectedToolCall[];
  actualToolCalls: EvalExpectedToolCall[];
  expectedOutput?: string;
  isNegativeTest?: boolean;
  matchOptions?: EvalMatchOptions;
}): PromptTraceSummaryLike {
  const {
    promptIndex,
    prompt,
    expectedToolCalls,
    actualToolCalls,
    expectedOutput,
    isNegativeTest,
    matchOptions,
  } = params;

  if (isNegativeTest) {
    return {
      promptIndex,
      prompt,
      expectedToolCalls: [],
      actualToolCalls,
      expectedOutput,
      missing: [],
      unexpected: actualToolCalls,
      argumentMismatches: [],
      passed: actualToolCalls.length === 0,
    };
  }

  if (expectedToolCalls.length === 0) {
    return {
      promptIndex,
      prompt,
      expectedToolCalls,
      actualToolCalls,
      expectedOutput,
      missing: [],
      unexpected: [],
      argumentMismatches: [],
      passed: true,
    };
  }

  const result = evaluateToolCalls(
    expectedToolCalls.map((call) => ({
      toolName: call.toolName,
      arguments: call.arguments ?? {},
    })),
    actualToolCalls.map((call) => ({
      toolName: call.toolName,
      arguments: call.arguments ?? {},
    })),
    resolveMatchOptions(matchOptions)
  );

  return {
    promptIndex,
    prompt,
    expectedToolCalls,
    actualToolCalls,
    expectedOutput,
    missing: result.missing,
    unexpected: result.extra,
    argumentMismatches: result.argumentMismatches,
    passed: result.passed,
  };
}

/**
 * Options for {@link promptsToEvalResult}. Pass/fail from your test assertion
 * (`passed`) is combined with trace/errors via {@link finalizePassedForEval}.
 */
export type PromptsToEvalResultOverrides = Partial<
  Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace" | "passed">
> & {
  caseTitle: string;
  passed: boolean;
  failOnToolError?: boolean;
};

/**
 * Build one {@link EvalResultInput} from several {@link PromptResult}s (e.g. a
 * multi-turn Vitest flow). Aggregates tool calls, messages, tokens, duration,
 * and merged timeline spans the same way as a single EvalTest iteration.
 *
 * @throws If `prompts` is empty
 */
export function promptsToEvalResult(
  prompts: PromptResult[],
  overrides: PromptsToEvalResultOverrides
): EvalResultInput {
  if (prompts.length === 0) {
    throw new Error("promptsToEvalResult requires at least one PromptResult");
  }

  const first = prompts[0]!;
  const actualToolCalls = prompts.flatMap((prompt) =>
    prompt.getToolCalls().map((toolCall) => ({
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
    }))
  );
  const traceMessages = prompts.flatMap((prompt) =>
    prompt.getMessages().map((message) => ({
      role: message.role,
      content: message.content,
    }))
  );
  const widgetSnapshots = prompts.flatMap((prompt) =>
    prompt.getWidgetSnapshots()
  );
  const promptTurns = extractPromptTurns(overrides);
  const promptSummaries = prompts.map((prompt, promptIndex) =>
    evaluatePromptSummary({
      promptIndex,
      prompt: promptTurns[promptIndex]?.prompt ?? prompt.getPrompt(),
      expectedToolCalls:
        promptTurns[promptIndex]?.expectedToolCalls ??
        (promptIndex === 0
          ? normalizeExpectedToolCalls(overrides.expectedToolCalls)
          : []),
      actualToolCalls: prompt.getToolCalls().map((toolCall) => ({
        toolName: toolCall.toolName,
        arguments: toolCall.arguments,
      })),
      expectedOutput: promptTurns[promptIndex]?.expectedOutput,
      isNegativeTest: overrides.isNegativeTest,
      matchOptions: overrides.matchOptions,
    })
  );
  const trace = iterationTraceFromPrompts(
    prompts,
    traceMessages,
    promptSummaries
  );

  const inputTokens = prompts.reduce((sum, p) => sum + p.inputTokens(), 0);
  const outputTokens = prompts.reduce((sum, p) => sum + p.outputTokens(), 0);
  const totalTokens = prompts.reduce((sum, p) => sum + p.totalTokens(), 0);

  const durationSum = prompts.reduce((sum, p) => sum + p.e2eLatencyMs(), 0);

  const errorParts = prompts
    .map((p) => p.getError())
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  const derivedError =
    errorParts.length > 0 ? errorParts.join("\n") : undefined;
  const iterationError = overrides.error ?? derivedError;

  const passed = finalizePassedForEval({
    matchPassed: overrides.passed,
    trace,
    iterationError,
    failOnToolError: overrides.failOnToolError,
  });

  return {
    caseTitle: overrides.caseTitle,
    query: overrides.query ?? first.getPrompt(),
    passed,
    // A caller-declared status wins; otherwise the same named legacy rule, on
    // the error this mapper already derived from the prompts.
    status:
      overrides.status ??
      legacyIterationStatusFromExecutionError(iterationError),
    durationMs: durationSum > 0 ? durationSum : undefined,
    provider: overrides.provider ?? first.getProvider(),
    model: overrides.model ?? first.getModel(),
    expectedToolCalls: overrides.expectedToolCalls,
    actualToolCalls,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens,
    },
    error: overrides.error ?? derivedError,
    errorDetails: overrides.errorDetails,
    trace,
    externalIterationId: overrides.externalIterationId,
    caseId: overrides.caseId,
    externalCaseId: overrides.externalCaseId,
    intent: overrides.intent,
    metadata: overrides.metadata,
    isNegativeTest: overrides.isNegativeTest,
    advancedConfig: overrides.advancedConfig,
    widgetSnapshots:
      overrides.widgetSnapshots ??
      (widgetSnapshots.length > 0 ? widgetSnapshots : undefined),
  };
}

/**
 * Merge per-prompt timeline spans into one iteration trace.
 * Prompt N spans are offset by the cumulative e2e latency of prompts 0..N-1.
 */
function mergePromptSpansForIteration(
  prompts: PromptResult[]
): EvalTraceSpanInput[] {
  const merged: EvalTraceSpanInput[] = [];
  let offsetMs = 0;
  let messageOffset = 0;

  prompts.forEach((prompt, promptIndex) => {
    const idPrefix = `prompt-${promptIndex}`;
    for (const span of prompt.getSpans()) {
      merged.push({
        ...span,
        id: `${idPrefix}:${span.id}`,
        parentId: span.parentId ? `${idPrefix}:${span.parentId}` : undefined,
        startMs: span.startMs + offsetMs,
        endMs: span.endMs + offsetMs,
        promptIndex,
        modelId: span.modelId ?? prompt.getModel(),
        messageStartIndex:
          typeof span.messageStartIndex === "number"
            ? span.messageStartIndex + messageOffset
            : undefined,
        messageEndIndex:
          typeof span.messageEndIndex === "number"
            ? span.messageEndIndex + messageOffset
            : undefined,
      });
    }
    offsetMs += prompt.e2eLatencyMs();
    messageOffset += prompt.getMessages().length;
  });
  return merged;
}

/**
 * Flatten every prompt's messages into the trace's `messages` array.
 *
 * Shared so the four mappers and the runner's predicate transcript all read the
 * same message list — `turnCountUnder` counts user roles here, so a divergent
 * copy would silently change a predicate's verdict.
 */
export function traceMessagesFromPrompts(
  prompts: PromptResult[]
): Array<{ role: string; content: unknown }> {
  return prompts.flatMap((prompt) =>
    prompt.getMessages().map((message) => ({
      role: message.role,
      content: message.content,
    }))
  );
}

/**
 * Flatten every prompt's tool calls, arguments included.
 *
 * Shared for the same reason: this is both the matcher's "actual" side and the
 * transcript's `toolCalls`, and the two must never disagree.
 */
export function actualToolCallsFromPrompts(
  prompts: PromptResult[]
): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  return prompts.flatMap((prompt) =>
    prompt.getToolCalls().map((toolCall) => ({
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
    }))
  );
}

/**
 * The provider and model an iteration ran on, from the same source
 * `promptsToEvalResult` reads. `fallback` covers an iteration that never
 * reached the model (setup failed before the first turn), so a run still names
 * what it was configured to run — a saved client's model, for instance.
 */
export function variantFromPrompts(
  prompts: PromptResult[],
  fallback?: { provider?: string; model?: string }
): { provider?: string; model?: string } {
  const first = prompts[0];
  return {
    provider: first?.getProvider() ?? fallback?.provider,
    model: first?.getModel() ?? fallback?.model,
  };
}

/**
 * The provider and model an executor is configured to run, for iterations that
 * produced no prompt of their own. Duck-typed: only `HostRunner` parses a model
 * string, and the `HostExecutor` interface does not promise these.
 */
export function variantFromExecutor(executor: unknown): {
  provider?: string;
  model?: string;
} {
  const candidate = executor as {
    getParsedProvider?: () => string;
    getParsedModel?: () => string;
  } | null;
  const provider = candidate?.getParsedProvider?.();
  const model = candidate?.getParsedModel?.();
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

export function iterationTraceFromPrompts(
  prompts: PromptResult[],
  traceMessages: Array<{ role: string; content: unknown }>,
  promptSummaries?: PromptTraceSummaryLike[]
): EvalResultInput["trace"] | undefined {
  const recordedContext = prompts.flatMap((prompt) =>
    prompt.recordedContext ? [prompt.recordedContext] : []
  );
  const mergedSpans = mergePromptSpansForIteration(prompts);
  if (
    traceMessages.length === 0 &&
    mergedSpans.length === 0 &&
    (!promptSummaries || promptSummaries.length === 0)
  ) {
    return undefined;
  }
  return {
    ...(recordedContext.length ? { recordedContext } : {}),
    messages: traceMessages,
    ...(mergedSpans.length > 0 ? { spans: mergedSpans } : {}),
    ...(promptSummaries && promptSummaries.length > 0
      ? { prompts: promptSummaries }
      : {}),
  };
}

/**
 * Options for converting a single iteration to an EvalResultInput.
 */
export interface IterationToEvalResultOptions {
  caseTitle: string;
  provider?: string;
  model?: string;
  expectedToolCalls?: EvalExpectedToolCall[];
  promptSelector?: "first" | "last";
  /** @see MCPJamReportingConfig.failOnToolError */
  failOnToolError?: boolean;
  /**
   * The case's DECLARED identity (`EvalTestConfig.id`), forwarded when given.
   *
   * Optional and never defaulted, because this converter cannot know it: it
   * receives a `casePrefix`, not an `EvalTest`. Passing it is what lets a
   * reporter built on these helpers join a renamed test to its hosted history.
   *
   * Supplying one across a run's iterations declares them ONE case rather than
   * one case per iteration — a change to how they land hosted, which is why
   * nothing supplies it on the caller's behalf. See {@link runToEvalResults}
   * for the `caseTitle` consequence.
   */
  caseId?: string;
  /** Authored analytics grouping label; omission keeps legacy wire behavior. */
  intent?: string | null;
}

/**
 * Convert a single IterationResult to an EvalResultInput.
 *
 * Aggregates tool calls, trace messages, and tokens from ALL prompts in the
 * iteration (not just a single selected prompt). The `promptSelector` option
 * only controls which prompt supplies `query`, `provider`, and `model`.
 */
export function iterationToEvalResult(
  iteration: IterationResult,
  index: number,
  options: IterationToEvalResultOptions
): EvalResultInput {
  const prompts = iteration.prompts ?? [];
  const selector = options.promptSelector ?? "first";
  const selectedPrompt: PromptResult | undefined =
    selector === "last" ? prompts[prompts.length - 1] : prompts[0];

  // Aggregate tool calls from ALL prompts
  const actualToolCalls = prompts.flatMap((prompt) =>
    prompt.getToolCalls().map((toolCall) => ({
      toolName: toolCall.toolName,
      arguments: toolCall.arguments,
    }))
  );

  // Aggregate trace messages from ALL prompts
  const traceMessages = prompts.flatMap((prompt) =>
    prompt.getMessages().map((message) => ({
      role: message.role,
      content: message.content,
    }))
  );
  const widgetSnapshots = prompts.flatMap((prompt) =>
    prompt.getWidgetSnapshots()
  );
  const trace = iterationTraceFromPrompts(prompts, traceMessages);

  // Use iteration-level tokens (already pre-aggregated by EvalTest)
  const durationMs = iteration.latencies.reduce(
    (sum, latency) => sum + latency.e2eMs,
    0
  );

  // Resolve provider/model: explicit options > selected prompt metadata > undefined
  const provider = options.provider ?? selectedPrompt?.getProvider();
  const model = options.model ?? selectedPrompt?.getModel();

  const passed = finalizePassedForEval({
    matchPassed: iteration.passed,
    trace,
    iterationError: iteration.error,
    failOnToolError: options.failOnToolError,
  });

  return {
    caseTitle: options.caseTitle,
    ...(options.caseId !== undefined ? { caseId: options.caseId } : {}),
    ...(options.intent !== undefined ? { intent: options.intent } : {}),
    query: selectedPrompt?.getPrompt(),
    passed,
    status: resolveIterationLifecycleStatus(iteration),
    durationMs: durationMs > 0 ? durationMs : undefined,
    provider,
    model,
    expectedToolCalls: options.expectedToolCalls,
    actualToolCalls: iteration.captureError ? undefined : actualToolCalls,
    tokens: iteration.captureError
      ? undefined
      : {
          input: iteration.tokens.input,
          output: iteration.tokens.output,
          total: iteration.tokens.total,
        },
    error: iteration.error,
    trace: iteration.captureError ? undefined : trace,
    widgetSnapshots: widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
    metadata: {
      iterationNumber: index + 1,
      retryCount: iteration.retryCount ?? 0,
      ...(iteration.captureError
        ? {
            captureError: iteration.captureError,
            captureCompleteness: "unavailable",
          }
        : {}),
    },
  };
}

/**
 * Options for converting a run's iterations to EvalResultInput payloads.
 */
export interface RunToEvalResultsOptions {
  casePrefix: string;
  provider?: string;
  model?: string;
  expectedToolCalls?: EvalExpectedToolCall[];
  promptSelector?: "first" | "last";
  failOnToolError?: boolean;
  /** @see IterationToEvalResultOptions.caseId */
  caseId?: string;
  /** Authored analytics grouping label; omission keeps legacy wire behavior. */
  intent?: string | null;
}

/**
 * Convert all iterations from an EvalRunResult to EvalResultInput payloads.
 *
 * The per-iteration `-iter-N` title suffix is what makes each iteration land as
 * its OWN hosted case, so it is dropped when a declared `caseId` is supplied:
 * that id says these iterations are one case, and the backend then titles that
 * case from the first result it accepts (`sdkEvals.ts`, the grouped-stats
 * `title` is set once and never revised) — leaving a case that holds N
 * iterations named after iteration 1, or after iteration 2 when the first is
 * skipped. Nothing is lost by dropping it: the iteration number already rides
 * every result as `metadata.iterationNumber`.
 */
export function runToEvalResults(
  run: EvalRunResult,
  options: RunToEvalResultsOptions
): EvalResultInput[] {
  return run.iterationDetails.map((iteration, index) =>
    iterationToEvalResult(iteration, index, {
      caseTitle:
        options.caseId !== undefined
          ? options.casePrefix
          : `${options.casePrefix}-iter-${index + 1}`,
      provider: options.provider,
      model: options.model,
      expectedToolCalls: options.expectedToolCalls,
      promptSelector: options.promptSelector,
      failOnToolError: options.failOnToolError,
      caseId: options.caseId,
      intent: options.intent,
    })
  );
}

/**
 * Options for converting a suite run's iterations to EvalResultInput payloads.
 */
export interface SuiteRunToEvalResultsOptions {
  casePrefix: string;
  provider?: string;
  model?: string;
  expectedToolCallsByTest?: Record<string, EvalExpectedToolCall[]>;
  promptSelector?: "first" | "last";
  failOnToolError?: boolean;
  /**
   * Declared case ids, keyed by test name — the same shape as
   * `expectedToolCallsByTest`, because one id cannot describe a whole suite.
   *
   * @see IterationToEvalResultOptions.caseId
   */
  caseIdByTest?: Record<string, string>;
  /** Authored analytics labels keyed by test name. */
  intentByTest?: Record<string, string | null>;
}

/**
 * Convert all iterations from a suite run (Map<string, EvalRunResult>) to
 * EvalResultInput payloads.
 */
export function suiteRunToEvalResults(
  testResults: Map<string, EvalRunResult>,
  options: SuiteRunToEvalResultsOptions
): EvalResultInput[] {
  const results: EvalResultInput[] = [];

  for (const [testName, testRun] of testResults) {
    const expectedToolCalls = options.expectedToolCallsByTest?.[testName];
    const testResults = runToEvalResults(testRun, {
      casePrefix: `${options.casePrefix}-${testName}`,
      provider: options.provider,
      model: options.model,
      expectedToolCalls,
      promptSelector: options.promptSelector,
      failOnToolError: options.failOnToolError,
      caseId: options.caseIdByTest?.[testName],
      intent: options.intentByTest?.[testName],
    });
    results.push(...testResults);
  }

  return results;
}

/**
 * Convert iterations for EvalTest internal auto-save (preserves existing behavior).
 */
/**
 * Additively merge host-derived metadata into a per-iteration metadata
 * object. Existing keys (`retryCount`, `iterationNumber`, …) are NEVER
 * overwritten — a conflicting host key is namespaced under `host.<key>`.
 */
function mergeHostExtrasIntoMetadata(
  base: Record<string, unknown>,
  hostExtras: Record<string, string | number | boolean> | undefined
): Record<string, unknown> {
  if (!hostExtras) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(hostExtras)) {
    if (key in merged) {
      merged[`host.${key}`] = value;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * The contract's wire seat: `metadata.scores` and `metadata.evaluationConfig`.
 *
 * `testIteration.metadata` is an open record and `toMetadataRecord` preserves
 * nested values, so no capability negotiation is required — a backend that has
 * not yet learned to validate scores simply stores them opaquely and
 * harmlessly. (Negotiation WOULD be required if scores ever became a top-level
 * wire field.)
 *
 * Both halves ship together or neither does. Results alone are un-joinable:
 * `role`, `onError` and `onSkipped` live only on the definitions, so a
 * consumer holding results without the snapshot cannot tell a gating failure
 * from an advisory one.
 *
 * Deliberately NOT written into `advancedConfig`: the backend hashes that into
 * the caseKey, so a changed threshold would fork case identity and split one
 * scenario's history in two.
 */
function scoreMetadata(
  iteration: IterationResult,
  evaluationConfig: EvaluationConfigSnapshot | undefined
): Record<string, unknown> {
  if (!iteration.scores || iteration.scores.length === 0) return {};
  if (!evaluationConfig) return {};
  return {
    scores: iteration.scores,
    evaluationConfig,
  };
}

/**
 * The canonical step model for a case whose predicates need to reach the
 * hosted suite: the turns it prompted, then one assert per predicate.
 *
 * ONE array per CASE, never one per iteration. The backend derives case
 * identity from a hash that includes these steps, so emitting each iteration's
 * own runtime prompts would split a single test into as many cases as it had
 * distinct prompt strings — a test that interpolates a timestamp or a computed
 * value would fork its own history inside one run. Taking the first iteration's
 * turns keeps every iteration of the test on one case.
 */
function syntheticStepsForCase(
  iterations: IterationResult[],
  predicates: Predicate[] | undefined
): { steps: unknown[] } | undefined {
  if (!predicates || predicates.length === 0) return undefined;
  const representative =
    iterations.find((iteration) => (iteration.prompts ?? []).length > 0)
      ?.prompts ?? [];
  return {
    steps: [
      ...representative.map((prompt, promptIndex) => ({
        id: `sdk-prompt-${promptIndex}`,
        kind: "prompt" as const,
        prompt: prompt.getPrompt(),
      })),
      ...predicates.map((predicate, predicateIndex) => ({
        id: `sdk-assert-${predicateIndex}`,
        kind: "assert" as const,
        assertion: predicate,
      })),
    ],
  };
}

/**
 * One uploaded per-step verdict. Mirrors the hosted runner's row
 * (`buildStepResultRecords` in the inspector server) so the Evaluate UI's
 * Steps tab reads SDK runs the same way it reads hosted ones. Only `stepId`
 * and `status` are load-bearing — the client overwrites `kind`/`stepIndex`
 * from the authored step — but we send the full row for parity.
 */
type SdkStepResult = {
  stepId: string;
  stepIndex: number;
  kind: "prompt" | "assert";
  status: "ok" | "fail" | "pending";
  reason?: string;
};

/** Deep-equal on the small `{toolName, arguments}` shape, key order aside. */
function sameToolCall(
  a: EvalExpectedToolCall,
  b: EvalExpectedToolCall
): boolean {
  return (
    a.toolName === b.toolName &&
    stableStringify(a.arguments) === stableStringify(b.arguments)
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    );
  });
}

/** Trim a reason so one mismatched argument blob cannot dominate the row. */
function briefly(value: unknown): string {
  const text = stableStringify(value) ?? "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const toolNames = (calls: readonly EvalExpectedToolCall[]): string =>
  [...new Set(calls.map((call) => call.toolName))].join(", ");

/**
 * Per-step verdicts for one iteration, keyed by the SAME step ids the case's
 * steps were authored with — which is why this branches on `predicates` the
 * way {@link syntheticStepsForCase} does:
 *
 * - predicates present: this SDK uploads the steps itself, as
 *   `advancedConfig.steps` with `sdk-prompt-N` / `sdk-assert-N` ids.
 * - otherwise: no steps are uploaded and the backend synthesizes them at
 *   ingest (`sdkSinglePromptSteps`) as `step-1` / `step-expect-N`. Those ids
 *   are mirrored here rather than uploading our own steps, because
 *   `advancedConfig` is hashed into the case key — emitting steps for a case
 *   that never had them would fork its hosted history.
 *
 * A row whose id matches no authored step is dropped by the client, so being
 * wrong here costs a blank row, never a wrong verdict.
 */
function stepResultsForIteration(args: {
  iteration: IterationResult;
  prompts: PromptResult[];
  expectedToolCalls: EvalExpectedToolCall[] | undefined;
  predicates: Predicate[] | undefined;
  isNegativeTest: boolean | undefined;
}): SdkStepResult[] {
  const { iteration, prompts, expectedToolCalls, predicates } = args;
  const rows: SdkStepResult[] = [];
  const push = (row: Omit<SdkStepResult, "stepIndex">) =>
    rows.push({ ...row, stepIndex: rows.length });

  if (predicates && predicates.length > 0) {
    prompts.forEach((_prompt, promptIndex) => {
      // The hosted adapter marks a prompt step ok once it ran at all; the
      // assertions below are what carry the verdict.
      push({
        stepId: `sdk-prompt-${promptIndex}`,
        kind: "prompt",
        status: "ok",
      });
    });
    predicates.forEach((_predicate, predicateIndex) => {
      const result = iteration.predicateResults?.[predicateIndex];
      if (!result) {
        // Never evaluated (an earlier failure halted the iteration). Pending,
        // not a false pass — same call the hosted adapter makes.
        push({
          stepId: `sdk-assert-${predicateIndex}`,
          kind: "assert",
          status: "pending",
        });
        return;
      }
      push({
        stepId: `sdk-assert-${predicateIndex}`,
        kind: "assert",
        status: result.passed ? "ok" : "fail",
        ...(result.reason ? { reason: result.reason } : {}),
      });
    });
    return rows;
  }

  if (prompts.length > 0) {
    push({ stepId: "step-1", kind: "prompt", status: "ok" });
  }
  if (!expectedToolCalls || expectedToolCalls.length === 0) return rows;

  const match = iteration.toolMatch;
  // The matcher returns one aggregate verdict with diff buckets, not a row per
  // expectation, so each expectation is re-attributed from those buckets. Each
  // bucket entry answers for one expectation only: two expectations of the
  // same tool must not both be blamed by a single missing or mismatched call.
  const remainingMissing = [...(match?.missing ?? [])];
  const remainingMismatches = [...(match?.argumentMismatches ?? [])];
  const blame = expectedToolCalls.map((expected): string | undefined => {
    if (!match || match.passed) return undefined;
    if (args.isNegativeTest) {
      const called = toolNames(match.extra);
      return called ? `tool was called: ${called}` : "tool was called";
    }
    const missingAt = remainingMissing.findIndex((call) =>
      sameToolCall(call, expected)
    );
    if (missingAt !== -1) {
      remainingMissing.splice(missingAt, 1);
      return "not called";
    }
    const mismatchAt = remainingMismatches.findIndex(
      (entry) =>
        entry.toolName === expected.toolName &&
        stableStringify(entry.expectedArgs) ===
          stableStringify(expected.arguments)
    );
    if (mismatchAt !== -1) {
      const [mismatch] = remainingMismatches.splice(mismatchAt, 1);
      return `arguments differed: expected ${briefly(
        mismatch.expectedArgs
      )}, got ${briefly(mismatch.actualArgs)}`;
    }
    return undefined;
  });
  // A match can fail on extras or ordering alone, implicating no single
  // expectation. Failing every row is the honest read — the header must never
  // say "1 of 1 passed" for an iteration whose tool calls did not match.
  const unattributed =
    match !== undefined && !match.passed && blame.every((r) => r === undefined);
  const shared = match?.outOfOrder.length
    ? "called out of order"
    : match?.extra.length
    ? `unexpected tool call: ${toolNames(match.extra)}`
    : "tool calls did not match";

  expectedToolCalls.forEach((_expected, expectedIndex) => {
    const stepId = `step-expect-${expectedIndex}`;
    if (!match) {
      push({ stepId, kind: "assert", status: "pending" });
      return;
    }
    if (match.passed) {
      push({ stepId, kind: "assert", status: "ok" });
      return;
    }
    const reason = blame[expectedIndex] ?? (unattributed ? shared : undefined);
    push({
      stepId,
      kind: "assert",
      status: reason ? "fail" : "ok",
      ...(reason ? { reason } : {}),
    });
  });
  return rows;
}

/**
 * Hosted-case identity and semantics carried onto every result row.
 *
 * Separate from `expectedToolCalls` and friends because these three describe
 * WHICH case this is and how it is graded, not what it expected — and the
 * backend reads them to join a local run to a hosted case's history.
 */
export type EvalCaseIdentity = {
  /** The case's DECLARED identity — `EvalTestConfig.id`. */
  caseId?: string;
  externalCaseId?: string;
  /** `null` explicitly records an unlabelled modern SDK case. */
  intent?: string | null;
  isNegativeTest?: boolean;
  expectedOutput?: string;
};

/**
 * Adapt one SDK iteration into the stage analyzer's evidence shape.
 *
 * The load-bearing distinction is between the two span-less cases:
 *
 *   - `traceAbsent` — `iterationTraceFromPrompts` returned nothing at all, so
 *     the iteration recorded no messages, no spans and no summaries. A retry
 *     that died before the executor ever ran looks like this.
 *   - `traceLacksSpanChannel` — a trace exists (messages survived) but carries
 *     no `spans` key. That is the caller-supplied `HostExecutor` signature:
 *     spans are not part of the `HostExecutor` contract, so an executor that
 *     never populates `PromptResult.spans` produces exactly this. Reading it
 *     as "nothing happened" is how an iteration whose every tool call failed
 *     scores a vacuous pass.
 */
function buildSdkStageEvidence(
  iteration: IterationResult,
  trace: EvalResultInput["trace"]
) {
  const spans =
    trace && typeof trace === "object" && !Array.isArray(trace) && trace.spans
      ? trace.spans
      : [];
  const match = iteration.toolMatch;
  return {
    ...(spans.length > 0 ? { spans } : {}),
    ...(match
      ? {
          prompts: [
            {
              promptIndex: 0,
              missing: match.missing,
              unexpected: match.extra,
              argumentMismatches: match.argumentMismatches,
              // The matcher's OWN verdict, under this case's match options.
              // Without it the analyzer cannot tell a tolerated extra call
              // (`maxExtraToolCalls: null`, the default) from a failing one,
              // and would report a passing run as broken at `selection`.
              passed: match.passed,
            },
          ],
        }
      : {}),
    ...(iteration.predicateResults?.length
      ? { predicateResults: iteration.predicateResults }
      : {}),
    traceAbsent: trace === undefined,
    traceLacksSpanChannel: trace !== undefined && spans.length === 0,
  };
}

/**
 * Derive one SDK iteration's user-value chain.
 *
 * Shared by BOTH exported mappers. They build the same per-iteration shape from
 * the same inputs, and a chain that appeared from one entry point and not the
 * other would leave a reader unable to tell "no derivation ran" from "the
 * derivation found nothing" — which is the exact ambiguity the `notMeasured`
 * state exists to remove.
 */
function deriveSdkStageResults(args: {
  iteration: IterationResult;
  trace: EvalResultInput["trace"];
  expectedToolCalls?: EvalExpectedToolCall[];
  predicates?: Predicate[];
  caseIdentity?: EvalCaseIdentity;
}) {
  const { iteration, trace, expectedToolCalls, predicates } = args;
  const caseIdentity = args.caseIdentity;
  return deriveStageResults({
    authored: {
      // An SDK case always drives a HostExecutor with prompts, so there is
      // always a model turn that could select a tool.
      mode: "model_driven",
      ...(caseIdentity?.isNegativeTest !== undefined
        ? { isNegativeTest: caseIdentity.isNegativeTest }
        : {}),
      // UVH-IN1's matrix, mirrored: a positive tool-call predicate expects a
      // call, `toolNeverCalled` does not. This path builds its own authored
      // case rather than calling `buildStageAuthoredCase` (it has no steps or
      // turns to read, and its `mode` and `expectsWidgetRender` are fixed by
      // what the SDK path can observe), so the matrix has to be applied twice
      // — a pre-existing divergence this PR keeps in step rather than widens.
      expectsToolCall:
        (expectedToolCalls?.length ?? 0) > 0 ||
        caseIdentity?.isNegativeTest === true ||
        (predicates ?? []).some((p) =>
          isPositiveToolCallPredicateKind(p?.type)
        ),
      // Render observations are not carried on the SDK path, so a case is
      // never treated as asserting a widget render here — claiming otherwise
      // would demand evidence this path cannot produce and report every SDK
      // run's `response` as an evidence gap.
      //
      // Tool-call predicates are excluded for the same reason they are on the
      // server: their results are routed to `selection`, so counting them here
      // would leave `userValue` applicable with nothing left to grade it.
      assertionCount:
        (predicates ?? []).filter((p) => !isSelectionPredicateKind(p?.type))
          .length + (caseIdentity?.expectedOutput !== undefined ? 1 : 0),
    },
    evidence: buildSdkStageEvidence(iteration, trace),
    iteration: {
      // The LIFECYCLE status, never the task verdict. Deriving it from `passed`
      // told the analyzer that every graded failure was an execution failure,
      // which is the one thing the two-axis contract exists to distinguish.
      status: resolveIterationLifecycleStatus(iteration),
      ...(iteration.error ? { error: iteration.error } : {}),
    },
  });
}

/**
 * The status a FINISHED iteration reports, from the iteration itself.
 *
 * `EvalTest` sets `status` on every terminal path, so the v2 path reads it
 * directly. The fallback is for `IterationResult`s built OUTSIDE this SDK
 * version — an older recorded run, or a caller assembling the struct by hand —
 * and it is deliberately the same rule the backend's compatibility adapter
 * uses: EXECUTION ERROR PRESENT means the execution failed, and nothing else.
 *
 * It must never consult `passed`. A graded failure is `completed` + a failed
 * task verdict; folding the verdict into the lifecycle makes a working harness
 * indistinguishable from a broken one, inflates every failure rate with harness
 * noise, and (through the validity checks) can turn a real regression into
 * `inconclusive`.
 */
export function resolveIterationLifecycleStatus(
  iteration: Pick<IterationResult, "status" | "error">
): IterationStatus {
  if (iteration.status !== undefined) return iteration.status;
  return legacyIterationStatusFromExecutionError(iteration.error);
}

/**
 * The named legacy adapter: the ONLY place a status is inferred rather than
 * reported. Kept separate from {@link resolveIterationLifecycleStatus} so the
 * inference is greppable and cannot creep onto the v2 path.
 */
export function legacyIterationStatusFromExecutionError(
  error: string | undefined
): IterationStatus {
  return error === undefined || error.trim().length === 0
    ? "completed"
    : "failed";
}

export function iterationsToEvalResultInputs(
  testName: string,
  iterations: IterationResult[],
  expectedToolCalls?: EvalExpectedToolCall[],
  failOnToolError?: boolean,
  hostExtras?: Record<string, string | number | boolean>,
  predicates?: Predicate[],
  matchOptions?: import("./matchers.js").EvalMatchOptions,
  evaluationConfig?: EvaluationConfigSnapshot,
  caseIdentity?: EvalCaseIdentity,
  variant?: { provider?: string; model?: string }
): EvalResultInput[] {
  const advancedConfig = syntheticStepsForCase(iterations, predicates);
  return iterations.map((iteration, index) => {
    const prompts = iteration.prompts ?? [];
    const durationMs = iteration.latencies.reduce(
      (sum, latency) => sum + latency.e2eMs,
      0
    );
    const actualToolCalls = actualToolCallsFromPrompts(prompts);
    const traceMessages = traceMessagesFromPrompts(prompts);
    const widgetSnapshots = prompts.flatMap((prompt) =>
      prompt.getWidgetSnapshots()
    );
    const trace = iterationTraceFromPrompts(prompts, traceMessages);

    const passed = finalizePassedForEval({
      matchPassed: iteration.passed,
      trace,
      iterationError: iteration.error,
      failOnToolError,
      predicateResults: iteration.predicateResults,
    });

    const stageDerivation = deriveSdkStageResults({
      iteration,
      trace,
      expectedToolCalls,
      predicates,
      caseIdentity,
    });

    const stepResults = stepResultsForIteration({
      iteration,
      prompts,
      expectedToolCalls,
      predicates,
      isNegativeTest: caseIdentity?.isNegativeTest,
    });

    return {
      caseTitle: testName,
      query: prompts[0]?.getPrompt() ?? testName,
      passed,
      status: resolveIterationLifecycleStatus(iteration),
      durationMs: durationMs > 0 ? durationMs : undefined,
      ...variantFromPrompts(prompts, variant),
      expectedToolCalls,
      actualToolCalls: iteration.captureError ? undefined : actualToolCalls,
      // Hosted↔local identity and semantics, on the wire. `caseId` is the
      // DECLARED identity the backend resolves by first (and adopts onto a
      // case that resolved by content hash); `externalCaseId` is the older
      // join key it hashes into caseKey. Either way a materialized hosted case
      // joins its own history instead of appearing as a new scenario.
      ...(caseIdentity?.caseId !== undefined
        ? { caseId: caseIdentity.caseId }
        : {}),
      ...(caseIdentity?.externalCaseId !== undefined
        ? { externalCaseId: caseIdentity.externalCaseId }
        : {}),
      ...(caseIdentity?.intent !== undefined
        ? { intent: caseIdentity.intent }
        : {}),
      ...(caseIdentity?.isNegativeTest !== undefined
        ? { isNegativeTest: caseIdentity.isNegativeTest }
        : {}),
      ...(caseIdentity?.expectedOutput !== undefined
        ? { expectedOutput: caseIdentity.expectedOutput }
        : {}),
      tokens: iteration.captureError
        ? undefined
        : {
            input: iteration.tokens.input,
            output: iteration.tokens.output,
            total: iteration.tokens.total,
          },
      error: iteration.error,
      trace: iteration.captureError ? undefined : trace,
      widgetSnapshots: widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
      advancedConfig,
      matchOptions,
      metadata: mergeHostExtrasIntoMetadata(
        {
          retryCount: iteration.retryCount ?? 0,
          ...(iteration.captureError
            ? {
                captureError: iteration.captureError,
                captureCompleteness: "unavailable",
              }
            : {}),
          iterationNumber: index + 1,
          ...(iteration.predicateResults
            ? { predicates: iteration.predicateResults }
            : {}),
          // Per-step verdicts for the Steps tab. Omitted when empty, the same
          // rule the hosted runner applies.
          ...(stepResults.length > 0 ? { stepResults } : {}),
          ...scoreMetadata(iteration, evaluationConfig),
          ...attachStageMeasurements(
            stageDerivationToMetadata(stageDerivation),
            trace && typeof trace === "object" && !Array.isArray(trace)
              ? trace.spans
              : undefined
          ),
        },
        resolveIterationHostExtras(iteration, hostExtras)
      ),
    };
  });
}

/**
 * Convert suite test results for EvalSuite internal auto-save (preserves existing behavior).
 */
export function suiteTestResultsToEvalResultInputs(
  testResults: Map<string, EvalRunResult>,
  expectedToolCallsByTest?: Record<string, EvalExpectedToolCall[]>,
  failOnToolError?: boolean,
  hostExtras?: Record<string, string | number | boolean>,
  predicatesByTest?: Record<string, Predicate[]>,
  matchOptionsByTest?: Record<
    string,
    import("./matchers.js").EvalMatchOptions | undefined
  >,
  caseIdentityByTest?: Record<string, EvalCaseIdentity | undefined>,
  variant?: { provider?: string; model?: string }
): EvalResultInput[] {
  const inputs: EvalResultInput[] = [];
  for (const [testName, testResult] of testResults) {
    const expectedToolCalls = expectedToolCallsByTest?.[testName];
    const predicates = predicatesByTest?.[testName];
    const matchOptions = matchOptionsByTest?.[testName];
    // One steps array per case — see `syntheticStepsForCase`.
    const advancedConfig = syntheticStepsForCase(
      testResult.iterationDetails,
      predicates
    );
    for (let index = 0; index < testResult.iterationDetails.length; index++) {
      const iteration = testResult.iterationDetails[index];
      const prompts = iteration.prompts ?? [];
      const durationMs = iteration.latencies.reduce(
        (sum, latency) => sum + latency.e2eMs,
        0
      );
      const actualToolCalls = actualToolCallsFromPrompts(prompts);
      const traceMessages = traceMessagesFromPrompts(prompts);
      const widgetSnapshots = prompts.flatMap((prompt) =>
        prompt.getWidgetSnapshots()
      );
      const trace = iterationTraceFromPrompts(prompts, traceMessages);

      const passed = finalizePassedForEval({
        matchPassed: iteration.passed,
        trace,
        iterationError: iteration.error,
        failOnToolError,
        predicateResults: iteration.predicateResults,
      });

      const identity = caseIdentityByTest?.[testName];
      const stepResults = stepResultsForIteration({
        iteration,
        prompts,
        expectedToolCalls,
        predicates,
        isNegativeTest: identity?.isNegativeTest,
      });
      inputs.push({
        caseTitle: testName,
        query: prompts[0]?.getPrompt() ?? testName,
        passed,
        status: resolveIterationLifecycleStatus(iteration),
        durationMs: durationMs > 0 ? durationMs : undefined,
        ...variantFromPrompts(prompts, variant),
        expectedToolCalls,
        actualToolCalls: iteration.captureError ? undefined : actualToolCalls,
        ...(identity?.caseId !== undefined
          ? {
              caseId: identity.caseId,
              ...(testResult.runEvaluation
                ? { externalIterationId: `${identity.caseId}:${index}` }
                : {}),
            }
          : {}),
        ...(identity?.externalCaseId !== undefined
          ? { externalCaseId: identity.externalCaseId }
          : {}),
        ...(identity?.intent !== undefined ? { intent: identity.intent } : {}),
        ...(identity?.isNegativeTest !== undefined
          ? { isNegativeTest: identity.isNegativeTest }
          : {}),
        ...(identity?.expectedOutput !== undefined
          ? { expectedOutput: identity.expectedOutput }
          : {}),
        tokens: iteration.captureError
          ? undefined
          : {
              input: iteration.tokens.input,
              output: iteration.tokens.output,
              total: iteration.tokens.total,
            },
        error: iteration.error,
        trace: iteration.captureError ? undefined : trace,
        widgetSnapshots:
          widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
        advancedConfig,
        matchOptions,
        metadata: mergeHostExtrasIntoMetadata(
          {
            testName,
            iterationNumber: index + 1,
            retryCount: iteration.retryCount ?? 0,
            ...(iteration.captureError
              ? {
                  captureError: iteration.captureError,
                  captureCompleteness: "unavailable",
                }
              : {}),
            ...(iteration.predicateResults
              ? { predicates: iteration.predicateResults }
              : {}),
            ...(stepResults.length > 0 ? { stepResults } : {}),
            ...scoreMetadata(iteration, testResult.evaluationConfig),
            ...attachStageMeasurements(
              stageDerivationToMetadata(
                deriveSdkStageResults({
                  iteration,
                  trace,
                  expectedToolCalls,
                  predicates,
                  caseIdentity: identity,
                })
              ),
              trace && typeof trace === "object" && !Array.isArray(trace)
                ? trace.spans
                : undefined
            ),
          },
          resolveIterationHostExtras(iteration, hostExtras)
        ),
      });
    }
  }
  return inputs;
}
