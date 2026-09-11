import {
  getToolName,
  isToolUIPart,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import {
  probeSerializedSize,
  truncateRpcPayload,
} from "@/shared/rpc-log-truncation";

export function isWebMcpError(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  if (record.error !== undefined) return true;
  if (!record.output || typeof record.output !== "object") return false;
  const output = record.output as Record<string, unknown>;
  return (
    output.isError === true || output.ok === false || output.error !== undefined
  );
}

/** Tool-call records, not synthetic MCP JSON-RPC frames. */
export function logWebMcpTraffic(options: {
  toolCallId: string;
  toolName: string;
  direction: "SEND" | "RECEIVE";
  payload: unknown;
  serverId?: string;
  serverName?: string;
}): void {
  // Diagnostics must never interrupt a tool or prevent its result reaching chat.
  try {
    useTrafficLogStore.getState().addMcpServerLog({
      id: `webmcp:${options.toolCallId}:${options.direction}`,
      serverId: options.serverId ?? "webmcp",
      serverName: options.serverName ?? "WebMCP",
      kind: "webmcp",
      direction: options.direction,
      method: options.toolName,
      timestamp: new Date().toISOString(),
      payload: probeSerializedSize(options.payload, 1024 * 1024).exceeded
        ? truncateRpcPayload(options.payload, 1024 * 1024)
        : options.payload,
    });
  } catch {
    // Logging is best effort, just like the MCP transport's diagnostic sink.
  }
}

function isDaemonPageTool(name: string): boolean {
  return name.startsWith("webmcp_") || name === "browser_webmcp_invoke";
}

/** Observe the live transport, so opening history or clearing logs cannot replay calls.
 * Client-fulfilled page aliases are recorded at their dispatch site instead.
 */
export function withWebMcpTraffic(
  transport: ChatTransport<UIMessage>,
): ChatTransport<UIMessage> {
  const calls = new Map<
    string,
    { name: string; inputLogged?: boolean; outputLogged?: boolean }
  >();
  function remember(id: string, name: string) {
    if (!isDaemonPageTool(name) || calls.has(id)) return;
    calls.set(id, { name });
    if (calls.size > 1000) calls.delete(calls.keys().next().value!);
  }
  function observe(stream: ReadableStream<UIMessageChunk>) {
    return stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          if (
            chunk.type === "tool-input-start" ||
            chunk.type === "tool-input-available" ||
            chunk.type === "tool-input-error"
          ) {
            remember(chunk.toolCallId, chunk.toolName);
          }
          if ("toolCallId" in chunk) {
            const call = calls.get(chunk.toolCallId);
            if (call) {
              if (
                (chunk.type === "tool-input-available" ||
                  chunk.type === "tool-input-error") &&
                !call.inputLogged
              ) {
                call.inputLogged = true;
                logWebMcpTraffic({
                  toolCallId: chunk.toolCallId,
                  toolName: call.name,
                  direction: "SEND",
                  payload: { toolCallId: chunk.toolCallId, input: chunk.input },
                });
              }
              if (
                !call.outputLogged &&
                ((chunk.type === "tool-output-available" &&
                  !chunk.preliminary) ||
                  chunk.type === "tool-output-error" ||
                  chunk.type === "tool-input-error" ||
                  chunk.type === "tool-output-denied")
              ) {
                call.outputLogged = true;
                logWebMcpTraffic({
                  toolCallId: chunk.toolCallId,
                  toolName: call.name,
                  direction: "RECEIVE",
                  payload:
                    chunk.type === "tool-output-available"
                      ? { toolCallId: chunk.toolCallId, output: chunk.output }
                      : {
                          toolCallId: chunk.toolCallId,
                          error:
                            chunk.type === "tool-output-denied"
                              ? "Tool call denied"
                              : chunk.errorText,
                        },
                });
              }
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
  }
  return {
    async sendMessages(options) {
      // Approval resumes may return only an output for a call from an earlier turn.
      for (const message of options.messages) {
        for (const part of message.parts) {
          if (isToolUIPart(part)) remember(part.toolCallId, getToolName(part));
        }
      }
      return observe(await transport.sendMessages(options));
    },
    async reconnectToStream(options) {
      const stream = await transport.reconnectToStream(options);
      return stream ? observe(stream) : null;
    },
  };
}
