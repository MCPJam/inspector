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
      typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
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
