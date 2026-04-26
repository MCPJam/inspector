import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { InspectorApiClient } from "../src/lib/inspector-api.js";

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("InspectorApiClient sends session token auth and supported endpoint payloads", async () => {
  const token = "session-token";
  const seen: Array<{ url?: string; auth?: string; body?: unknown }> = [];

  await withServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/connect") {
      const body = await readJsonBody(request);
      seen.push({
        url: request.url,
        auth: request.headers["x-mcp-session-auth"] as string | undefined,
        body,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, status: "connected" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/tools/execute") {
      const body = await readJsonBody(request);
      seen.push({
        url: request.url,
        auth: request.headers["x-mcp-session-auth"] as string | undefined,
        body,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "completed",
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  }, async (baseUrl) => {
    const client = new InspectorApiClient({ baseUrl });
    await client.connectServer("demo", { url: "http://example.test/mcp" });
    const result = await client.executeTool("demo", "echo", { message: "hi" });

    assert.deepEqual(result, {
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    assert.deepEqual(seen, [
      {
        url: "/api/mcp/connect",
        auth: `Bearer ${token}`,
        body: {
          serverId: "demo",
          serverConfig: { url: "http://example.test/mcp" },
        },
      },
      {
        url: "/api/mcp/tools/execute",
        auth: `Bearer ${token}`,
        body: {
          serverId: "demo",
          toolName: "echo",
          parameters: { message: "hi" },
        },
      },
    ]);
  });
});

test("InspectorApiClient caches session tokens per base URL", async () => {
  let tokenRequests = 0;

  await withServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/session-token") {
      tokenRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "cached-token" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/mcp/servers") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, servers: [] }));
      return;
    }

    response.writeHead(404);
    response.end();
  }, async (baseUrl) => {
    const client = new InspectorApiClient({ baseUrl });
    await client.listServers();
    await client.listServers();

    assert.equal(tokenRequests, 1);
  });
});

test("InspectorApiClient returns structured command bus errors from non-2xx responses", async () => {
  const token = "command-token";
  const seen: Array<{ auth?: string; body?: unknown }> = [];

  await withServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/command") {
      const body = await readJsonBody(request);
      seen.push({
        auth: request.headers["x-mcp-session-auth"] as string | undefined,
        body,
      });
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          id: body.id,
          status: "error",
          error: {
            code: "no_active_client",
            message: "No active Inspector client is subscribed.",
          },
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  }, async (baseUrl) => {
    const client = new InspectorApiClient({ baseUrl });
    const result = await client.executeCommand({
      id: "cmd-1",
      type: "openAppBuilder",
      payload: {},
    });

    assert.deepEqual(result, {
      id: "cmd-1",
      status: "error",
      error: {
        code: "no_active_client",
        message: "No active Inspector client is subscribed.",
      },
    });
    assert.deepEqual(seen, [
      {
        auth: `Bearer ${token}`,
        body: {
          id: "cmd-1",
          type: "openAppBuilder",
          payload: {},
        },
      },
    ]);
  });
});
