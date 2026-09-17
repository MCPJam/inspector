/**
 * Closing a partial turn safely — Layer 3 of the turn-outcome contract.
 *
 * A turn that ends abnormally can leave a tool call with no result. Persisting
 * that history as-is is not merely untidy: on the NEXT turn the emulated engine
 * runs every unresolved call in history, so a call the user pressed Stop on
 * would execute for real afterwards. Closing the call with a synthetic result
 * is what makes a stopped turn safe to persist at all.
 *
 * TWO STATES, NEVER ONE. A call with no result either never started, or was
 * dispatched and lost its result. The second may have taken effect on somebody's
 * real system, and the text says so — to the model and to the reader. Collapsing
 * them into one reassuring sentence would make that sentence a lie exactly where
 * it matters. Closing the call prevents automatic REPLAY; it cannot undo an
 * external effect, and nothing here pretends otherwise.
 *
 * DETERMINISTIC, because two different places apply it to the same turn — the
 * client on Stop, and the server at persist time — and web chat ingests the FULL
 * history every turn. If the two produced different bytes, the stopped turn's
 * persist and the next turn's persist would disagree about a message that
 * already exists, and whichever landed last would win. Given the same inputs
 * this produces byte-identical output: no timestamps, no ids, no map iteration
 * order, no locale.
 *
 * PAUSED TURNS ARE LEFT OPEN. A paused turn's dangling tool call IS the resume
 * handle — closing it would destroy the thing the next request needs. See
 * `needsToolCallClosure`.
 */
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { UnresolvedToolCallState } from "./turn-outcome";

/** One unresolved call, with the only two states it can be in. */
export type UnresolvedToolCall = {
  toolCallId: string;
  toolName: string;
  state: UnresolvedToolCallState;
};

/**
 * What the model — and the person reading the transcript — is told.
 *
 * Exported because the backend's judge projection and the UI label both quote
 * them, and a reader who meets this sentence in a transcript and one who meets
 * it in a chip should be reading the same words.
 */
export const INTERRUPTED_TOOL_CALL_TEXT: Record<UnresolvedToolCallState, string> =
  {
    never_started: "Interrupted before this tool call started.",
    outcome_unknown:
      "Interrupted after this tool call was sent; its outcome is unknown and it may have taken effect.",
  };

/** The provider-options namespace the synthetic results are stamped with, so a
 *  reader can tell a closure apart from a tool that genuinely errored. */
export const INTERRUPTED_TOOL_CALL_PROVIDER_KEY = "mcpjam";

type ToolCallLike = { toolCallId: string; toolName: string };

/**
 * Every tool call in `messages` that has no matching tool-result.
 *
 * Returned in HISTORY ORDER (assistant message order, then part order within a
 * message), never in `Set` insertion or map order, because this list is written
 * into a persisted record that two sides must agree on byte for byte.
 */
export function listUnresolvedToolCalls(
  messages: readonly ModelMessage[],
  stateOf: (toolCallId: string) => UnresolvedToolCallState,
): UnresolvedToolCall[] {
  const resolved = collectResolvedToolCallIds(messages);
  const out: UnresolvedToolCall[] = [];
  const seen = new Set<string>();
  for (const call of iterateToolCalls(messages)) {
    if (resolved.has(call.toolCallId) || seen.has(call.toolCallId)) continue;
    seen.add(call.toolCallId);
    out.push({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      state: stateOf(call.toolCallId),
    });
  }
  return out;
}

/**
 * Append synthetic `error-text` tool results for every unresolved call.
 *
 * Returns a NEW array; the input is never mutated, because the caller's copy is
 * often the live history another closure is still reading.
 *
 * One tool message per closure, appended in history order, so the result is a
 * pure function of the input. The shape matches the auto-deny path, which
 * already splices an `error-text` result for a call that will not run.
 */
export function closeUnresolvedToolCalls(
  messages: readonly ModelMessage[],
  states: readonly UnresolvedToolCall[],
  opts?: { turnId?: string },
): ModelMessage[] {
  if (states.length === 0) return [...messages];
  const resolved = collectResolvedToolCallIds(messages);
  const closures: ModelMessage[] = [];
  const seen = new Set<string>();
  for (const call of states) {
    // Idempotent: closing an already-closed history is a no-op, which is what
    // makes it safe for the client and the server to both apply it.
    if (resolved.has(call.toolCallId) || seen.has(call.toolCallId)) continue;
    seen.add(call.toolCallId);
    closures.push(buildClosureMessage(call, opts?.turnId));
  }
  return [...messages, ...closures];
}

/** The single tool message a closed call becomes. Shared so the client's
 *  projection and the server's write cannot drift. */
export function buildClosureMessage(
  call: UnresolvedToolCall,
  turnId?: string,
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          type: "error-text",
          value: INTERRUPTED_TOOL_CALL_TEXT[call.state],
        },
        providerOptions: {
          [INTERRUPTED_TOOL_CALL_PROVIDER_KEY]: {
            interrupted: call.state,
            // Omitted rather than nulled when absent: an explicit `null` would
            // change the serialized bytes the two sides must agree on.
            ...(turnId ? { turnId } : {}),
          },
        },
      },
    ],
  } as unknown as ModelMessage;
}

/** Was this tool-result written by a closure rather than by a tool? */
export function isInterruptedToolResult(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const options = (part as { providerOptions?: unknown }).providerOptions;
  if (!options || typeof options !== "object") return false;
  const mcpjam = (options as Record<string, unknown>)[
    INTERRUPTED_TOOL_CALL_PROVIDER_KEY
  ];
  if (!mcpjam || typeof mcpjam !== "object") return false;
  const interrupted = (mcpjam as Record<string, unknown>).interrupted;
  return interrupted === "never_started" || interrupted === "outcome_unknown";
}

// ---------------------------------------------------------------------------

function collectResolvedToolCallIds(
  messages: readonly ModelMessage[],
): Set<string> {
  const resolved = new Set<string>();
  for (const message of messages) {
    if (!message || message.role !== "tool") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part?.type === "tool-result" &&
        typeof part.toolCallId === "string" &&
        part.toolCallId
      ) {
        resolved.add(part.toolCallId);
      }
    }
  }
  return resolved;
}

function* iterateToolCalls(
  messages: readonly ModelMessage[],
): Generator<ToolCallLike> {
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part?.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        part.toolCallId
      ) {
        yield {
          toolCallId: part.toolCallId,
          // A call with no name is not a call anyone can read; the fallback
          // keeps the record writable rather than dropping the row, which
          // would understate what was left open.
          toolName:
            typeof part.toolName === "string" && part.toolName
              ? part.toolName
              : "unknown",
        };
      }
    }
  }
}
