import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function peer({ resumable = false } = {}) {
  let tool: http.ServerResponse | undefined;
  let listening: http.ServerResponse | undefined;
  let requestId: unknown;
  const forms = new Map<string, { response: http.ServerResponse; id: unknown }>();
  let calls = 0;
  let resumed = 0;
  let cancellations = 0;
  const result = { content: [{ type: "text", text: "one result" }] };
  function finish(response: http.ServerResponse, id = requestId) {
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      if (request.headers["last-event-id"] === "resume-tool") {
        resumed++;
        finish(response);
      } else listening = response;
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const json = (value: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (body.method === "initialize") {
      response.setHeader("mcp-session-id", "one-session");
      json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stream-close", version: "1" } } });
    } else if (body.method === "tools/list") {
      json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "ask", inputSchema: { type: "object", properties: {} } }] } });
    } else if (body.method === "tools/call") {
      calls++;
      requestId = body.id;
      tool = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      if (resumable) response.write("id: resume-tool\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{\"level\":\"info\",\"data\":\"pending\"}}\n\n");
      else {
        const form = `form-${calls}`;
        forms.set(form, { response, id: body.id });
        response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: form, method: "openai/elicitation/create", params: { mode: "form", message: "Answer", requestedSchema: { type: "object", properties: {} } } })}\n\n`);
      }
    } else if (forms.has(body.id)) {
      response.writeHead(202).end();
      const form = forms.get(body.id)!;
      if (!form.response.destroyed) finish(form.response, form.id);
    } else {
      if (body.method === "notifications/cancelled") cancellations++;
      response.writeHead(202).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    get calls() { return calls; },
    get resumed() { return resumed; },
    get cancellations() { return cancellations; },
    get listening() { return !!listening; },
    closeTool(reset: boolean, first = false) {
      const target = first ? forms.values().next().value?.response : tool;
      if (reset) target?.socket?.resetAndDestroy(); else target?.end();
    },
    closeGet() { listening?.socket?.resetAndDestroy(); },
  };
}

async function client(url: string) {
  let forms = 0;
  let answer!: (value: { action: "cancel" }) => void;
  const pending = new Promise<{ action: "cancel" }>(resolve => { answer = resolve; });
  const manager = new MCPClientManager({}, {
    lazyConnect: true,
    extensionRequestHandlers: { server: [{
      method: "openai/elicitation/create",
      waitsForInput: true,
      legacyClaim: "openai/elicitation",
      schemas: { params: z.object({ mode: z.literal("form"), message: z.string(), requestedSchema: z.unknown() }), result: z.object({ action: z.literal("cancel") }) },
      handler: async () => { forms++; return pending; },
    }] },
  });
  await manager.connectToServer("server", { url, mcpProtocolVersion: "2025-11-25", reconnectionOptions: { initialReconnectionDelay: 10, maxReconnectionDelay: 10, maxRetries: 2 } });
  cleanup.push(async () => { answer({ action: "cancel" }); await manager.disconnectAllServers(); });
  return { manager, answer, get forms() { return forms; } };
}

it.each([false, true])("ends an unanswered tool when its HTTP response terminates (reset=%s)", async reset => {
  const remote = await peer();
  const host = await client(remote.url);
  const abort = new AbortController();
  let outcome = "pending";
  const call = host.manager.executeTool("server", "ask", {}, { request: { signal: abort.signal, timeout: 5000 } })
    .then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
  try {
    await vi.waitFor(() => expect(host.forms).toBe(1));
    remote.closeTool(reset);
    await vi.waitFor(() => expect(outcome).toBe("rejected"), { timeout: 500 });
    expect(remote.calls).toBe(1);
    expect(host.manager.getConnectionStatus("server")).toBe("connected");
  } finally {
    abort.abort();
    host.answer({ action: "cancel" });
    await call;
  }
});

it("keeps a final response that is followed by EOF", async () => {
  const remote = await peer();
  const host = await client(remote.url);
  const call = host.manager.executeTool("server", "ask");
  await vi.waitFor(() => expect(host.forms).toBe(1));
  host.answer({ action: "cancel" });
  await expect(call).resolves.toMatchObject({ content: [{ text: "one result" }] });
  expect(remote.calls).toBe(1);
  expect(host.manager.getConnectionStatus("server")).toBe("connected");
});

it("does not fail the tool when the persistent GET stream reconnects", async () => {
  const remote = await peer();
  const host = await client(remote.url);
  const call = host.manager.executeTool("server", "ask");
  await vi.waitFor(() => { expect(host.forms).toBe(1); expect(remote.listening).toBe(true); });
  remote.closeGet();
  host.answer({ action: "cancel" });
  await expect(call).resolves.toMatchObject({ content: [{ text: "one result" }] });
  expect(remote.calls).toBe(1);
});

it("preserves a resumable tool response instead of closing on its first EOF", async () => {
  const remote = await peer({ resumable: true });
  const host = await client(remote.url);
  const call = host.manager.executeTool("server", "ask", {}, { request: { timeout: 2000 } });
  await vi.waitFor(() => expect(remote.calls).toBe(1));
  remote.closeTool(false);
  await expect(call).resolves.toMatchObject({ content: [{ text: "one result" }] });
  expect(remote.resumed).toBe(1);
  expect(remote.calls).toBe(1);
});

it("keeps an intentional cancellation from closing the connection on later EOF", async () => {
  const remote = await peer();
  const host = await client(remote.url);
  const abort = new AbortController();
  const call = host.manager.executeTool("server", "ask", {}, { request: { signal: abort.signal } });
  const rejected = expect(call).rejects.toThrow();
  await vi.waitFor(() => expect(host.forms).toBe(1));
  abort.abort();
  await rejected;
  await vi.waitFor(() => expect(remote.cancellations).toBe(1));
  remote.closeTool(false);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(host.manager.getConnectionStatus("server")).toBe("connected");
});

it("fails only the lost response while another tool on the connection completes", async () => {
  const remote = await peer();
  const host = await client(remote.url);
  let firstOutcome = "pending";
  const first = host.manager.executeTool("server", "ask").then(
    () => { firstOutcome = "resolved"; },
    () => { firstOutcome = "rejected"; },
  );
  await vi.waitFor(() => expect(host.forms).toBe(1));
  let secondOutcome = "pending";
  const second = host.manager.executeTool("server", "ask").then(result => {
    secondOutcome = "resolved";
    return result;
  });
  await vi.waitFor(() => expect(host.forms).toBe(2));
  remote.closeTool(true, true);
  await vi.waitFor(() => expect(firstOutcome).toBe("rejected"), { timeout: 500 });
  expect(secondOutcome).toBe("pending");
  host.answer({ action: "cancel" });
  await expect(second).resolves.toMatchObject({ content: [{ text: "one result" }] });
  await first;
  expect(remote.calls).toBe(2);
  expect(host.manager.getConnectionStatus("server")).toBe("connected");
});
