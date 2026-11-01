/**
 * The one reader for the envelopes a tool result travels in.
 *
 * A result reaches a reader in whatever shape the last hop left it: the string
 * an `execute` returned, an AI SDK model output (`{ type, value }`), or that
 * output wrapped in `{ type: "json", value }` by `convertToModelMessages`,
 * once for every round trip through history. Readers unwrap through here so
 * they agree on the shape, and so reaching the depth limit is reported rather
 * than read as an ordinary value: a security check that took "too deep to
 * read" for "nothing there" would open exactly when the wrapping drifted.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonEnvelope(
  value: unknown,
): value is { type: "json"; value: unknown } {
  return (
    isRecord(value) &&
    value.type === "json" &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
}

export type ToolOutputUnwrap =
  | { status: "ok"; value: unknown }
  /** `value` is where unwrapping stopped: still a `json` envelope. */
  | { status: "limit_exceeded"; value: unknown };

/** Strips up to `maxDepth` nested `{ type: "json", value }` envelopes. */
export function unwrapToolOutputEnvelope(
  value: unknown,
  maxDepth: number,
): ToolOutputUnwrap {
  let current = value;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!isJsonEnvelope(current)) return { status: "ok", value: current };
    current = current.value;
  }
  return isJsonEnvelope(current)
    ? { status: "limit_exceeded", value: current }
    : { status: "ok", value: current };
}

/**
 * Deep enough for every wrapping a result picks up in practice (one per
 * history round trip), and shallow enough that a crafted nest stays cheap.
 */
export const TOOL_OUTPUT_TEXT_DEPTH = 16;

export interface ToolOutputText {
  /** `error-text` is a failed call's message, never content it produced. */
  kind: "text" | "error-text";
  value: string;
}

export type ToolOutputTexts =
  | { status: "ok"; texts: ToolOutputText[] }
  | { status: "limit_exceeded" }
  /** An object this reader does not know, so its text cannot be told. */
  | { status: "unrecognized" };

/**
 * The text a tool result carries, in any of the shapes it can arrive in.
 *
 * Known shapes without text (a denied execution, an error object) read as
 * `ok` with no texts. Anything else is `unrecognized`, which a caller deciding
 * a security question must not treat as "no text".
 */
export function readToolOutputTexts(
  output: unknown,
  maxDepth: number = TOOL_OUTPUT_TEXT_DEPTH,
): ToolOutputTexts {
  const unwrapped = unwrapToolOutputEnvelope(output, maxDepth);
  if (unwrapped.status === "limit_exceeded") {
    return { status: "limit_exceeded" };
  }
  const value = unwrapped.value;
  if (typeof value === "string") {
    return { status: "ok", texts: [{ kind: "text", value }] };
  }
  if (!isRecord(value)) return { status: "unrecognized" };
  if (
    (value.type === "text" || value.type === "error-text") &&
    typeof value.value === "string"
  ) {
    return { status: "ok", texts: [{ kind: value.type, value: value.value }] };
  }
  if (value.type === "content" && Array.isArray(value.value)) {
    const texts: ToolOutputText[] = [];
    for (const part of value.value) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        texts.push({ kind: "text", value: part.text });
      }
    }
    return { status: "ok", texts };
  }
  if (value.type === "execution-denied" || value.type === "error-json") {
    return { status: "ok", texts: [] };
  }
  return { status: "unrecognized" };
}
