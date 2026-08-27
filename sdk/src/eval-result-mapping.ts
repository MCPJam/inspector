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
  attachStageMeasurements,
  type MeasurementSpanLike,
} from "./contract/stage-measurements.js";
import {
  deriveStageResults,
  stageDerivationToMetadata,
} from "./contract/stage-derivation.js";

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
      overrides.status ?? legacyIterationStatusFromExecutionError(iterationError),
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

export function iterationTraceFromPrompts(
  prompts: PromptResult[],
  traceMessages: Array<{ role: string; content: unknown }>,
  promptSummaries?: PromptTraceSummaryLike[]
): EvalResultInput["trace"] | undefined {
  const mergedSpans = mergePromptSpansForIteration(prompts);
  if (
    traceMessages.length === 0 &&
    mergedSpans.length === 0 &&
    (!promptSummaries || promptSummaries.length === 0)
  ) {
    return undefined;
  }
  return {
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
    query: selectedPrompt?.getPrompt(),
    passed,
    status: resolveIterationLifecycleStatus(iteration),
    durationMs: durationMs > 0 ? durationMs : undefined,
    provider,
    model,
    expectedToolCalls: options.expectedToolCalls,
    actualToolCalls,
    tokens: {
      input: iteration.tokens.input,
      output: iteration.tokens.output,
      total: iteration.tokens.total,
    },
    error: iteration.error,
    trace,
    widgetSnapshots: widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
    metadata: {
      iterationNumber: index + 1,
      retryCount: iteration.retryCount ?? 0,
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
 * Hosted-case identity and semantics carried onto every result row.
 *
 * Separate from `expectedToolCalls` and friends because these three describe
 * WHICH case this is and how it is graded, not what it expected — and the
 * backend reads them to join a local run to a hosted case's history.
 */
/**
 * The spans an iteration trace carries, if it carries any.
 *
 * Defensive because `trace` is an open shape at this layer: a caller-supplied
 * host executor may return no `spans` key at all, and a missing key must mean
 * "no timing samples", never a thrown mapper.
 */
function traceSpansOf(trace: unknown): MeasurementSpanLike[] | undefined {
  if (typeof trace !== "object" || trace === null) return undefined;
  const spans = (trace as { spans?: unknown }).spans;
  return Array.isArray(spans) ? (spans as MeasurementSpanLike[]) : undefined;
}

export type EvalCaseIdentity = {
  /** The case's DECLARED identity — `EvalTestConfig.id`. */
  caseId?: string;
  externalCaseId?: string;
  isNegativeTest?: boolean;
  expectedOutput?: string;
  /**
   * The analytics intent, in its WIRE form.
   *
   * `string | null`, not `string | undefined`, because this crosses an
   * authoritative boundary: a code-authored case that carries no label is
   * saying so, and must send `null` to clear a stale one. Only `undefined`
   * means "this reporter does not speak to intent", which is what a pre-intent
   * SDK sends and what preserves whatever is stored.
   */
  intent?: string | null;
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
      expectsToolCall:
        (expectedToolCalls?.length ?? 0) > 0 ||
        caseIdentity?.isNegativeTest === true,
      // Render observations are not carried on the SDK path, so a case is
      // never treated as asserting a widget render here — claiming otherwise
      // would demand evidence this path cannot produce and report every SDK
      // run's `response` as an evidence gap.
      assertionCount:
        (predicates?.length ?? 0) +
        (caseIdentity?.expectedOutput !== undefined ? 1 : 0),
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
  caseIdentity?: EvalCaseIdentity
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

    return {
      caseTitle: testName,
      query: prompts[0]?.getPrompt() ?? testName,
      passed,
      status: resolveIterationLifecycleStatus(iteration),
      durationMs: durationMs > 0 ? durationMs : undefined,
      expectedToolCalls,
      actualToolCalls,
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
      ...(caseIdentity?.isNegativeTest !== undefined
        ? { isNegativeTest: caseIdentity.isNegativeTest }
        : {}),
      ...(caseIdentity?.expectedOutput !== undefined
        ? { expectedOutput: caseIdentity.expectedOutput }
        : {}),
      // `null` is SENT (an authoritative clear); only `undefined` is omitted.
      ...(caseIdentity?.intent !== undefined
        ? { intent: caseIdentity.intent }
        : {}),
      tokens: {
        input: iteration.tokens.input,
        output: iteration.tokens.output,
        total: iteration.tokens.total,
      },
      error: iteration.error,
      trace,
      widgetSnapshots: widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
      advancedConfig,
      matchOptions,
      metadata: mergeHostExtrasIntoMetadata(
        {
          retryCount: iteration.retryCount ?? 0,
          iterationNumber: index + 1,
          ...(iteration.predicateResults
            ? { predicates: iteration.predicateResults }
            : {}),
          ...scoreMetadata(iteration, evaluationConfig),
          // Measurements ride WITH the chain, derived from the rows actually
          // serialized here — one helper, shared with the hosted finalizer, so
          // there is exactly one timing derivation in the product.
          ...attachStageMeasurements(
            stageDerivationToMetadata(stageDerivation),
            traceSpansOf(trace)
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
  caseIdentityByTest?: Record<string, EvalCaseIdentity | undefined>
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
      inputs.push({
        caseTitle: testName,
        query: prompts[0]?.getPrompt() ?? testName,
        passed,
        status: resolveIterationLifecycleStatus(iteration),
        durationMs: durationMs > 0 ? durationMs : undefined,
        expectedToolCalls,
        actualToolCalls,
        ...(identity?.caseId !== undefined ? { caseId: identity.caseId } : {}),
        ...(identity?.externalCaseId !== undefined
          ? { externalCaseId: identity.externalCaseId }
          : {}),
        ...(identity?.isNegativeTest !== undefined
          ? { isNegativeTest: identity.isNegativeTest }
          : {}),
        ...(identity?.expectedOutput !== undefined
          ? { expectedOutput: identity.expectedOutput }
          : {}),
        // `null` is SENT (an authoritative clear); only `undefined` is omitted.
        ...(identity?.intent !== undefined ? { intent: identity.intent } : {}),
        tokens: {
          input: iteration.tokens.input,
          output: iteration.tokens.output,
          total: iteration.tokens.total,
        },
        error: iteration.error,
        trace,
        widgetSnapshots:
          widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
        advancedConfig,
        matchOptions,
        metadata: mergeHostExtrasIntoMetadata(
          {
            testName,
            iterationNumber: index + 1,
            retryCount: iteration.retryCount ?? 0,
            ...(iteration.predicateResults
              ? { predicates: iteration.predicateResults }
              : {}),
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
              traceSpansOf(trace)
            ),
          },
          resolveIterationHostExtras(iteration, hostExtras)
        ),
      });
    }
  }
  return inputs;
}
