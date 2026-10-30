import { describe, expect, it, vi } from "vitest";
import { parseNativeMessage, nativeRequestHeaders } from "../native-wire.js";
import { forwardNativeMcp } from "../native-transport.js";
import type { Settlement } from "../execution-control.js";

const message = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name: "read", arguments: { value: 1 } },
};
const request = () =>
  new Request("https://forwarder.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "untrusted",
      "x-mcpjam-forwarding-secret": "grant",
      "x-custom": "untrusted",
      "user-agent": "real-client",
    },
    body: JSON.stringify(message),
  });
const reply =
  '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"yes"},{"type":"image","data":"AA==","mimeType":"image/png"}],"structuredContent":{"value":1},"_meta":{"private":true},"isError":false},"unknown":true}';

describe("native MCP wire", () => {
  it("rejects duplicate decision keys including escaped and nested keys", () => {
    for (const raw of [
      '{"jsonrpc":"2.0","id":1,"method":"read","method":"write"}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","name":"b"}}',
      '{"jsonrpc":"2.0","id":1,"method":"read","\u0069d":2}',
    ]) {
      expect(() => parseNativeMessage(raw, new Headers())).toThrow(
        "duplicate_key",
      );
    }
    expect(parseNativeMessage(JSON.stringify(message), new Headers())).toEqual(
      message,
    );
  });
  it("refuses batches, invalid IDs and oversized requests", () => {
    for (const raw of [
      JSON.stringify([message]),
      JSON.stringify({ ...message, id: true }),
      "x".repeat(1024 * 1024 + 1),
    ])
      expect(() => parseNativeMessage(raw, new Headers())).toThrow();
  });
  it("preserves unknown JSON members and typed ids", () => {
    const raw = JSON.stringify({
      ...message,
      id: "1",
      extra: { future: true },
    });
    expect(parseNativeMessage(raw, new Headers())).toMatchObject({
      id: "1",
      extra: { future: true },
    });
  });
  it("rejects conflicting modern routing metadata through the shared SDK checker", () => {
    expect(() =>
      parseNativeMessage(
        JSON.stringify(message),
        new Headers({
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "resources/read",
          "mcp-name": "other",
        }),
      ),
    ).toThrow("header_mismatch");
  });
  it("takes credentials only from the authorized endpoint", () => {
    const headers = nativeRequestHeaders(request().headers, {
      authorization: "Bearer upstream",
      "x-api-key": "key",
    });
    expect(headers.get("authorization")).toBe("Bearer upstream");
    expect(headers.get("x-api-key")).toBe("key");
    expect(headers.get("x-custom")).toBeNull();
    expect(headers.get("x-mcpjam-forwarding-secret")).toBeNull();
    expect(headers.get("user-agent")).toBe("real-client");
  });
});

describe("native streaming transport", () => {
  it("preserves the exact JSON request and complete raw result without projection", async () => {
    const raw =
      ' {"jsonrpc":"2.0", "id":1,"method":"tools/call","params":{"name":"read","future":true}} ';
    const transport = vi.fn(async (_url, init) => {
      expect(init.body).toBe(raw);
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer upstream",
      );
      return new Response(reply, {
        headers: {
          "content-type": "application/json",
          "set-cookie": "private",
          "www-authenticate": "secret",
          "mcp-session-id": "upstream-session",
        },
      });
    });
    const settle = vi.fn(async (_result: Settlement) => undefined);
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: request(),
      body: raw,
      message,
      fetch: transport,
      trustedHeaders: { authorization: "Bearer upstream" },
      settle,
    });
    expect(await response.text()).toBe(reply);
    expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(settle).toHaveBeenCalledWith({
      outcome: "success",
      resultJson: reply,
    });
    expect(transport).toHaveBeenCalledOnce();
  });
  it("streams progress before completion, preserving split UTF-8 and SSE framing", async () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const progress =
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\r\n\r\n';
    const result = `event: message\ndata: ${reply}\n\n`;
    const settle = vi.fn(async (_result: Settlement) => undefined);
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: request(),
      message,
      fetch: async () =>
        new Response(source, {
          headers: { "content-type": "text/event-stream" },
        }),
      settle,
    });
    const reader = response.body!.getReader();
    controller!.enqueue(encoder.encode(progress));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(progress);
    expect(settle).not.toHaveBeenCalled();
    const bytes = encoder.encode(result);
    controller!.enqueue(bytes.slice(0, 20));
    controller!.enqueue(bytes.slice(20));
    controller!.close();
    const next = await reader.read();
    expect(new TextDecoder().decode(next.value)).toBe(result);
    expect(settle).toHaveBeenCalledWith({
      outcome: "success",
      resultJson: reply,
    });
    expect((await reader.read()).done).toBe(true);
  });
  it.each([
    ["isError", true, "tool_error"],
    ["status", "input_required", "input_required"],
  ] as const)("keeps %s outcomes intact", async (key, value, expected) => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { [key]: value, content: [] },
    });
    const settle = vi.fn(async (_result: Settlement) => undefined);
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: request(),
      message,
      fetch: async () =>
        new Response(raw, { headers: { "content-type": "application/json" } }),
      settle,
    });
    expect(await response.text()).toBe(raw);
    expect(settle).toHaveBeenCalledWith({ outcome: expected, resultJson: raw });
  });
  it("keeps protocol errors and does not expose non-MCP provider bodies", async () => {
    const settle = vi.fn(async (_result: Settlement) => undefined);
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: request(),
      message,
      fetch: async () =>
        new Response("<html>private token</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      settle,
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private token");
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "protocol_error" }),
    );
  });
  it("does not retry a reset or a lost body", async () => {
    const transport = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(
      forwardNativeMcp({
        url: "https://server.example/mcp",
        serverId: "server",
        request: request(),
        message,
        fetch: transport,
      }),
    ).rejects.toThrow("connection reset");
    expect(transport).toHaveBeenCalledOnce();
    const settle = vi.fn(async (_result: Settlement) => undefined);
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: request(),
      message,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"jsonrpc":'));
              c.error(new Error("lost body"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      settle,
    });
    await expect(response.text()).rejects.toThrow("lost body");
    expect(settle).toHaveBeenCalledWith({ outcome: "incomplete" });
  });
  it("only refreshes a definite authorization refusal once", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(reply, {
          headers: { "content-type": "application/json" },
        }),
      );
    const refresh = vi.fn(async () => ({ accessToken: "new-token" }));
    const response = await forwardNativeMcp({
      url: "https://server.example/mcp",
      serverId: "server",
      request: request(),
      message,
      fetch: transport,
      onUnauthorized: refresh,
    });
    expect(await response.text()).toBe(reply);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

it.each([undefined, null])(
  "rejects tools/call without a request ID (%s)",
  (id) => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      ...(id === undefined ? {} : { id }),
      params: { name: "write" },
    });
    expect(() => parseNativeMessage(raw, new Headers())).toThrow(
      "request_requires_id",
    );
  },
);
it("releases a CR-only SSE frame before the server closes", async () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = await forwardNativeMcp({
    url: "https://server.example/mcp",
    serverId: "server",
    request: request(),
    message,
    fetch: async () =>
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const frame =
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\r\r';
  controller.enqueue(encoder.encode(frame));
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe(frame);
  controller.close();
  await reader.cancel();
});

it("preserves the empty 202 acknowledgement for native notifications", async () => {
  const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
  const raw = JSON.stringify(notification);
  const response = await forwardNativeMcp({
    url: "https://upstream.example/mcp",
    serverId: "server",
    request: new Request("https://forwarder.example/mcp", {
      method: "POST",
      body: raw,
    }),
    body: raw,
    message: notification,
    fetch: vi.fn(async () => new Response("", { status: 202 })),
  });
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("");
});

it.each([
  { result: { action: "accept", content: { color: "blue" } } },
  { error: { code: -32603, message: "Client could not answer" } },
])("preserves empty acknowledgements of client responses: %j", async (payload) => {
  const message = { jsonrpc: "2.0" as const, id: "server-request", ...payload };
  const raw = JSON.stringify(message);
  const send = vi.fn(async () => new Response("", { status: 202 }));
  const response = await forwardNativeMcp({
    url: "https://upstream.example/mcp",
    serverId: "server",
    request: new Request("https://forwarder.example/mcp", {
      method: "POST",
      body: raw,
    }),
    body: raw,
    message,
    fetch: send,
  });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]).toEqual([
    "https://upstream.example/mcp",
    expect.objectContaining({ body: raw }),
  ]);
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("");
});
