import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Mock the entire auth module to avoid transitive @mcpjam/sdk resolution
vi.mock("../auth.js", () => {
  class WebRouteError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        const result = await handler();
        return c.json(result, 200);
      } catch (error: any) {
        // Check for WebRouteError by duck-typing (status + code properties)
        if (error && typeof error.status === "number" && error.code) {
          return c.json(
            { code: error.code, message: error.message },
            error.status,
          );
        }
        return c.json({ code: "INTERNAL_ERROR", message: error.message }, 500);
      }
    },
    WebRouteError,
  };
});

vi.mock("../errors.js", () => {
  const ErrorCode = {
    UNAUTHORIZED: "UNAUTHORIZED",
    VALIDATION_ERROR: "VALIDATION_ERROR",
    INTERNAL_ERROR: "INTERNAL_ERROR",
    TIMEOUT: "TIMEOUT",
  };

  class WebRouteError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  return {
    ErrorCode,
    WebRouteError,
    assertBearerToken: (c: any) => {
      const auth = c.req.header("authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        throw new WebRouteError(401, "UNAUTHORIZED", "Missing bearer token");
      }
      return auth.slice("Bearer ".length);
    },
    readJsonBody: async (c: any) => {
      return await c.req.json();
    },
    webError: (c: any, status: number, code: string, message: string) => {
      return c.json({ code, message }, status);
    },
    mapRuntimeError: (error: any) => {
      if (error instanceof WebRouteError) return error;
      return new WebRouteError(500, "INTERNAL_ERROR", error.message);
    },
    parseErrorMessage: (error: any) =>
      error instanceof Error ? error.message : String(error),
  };
});

describe("chat-history routes", () => {
  let app: Hono;

  beforeEach(async () => {
    fetchMock.mockReset();
    process.env.CONVEX_HTTP_URL = "https://convex.test";

    const chatHistoryModule = await import("../chat-history.js");
    app = new Hono();
    app.route("/chat-history", chatHistoryModule.default);
  });

  describe("GET /chat-history/list", () => {
    it("proxies list request to Convex backend", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            personal: [{ chatSessionId: "s1", firstMessagePreview: "Hello" }],
            workspace: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const res = await app.request(
        "/chat-history/list?workspaceId=ws1&status=active",
        {
          method: "GET",
          headers: { Authorization: "Bearer test-token" },
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.personal).toHaveLength(1);
      expect(body.personal[0].chatSessionId).toBe("s1");

      const [fetchUrl] = fetchMock.mock.calls[0];
      expect(fetchUrl).toContain("/direct-chat/list");
      expect(fetchUrl).toContain("workspaceId=ws1");
      expect(fetchUrl).toContain("status=active");
    });

    it("returns 401 when bearer token is missing", async () => {
      const res = await app.request("/chat-history/list?status=active", {
        method: "GET",
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /chat-history/detail", () => {
    it("proxies detail request to Convex backend", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            session: {
              chatSessionId: "s1",
              messagesBlobUrl: "https://storage.test/blob",
              version: 3,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const res = await app.request(
        "/chat-history/detail?chatSessionId=s1",
        {
          method: "GET",
          headers: { Authorization: "Bearer test-token" },
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.chatSessionId).toBe("s1");
    });

    it("returns 400 when chatSessionId is missing", async () => {
      const res = await app.request("/chat-history/detail", {
        method: "GET",
        headers: { Authorization: "Bearer test-token" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /chat-history/action", () => {
    it("proxies rename action to Convex backend", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const res = await app.request("/chat-history/action", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "rename",
          sessionId: "session123",
          customTitle: "My Chat",
        }),
      });

      expect(res.status).toBe(200);

      const [, fetchOptions] = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(fetchOptions.body);
      expect(sentBody.action).toBe("rename");
      expect(sentBody.sessionId).toBe("session123");
      expect(sentBody.customTitle).toBe("My Chat");
    });

    it("proxies backend errors correctly", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error: "Session not found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      );

      const res = await app.request("/chat-history/action", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "delete",
          sessionId: "nonexistent",
        }),
      });

      // Backend 404 is passed through via handleRoute error handling
      const body = await res.json();
      expect(body.message || body.code).toBeTruthy();
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("handles pin/unpin actions", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const res = await app.request("/chat-history/action", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "pin",
          sessionId: "session123",
        }),
      });

      expect(res.status).toBe(200);
    });
  });
});
