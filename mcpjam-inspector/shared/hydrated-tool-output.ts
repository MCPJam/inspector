/**
 * The output a persisted tool result hydrates back into.
 *
 * A reopened conversation is rebuilt in the browser from the persisted
 * transcript (`client/src/lib/transcript-to-ui-messages.ts`). There, each
 * `role: "tool"` result is merged into its assistant `tool-call` part and the
 * part's `output` is picked by {@link readHydratedToolOutput}. The server signs
 * that SAME value when it persists a result (MJ-009 history provenance), so the
 * value must be computed by one implementation on both sides — this one.
 */

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Strip up to four nested `{ type: "json", value }` envelopes. */
export function unwrapJsonEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const record = current as Record<string, unknown>;
    if (record.type !== "json" || !hasOwn(record, "value")) {
      return current;
    }
    current = record.value;
  }
  return current;
}

/**
 * Whether a model-facing output carries images (or the placeholders left
 * where images were omitted), in which case the raw `result` is the better
 * copy for the UI.
 */
export function isModelVisibleImageOutput(value: unknown): boolean {
  const output = unwrapJsonEnvelope(value);
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  if (record.type !== "content" || !Array.isArray(record.value)) {
    return false;
  }
  return record.value.some((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      return (
        partRecord.text.startsWith("[image omitted:") ||
        partRecord.text.startsWith("[resource link omitted:") ||
        partRecord.text.startsWith("[embedded image resource omitted:")
      );
    }
    return (
      (partRecord.type === "media" || partRecord.type === "image-data") &&
      typeof partRecord.mediaType === "string" &&
      partRecord.mediaType.startsWith("image/")
    );
  });
}

/**
 * The output a hydrated tool-call part shows, from the `result` / `output`
 * fields merged onto it. Image traces may carry model-facing media in `output`
 * and raw MCP JSON in `result`; legacy widget traces may carry raw widget data
 * in `output`.
 */
export function readHydratedToolOutput(part: Record<string, unknown>): unknown {
  const hasResult = hasOwn(part, "result");
  const hasOutput = hasOwn(part, "output");
  if (hasResult && hasOutput && isModelVisibleImageOutput(part.output)) {
    return part.result;
  }
  if (hasOutput) return part.output;
  if (hasResult) return part.result;
  return {};
}

/**
 * {@link readHydratedToolOutput} for a persisted `tool-result` part, applying
 * the merge `mergeTranscriptToolResults` performs first: `result` falls back
 * to `output`, and each field is copied only when it is defined.
 */
export function hydratedToolResultOutput(toolResult: {
  result?: unknown;
  output?: unknown;
}): unknown {
  const merged: Record<string, unknown> = {};
  const mergedResult =
    toolResult.result !== undefined ? toolResult.result : toolResult.output;
  if (mergedResult !== undefined) merged.result = mergedResult;
  if (toolResult.output !== undefined) merged.output = toolResult.output;
  return readHydratedToolOutput(merged);
}
