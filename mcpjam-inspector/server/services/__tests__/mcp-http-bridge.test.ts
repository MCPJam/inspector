/**
 * Bridge failure telemetry: every real `handleJsonRpc` failure leaves the
 * process as HTTP 200 (a JSON-RPC error envelope, or manager-mode's success
 * envelope with `isError: true`), so `http.request.failed` never sees it.
 * The injected `failureReporter` is its only typed record — and it must
 * NEVER change the JSON-RPC response, which is what most of these pin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleJsonRpc,
  parseAndValidateJsonRpc,
} from "../mcp-http-bridge";
import type { StreamFailureEvent } from "../../utils/stream-failure-reporter";

function makeReporter() {
  const calls: StreamFailureEvent[] = [];
  const reporter = vi.fn((e: StreamFailureEvent) => {
    calls.push(e);
    return {
      normalized: e.normalized ?? ({ slug: "internal/unknown" } as any),
      origin: "user_server" as const,
    };
  });
  return { reporter, calls };
}

function failingManager(over: Record<string, unknown> = {}) {
  return {
    getManagedClient: vi.fn().mockReturnValue(undefined),
    hasServer: vi.fn().mockReturnValue(false),
    listTools: vi.fn(),
    executeTool: vi.fn().mockRejectedValue(new Error("tool blew up")),
    readResource: vi.fn().mockRejectedValue(new Error("resource gone")),
    getPrompt: vi.fn().mockRejectedValue(new Error("prompt gone")),
    ...over,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleJsonRpc failure telemetry", () => {
  it("manager-mode tools/call: reports once AND keeps the success+isError envelope", async () => {
    const { reporter, calls } = makeReporter();
    const response = await handleJsonRpc(
      "srv-1",
      { id: 1, method: "tools/call", params: { name: "boom", arguments: {} } },
      failingManager(),
      "manager",
      { failureReporter: reporter },
    );

    // The envelope the plan calls "a failure invisible to both HTTP status
    // and JSON-RPC error accounting" — byte-identical to before.
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "Error: tool blew up" }],
        isError: true,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: "mcp.bridge.rpc",
      hop: "user_server_hop",
      transport: "rpc_envelope",
      rpcMethod: "tools/call",
      errorCode: "-32000",
    });
    expect(calls[0].normalized).toBeDefined();
  });

  it("adapter-mode tools/call: envelope unchanged, one report", async () => {
    const { reporter, calls } = makeReporter();
    const response = await handleJsonRpc(
      "srv-1",
      { id: 2, method: "tools/call", params: { name: "boom", arguments: {} } },
      failingManager(),
      "adapter",
      { failureReporter: reporter },
    );

    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe("tool blew up");
    expect(response.error.data.normalized).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("resources/read and prompts/get report with their method names", async () => {
    const { reporter, calls } = makeReporter();
    await handleJsonRpc(
      "srv-1",
      { id: 3, method: "resources/read", params: { uri: "x://y" } },
      failingManager(),
      "adapter",
      { failureReporter: reporter },
    );
    await handleJsonRpc(
      "srv-1",
      { id: 4, method: "prompts/get", params: { name: "p" } },
      failingManager(),
      "adapter",
      { failureReporter: reporter },
    );
    expect(calls.map((c) => c.rpcMethod)).toEqual([
      "resources/read",
      "prompts/get",
    ]);
  });

  it("passthrough failures report under the forwarded method", async () => {
    const { reporter, calls } = makeReporter();
    const manager = failingManager({
      getManagedClient: vi.fn().mockReturnValue({
        request: vi.fn().mockRejectedValue(new Error("upstream refused")),
      }),
    });
    const response = await handleJsonRpc(
      "srv-1",
      { id: 5, method: "resources/subscribe", params: {} },
      manager,
      "adapter",
      { failureReporter: reporter },
    );
    expect(response.error.code).toBe(-32000);
    expect(calls).toHaveLength(1);
    expect(calls[0].rpcMethod).toBe("resources/subscribe");
  });

  it("attributes a prefixed tools/call to the server that actually ran it", async () => {
    const { reporter, calls } = makeReporter();
    await handleJsonRpc(
      "srv-1",
      {
        id: 10,
        method: "tools/call",
        params: { name: "other-server:boom", arguments: {} },
      },
      failingManager({ hasServer: vi.fn().mockReturnValue(true) }),
      "adapter",
      { failureReporter: reporter },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].context).toMatchObject({
      serverId: "srv-1",
      targetServerId: "other-server",
    });
  });

  it("an UPSTREAM -32601 through the passthrough is a declared outcome — no report", async () => {
    const { reporter, calls } = makeReporter();
    const manager = failingManager({
      getManagedClient: vi.fn().mockReturnValue({
        request: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("Method not found"), { code: -32601 }),
          ),
      }),
    });
    const response = await handleJsonRpc(
      "srv-1",
      { id: 11, method: "tasks/list", params: {} },
      manager,
      "adapter",
      { failureReporter: reporter },
    );
    expect(response.error.code).toBe(-32000);
    expect(calls).toHaveLength(0);
  });

  it("-32601 method-not-implemented is a declared client outcome — no report", async () => {
    const { reporter, calls } = makeReporter();
    const response = await handleJsonRpc(
      "srv-1",
      { id: 6, method: "no/such-method", params: {} },
      failingManager(),
      "adapter",
      { failureReporter: reporter },
    );
    expect(response.error.code).toBe(-32601);
    expect(calls).toHaveLength(0);
  });

  it("notifications produce no response and no report", async () => {
    const { reporter, calls } = makeReporter();
    const response = await handleJsonRpc(
      "srv-1",
      { method: "notifications/initialized" },
      failingManager(),
      "adapter",
      { failureReporter: reporter },
    );
    expect(response).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a throwing reporter never alters the JSON-RPC response", async () => {
    const reporter = vi.fn(() => {
      throw new Error("telemetry sink down");
    });
    const response = await handleJsonRpc(
      "srv-1",
      { id: 7, method: "tools/call", params: { name: "boom", arguments: {} } },
      failingManager(),
      "adapter",
      { failureReporter: reporter as any },
    );
    expect(response.error.code).toBe(-32000);
    expect(response.error.message).toBe("tool blew up");
  });

  it("works identically with no reporter injected", async () => {
    const response = await handleJsonRpc(
      "srv-1",
      { id: 8, method: "tools/call", params: { name: "boom", arguments: {} } },
      failingManager(),
      "adapter",
    );
    expect(response.error.code).toBe(-32000);
  });
});

describe("parse-path stays report-free", () => {
  it("a parse error is already visible as a 4xx row — never a report", async () => {
    // The reporter never reaches parseAndValidateJsonRpc at all (it has no
    // options), which IS the design: this test documents the boundary.
    const validation = await parseAndValidateJsonRpc(() =>
      Promise.reject(new SyntaxError("bad json")),
    );
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.status).toBe(400);
      expect(validation.response.error.code).toBe(-32700);
    }
  });
});
