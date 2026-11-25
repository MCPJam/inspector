import type { EvalTraceSpan } from "./eval-trace";

/**
 * The trace's mark for a tool call a mock answered itself. It is a span under
 * the call, named with this prefix, because a trace span has no field for it
 * and the result a model reads must carry none.
 */
export const MOCK_ANSWER_SPAN_PREFIX = "Answered by the mock: ";

/** What a tool call's mark says ("its saved answer"), or undefined when a mock did not answer it. */
export function mockAnswerOf(
  tool: EvalTraceSpan,
  spans: readonly EvalTraceSpan[] | null | undefined,
): string | undefined {
  const mark = spans?.find(
    (s) => s.parentId === tool.id && s.name.startsWith(MOCK_ANSWER_SPAN_PREFIX),
  );
  return mark?.name.slice(MOCK_ANSWER_SPAN_PREFIX.length);
}
