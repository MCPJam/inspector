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
