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
 * Close every unresolved call by SPLICING a synthetic `error-text` tool result
 * immediately after the assistant message that issued it.
 *
 * Returns a NEW array; the input is never mutated, because the caller's copy is
 * often the live history another closure is still reading.
 *
 * SPLICED, NOT APPENDED, and that is not a stylistic choice: providers require
 * a tool result to follow its tool call directly (Anthropic rejects a request
 * whose `tool_use` is not answered by the next message). Appending at the end
 * would make the very next turn 400 — which is precisely the failure this
 * closure exists to prevent. Same placement the auto-deny path already uses.
 *
 * One tool message per issuing assistant message, parts in history order, so
 * the output is a pure function of the input: no timestamps, no ids, no map
 * iteration order.
 */
export function closeUnresolvedToolCalls(
  messages: readonly ModelMessage[],
  states: readonly UnresolvedToolCall[],
  opts?: { turnId?: string },
): ModelMessage[] {
  if (states.length === 0) return [...messages];
  const resolved = collectResolvedToolCallIds(messages);
  const wanted = new Map<string, UnresolvedToolCall>();
  for (const call of states) {
    // Idempotent: closing an already-closed history is a no-op, which is what
    // makes it safe for the client and the server to both apply it.
    if (resolved.has(call.toolCallId) || wanted.has(call.toolCallId)) continue;
    wanted.set(call.toolCallId, call);
  }
  if (wanted.size === 0) return [...messages];

  const out = [...messages];
  // Descending, so an earlier splice cannot shift a later index.
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const message = out[i];
    if (!message || message.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const parts: ToolResultLike[] = [];
    for (const part of content) {
      if (part?.type !== "tool-call") continue;
      const call = wanted.get(part.toolCallId);
      if (!call) continue;
      parts.push(buildClosurePart(call, opts?.turnId));
    }
    if (parts.length > 0) {
      out.splice(i + 1, 0, { role: "tool", content: parts } as ModelMessage);
    }
  }
  return out;
}

/** The single tool-result part a closed call becomes. Shared so the client's
 *  projection and the server's write cannot drift. */
export function buildClosurePart(
  call: UnresolvedToolCall,
  turnId?: string,
): ToolResultLike {
  return {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: "error-text",
      value: INTERRUPTED_TOOL_CALL_TEXT[call.state],
    },
    providerOptions: buildClosureProviderOptions(call.state, turnId),
  };
}

/**
 * The `providerOptions` stamp, shared by the server's tool-result and the
 * client's `callProviderMetadata`.
 *
 * `turnId` is OMITTED rather than nulled when absent: an explicit `null` would
 * change the serialized bytes the two sides have to agree on.
 */
export function buildClosureProviderOptions(
  state: UnresolvedToolCallState,
  turnId?: string,
): Record<string, Record<string, unknown>> {
  return {
    [INTERRUPTED_TOOL_CALL_PROVIDER_KEY]: {
      interrupted: state,
      ...(turnId ? { turnId } : {}),
    },
  };
}

type ToolResultLike = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "error-text"; value: string };
  providerOptions: Record<string, Record<string, unknown>>;
};

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

// ---------------------------------------------------------------------------
// The client's half
// ---------------------------------------------------------------------------

/**
 * The tool-part shape the AI SDK's `UIMessage` uses. Typed structurally rather
 * than imported so this module stays importable from the server without
 * dragging a UI type across the boundary.
 */
type UiToolPart = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  callProviderMetadata?: unknown;
};

type UiMessageLike = { role?: string; parts?: unknown[] };

/**
 * Read an unresolved UI tool part's state, CONSERVATIVELY.
 *
 * The client cannot see dispatch: the server executes the tool and the browser
 * learns nothing until a result arrives. So `input-available` — the input is
 * complete and the call is with the server — must read as `outcome_unknown`.
 * Only `input-streaming`, where the model has not finished dictating the
 * arguments, is safely `never_started`.
 *
 * Guessing the other way would put the reassuring sentence on a call that may
 * have charged somebody's card.
 */
export function uiToolPartInterruptedState(
  part: UiToolPart,
): UnresolvedToolCallState {
  return part.state === "input-streaming" ? "never_started" : "outcome_unknown";
}

/** Is this UI part a tool call still awaiting its result? */
export function isUnresolvedUiToolPart(part: unknown): part is UiToolPart {
  if (!part || typeof part !== "object") return false;
  const candidate = part as UiToolPart;
  if (typeof candidate.type !== "string") return false;
  if (
    !candidate.type.startsWith("tool-") &&
    candidate.type !== "dynamic-tool"
  ) {
    return false;
  }
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId) {
    return false;
  }
  return (
    candidate.state === "input-streaming" || candidate.state === "input-available"
  );
}

/**
 * Close a partial assistant UI message in place of the server.
 *
 * Applied by the client the moment Stop is pressed, so the user can send again
 * immediately: the next request then carries a history with NO open calls, and
 * the new turn can never run over one. The server applies the equivalent
 * closure at persist time; `convertToModelMessages` maps this part to exactly
 * the tool-result {@link buildClosurePart} writes, which is what makes the two
 * ingests of the same history agree byte for byte.
 *
 * Returns the SAME object when nothing was open, so React sees no change.
 */
export function closeUnresolvedUiToolParts<T extends UiMessageLike>(
  message: T,
  opts?: { turnId?: string },
): T {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return message;
  let changed = false;
  const next = parts.map((part) => {
    if (!isUnresolvedUiToolPart(part)) return part;
    changed = true;
    const state = uiToolPartInterruptedState(part);
    return {
      ...part,
      state: "output-error",
      errorText: INTERRUPTED_TOOL_CALL_TEXT[state],
      callProviderMetadata: buildClosureProviderOptions(state, opts?.turnId),
    };
  });
  return changed ? { ...message, parts: next } : message;
}

/**
 * Closed tool calls whose text the client and the server disagree about.
 *
 * Both sides close the same turn — the client on Stop, the server at persist
 * time — and the whole design rests on them producing the same bytes. This is
 * the check that the assumption held in production rather than only in the
 * golden test, and it exists BECAUSE the failure would otherwise be silent: the
 * server copy wins on rehydration either way, so a divergence would quietly
 * rewrite what the user was told about a call that may have taken effect.
 *
 * Read-only, and it reports rather than resolves. The caller keeps the server's
 * copy; this only names what changed under the reader.
 */
export function diffInterruptedToolParts(
  local: readonly UiMessageLike[],
  server: readonly UiMessageLike[],
): Array<{ toolCallId: string; local: string; server: string }> {
  const localById = new Map<string, string>();
  for (const message of local) {
    for (const part of message?.parts ?? []) {
      const closed = readClosedUiPart(part);
      if (closed) localById.set(closed.toolCallId, closed.errorText);
    }
  }
  if (localById.size === 0) return [];
  const out: Array<{ toolCallId: string; local: string; server: string }> = [];
  for (const message of server) {
    for (const part of message?.parts ?? []) {
      const closed = readClosedUiPart(part);
      if (!closed) continue;
      const localText = localById.get(closed.toolCallId);
      // A call the local copy never closed is not a disagreement: the server
      // closed something this surface never saw open.
      if (localText === undefined || localText === closed.errorText) continue;
      out.push({
        toolCallId: closed.toolCallId,
        local: localText,
        server: closed.errorText,
      });
    }
  }
  return out;
}

function readClosedUiPart(
  part: unknown,
): { toolCallId: string; errorText: string } | undefined {
  if (!part || typeof part !== "object") return undefined;
  const candidate = part as UiToolPart;
  if (candidate.state !== "output-error") return undefined;
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId) {
    return undefined;
  }
  const metadata = candidate.callProviderMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const mcpjam = (metadata as Record<string, unknown>)[
    INTERRUPTED_TOOL_CALL_PROVIDER_KEY
  ];
  if (!mcpjam || typeof mcpjam !== "object") return undefined;
  const interrupted = (mcpjam as Record<string, unknown>).interrupted;
  if (interrupted !== "never_started" && interrupted !== "outcome_unknown") {
    return undefined;
  }
  return {
    toolCallId: candidate.toolCallId,
    errorText:
      typeof candidate.errorText === "string" ? candidate.errorText : "",
  };
}
