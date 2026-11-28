/**
 * `/mcpjam/iteration.json`: what a code evaluator grades (EFTW-90).
 *
 * The evaluator library's versioned input, `EvaluatorContextV1`: the case,
 * the transcript the deterministic checks read (tool calls, results, the final
 * answer, usage), the message trace, and the expected output and tool calls.
 * ONE builder, so a run's grading box and "Test on a past iteration" hand a
 * script the same document for the same iteration.
 */
import type { EvaluatorContextV1 } from "@mcpjam/sdk/contract";
import { buildIterationTranscript } from "@/shared/eval-matching";

type TranscriptInput = Parameters<typeof buildIterationTranscript>[0];

export type GradingInputSource = {
  scenario: {
    title: string;
    isNegativeTest?: boolean;
    scenarioKey?: string;
  };
  /** The model-visible or trace messages the iteration persisted, in order. */
  messages: Array<{ role: string; content: unknown }>;
  /** The calls the matcher graded (`evaluation.toolsCalled`). */
  toolCalls: TranscriptInput["toolCalls"];
  usage?: TranscriptInput["usage"];
  expectedOutput?: string;
  expectedToolCalls?: EvaluatorContextV1["expectedToolCalls"];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

type Named = Record<string, unknown> & { toolName: string };

function named(value: Record<string, unknown>): value is Named {
  return typeof value.toolName === "string";
}

function isMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { role: string; content: unknown } {
  return typeof value.role === "string";
}

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const;

/**
 * The source a run built its input from, read back off the stored iteration
 * and its trace (`getTestIteration`, `getTestIterationBlob`). Rows pass
 * through as stored, as a run passes its own; a malformed one is left out
 * rather than guessed at.
 */
export function gradingInputSourceFromStored(
  iteration: unknown,
  trace: unknown,
): GradingInputSource {
  const row = record(iteration);
  const snapshot = record(row.testCaseSnapshot);
  const usage = record(row.usage);
  const usageTotals: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      usageTotals[key] = value;
    }
  }
  const expectedToolCalls = list(snapshot.expectedToolCalls)
    .filter(named)
    .map(({ arguments: args, ...call }) => ({
      ...call,
      ...(args === undefined ? {} : { arguments: record(args) }),
    }));
  return {
    scenario: {
      title: typeof snapshot.title === "string" ? snapshot.title : "",
      ...(snapshot.isNegativeTest === true ? { isNegativeTest: true } : {}),
    },
    messages: list(record(trace).messages).filter(isMessage),
    toolCalls: list(row.actualToolCalls)
      .filter(named)
      .map(({ arguments: args, ...call }) => ({
        ...call,
        arguments: record(args),
      })),
    ...(Object.keys(usageTotals).length ? { usage: usageTotals } : {}),
    ...(typeof snapshot.expectedOutput === "string" && snapshot.expectedOutput
      ? { expectedOutput: snapshot.expectedOutput }
      : {}),
    ...(expectedToolCalls.length ? { expectedToolCalls } : {}),
  };
}

export function buildGradingInput(
  source: GradingInputSource,
): EvaluatorContextV1 {
  const transcript = buildIterationTranscript({
    trace: { messages: source.messages } as TranscriptInput["trace"],
    toolCalls: source.toolCalls,
    ...(source.usage ? { usage: source.usage } : {}),
  });
  return {
    version: 1,
    scenario: {
      title: source.scenario.title,
      ...(source.scenario.isNegativeTest ? { isNegativeTest: true } : {}),
      ...(source.scenario.scenarioKey
        ? { scenarioKey: source.scenario.scenarioKey }
        : {}),
    },
    transcript,
    trace: { messages: source.messages },
    ...(source.expectedOutput ? { expectedOutput: source.expectedOutput } : {}),
    ...(source.expectedToolCalls?.length
      ? { expectedToolCalls: source.expectedToolCalls }
      : {}),
    ...(source.usage ? { usage: source.usage } : {}),
  };
}
