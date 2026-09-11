import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import {
  isWebMcpError,
  logWebMcpTraffic,
  withWebMcpTraffic,
} from "../webmcp-traffic";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

function stream(chunks: UIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });
}
async function drain(source: ReadableStream<UIMessageChunk>) {
  const reader = source.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
}
const request: UIMessageChunk = {
  type: "tool-input-available",
  toolCallId: "call-1",
  toolName: "webmcp_add_to_cart",
  input: { quantity: 2 },
};
const response: UIMessageChunk = {
  type: "tool-output-available",
  toolCallId: "call-1",
  output: { ok: true, total: 2 },
};
const options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0] = {
  chatId: "chat-1",
  messages: [],
  trigger: "submit-message",
  messageId: undefined,
};
function setup(chunks: UIMessageChunk[]) {
  const transport = {
    sendMessages: vi.fn(async () => stream(chunks)),
    reconnectToStream: vi.fn(async () => stream(chunks)),
  };
  return { raw: transport, logged: withWebMcpTraffic(transport) };
}
beforeEach(() => useTrafficLogStore.getState().clear());

describe("WebMCP transport logs", () => {
  it("records inputs and outputs without changing the stream", async () => {
    const { logged } = setup([request, response]);
    expect(await drain(await logged.sendMessages(options))).toEqual([
      request,
      response,
    ]);
    expect(useTrafficLogStore.getState().mcpServerItems).toMatchObject([
      {
        kind: "webmcp",
        method: "webmcp_add_to_cart",
        direction: "RECEIVE",
        payload: { output: { total: 2 } },
      },
      {
        kind: "webmcp",
        direction: "SEND",
        payload: { input: { quantity: 2 } },
      },
    ]);
    expect(
      useTrafficLogStore.getState().mcpServerItems[0].payload,
    ).not.toHaveProperty("_truncated");
  });
  it.each([
    {
      type: "tool-output-error",
      toolCallId: "call-1",
      errorText: "Browser disconnected",
    },
    { type: "tool-output-denied", toolCallId: "call-1" },
    {
      type: "tool-output-available",
      toolCallId: "call-1",
      output: { error: "stale_binding" },
    },
    {
      type: "tool-output-available",
      toolCallId: "call-1",
      output: { ok: false },
    },
  ] as UIMessageChunk[])("records terminal failure $type", async (failure) => {
    const { logged } = setup([request, failure]);
    await drain(await logged.sendMessages(options));
    expect(
      isWebMcpError(useTrafficLogStore.getState().mcpServerItems[0].payload),
    ).toBe(true);
  });
  it("records invalid input and skips preliminary results", async () => {
    const invalid: UIMessageChunk = {
      type: "tool-input-error",
      toolCallId: "call-1",
      toolName: "webmcp_add_to_cart",
      input: "invalid",
      errorText: "Invalid arguments",
    };
    const { logged } = setup([{ ...response, preliminary: true }, invalid]);
    await drain(await logged.sendMessages(options));
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(2);
    expect(
      isWebMcpError(useTrafficLogStore.getState().mcpServerItems[0].payload),
    ).toBe(true);
  });
  it("does not duplicate a replay or repopulate cleared logs on reconnect", async () => {
    const { logged } = setup([request, response]);
    await drain(await logged.sendMessages(options));
    await drain((await logged.reconnectToStream({ chatId: "chat-1" }))!);
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(2);
    useTrafficLogStore.getState().clear();
    await drain((await logged.reconnectToStream({ chatId: "chat-1" }))!);
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(0);
  });
  it("correlates an approval-resume output without replaying history", async () => {
    const { logged } = setup([response]);
    await drain(
      await logged.sendMessages({
        ...options,
        messages: [
          {
            id: "m1",
            role: "assistant",
            parts: [
              {
                type: "tool-webmcp_add_to_cart",
                toolCallId: "call-1",
                state: "input-available",
                input: {},
              },
            ],
          },
        ],
      }),
    );
    expect(useTrafficLogStore.getState().mcpServerItems).toMatchObject([
      { method: "webmcp_add_to_cart", direction: "RECEIVE" },
    ]);
  });
  it("ignores MCP, UI and client-fulfilled aliases and includes the generic browser invoke", async () => {
    const chunks = [
      "mcp_search",
      "ui_snapshot_app",
      "page_12345678",
      "browser_webmcp_invoke",
    ].flatMap((toolName) => [
      { ...request, toolCallId: toolName, toolName },
      { ...response, toolCallId: toolName },
    ]);
    const { logged } = setup(chunks);
    await drain(await logged.sendMessages(options));
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(2);
    expect(useTrafficLogStore.getState().mcpServerItems[0].method).toBe(
      "browser_webmcp_invoke",
    );
  });
  it("bounds oversized results", () => {
    logWebMcpTraffic({
      toolCallId: "large",
      toolName: "webmcp_image",
      direction: "RECEIVE",
      payload: { output: { image: "a".repeat(2 * 1024 * 1024) } },
    });
    const payload = useTrafficLogStore.getState().mcpServerItems[0].payload;
    expect(payload).toHaveProperty("_truncated", true);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(1024 * 1024);
  });
});
