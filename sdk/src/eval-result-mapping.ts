/**
 * Shared utilities for converting iteration results to EvalResultInput payloads.
 * Used by EvalTest, EvalSuite, and EvalRunReporter helpers.
 */

import type { IterationResult } from "./EvalTest.js";
import type { EvalRunResult } from "./EvalTest.js";
import type {
  EvalResultInput,
  EvalExpectedToolCall,
} from "./eval-reporting-types.js";
import type { PromptResult } from "./PromptResult.js";

/**
 * Options for converting a single iteration to an EvalResultInput.
 */
export interface IterationToEvalResultOptions {
  caseTitle: string;
  provider?: string;
  model?: string;
  expectedToolCalls?: EvalExpectedToolCall[];
  promptSelector?: "first" | "last";
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

  // Use iteration-level tokens (already pre-aggregated by EvalTest)
  const durationMs = iteration.latencies.reduce(
    (sum, latency) => sum + latency.e2eMs,
    0
  );

  // Resolve provider/model: explicit options > selected prompt metadata > undefined
  const provider = options.provider ?? selectedPrompt?.getProvider();
  const model = options.model ?? selectedPrompt?.getModel();

  return {
    caseTitle: options.caseTitle,
    query: selectedPrompt?.getPrompt(),
    passed: iteration.passed,
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
    trace: traceMessages.length > 0 ? { messages: traceMessages } : undefined,
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
  expectedToolCalls?: EvalExpectedToolCall[]
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

    return {
      caseTitle: testName,
      query: prompts[0]?.getPrompt() ?? testName,
      passed: iteration.passed,
      durationMs: durationMs > 0 ? durationMs : undefined,
      expectedToolCalls,
      actualToolCalls,
      tokens: {
        input: iteration.tokens.input,
        output: iteration.tokens.output,
        total: iteration.tokens.total,
      },
      error: iteration.error,
      trace:
        traceMessages.length > 0
          ? {
              messages: traceMessages,
            }
          : undefined,
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
  expectedToolCallsByTest?: Record<string, EvalExpectedToolCall[]>
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

      inputs.push({
        caseTitle: testName,
        query: prompts[0]?.getPrompt() ?? testName,
        passed: iteration.passed,
        durationMs: durationMs > 0 ? durationMs : undefined,
        expectedToolCalls,
        actualToolCalls,
        tokens: {
          input: iteration.tokens.input,
          output: iteration.tokens.output,
          total: iteration.tokens.total,
        },
        error: iteration.error,
        trace:
          traceMessages.length > 0
            ? {
                messages: traceMessages,
              }
            : undefined,
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
