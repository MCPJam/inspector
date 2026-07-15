/**
 * HTTP Adapters Tests
 *
 * Tests for the HTTP/SSE bridge endpoints that proxy MCP servers.
 * These tests verify:
 * - No hardcoded Access-Control-Allow-Origin: * headers
 * - Routes require authentication via the security middleware
 * - Cross-origin requests are blocked
 *
 * SECURITY NOTE: These tests exist because this route was previously vulnerable
 * to cross-origin attacks (GHSA-39g4-cgq3-5763). The vulnerability allowed any
 * website to invoke MCP tools and read resources from connected servers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  expectJson,
  type MockMCPClientManager,
} from "./helpers/index.js";
import {
  generateSessionToken,
  getSessionToken,
} from "../../../services/session-token.js";
import {
  registerTunnelDomain,
  unregisterTunnelDomain,
} from "../../../services/tunnel-registry.js";

describe("HTTP Adapters Security", () => {
  let manager: MockMCPClientManager;
  let app: Hono;
  let validToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    validToken = generateSessionToken();

    // Configure mock manager for http-adapters
    manager = createMockMcpClientManager({
      listServers: vi.fn().mockReturnValue(["test-server"]),
      getClient: vi
        .fn()
        .mockImplementation((id: string) => (id === "test-server" ? {} : null)),
      getManagedClient: vi
        .fn()
        .mockImplementation((id: string) =>
          id === "test-server" ? {} : undefined
        ),
      hasServer: vi
        .fn()
        .mockImplementation((id: string) => id === "test-server"),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      listResources: vi.fn().mockResolvedValue({ resources: [] }),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      executeTool: vi.fn().mockResolvedValue({ content: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
      getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    });

    // Create app with security middleware enabled
    app = createTestApp(manager, ["adapter-http", "manager-http"], {
      withSecurity: true,
    });
  });

  describe("authentication not required (tunneling support)", () => {
    /**
     * HTTP adapter endpoints are intentionally unprotected IN-PROCESS to
     * support tunneling: external MCP clients (Claude Desktop, ChatGPT)
     * reach them through an ngrok tunnel and have no session token.
     *
     * The real gate is at the ngrok EDGE, before traffic reaches this app:
     * the Traffic Policy bound at listen time (built by the backend's
     * convex/lib/tunnelPolicy.ts) rejects requests without the per-tunnel
     * `?k=` bearer secret (401), confines the tunnel to its provisioned
     * serverId's adapter path (404), and rate-limits per secret.
     *
     * In-process defenses that remain:
     * 1. Cross-origin protection - browser-based attacks are blocked
     * 2. Per-server isolation guard - see "tunnel per-server isolation"
     * 3. Session-token tunnel-host denial - tokens never cross a tunnel
     */
    const routes = [
      { prefix: "adapter-http", description: "adapter HTTP bridge" },
      { prefix: "manager-http", description: "manager HTTP bridge" },
    ];

    for (const { prefix, description } of routes) {
      describe(`${description}`, () => {
        it("accepts POST without authentication token (for tunneled clients)", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          // Should succeed - these endpoints are unprotected for tunneling
          expect(res.status).toBe(200);
        });

        it("accepts GET (SSE) without authentication token (for tunneled clients)", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "GET",
          });

          // SSE returns 200 with streaming response
          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        });

        it("also accepts POST with valid token in header", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-MCP-Session-Auth": `Bearer ${validToken}`,
            },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          expect(res.status).toBe(200);
        });

        it("also accepts GET (SSE) with valid token in query param", async () => {
          const res = await app.request(
            `/api/mcp/${prefix}/test-server?_token=${validToken}`,
            {
              method: "GET",
            }
          );

          // SSE returns 200 with streaming response
          expect(res.status).toBe(200);
          expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        });
      });
    }
  });

  describe("cross-origin protection", () => {
    const routes = [
      { prefix: "adapter-http", description: "adapter HTTP bridge" },
      { prefix: "manager-http", description: "manager HTTP bridge" },
    ];

    for (const { prefix, description } of routes) {
      describe(`${description}`, () => {
        it("blocks requests from malicious origins", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://evil.com",
              "X-MCP-Session-Auth": `Bearer ${validToken}`,
            },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          expect(res.status).toBe(403);
          const data = await res.json();
          expect(data.error).toBe("Forbidden");
          expect(data.message).toBe("Request origin not allowed.");
        });

        it("allows requests from localhost origin", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:5173",
              "X-MCP-Session-Auth": `Bearer ${validToken}`,
            },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          expect(res.status).toBe(200);
        });

        it("allows requests from 127.0.0.1 origin", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://127.0.0.1:6274",
              "X-MCP-Session-Auth": `Bearer ${validToken}`,
            },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          expect(res.status).toBe(200);
        });
      });
    }
  });

  describe("no hardcoded CORS * headers", () => {
    const routes = [
      { prefix: "adapter-http", description: "adapter HTTP bridge" },
      { prefix: "manager-http", description: "manager HTTP bridge" },
    ];

    for (const { prefix, description } of routes) {
      describe(`${description}`, () => {
        it("does not return Access-Control-Allow-Origin: * on POST response", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost:5173",
              "X-MCP-Session-Auth": `Bearer ${validToken}`,
            },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          expect(res.status).toBe(200);

          // CORS header should be set to the actual origin (from global CORS middleware),
          // not to "*" wildcard
          const corsHeader = res.headers.get("Access-Control-Allow-Origin");
          expect(corsHeader).not.toBe("*");
          // It should either be the actual origin or null (if not in allowed list)
          if (corsHeader) {
            expect(corsHeader).toBe("http://localhost:5173");
          }
        });

        it("does not return Access-Control-Allow-Origin: * on OPTIONS response", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "OPTIONS",
            headers: {
              Origin: "http://localhost:5173",
              "Access-Control-Request-Method": "POST",
            },
          });

          expect(res.status).toBe(204);

          const corsHeader = res.headers.get("Access-Control-Allow-Origin");
          expect(corsHeader).not.toBe("*");
        });

        it("does not return Access-Control-Allow-Origin: * on GET (SSE) response", async () => {
          const res = await app.request(
            `/api/mcp/${prefix}/test-server?_token=${validToken}`,
            {
              method: "GET",
              headers: {
                Origin: "http://localhost:5173",
              },
            }
          );

          expect(res.status).toBe(200);

          const corsHeader = res.headers.get("Access-Control-Allow-Origin");
          expect(corsHeader).not.toBe("*");
        });
      });
    }
  });

  describe("JSON-RPC methods work with proper auth", () => {
    it("handles resources/list", async () => {
      const res = await app.request("/api/mcp/manager-http/test-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({ id: 1, method: "resources/list", params: {} }),
      });

      const { status, data } = await expectJson(res);
      expect(status).toBe(200);
      expect(data.jsonrpc).toBe("2.0");
      expect(data.id).toBe(1);
      expect(data.result).toBeDefined();
    });

    it("handles tools/list", async () => {
      const res = await app.request("/api/mcp/manager-http/test-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({ id: 2, method: "tools/list", params: {} }),
      });

      const { status, data } = await expectJson(res);
      expect(status).toBe(200);
      expect(data.jsonrpc).toBe("2.0");
      expect(data.id).toBe(2);
    });

    it("handles ping", async () => {
      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({ id: 3, method: "ping", params: {} }),
      });

      const { status, data } = await expectJson(res);
      expect(status).toBe(200);
      expect(data.jsonrpc).toBe("2.0");
      expect(data.id).toBe(3);
      expect(data.result).toEqual({});
    });
  });

  describe("transparent bridge: initialize", () => {
    it("returns the connected server's real initialize info", async () => {
      manager.getInitializationInfo.mockReturnValue({
        protocolVersion: "2025-03-26",
        transport: "stdio",
        serverCapabilities: { tools: { listChanged: true }, completions: {} },
        serverVersion: { name: "real-server", version: "9.9.9" },
        instructions: "Handle with care",
        clientCapabilities: {},
      });

      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, method: "initialize", params: {} }),
      });

      const { status, data } = await expectJson(res);
      expect(status).toBe(200);
      expect(data.result.protocolVersion).toBe("2025-03-26");
      expect(data.result.capabilities).toEqual({
        tools: { listChanged: true },
        completions: {},
      });
      expect(data.result.serverInfo).toEqual({
        name: "real-server",
        version: "9.9.9",
      });
      expect(data.result.instructions).toBe("Handle with care");
    });

    it("falls back to the fabricated initialize when the server is not connected", async () => {
      manager.getInitializationInfo.mockReturnValue(undefined);

      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, method: "initialize", params: {} }),
      });

      const { status, data } = await expectJson(res);
      expect(status).toBe(200);
      expect(data.result.serverInfo.version).toBe("stdio-adapter");
    });
  });

  describe("transparent bridge: passthrough of unhandled methods", () => {
    it("forwards unhandled methods verbatim to the managed client", async () => {
      const request = vi.fn().mockResolvedValue({
        resourceTemplates: [{ uriTemplate: "file://{path}" }],
      });
      manager.getManagedClient.mockImplementation((id: string) =>
        id === "test-server" ? { request } : undefined
      );

      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 7,
          method: "resources/templates/list",
          params: { cursor: "abc" },
        }),
      });

      const { status, data } = await expectJson(res);
      expect(status).toBe(200);
      expect(request).toHaveBeenCalledWith({
        method: "resources/templates/list",
        params: { cursor: "abc" },
      });
      expect(data.result.resourceTemplates).toEqual([
        { uriTemplate: "file://{path}" },
      ]);
    });

    it("maps passthrough failures to JSON-RPC -32000", async () => {
      const request = vi.fn().mockRejectedValue(new Error("upstream broke"));
      manager.getManagedClient.mockImplementation((id: string) =>
        id === "test-server" ? { request } : undefined
      );

      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 8,
          method: "completion/complete",
          params: {},
        }),
      });

      const { data } = await expectJson(res);
      expect(data.error.code).toBe(-32000);
      expect(data.error.message).toBe("upstream broke");
    });

    it("still returns -32601 when no managed client exists for the server", async () => {
      manager.getManagedClient.mockReturnValue(undefined);

      const res = await app.request("/api/mcp/adapter-http/ghost-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 9,
          method: "completion/complete",
          params: {},
        }),
      });

      const { data } = await expectJson(res);
      expect(data.error.code).toBe(-32601);
    });
  });

  describe("tunnel per-server isolation", () => {
    afterEach(() => {
      unregisterTunnelDomain("bound.ngrok.app");
      unregisterTunnelDomain("shared-tunnel.ngrok.app");
    });

    const postResourcesList = (serverId: string, forwardedHost?: string) =>
      app.request(`/api/mcp/adapter-http/${serverId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(forwardedHost ? { "X-Forwarded-Host": forwardedHost } : {}),
        },
        body: JSON.stringify({ id: 1, method: "resources/list", params: {} }),
      });

    it("404s when a per-server tunnel addresses a different serverId", async () => {
      registerTunnelDomain("bound.ngrok.app", "other-server");
      const res = await postResourcesList("test-server", "bound.ngrok.app");
      expect(res.status).toBe(404);
    });

    it("allows the bound serverId through its own tunnel", async () => {
      registerTunnelDomain("bound.ngrok.app", "test-server");
      const res = await postResourcesList("test-server", "bound.ngrok.app");
      expect(res.status).toBe(200);
    });

    it("ignores x-forwarded-host values that are not active tunnel domains", async () => {
      const res = await postResourcesList("test-server", "corp-proxy.internal");
      expect(res.status).toBe(200);
    });

    it("does not restrict the legacy shared tunnel", async () => {
      registerTunnelDomain("shared-tunnel.ngrok.app", null);
      const res = await postResourcesList(
        "test-server",
        "shared-tunnel.ngrok.app"
      );
      expect(res.status).toBe(200);
    });

    it("guards the SSE GET endpoint too", async () => {
      registerTunnelDomain("bound.ngrok.app", "other-server");
      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "GET",
        headers: { "X-Forwarded-Host": "bound.ngrok.app" },
      });
      expect(res.status).toBe(404);
    });

    it("guards the SSE messages endpoint before session validation", async () => {
      registerTunnelDomain("bound.ngrok.app", "other-server");
      const res = await app.request(
        "/api/mcp/adapter-http/test-server/messages?sessionId=nope",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-Host": "bound.ngrok.app",
          },
          body: JSON.stringify({ id: 1, method: "ping", params: {} }),
        }
      );
      // 404 from the scope guard, not 400 invalid-session
      expect(res.status).toBe(404);
    });
  });

  describe("SSE endpoint event carries the tunnel bearer secret", () => {
    it("appends ?k= from the incoming GET to the advertised messages URL", async () => {
      const res = await app.request(
        "/api/mcp/adapter-http/test-server?k=tunnelsecret123",
        { method: "GET" }
      );
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (let i = 0; i < 8; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("event: endpoint") && buf.includes("sessionId=")) {
          break;
        }
      }
      await reader.cancel();

      // The endpoint URL is used verbatim by SSE clients; without the
      // secret their POSTs would be rejected at the ngrok edge.
      expect(buf).toContain("k=tunnelsecret123");
      expect(buf).toMatch(/k=tunnelsecret123&sessionId=|sessionId=[^&]*&k=/);
    });

    it("does not invent a secret when the GET has none", async () => {
      const res = await app.request("/api/mcp/adapter-http/test-server", {
        method: "GET",
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (let i = 0; i < 8; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("event: endpoint") && buf.includes("sessionId=")) {
          break;
        }
      }
      await reader.cancel();
      expect(buf).not.toContain("k=");
    });
  });

  describe("server notification relay over SSE", () => {
    it("forwards registered server notifications as SSE message frames", async () => {
      // Unique serverId: the relay hook registry is module-level, so reusing
      // "test-server" would be a no-op after earlier SSE tests in this file.
      const serverId = `relay-server-${Date.now()}`;
      const captured = new Map<string, (notification: any) => void>();
      manager.addNotificationHandler.mockImplementation(
        (sid: string, method: string, handler: (notification: any) => void) => {
          if (sid === serverId) {
            captured.set(method, handler);
          }
        }
      );

      const res = await app.request(`/api/mcp/adapter-http/${serverId}`, {
        method: "GET",
      });
      expect(res.status).toBe(200);

      // The relay subscribes to the standard MCP notification methods.
      expect(captured.has("notifications/resources/list_changed")).toBe(true);
      expect(captured.has("notifications/progress")).toBe(true);
      expect(captured.has("notifications/message")).toBe(true);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // Drain the handshake, then trigger a notification and expect it as
      // an SSE `message` frame carrying the JSON-RPC notification.
      const handler = captured.get("notifications/resources/list_changed")!;
      handler({
        method: "notifications/resources/list_changed",
        params: {},
      });

      for (let i = 0; i < 8; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (
          buf.includes("event: message") &&
          buf.includes("notifications/resources/list_changed")
        ) {
          break;
        }
      }
      await reader.cancel();

      expect(buf).toContain("event: message");
      expect(buf).toContain("notifications/resources/list_changed");
      expect(buf).toContain('"jsonrpc":"2.0"');
    });

    it("re-registers stable relay handlers on every SSE open (survives removeServer)", async () => {
      // removeServer() clears the manager's stored notification handlers;
      // a re-added server with the same id must get its relay hooks back
      // when the next tunneled stream opens. The handler instances must be
      // stable so re-registration dedupes in the manager's handler Set.
      const serverId = `rehook-server-${Date.now()}`;
      const registrations: Array<{ method: string; handler: unknown }> = [];
      manager.addNotificationHandler.mockImplementation(
        (sid: string, method: string, handler: unknown) => {
          if (sid === serverId) {
            registrations.push({ method, handler });
          }
        }
      );

      const first = await app.request(`/api/mcp/adapter-http/${serverId}`, {
        method: "GET",
      });
      expect(first.status).toBe(200);
      const firstCount = registrations.length;
      expect(firstCount).toBeGreaterThan(0);
      await first.body!.cancel();

      // Simulates the state after removeServer + re-add: the manager lost
      // its handlers, and a new SSE open must register them again.
      const second = await app.request(`/api/mcp/adapter-http/${serverId}`, {
        method: "GET",
      });
      expect(second.status).toBe(200);
      await second.body!.cancel();

      expect(registrations.length).toBe(firstCount * 2);
      const firstByMethod = new Map(
        registrations.slice(0, firstCount).map((r) => [r.method, r.handler])
      );
      for (const { method, handler } of registrations.slice(firstCount)) {
        expect(handler).toBe(firstByMethod.get(method));
      }
    });
  });

  describe("regression: GHSA-39g4-cgq3-5763 PoC", () => {
    /**
     * This test reproduces the exact attack vector from the security report.
     * The PoC demonstrated that any website could invoke MCP tools by making
     * cross-origin requests to the HTTP bridge endpoints.
     *
     * Original PoC:
     * ```html
     * <script>
     * const endpoint = "http://127.0.0.1:6274/api/mcp/manager-http/local";
     * fetch(endpoint, {
     *   method: "POST",
     *   headers: {"Content-Type":"application/json"},
     *   body: JSON.stringify({id:1, method:"resources/list", params:{}})
     * }).then(r=>r.text()).then(console.log);
     * </script>
     * ```
     */
    it("blocks the exact attack vector from the security report", async () => {
      // Simulate cross-origin fetch from malicious website without auth token
      const res = await app.request("/api/mcp/manager-http/test-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil-website.com",
        },
        body: JSON.stringify({ id: 1, method: "resources/list", params: {} }),
      });

      // Should be blocked by origin validation (403) before auth check (401)
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("Forbidden");
      expect(data.message).toBe("Request origin not allowed.");
    });

    it("blocks cross-origin requests even if attacker guesses a valid token", async () => {
      // Even with a valid token, cross-origin requests should be blocked
      const res = await app.request("/api/mcp/manager-http/test-server", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil-website.com",
          "X-MCP-Session-Auth": `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          id: 1,
          method: "tools/call",
          params: { name: "dangerous_tool" },
        }),
      });

      // Origin validation happens before auth, so still 403
      expect(res.status).toBe(403);
    });
  });
});
