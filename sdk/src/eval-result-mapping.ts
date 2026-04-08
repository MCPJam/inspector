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
import type { PromptResult } from "./PromptResult.js";
import { finalizePassedForEval } from "./eval-tool-execution.js";

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

function normalizeExpectedToolCalls(
  value: unknown
): EvalExpectedToolCall[] {
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

function extractPromptTurns(
  overrides: PromptsToEvalResultOverrides
): PromptTurnLike[] {
  const rawTurns = (overrides.advancedConfig as { promptTurns?: unknown } | undefined)
    ?.promptTurns;
  if (Array.isArray(rawTurns) && rawTurns.length > 0) {
    return rawTurns
      .filter((turn) => turn && typeof turn === "object")
      .map((turn, index) => {
        const raw = turn as {
          prompt?: unknown;
          expectedToolCalls?: unknown;
          expectedOutput?: unknown;
        };
        return {
          prompt:
            typeof raw.prompt === "string"
              ? raw.prompt
              : index === 0
                ? overrides.query ?? ""
                : "",
          expectedToolCalls: normalizeExpectedToolCalls(raw.expectedToolCalls),
          expectedOutput:
            typeof raw.expectedOutput === "string"
              ? raw.expectedOutput
              : undefined,
        };
      });
  }

  return [
    {
      prompt: overrides.query ?? "",
      expectedToolCalls: normalizeExpectedToolCalls(overrides.expectedToolCalls),
      expectedOutput: undefined,
    },
  ];
}

function argumentsMatch(
  expectedArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>
): boolean {
  return Object.entries(expectedArgs).every(([key, value]) => {
    return JSON.stringify(actualArgs?.[key]) === JSON.stringify(value);
  });
}

function evaluatePromptSummary(params: {
  promptIndex: number;
  prompt: string;
  expectedToolCalls: EvalExpectedToolCall[];
  actualToolCalls: EvalExpectedToolCall[];
  expectedOutput?: string;
  isNegativeTest?: boolean;
}): PromptTraceSummaryLike {
  const {
    promptIndex,
    prompt,
    expectedToolCalls,
    actualToolCalls,
    expectedOutput,
    isNegativeTest,
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

  const matchedActual = new Set<number>();
  const missing: EvalExpectedToolCall[] = [];
  const argumentMismatches: PromptTraceSummaryLike["argumentMismatches"] = [];

  for (const expectedCall of expectedToolCalls) {
    const exactMatchIndex = actualToolCalls.findIndex((actualCall, index) => {
      if (matchedActual.has(index)) {
        return false;
      }
      return (
        actualCall.toolName === expectedCall.toolName &&
        argumentsMatch(expectedCall.arguments ?? {}, actualCall.arguments ?? {})
      );
    });

    if (exactMatchIndex >= 0) {
      matchedActual.add(exactMatchIndex);
      continue;
    }

    const toolOnlyMatchIndex = actualToolCalls.findIndex((actualCall, index) => {
      if (matchedActual.has(index)) {
        return false;
      }
      return actualCall.toolName === expectedCall.toolName;
    });

    if (toolOnlyMatchIndex >= 0) {
      matchedActual.add(toolOnlyMatchIndex);
      argumentMismatches.push({
        toolName: expectedCall.toolName,
        expectedArgs: expectedCall.arguments ?? {},
        actualArgs: actualToolCalls[toolOnlyMatchIndex]?.arguments ?? {},
      });
      continue;
    }

    missing.push(expectedCall);
  }

  return {
    promptIndex,
    prompt,
    expectedToolCalls,
    actualToolCalls,
    expectedOutput,
    missing,
    unexpected: actualToolCalls.filter((_, index) => !matchedActual.has(index)),
    argumentMismatches,
    passed: missing.length === 0 && argumentMismatches.length === 0,
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
    })
  );
  const trace = iterationTraceFromPrompts(prompts, traceMessages, promptSummaries);

  const inputTokens = prompts.reduce((sum, p) => sum + p.inputTokens(), 0);
  const outputTokens = prompts.reduce((sum, p) => sum + p.outputTokens(), 0);
  const totalTokens = prompts.reduce((sum, p) => sum + p.totalTokens(), 0);

  const durationSum = prompts.reduce(
    (sum, p) => sum + p.e2eLatencyMs(),
    0
  );

  const errorParts = prompts
    .map((p) => p.getError())
    .filter(
      (e): e is string => typeof e === "string" && e.trim().length > 0
    );
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

function iterationTraceFromPrompts(
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
    query: selectedPrompt?.getPrompt(),
    passed,
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
}

/**
 * Convert all iterations from an EvalRunResult to EvalResultInput payloads.
 */
export function runToEvalResults(
  run: EvalRunResult,
  options: RunToEvalResultsOptions
): EvalResultInput[] {
  return run.iterationDetails.map((iteration, index) =>
    iterationToEvalResult(iteration, index, {
      caseTitle: `${options.casePrefix}-iter-${index + 1}`,
      provider: options.provider,
      model: options.model,
      expectedToolCalls: options.expectedToolCalls,
      promptSelector: options.promptSelector,
      failOnToolError: options.failOnToolError,
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
    });
    results.push(...testResults);
  }

  return results;
}

/**
 * Convert iterations for EvalTest internal auto-save (preserves existing behavior).
 */
export function iterationsToEvalResultInputs(
  testName: string,
  iterations: IterationResult[],
  expectedToolCalls?: EvalExpectedToolCall[],
  failOnToolError?: boolean
): EvalResultInput[] {
  return iterations.map((iteration, index) => {
    const prompts = iteration.prompts ?? [];
    const durationMs = iteration.latencies.reduce(
      (sum, latency) => sum + latency.e2eMs,
      0
    );
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
    const trace = iterationTraceFromPrompts(prompts, traceMessages);

    const passed = finalizePassedForEval({
      matchPassed: iteration.passed,
      trace,
      iterationError: iteration.error,
      failOnToolError,
    });

    return {
      caseTitle: testName,
      query: prompts[0]?.getPrompt() ?? testName,
      passed,
      durationMs: durationMs > 0 ? durationMs : undefined,
      expectedToolCalls,
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
        retryCount: iteration.retryCount ?? 0,
        iterationNumber: index + 1,
      },
    };
  });
}

/**
 * Convert suite test results for EvalSuite internal auto-save (preserves existing behavior).
 */
export function suiteTestResultsToEvalResultInputs(
  testResults: Map<string, EvalRunResult>,
  expectedToolCallsByTest?: Record<string, EvalExpectedToolCall[]>,
  failOnToolError?: boolean
): EvalResultInput[] {
  const inputs: EvalResultInput[] = [];
  for (const [testName, testResult] of testResults) {
    const expectedToolCalls = expectedToolCallsByTest?.[testName];
    for (let index = 0; index < testResult.iterationDetails.length; index++) {
      const iteration = testResult.iterationDetails[index];
      const prompts = iteration.prompts ?? [];
      const durationMs = iteration.latencies.reduce(
        (sum, latency) => sum + latency.e2eMs,
        0
      );
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
      const trace = iterationTraceFromPrompts(prompts, traceMessages);

      const passed = finalizePassedForEval({
        matchPassed: iteration.passed,
        trace,
        iterationError: iteration.error,
        failOnToolError,
      });

      inputs.push({
        caseTitle: testName,
        query: prompts[0]?.getPrompt() ?? testName,
        passed,
        durationMs: durationMs > 0 ? durationMs : undefined,
        expectedToolCalls,
        actualToolCalls,
        tokens: {
          input: iteration.tokens.input,
          output: iteration.tokens.output,
          total: iteration.tokens.total,
        },
        error: iteration.error,
        trace,
        widgetSnapshots:
          widgetSnapshots.length > 0 ? widgetSnapshots : undefined,
        metadata: {
          testName,
          iterationNumber: index + 1,
          retryCount: iteration.retryCount ?? 0,
        },
      });
    }
  }
  return inputs;
}
