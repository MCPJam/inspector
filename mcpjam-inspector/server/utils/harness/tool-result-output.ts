import { toModelMessageToolOutput } from "../normalize-model-messages-for-convex.js";

/** Build the persisted `tool-result` `output` for a harness tool result, matching
 *  the emulated engine's canonical single-wrap shape (shared/http-tool-calls.ts).
 *
 *  The harness `tool-result` part's `.output` (`event.result`) is the RAW result
 *  for most tools, but some tools — and computer-use / image results — already
 *  hand back an already-typed `{type, value}` output. Blindly wrapping that as
 *  `{type:"json", value: rawOutput}` produced the double-nested
 *  `{type:json,value:{type:json,value:…}}` seen in persisted transcripts. So:
 *  errors → `error-text`; a typed output whose value fits its tag passes
 *  through unchanged; anything else is wrapped once as `{type:"json", value}`. */
export function toToolResultOutput(
  rawOutput: unknown,
  isError: boolean,
): { type: string; value?: unknown } {
  if (isError) {
    // `JSON.stringify(undefined)` is `undefined`, not `"undefined"`, so a
    // failed tool with no payload would produce a value that serializes away
    // and fails `modelMessageSchema` — an invalid message describing an error.
    const text =
      typeof rawOutput === "string"
        ? rawOutput
        : (harnessToolOutputError(rawOutput) ?? JSON.stringify(rawOutput));
    return {
      type: "error-text",
      value: text ?? "The tool reported an error with no payload.",
    };
  }
  // Delegated rather than re-decided here: the local copy of this rule
  // recognized four output types where the schema has five (it dropped
  // `error-json`, so a genuine one was re-wrapped as `json` and lost its
  // error signal), and it trusted the type tag without checking the value
  // against it.
  return toModelMessageToolOutput(rawOutput) ?? { type: "json", value: null };
}

/**
 * The error an ACP runtime reports inside a tool result, or `undefined`.
 *
 * ACP marks a failed MCP call `completed` with `rawOutput: { error }` rather
 * than `failed`, so the result arrives looking successful. Cursor's own 60 s
 * MCP timeout reaches MCPJam exactly this way. Only that exact shape counts: an
 * object whose single key is a non-empty `error` string.
 */
export function harnessToolOutputError(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return undefined;
  const keys = Object.keys(output);
  const error: unknown = Reflect.get(output, "error");
  return keys.length === 1 && typeof error === "string" && error.trim()
    ? error
    : undefined;
}
