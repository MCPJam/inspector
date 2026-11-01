import { randomUUID } from "node:crypto";
import type { BridgeTurn } from "@ai-sdk/harness/bridge";

/** A retained call keeps one identity through approval, result and App history. */
export async function callHostTool(
  active:
    | {
        turn: Pick<BridgeTurn, "emit" | "requestToolResult">;
        aliasToCanonical: ReadonlyMap<string, string>;
      }
    | undefined,
  request: { toolName: string; input: unknown },
) {
  if (!active) throw new Error("no active turn for a host tool call");
  const canonical =
    active.aliasToCanonical.get(request.toolName) ?? request.toolName;
  // Counters restarted per turn collide with earlier results in the same chat.
  const toolCallId = `mcpjam-host-${randomUUID()}`;
  // MCPJam's host-side gate owns approval for providerExecuted: false calls.
  active.turn.emit({
    type: "tool-call",
    toolCallId,
    toolName: canonical,
    input: JSON.stringify(request.input ?? {}),
    providerExecuted: false,
  });
  const result = await active.turn.requestToolResult(toolCallId);
  active.turn.emit({
    type: "tool-result",
    toolCallId,
    toolName: canonical,
    result,
  });
  return result;
}
