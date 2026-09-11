/**
 * The adapter-to-renderer channel for a READABLE tool result.
 *
 * Under `toolResultDisplay: "attached-to-tool"` the trace adapter writes the
 * readable rendering of a tool result onto the tool part itself — the text as
 * `traceDisplayText`, and how to render it as `traceDisplayMode`. Neither is
 * part of the public part types: this is an internal channel between the two
 * halves of the package, and a part that never went through the adapter simply
 * has no such field.
 *
 * The reason it lives in its own module rather than being read inline at each
 * end: it was read inline at each end, and the ends disagreed. The inspector's
 * `chat-v2` `ToolPart` required a recognised `traceDisplayMode`; this package's
 * `PartSwitch` ignored the mode entirely and accepted any non-empty string,
 * including whitespace, which `ToolCallPart` then rejected on its own stricter
 * test. Three readers, three answers, for one channel with one producer. One
 * function instead, imported by all of them.
 */

/**
 * How `traceDisplayText` is meant to be rendered. Both values are markdown —
 * `json-markdown` is a payload the adapter already wrapped in a ```json fence —
 * which is why one `Markdown` render serves both.
 */
export type TraceDisplayMode = "markdown" | "json-markdown";

const TRACE_DISPLAY_MODES: readonly TraceDisplayMode[] = [
  "markdown",
  "json-markdown",
];

export function isTraceDisplayMode(value: unknown): value is TraceDisplayMode {
  return TRACE_DISPLAY_MODES.includes(value as TraceDisplayMode);
}

/**
 * The readable result a trace adapter attached to this part, or `undefined`.
 *
 * BLANK IS NOT A TRANSLATION. A tool whose text content is whitespace produced
 * nothing to read, and accepting it would replace the payload with an empty
 * block — losing the only copy of the result on the one surface that shows it.
 *
 * AN UNRECOGNISED MODE IS NOT A TRANSLATION EITHER. The mode is the producer's
 * statement that the text is markdown; rendering some future mode as markdown
 * regardless is how a renderer starts lying about content it cannot read. A
 * reader that does not understand the claim falls back to the raw payload,
 * which is always still correct.
 *
 * A MISSING mode is deliberately not the same as an unrecognised one. Absent
 * means no claim was made, and every producer that has ever written this field
 * wrote markdown; treating that as "no result" would re-open BB-198 for any
 * caller that sets the text and forgets the mode, which is a worse failure than
 * rendering plain prose through a markdown renderer.
 */
export function readTraceDisplayText(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const { traceDisplayText, traceDisplayMode } = part as {
    traceDisplayText?: unknown;
    traceDisplayMode?: unknown;
  };
  if (typeof traceDisplayText !== "string") return undefined;
  if (traceDisplayText.trim().length === 0) return undefined;
  if (traceDisplayMode !== undefined && !isTraceDisplayMode(traceDisplayMode)) {
    return undefined;
  }
  return traceDisplayText;
}
