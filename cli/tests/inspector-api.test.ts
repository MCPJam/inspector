import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import type { AddressInfo } from "node:net";
import {
  InspectorApiClient,
  buildInspectorBrowserUrl,
  clearInspectorSessionTokenCache,
  ensureInspector,
  getNpxExecutable,
  normalizeInspectorFrontendUrl,
  normalizeInspectorBaseUrl,
  resolveInspectorBrowserBaseUrl,
  stopInspector,
} from "../src/lib/inspector-api.js";

const previousDisableBrowserOpen = process.env.MCPJAM_CLI_DISABLE_BROWSER_OPEN;
const INSPECTOR_FRONTEND_HTML =
  '<!doctype html><meta name="mcpjam-inspector" content="true"><title>MCPJam Inspector</title><div id="root"></div>';

before(() => {
  process.env.MCPJAM_CLI_DISABLE_BROWSER_OPEN = "1";
});

after(() => {
  if (previousDisableBrowserOpen === undefined) {
    delete process.env.MCPJAM_CLI_DISABLE_BROWSER_OPEN;
  } else {
    process.env.MCPJAM_CLI_DISABLE_BROWSER_OPEN = previousDisableBrowserOpen;
  }
});

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

async function withServerOnAvailablePort(
  ports: number[],
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  let lastError: unknown;

  for (const port of ports) {
    const server = http.createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      try {
        await fn(`http://127.0.0.1:${port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        // EADDRINUSE means listen never completed; close reports ERR_SERVER_NOT_RUNNING, which is safe to swallow here.
        server.close(() => resolve());
      });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("No available port for test server.");
}

async function withServersOnConsecutiveAvailablePorts(
  ports: number[],
  handlers: [http.RequestListener, http.RequestListener],
  fn: (baseUrls: [string, string]) => Promise<void>,
): Promise<void> {
  let lastError: unknown;

  for (const port of ports) {
    const servers = handlers.map((handler) => http.createServer(handler)) as [
      http.Server,
      http.Server,
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        servers[0].once("error", reject);
        servers[0].listen(port, "127.0.0.1", () => {
          servers[0].off("error", reject);
          resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        servers[1].once("error", reject);
        servers[1].listen(port + 1, "127.0.0.1", () => {
          servers[1].off("error", reject);
          resolve();
        });
      });

      try {
        await fn([
          `http://127.0.0.1:${port}`,
          `http://127.0.0.1:${port + 1}`,
        ]);
      } finally {
        await Promise.all(
          servers.map(
            (server) =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
              }),
          ),
        );
      }
      return;
    } catch (error) {
      lastError = error;
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("No consecutive ports available for test servers.");
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

test("normalizeInspectorBaseUrl preserves explicit localhost hosts", () => {
  assert.equal(
    normalizeInspectorBaseUrl("http://localhost:6274/"),
    "http://localhost:6274",
  );
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
    buildInspectorBrowserUrl(
      "http://127.0.0.1:6274",
      "http://localhost:6274/",
      "app-builder",
    ),
    "http://127.0.0.1:6274/#app-builder",
  );
  assert.equal(
    buildInspectorBrowserUrl("http://127.0.0.1:6274", undefined, "app-builder"),
    "http://127.0.0.1:6274/#app-builder",
  );
});

test("ensureInspector reports the frontend URL from Inspector health", async () => {
  await withServer(
    (frontendRequest, frontendResponse) => {
      if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
        frontendResponse.writeHead(200, { "Content-Type": "text/html" });
        frontendResponse.end(INSPECTOR_FRONTEND_HTML);
        return;
      }

      frontendResponse.writeHead(404);
      frontendResponse.end();
    },
    async (frontendUrl) => {
      await withServer(
        (request, response) => {
          if (request.method === "GET" && request.url === "/health") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                status: "ok",
                hasActiveClient: true,
                frontend: `${frontendUrl}/`,
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
            frontendUrl,
            hasActiveClient: true,
            url: `${frontendUrl}/#app-builder`,
            started: false,
          });
        },
      );
    },
  );
});

test("ensureInspector with explicit frontendUrl skips advertised frontend probes", async () => {
  let advertisedRootRequests = 0;

  await withServer(
    (frontendRequest, frontendResponse) => {
      if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
        advertisedRootRequests += 1;
        frontendResponse.writeHead(200, { "Content-Type": "text/html" });
        frontendResponse.end(INSPECTOR_FRONTEND_HTML);
        return;
      }

      frontendResponse.writeHead(404);
      frontendResponse.end();
    },
    async (advertisedFrontendUrl) => {
      await withServer(
        (request, response) => {
          if (request.method === "GET" && request.url === "/health") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                status: "ok",
                hasActiveClient: true,
                frontend: `${advertisedFrontendUrl}/`,
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
            frontendUrl: "http://localhost:9/inspector/?debug=1#old",
            openBrowser: false,
            tab: "app-builder",
          });

          assert.equal(advertisedRootRequests, 0);
          assert.deepEqual(result, {
            baseUrl,
            frontendUrl: "http://localhost:9/inspector",
            hasActiveClient: true,
            url: "http://localhost:9/inspector/#app-builder",
            started: false,
          });
        },
      );
    },
  );
});

test("ensureInspector allows active attach when health frontend is stale", async () => {
  const staleFrontendUrl = "http://127.0.0.1:9";

  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "ok",
            hasActiveClient: true,
            frontend: staleFrontendUrl,
          }),
        );
        return;
      }

      if (request.method === "GET" && request.url === "/api/session-token") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ token: "ok" }));
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const result = await ensureInspector({
        baseUrl,
        openBrowser: false,
        startIfNeeded: false,
        tab: "app-builder",
      });

      assert.equal(result.hasActiveClient, true);
      assert.equal(result.frontendUrl, staleFrontendUrl);
      assert.equal(result.url, `${staleFrontendUrl}/#app-builder`);
      assert.equal(result.started, false);
    },
  );
});

test("ensureInspector with skipDiscovery avoids nearby frontend port scans", async () => {
  let nearbyRootRequests = 0;

  await withServerOnAvailablePort(
    [5181, 5182, 5183, 5184, 5185],
    (frontendRequest, frontendResponse) => {
      if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
        nearbyRootRequests += 1;
        frontendResponse.writeHead(200, { "Content-Type": "text/html" });
        frontendResponse.end(INSPECTOR_FRONTEND_HTML);
        return;
      }

      frontendResponse.writeHead(404);
      frontendResponse.end();
    },
    async (frontendUrl) => {
      const frontendPort = Number(new URL(frontendUrl).port);
      const staleFrontendUrl = `http://127.0.0.1:${frontendPort - 1}`;

      await withServer(
        (request, response) => {
          if (request.method === "GET" && request.url === "/health") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                status: "ok",
                hasActiveClient: true,
                frontend: staleFrontendUrl,
              }),
            );
            return;
          }

          if (
            request.method === "GET" &&
            request.url === "/api/session-token"
          ) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ token: "ok" }));
            return;
          }

          response.writeHead(404);
          response.end();
        },
        async (baseUrl) => {
          const result = await ensureInspector({
            baseUrl,
            openBrowser: false,
            skipDiscovery: true,
            tab: "app-builder",
          });

          assert.equal(nearbyRootRequests, 0);
          assert.equal(result.frontendUrl, staleFrontendUrl);
          assert.equal(result.url, `${staleFrontendUrl}/#app-builder`);
          assert.equal(result.started, false);
        },
      );
    },
  );
});

test("resolveInspectorBrowserBaseUrl discovers nearby dev frontend when health is stale", async () => {
  await withServer(
    (request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      await withServerOnAvailablePort(
        [5181, 5182, 5183, 5184, 5185],
        (request, response) => {
          if (request.method === "GET" && request.url === "/") {
            response.writeHead(200, { "Content-Type": "text/html" });
            response.end(INSPECTOR_FRONTEND_HTML);
            return;
          }

          response.writeHead(404);
          response.end();
        },
        async (frontendUrl) => {
          const frontendPort = Number(new URL(frontendUrl).port);
          // One-port stale hint depends on the resolver's frontend probe window.
          const staleFrontendUrl = `http://127.0.0.1:${frontendPort - 1}`;

          assert.equal(
            await resolveInspectorBrowserBaseUrl(baseUrl, staleFrontendUrl),
            frontendUrl,
          );
        },
      );
    },
  );
});

test("resolveInspectorBrowserBaseUrl prefers first usable discovered frontend deterministically", async () => {
  await withServersOnConsecutiveAvailablePorts(
    [5181, 5182, 5183, 5184],
    [
      (frontendRequest, frontendResponse) => {
        if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
          frontendResponse.writeHead(200, { "Content-Type": "text/html" });
          frontendResponse.end(INSPECTOR_FRONTEND_HTML);
          return;
        }

        frontendResponse.writeHead(404);
        frontendResponse.end();
      },
      (frontendRequest, frontendResponse) => {
        if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
          frontendResponse.writeHead(200, { "Content-Type": "text/html" });
          frontendResponse.end(INSPECTOR_FRONTEND_HTML);
          return;
        }

        frontendResponse.writeHead(404);
        frontendResponse.end();
      },
    ],
    async ([firstFrontendUrl, secondFrontendUrl]) => {
      const firstFrontendPort = Number(new URL(firstFrontendUrl).port);
      const staleFrontendUrl = `http://127.0.0.1:${firstFrontendPort - 1}`;

      await withServer(
        (request, response) => {
          if (
            request.method === "GET" &&
            request.url === "/api/session-token"
          ) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ token: "ok" }));
            return;
          }

          response.writeHead(404);
          response.end();
        },
        async (baseUrl) => {
          assert.equal(
            await resolveInspectorBrowserBaseUrl(baseUrl, staleFrontendUrl),
            firstFrontendUrl,
          );
          assert.notEqual(firstFrontendUrl, secondFrontendUrl);
        },
      );
    },
  );
});

test("resolveInspectorBrowserBaseUrl reports advertised frontend rejected by backend", async () => {
  await withServer(
    (frontendRequest, frontendResponse) => {
      if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
        frontendResponse.writeHead(200, { "Content-Type": "text/html" });
        frontendResponse.end(INSPECTOR_FRONTEND_HTML);
        return;
      }

      frontendResponse.writeHead(404);
      frontendResponse.end();
    },
    async (frontendUrl) => {
      await withServer(
        (request, response) => {
          if (
            request.method === "GET" &&
            request.url === "/api/session-token"
          ) {
            response.writeHead(403, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: "Forbidden",
                message: "Request origin not allowed.",
              }),
            );
            return;
          }

          response.writeHead(404);
          response.end();
        },
        async (baseUrl) => {
          await assert.rejects(
            () => resolveInspectorBrowserBaseUrl(baseUrl, frontendUrl),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.match(error.message, /frontend .* is reachable/i);
              assert.doesNotMatch(
                error.message,
                /no Inspector frontend responded/i,
              );
              assert.equal(
                (error as { details?: Record<string, unknown> }).details
                  ?.rejectedFrontendUrl,
                frontendUrl,
              );
              return true;
            },
          );
        },
      );
    },
  );
});

test("resolveInspectorBrowserBaseUrl rejects discovered frontend when backend rejects its origin", async () => {
  await withServerOnAvailablePort(
    [5181, 5182, 5183, 5184, 5185],
    (frontendRequest, frontendResponse) => {
      if (frontendRequest.method === "GET" && frontendRequest.url === "/") {
        frontendResponse.writeHead(200, { "Content-Type": "text/html" });
        frontendResponse.end(INSPECTOR_FRONTEND_HTML);
        return;
      }

      frontendResponse.writeHead(404);
      frontendResponse.end();
    },
    async (frontendUrl) => {
      const frontendPort = Number(new URL(frontendUrl).port);
      // One-port stale hint depends on the resolver's frontend probe window.
      const advertisedUrl = `http://127.0.0.1:${frontendPort - 1}`;

      await withServer(
        (request, response) => {
          if (
            request.method === "GET" &&
            request.url === "/api/session-token"
          ) {
            const origin = request.headers.origin;
            if (origin === advertisedUrl) {
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(JSON.stringify({ token: "ok" }));
              return;
            }

            response.writeHead(403, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                error: "Forbidden",
                message: "Request origin not allowed.",
              }),
            );
            return;
          }

          response.writeHead(404);
          response.end();
        },
        async (baseUrl) => {
          await assert.rejects(
            () => resolveInspectorBrowserBaseUrl(baseUrl, advertisedUrl),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.match(error.message, /Inspector backend advertises /);
              assert.match(error.message, /frontend was found at /);
              assert.match(error.message, /rejects that origin/);
              assert.equal(
                (error as { details?: Record<string, unknown> }).details
                  ?.advertisedFrontendUrl,
                advertisedUrl,
              );
              assert.equal(
                (error as { details?: Record<string, unknown> }).details
                  ?.rejectedFrontendUrl,
                frontendUrl,
              );
              assert.notEqual(
                (error as { details?: Record<string, unknown> }).details
                  ?.advertisedFrontendUrl,
                (error as { details?: Record<string, unknown> }).details
                  ?.rejectedFrontendUrl,
              );
              return true;
            },
          );
        },
      );
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
