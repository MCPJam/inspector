/**
 * Projecting a conversation into the tool calls an eval graded on.
 *
 * One implementation, two callers that had drifted into being two: the live
 * eval runner (`server/services/evals-runner.ts`) and the persisted-transcript
 * predicate path (`server/services/checks/run-predicates-on-chat-session.ts`),
 * whose copy carried a NOTE calling itself a mirror and a back-reference to a
 * line number that had since moved. A mirror nobody can find is a mirror that
 * stops being one.
 *
 * ## The dedupe, and why it changed
 *
 * Both copies deduped by `toolName + JSON.stringify(arguments)`. That
 * conflates two very different things:
 *
 *   1. ONE call seen through two sources — a step's `toolCalls` array and the
 *      assistant message's `tool-call` part describe the same execution, and
 *      counting it twice would invent a call that never happened.
 *   2. TWO calls that happen to look alike — a model calling `search{q:"x"}`
 *      three times really did call it three times, and collapsing them to one
 *      loses a fact the run is being graded on.
 *
 * Value identity cannot tell those apart. `toolCallId` can: it is minted per
 * execution, so the first case shares one and the second does not. So identity
 * is the id when both calls have one, and falls back to value identity only
 * when an id is absent (legacy transcripts, and shapes that never carried one).
 *
 * This CHANGES VERDICTS for suites where a model repeats an identical call: the
 * repeats now count, which can push a run past `maxExtraToolCalls` where it
 * previously fit. That is the correction, not a side effect — the emulated and
 * harness engines have to count the same executions the same way, and "how
 * many times did it call this" is one of the things an eval exists to measure.
 */

export type ProjectedToolCall = {
  toolName: string;
  arguments: unknown;
  toolCallId?: string;
};

type ConversationSource = {
  /** AI-SDK step records, when the caller has the live run's steps. */
  steps?: ReadonlyArray<unknown>;
  /** The conversation itself. Persisted-transcript callers have only this. */
  messages: ReadonlyArray<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readToolName(call: Record<string, unknown>): string | null {
  const name = call.toolName ?? call.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function readToolCallId(call: Record<string, unknown>): string | undefined {
  return typeof call.toolCallId === "string" && call.toolCallId.length > 0
    ? call.toolCallId
    : undefined;
}

/**
 * Identity for "have I already recorded THIS execution?".
 *
 * An id is authoritative when present. The value fallback is deliberately the
 * old behaviour, kept for id-less shapes so a legacy transcript projects
 * exactly as it always did rather than suddenly counting its own re-readings
 * of one call as several.
 */
export function toolCallIdentity(toolCall: ProjectedToolCall): string {
  if (toolCall.toolCallId) return `id:${toolCall.toolCallId}`;
  return `value:${toolCall.toolName}:${JSON.stringify(toolCall.arguments ?? {})}`;
}

function pushUnlessSeen(
  into: ProjectedToolCall[],
  seen: Set<string>,
  call: ProjectedToolCall,
): void {
  const identity = toolCallIdentity(call);
  if (seen.has(identity)) return;
  seen.add(identity);
  into.push(call);
}

/**
 * Every tool call the conversation records, in execution order.
 *
 * Steps first (they carry the run's own accounting), then the messages, so a
 * call visible in both keeps the step's record and the message pass adds only
 * what the steps did not see.
 */
export function extractToolCallsFromConversation(
  params: ConversationSource,
): ProjectedToolCall[] {
  const toolsCalled: ProjectedToolCall[] = [];
  const seen = new Set<string>();

  if (Array.isArray(params.steps)) {
    for (const rawStep of params.steps) {
      const step = asRecord(rawStep);
      const stepToolCalls = step?.toolCalls;
      if (!Array.isArray(stepToolCalls)) continue;
      for (const rawCall of stepToolCalls) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const toolName = readToolName(call);
        if (!toolName) continue;
        const toolCallId = readToolCallId(call);
        pushUnlessSeen(toolsCalled, seen, {
          toolName,
          arguments: call.args ?? call.input ?? {},
          ...(toolCallId ? { toolCallId } : {}),
        });
      }
    }
  }

  for (const rawMessage of params.messages) {
    const msg = asRecord(rawMessage);
    if (!msg || msg.role !== "assistant") continue;

    if (Array.isArray(msg.content)) {
      for (const rawItem of msg.content) {
        const item = asRecord(rawItem);
        if (!item || item.type !== "tool-call") continue;
        const toolName = readToolName(item);
        if (!toolName) continue;
        const toolCallId = readToolCallId(item);
        pushUnlessSeen(toolsCalled, seen, {
          toolName,
          arguments: item.input ?? item.parameters ?? item.args ?? {},
          ...(toolCallId ? { toolCallId } : {}),
        });
      }
    }

    if (Array.isArray(msg.toolCalls)) {
      for (const rawCall of msg.toolCalls) {
        const call = asRecord(rawCall);
        if (!call) continue;
        const toolName = readToolName(call);
        if (!toolName) continue;
        const toolCallId = readToolCallId(call);
        pushUnlessSeen(toolsCalled, seen, {
          toolName,
          arguments: call.args ?? call.input ?? {},
          ...(toolCallId ? { toolCallId } : {}),
        });
      }
    }
  }

  return toolsCalled;
}

/**
 * The same projection, minus calls a tool policy refused.
 *
 * A blocked call never reached its server — the proxy returns the block
 * envelope before the bridge executes anything — so counting it would grade the
 * run on a call that did not happen. Calls with no id cannot be matched against
 * the blocked set and are kept: dropping every id-less call to be safe would
 * silently empty a legacy transcript's projection.
 */
export function extractToolCallsExcludingPolicyBlocks(
  params: ConversationSource,
  blockedToolCallIds: ReadonlySet<string>,
): ProjectedToolCall[] {
  return extractToolCallsFromConversation(params).filter(
    (toolCall) =>
      toolCall.toolCallId === undefined ||
      !blockedToolCallIds.has(toolCall.toolCallId),
  );
}

/**
 * Merge a later projection into an earlier one, keeping the earlier order.
 *
 * Used where a turn's calls are accumulated across passes (a failed turn's
 * partial messages are projected and appended to what the prompt already
 * recorded), so the same execution seen twice must not become two.
 */
export function mergeToolCalls(
  existingToolCalls: ProjectedToolCall[],
  incomingToolCalls: ProjectedToolCall[],
): ProjectedToolCall[] {
  const seen = new Set(existingToolCalls.map(toolCallIdentity));
  const merged = [...existingToolCalls];
  for (const toolCall of incomingToolCalls) {
    pushUnlessSeen(merged, seen, toolCall);
  }
  return merged;
}
