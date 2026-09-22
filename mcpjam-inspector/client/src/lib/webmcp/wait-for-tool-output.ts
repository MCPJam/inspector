/**
 * Wait for client-fulfilled tool calls to reach a terminal output state.
 *
 * WHY THIS EXISTS: settling a parked UI tool (a dismissed `ui_ask_user`) only
 * resolves the promise `execute` is sitting on. `execute` then returns on a
 * later microtask, and the executor writes `addToolOutput` after that. Any
 * caller that starts a NEW request in between snapshots the assistant message
 * with the tool part still `input-available` — a tool call carrying no result,
 * which both Anthropic and OpenAI reject as an invalid message history.
 *
 * Polls rather than subscribing because the authoritative state lives in the
 * SDK's own message array, which offers no per-part completion hook. The wait
 * is bounded and NON-fatal on timeout: a stuck output is a bug, but blocking
 * the user's message forever would be a worse one, so we give up and let the
 * send proceed.
 */

/** Terminal = any `output-*` state (available, error, denied). */
function isTerminalState(state: unknown): boolean {
  return typeof state === "string" && state.startsWith("output-");
}

interface MessageLike {
  parts?: unknown[];
}

/**
 * Resolve once every id in `toolCallIds` has a terminal part — or once
 * `timeoutMs` elapses.
 *
 * `getMessages` is a thunk, not an array: the SDK replaces the messages array
 * on every update, so a captured reference would never show the output land.
 *
 * Returns true when everything settled, false on timeout — callers may use it
 * for telemetry, but must not treat false as a reason to drop the send.
 */
export async function waitForTerminalToolParts(
  getMessages: () => MessageLike[],
  toolCallIds: string[],
  { timeoutMs = 2000, pollMs = 10 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  if (toolCallIds.length === 0) return true;
  const wanted = new Set(toolCallIds);
  const deadline = Date.now() + timeoutMs;

  const allTerminal = () => {
    const seen = new Set<string>();
    for (const message of getMessages()) {
      if (!Array.isArray(message.parts)) continue;
      for (const part of message.parts) {
        const candidate = part as { toolCallId?: string; state?: unknown };
        if (!candidate.toolCallId || !wanted.has(candidate.toolCallId)) continue;
        if (isTerminalState(candidate.state)) seen.add(candidate.toolCallId);
      }
    }
    return seen.size === wanted.size;
  };

  // Check before waiting: the output can already be there (a re-emitted call
  // the executor settled synchronously), and an unconditional sleep would add
  // latency to every send.
  if (allTerminal()) return true;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (allTerminal()) return true;
  }
  return false;
}
