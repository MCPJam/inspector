import type { ModelMessage } from "ai";
import type { SettleSuspendedToolCall } from "./direct-chat-scope-step-up.js";

/** Resolve independent saved calls in bounded batches, preserving history order. */
export async function settleHistoryBatch(
  history: ModelMessage[],
  resolved: ReadonlySet<string>,
  settle: SettleSuspendedToolCall,
): Promise<Map<string, string | undefined>> {
  const calls = new Map<string, { toolCallId: string; toolName: string }>();
  for (const message of history) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue;
    for (const part of message.content) {
      if (
        part.type !== "tool-call" ||
        part.providerExecuted ||
        resolved.has(part.toolCallId)
      )
        continue;
      calls.set(part.toolCallId, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      });
    }
  }
  const pending = [...calls.values()];
  const results = new Map<string, string | undefined>();
  for (let offset = 0; offset < pending.length; offset += 8) {
    const batch = await Promise.all(
      pending
        .slice(offset, offset + 8)
        .map(async (call) => [call.toolCallId, await settle(call)] as const),
    );
    for (const [id, result] of batch) results.set(id, result);
  }
  return results;
}
