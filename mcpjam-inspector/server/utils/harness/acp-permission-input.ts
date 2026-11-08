/**
 * The input of a call an ACP runtime asks permission for.
 *
 * `@ai-sdk/harness-acp` 1.0.60 holds each tool call's updates for up to a
 * second while it looks for a host-tool match, but answers a permission
 * request at once: the call it emits for the prompt then carries no input, so
 * an approval could not name the MCP server, tool and arguments it is for. The
 * raw ACP updates are emitted unbuffered, and Cursor sends the `rawInput`
 * update before it asks, so the input is restored from the latest one.
 */
import type { HarnessV1 } from "@ai-sdk/harness";
import { withTurnEmit } from "./turn-emit.js";

const MAX_TRACKED_CALLS = 256;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `{ toolCallId, rawInput }` from a raw ACP `tool_call` or `tool_call_update`. */
function rawToolInput(
  rawValue: unknown,
): { toolCallId: string; rawInput: Record<string, unknown> } | undefined {
  const update = record(rawValue);
  if (
    update?.sessionUpdate !== "tool_call" &&
    update?.sessionUpdate !== "tool_call_update"
  )
    return undefined;
  const rawInput = record(update.rawInput);
  return typeof update.toolCallId === "string" &&
    rawInput &&
    Object.keys(rawInput).length > 0
    ? { toolCallId: update.toolCallId, rawInput }
    : undefined;
}

export function withAcpPermissionCallInput<T extends HarnessV1>(harness: T): T {
  return withTurnEmit(harness, (emit) => {
    const inputs = new Map<string, Record<string, unknown>>();
    return (part) => {
      if (part.type === "raw") {
        const seen = rawToolInput(part.rawValue);
        if (seen) {
          if (inputs.size >= MAX_TRACKED_CALLS)
            inputs.delete(inputs.keys().next().value!);
          inputs.set(seen.toolCallId, seen.rawInput);
        }
      } else if (part.type === "tool-call" && part.input === "{}") {
        const rawInput = inputs.get(part.toolCallId);
        if (rawInput) {
          emit({ ...part, input: JSON.stringify(rawInput) });
          return;
        }
      }
      emit(part);
    };
  });
}
