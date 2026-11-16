import { isRecord } from "../../byok/list-request.js";
import { ExecutionControlError, type ExecutionControl } from "./execution-control.js";
import type { NativeMessage } from "./native-wire.js";

/** Claude owns this metadata; it correlates results without granting a dispatch. */
export function nativeToolCallId(params: unknown, metadataKey = "claudecode/toolUseId"): string | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return;
  const id = params._meta[metadataKey];
  return typeof id === "string" && id.length > 0 && id.length <= 512
    ? id
    : undefined;
}

/**
 * A key in MCPJam's own `mcpjam/` namespace was stamped by MCPJam, not sent by
 * the runtime, so the request the server receives leaves it out. A runtime's
 * own correlation key passes through untouched.
 */
export function withoutHostCorrelation(
  forwarded: { body: string; message: NativeMessage | undefined },
  metadataKey: string | undefined,
): { body: string; message: NativeMessage | undefined } {
  const { message } = forwarded;
  if (
    !metadataKey?.startsWith("mcpjam/") ||
    !message ||
    !isRecord(message.params) ||
    !isRecord(message.params._meta) ||
    !Object.hasOwn(message.params._meta, metadataKey)
  )
    return forwarded;
  const meta = Object.fromEntries(
    Object.entries(message.params._meta).filter(([key]) => key !== metadataKey),
  );
  const params = Object.fromEntries(
    Object.entries(message.params).flatMap(([key, value]) =>
      key !== "_meta" ? [[key, value]] : Object.keys(meta).length ? [[key, meta]] : [],
    ),
  );
  const stripped = { ...message, params };
  return { body: JSON.stringify(stripped), message: stripped };
}

/** Hydrate from the exact settled wire result, before the UI sees Claude's projection. */
export async function readNativeToolResult(
  control: Pick<ExecutionControl, "nativeResult">,
  turnId: string,
  toolCallId: string,
  onReceipt?: (executionId: string) => void,
): Promise<unknown> {
  const receipt = await control.nativeResult(turnId, toolCallId).catch((error: unknown) => {
    if (error instanceof ExecutionControlError) {
      throw new Error(
        "The tool may have run, but its final result could not be confirmed. Check the server before trying again.",
        { cause: error },
      );
    }
    throw error;
  });
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
