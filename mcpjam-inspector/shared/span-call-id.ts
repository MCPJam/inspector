/** The longest `EvalTraceSpan.callId` the backend keeps. */
export const MAX_SPAN_CALL_ID_LENGTH = 200;

/**
 * An llm span's `callId`: the local org usage writeback's `requestId` for the
 * call (`<turnId>:<stepIndex>`). The backend matches it to the usage row it
 * priced, so the call keeps the organization's rate. Anything but a non-empty
 * string of at most {@link MAX_SPAN_CALL_ID_LENGTH} characters reads as none.
 */
export function parseSpanCallId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SPAN_CALL_ID_LENGTH
    ? value
    : undefined;
}
