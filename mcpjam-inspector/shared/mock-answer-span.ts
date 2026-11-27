import type { EvalTraceSpan } from "./eval-trace";

/**
 * The trace's mark for a tool call a mock handled. It is a span under the
 * call, named with this prefix, because a trace span has no field for it and
 * the result a model reads must carry none.
 */
export const MOCK_ANSWER_SPAN_PREFIX = "Answered by the mock: ";

/** Where a mock's answer to one call came from. */
export type MockCallSource = "saved" | "state" | "forwarded" | "blocked" | "unmatched";

/** What the trace records about one call a mock handled. */
export interface MockCallMark {
  mockId: string;
  version: number;
  /** The name the client called. */
  tool: string;
  source: MockCallSource;
  /** For a forward (or a blocked one): the real server and the tool that was, or would have been, called. */
  realServerId?: string;
  realTool?: string;
  /** For a saved answer: which case answered, counted from 0 (the text counts from 1). */
  caseIndex?: number;
  /** The answering case has no `when`, so it answers any input. */
  catchAll?: boolean;
  /** Why a call was refused, in the SDK's words (`blocked_by_policy`, `no_access`...). */
  refusal?: string;
}

/** The saved answer's words. A catch-all says so: a run that passes on one may have met an input nobody planned. */
function savedAnswerText(mark: MockCallMark): string {
  const n = mark.caseIndex === undefined ? undefined : mark.caseIndex + 1;
  if (mark.catchAll) {
    return n === undefined
      ? "its catch-all answer (which matches any input)"
      : `its catch-all answer (case ${n}, which matches any input)`;
  }
  return n === undefined ? "its saved answer" : `its saved answer (case ${n})`;
}

/** The mark as a sentence ("its saved answer (case 1)"), with the mock and version it came from. */
export function describeMockCall(mark: MockCallMark): string {
  const real = mark.realTool
    ? `${mark.realTool}${mark.realServerId ? ` on server ${mark.realServerId}` : ""}`
    : "the real tool";
  const what =
    mark.source === "saved"
      ? savedAnswerText(mark)
      : mark.source === "state"
        ? "its records"
        : mark.source === "forwarded"
          ? `forwarded to ${real}`
          : mark.source === "blocked"
            ? `a forward to ${real} was refused${mark.refusal ? ` (${mark.refusal})` : ""}`
            : "no saved answer matched";
  return `${what} (mock ${mark.mockId}, version ${mark.version})`;
}

/** What a tool call's mark says, or undefined when a mock did not handle it. */
export function mockAnswerOf(
  tool: EvalTraceSpan,
  spans: readonly EvalTraceSpan[] | null | undefined,
): string | undefined {
  const mark = spans?.find(
    (s) => s.parentId === tool.id && s.name.startsWith(MOCK_ANSWER_SPAN_PREFIX),
  );
  return mark?.name.slice(MOCK_ANSWER_SPAN_PREFIX.length);
}
