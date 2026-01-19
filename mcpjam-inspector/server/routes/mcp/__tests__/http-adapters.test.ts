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

import { describe, it, expect, beforeEach, vi } from "vitest";
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

  describe("authentication required", () => {
    const routes = [
      { prefix: "adapter-http", description: "adapter HTTP bridge" },
      { prefix: "manager-http", description: "manager HTTP bridge" },
    ];

    for (const { prefix, description } of routes) {
      describe(`${description}`, () => {
        it("rejects POST without authentication token", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: 1,
              method: "resources/list",
              params: {},
            }),
          });

          expect(res.status).toBe(401);
          const data = await res.json();
          expect(data.error).toBe("Unauthorized");
        });

        it("rejects GET (SSE) without authentication token", async () => {
          const res = await app.request(`/api/mcp/${prefix}/test-server`, {
            method: "GET",
          });

          expect(res.status).toBe(401);
        });

        it("accepts POST with valid token in header", async () => {
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

        it("accepts GET (SSE) with valid token in query param", async () => {
          const res = await app.request(
            `/api/mcp/${prefix}/test-server?_token=${validToken}`,
            {
              method: "GET",
            },
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
            },
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
