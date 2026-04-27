import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  InspectorApiClient,
  buildInspectorBrowserUrl,
  clearInspectorSessionTokenCache,
  ensureInspector,
  getNpxExecutable,
  normalizeInspectorFrontendUrl,
  normalizeInspectorBaseUrl,
  stopInspector,
} from "../src/lib/inspector-api.js";

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

  await withServer(
    async (request, response) => {
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

      if (
        request.method === "POST" &&
        request.url === "/api/mcp/tools/execute"
      ) {
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
    },
    async (baseUrl) => {
      const client = new InspectorApiClient({ baseUrl });
      await client.connectServer("demo", { url: "http://example.test/mcp" });
      const result = await client.executeTool("demo", "echo", {
        message: "hi",
      });

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
    },
  );
});

test("InspectorApiClient applies explicit timeout to connectServer", async () => {
  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/api/session-token") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ token: "connect-timeout-token" }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/mcp/connect") {
        setTimeout(() => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ success: true, status: "connected" }));
        }, 200);
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new InspectorApiClient({ baseUrl });
      const startedAt = Date.now();

      await assert.rejects(
        () =>
          client.connectServer(
            "slow",
            { url: "http://example.test/mcp" },
            { timeoutMs: 25 },
          ),
        /Failed to contact Inspector/,
      );
      assert.ok(Date.now() - startedAt < 1_000);
    },
  );
});

test("InspectorApiClient caches session tokens per base URL", async () => {
  let tokenRequests = 0;

  await withServer(
    (request, response) => {
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
    },
    async (baseUrl) => {
      const client = new InspectorApiClient({ baseUrl });
      await client.listServers();
      await client.listServers();

      assert.equal(tokenRequests, 1);
    },
  );
});

test("InspectorApiClient refreshes stale session tokens after auth failure", async () => {
  let tokenRequests = 0;
  const seenAuth: string[] = [];

  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/api/session-token") {
        tokenRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            token: tokenRequests === 1 ? "stale-token" : "fresh-token",
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/mcp/servers") {
        const auth = request.headers["x-mcp-session-auth"] as
          | string
          | undefined;
        seenAuth.push(auth ?? "");

        if (auth !== "Bearer fresh-token") {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, servers: [] }));
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      clearInspectorSessionTokenCache(baseUrl);
      const client = new InspectorApiClient({ baseUrl });
      const result = await client.listServers();

      assert.deepEqual(result, { success: true, servers: [] });
      assert.equal(tokenRequests, 2);
      assert.deepEqual(seenAuth, ["Bearer stale-token", "Bearer fresh-token"]);
    },
  );
});

test("normalizeInspectorBaseUrl reads MCPJAM_INSPECTOR_URL lazily", () => {
  const previous = process.env.MCPJAM_INSPECTOR_URL;
  try {
    process.env.MCPJAM_INSPECTOR_URL = "http://127.0.0.1:8123/";
    assert.equal(normalizeInspectorBaseUrl(undefined), "http://127.0.0.1:8123");

    process.env.MCPJAM_INSPECTOR_URL = "http://127.0.0.1:9123/";
    assert.equal(normalizeInspectorBaseUrl(undefined), "http://127.0.0.1:9123");
  } finally {
    if (previous === undefined) {
      delete process.env.MCPJAM_INSPECTOR_URL;
    } else {
      process.env.MCPJAM_INSPECTOR_URL = previous;
    }
  }
});

test("normalizeInspectorFrontendUrl accepts absolute frontend URLs only", () => {
  assert.equal(
    normalizeInspectorFrontendUrl("http://localhost:5173/?debug=1#app-builder"),
    "http://localhost:5173",
  );
  assert.equal(normalizeInspectorFrontendUrl("not a url"), undefined);
  assert.equal(normalizeInspectorFrontendUrl(undefined), undefined);
});

test("buildInspectorBrowserUrl prefers health frontend URL for UI tabs", () => {
  assert.equal(
    buildInspectorBrowserUrl(
      "http://127.0.0.1:6274",
      "http://localhost:5173/",
      "app-builder",
    ),
    "http://localhost:5173/#app-builder",
  );
  assert.equal(
    buildInspectorBrowserUrl("http://127.0.0.1:6274", undefined, "app-builder"),
    "http://127.0.0.1:6274/#app-builder",
  );
});

test("ensureInspector reports the frontend URL from Inspector health", async () => {
  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "ok",
            hasActiveClient: true,
            frontend: "http://localhost:5173/",
          }),
        );
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const result = await ensureInspector({
        baseUrl,
        openBrowser: true,
        tab: "app-builder",
      });

      assert.deepEqual(result, {
        baseUrl,
        frontendUrl: "http://localhost:5173",
        url: "http://localhost:5173/#app-builder",
        started: false,
      });
    },
  );
});

test("getNpxExecutable resolves Windows batch shim", () => {
  assert.equal(getNpxExecutable("win32"), "npx.cmd");
  assert.equal(getNpxExecutable("darwin"), "npx");
  assert.equal(getNpxExecutable("linux"), "npx");
});

test("stopInspector posts shutdown with session auth", async () => {
  const seenAuth: string[] = [];

  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (request.method === "GET" && request.url === "/api/session-token") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ token: "shutdown-token" }));
        return;
      }

      if (request.method === "POST" && request.url === "/api/shutdown") {
        seenAuth.push(
          (request.headers["x-mcp-session-auth"] as string | undefined) ?? "",
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      clearInspectorSessionTokenCache(baseUrl);
      const result = await stopInspector(baseUrl);

      assert.deepEqual(result, { stopped: true, baseUrl });
      assert.deepEqual(seenAuth, ["Bearer shutdown-token"]);
    },
  );
});

test("InspectorApiClient returns structured command bus errors from non-2xx responses", async () => {
  const token = "command-token";
  const seen: Array<{ auth?: string; body?: unknown }> = [];

  await withServer(
    async (request, response) => {
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
    },
    async (baseUrl) => {
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
    },
  );
});

test("InspectorApiClient reports persistent auth failure instead of command envelope", async () => {
  let tokenRequests = 0;

  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/api/session-token") {
        tokenRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            token: tokenRequests === 1 ? "stale-token" : "fresh-token",
          }),
        );
        return;
      }

      if (request.method === "POST" && request.url === "/api/mcp/command") {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "cmd-auth",
            status: "error",
            error: {
              code: "no_active_client",
              message: "This body should not mask auth failure.",
            },
          }),
        );
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      clearInspectorSessionTokenCache(baseUrl);
      const client = new InspectorApiClient({ baseUrl });

      await assert.rejects(
        () =>
          client.executeCommand({
            id: "cmd-auth",
            type: "openAppBuilder",
            payload: {},
          }),
        /Inspector command request failed authentication with 403/,
      );
      assert.equal(tokenRequests, 2);
    },
  );
});
