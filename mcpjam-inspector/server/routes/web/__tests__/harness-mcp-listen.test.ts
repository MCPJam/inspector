import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgedListenStream,
  harnessLeanDiscoveryEnabled,
  harnessLegacyDownstreamEnabled,
  harnessListenAckEnabled,
  isDiscoveryMethod,
  isJsonRpcId,
  methodNotFound,
} from "../harness-mcp-listen.js";

function messages(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

describe("acknowledgedListenStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("acknowledges first, with the request id as the subscription id and nothing honoured", async () => {
    const reader = acknowledgedListenStream(7, 60_000).getReader();
    const { value } = await reader.read();
    const [first] = messages(new TextDecoder().decode(value));
    expect(first).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": 7 },
        notifications: {},
      },
    });
    await reader.cancel();
  });

  it("ends gracefully at the cap with a completion result for the listen request", async () => {
    vi.useFakeTimers();
    const stream = acknowledgedListenStream("listen-1", 30_000);
    const all = readAll(stream);
    await vi.advanceTimersByTimeAsync(30_000);
    const sent = messages(await all);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      jsonrpc: "2.0",
      id: "listen-1",
      result: { _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" } },
    });
  });

  it("sends keep-alives while open and stops its timers when the client closes it", async () => {
    vi.useFakeTimers();
    const reader = acknowledgedListenStream(1, 120_000).getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(": keepalive\n\n");
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("listen helpers", () => {
  it("is off unless switched on", () => {
    expect(harnessListenAckEnabled({})).toBe(false);
    expect(harnessListenAckEnabled({ MCPJAM_HARNESS_LISTEN_ACK: "1" })).toBe(true);
  });

  it("accepts only JSON-RPC request ids", () => {
    expect(isJsonRpcId(0)).toBe(true);
    expect(isJsonRpcId("a")).toBe(true);
    expect(isJsonRpcId(null)).toBe(false);
    expect(isJsonRpcId(undefined)).toBe(false);
  });
});

describe("downstream protocol switches", () => {
  it("are off unless switched on", () => {
    expect(harnessLegacyDownstreamEnabled({})).toBe(false);
    expect(harnessLegacyDownstreamEnabled({ MCPJAM_HARNESS_MCP_LEGACY_DOWNSTREAM: "1" })).toBe(true);
    expect(harnessLeanDiscoveryEnabled({})).toBe(false);
    expect(harnessLeanDiscoveryEnabled({ MCPJAM_HARNESS_MCP_LEAN_DISCOVERY: "1" })).toBe(true);
  });

  it("answers server/discover as a server without that method", () => {
    expect(methodNotFound(3, "server/discover")).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found: server/discover" },
    });
  });

  it("treats only the handshake, ping and the list methods as discovery", () => {
    for (const method of ["initialize", "ping", "tools/list", "prompts/list", "resources/list", "resources/templates/list"]) {
      expect(isDiscoveryMethod(method)).toBe(true);
    }
    for (const method of ["tools/call", "resources/read", "prompts/get", "completion/complete", undefined]) {
      expect(isDiscoveryMethod(method)).toBe(false);
    }
  });
});
