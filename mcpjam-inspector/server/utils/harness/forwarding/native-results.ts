import { isRecord } from "../../byok/list-request.js";
import type { ExecutionControl } from "./execution-control.js";

/** Claude owns this metadata; it correlates results without granting a dispatch. */
export function nativeToolCallId(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return;
  const id = params._meta["claudecode/toolUseId"];
  return typeof id === "string" && id.length > 0 && id.length <= 512
    ? id
    : undefined;
}

/** Hydrate from the exact settled wire result, before the UI sees Claude's projection. */
export async function readNativeToolResult(
  control: Pick<ExecutionControl, "nativeResult">,
  turnId: string,
  toolCallId: string,
  onReceipt?: (executionId: string) => void,
): Promise<unknown> {
  const receipt = await control.nativeResult(turnId, toolCallId);
  if (receipt.outcome === "incomplete")
    throw new Error("The original MCP result is incomplete.");
  if (receipt.outcome !== "success" && receipt.outcome !== "tool_error") return;
  if (!receipt.complete || !receipt.result || receipt.result.truncated)
    throw new Error("The original MCP result is unavailable.");
  let json = receipt.result.json;
  if (json === null && receipt.result.url) {
    const response = await fetch(receipt.result.url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body)
      throw new Error("The original MCP result could not be read.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 7.5 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("The original MCP result exceeds the read limit.");
      }
      chunks.push(chunk.value);
    }
    json = Buffer.concat(chunks).toString("utf8");
  }
  const message: unknown = json === null ? null : JSON.parse(json);
  if (
    !isRecord(message) ||
    message.jsonrpc !== "2.0" ||
    !isRecord(message.result)
  )
    throw new Error("The original MCP tool result is invalid.");
  onReceipt?.(receipt._id);
  return message.result;
}
