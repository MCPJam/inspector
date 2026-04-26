import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
    event: vi.fn(),
    systemEvent: vi.fn(),
  },
}));

import { requestLogContextMiddleware } from "../request-log-context.js";
import { logger } from "../../utils/logger.js";

function createTestApp() {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  return app;
}

describe("requestLogContextMiddleware", () => {
  beforeEach(() => {
    vi.mocked(logger.event).mockClear();
    vi.mocked(logger.systemEvent).mockClear();
  });

  it("populates requestLogContext for an API request", async () => {
    const app = createTestApp();
    let capturedCtx: any;

    app.get("/api/web/test", (c) => {
      capturedCtx = c.var.requestLogContext;
      return c.json({ ok: true });
    });

    const res = await app.request("/api/web/test", { method: "GET" });
    expect(res.status).toBe(200);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.requestId).toBeTruthy();
    expect(capturedCtx.method).toBe("GET");
    expect(capturedCtx.authType).toBe("unknown");
    expect(capturedCtx.environment).toBeDefined();
    expect(capturedCtx.release).toBeDefined();
  });

  it("sets x-request-id response header", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/web/test");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("uses x-request-id from incoming request if provided", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/web/test", {
      headers: { "x-request-id": "my-custom-id" },
    });
    expect(res.headers.get("x-request-id")).toBe("my-custom-id");
  });

  it("emits exactly one http.request.completed for a 200 response and zero http.request.failed", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    await app.request("/api/web/test");

    const calls = vi.mocked(logger.event).mock.calls;
    const completedCalls = calls.filter(([name]) => name === "http.request.completed");
    const failedCalls = calls.filter(([name]) => name === "http.request.failed");

    expect(completedCalls).toHaveLength(1);
    expect(failedCalls).toHaveLength(0);
    expect((completedCalls[0][2] as any).statusCode).toBe(200);
  });

  it("emits exactly one http.request.failed for a 500 response and zero http.request.completed", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ error: "boom" }, 500));

    await app.request("/api/web/test");

    const calls = vi.mocked(logger.event).mock.calls;
    const completedCalls = calls.filter(([name]) => name === "http.request.completed");
    const failedCalls = calls.filter(([name]) => name === "http.request.failed");

    expect(failedCalls).toHaveLength(1);
    expect(completedCalls).toHaveLength(0);
  });

  it("does not emit anything for /api/mcp/health", async () => {
    const app = createTestApp();
    app.get("/api/mcp/health", (c) => c.json({ status: "ok" }));

    await app.request("/api/mcp/health");

    expect(vi.mocked(logger.event)).not.toHaveBeenCalled();
  });

  it("does not emit anything for /api/apps/health", async () => {
    const app = createTestApp();
    app.get("/api/apps/health", (c) => c.json({ status: "ok" }));

    await app.request("/api/apps/health");

    expect(vi.mocked(logger.event)).not.toHaveBeenCalled();
  });

  it("does not use raw URL as route for a 404 (uses pattern or 'unmatched')", async () => {
    const app = createTestApp();

    await app.request("/api/web/nonexistent");

    const calls = vi.mocked(logger.event).mock.calls;
    const completedCalls = calls.filter(([name]) => name === "http.request.completed");
    if (completedCalls.length > 0) {
      const base = completedCalls[0][1] as any;
      // route should be a pattern (e.g. /api/*) or "unmatched", never the raw URL
      expect(base.route).not.toContain("nonexistent");
    }
  });

  it("skips emission for SSE streaming routes", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      return c.body("data: hello\n\n");
    });

    await app.request("/api/web/stream");

    const calls = vi.mocked(logger.event).mock.calls;
    const httpCalls = calls.filter(
      ([name]) => name === "http.request.completed" || name === "http.request.failed",
    );
    expect(httpCalls).toHaveLength(0);
  });

  it("re-throws exceptions after emitting http.request.failed", async () => {
    const app = createTestApp();
    app.get("/api/web/explode", () => {
      throw new Error("unexpected failure");
    });
    app.onError((err, c) => c.json({ error: err.message }, 500));

    const res = await app.request("/api/web/explode");
    expect(res.status).toBe(500);

    const calls = vi.mocked(logger.event).mock.calls;
    const failedCalls = calls.filter(([name]) => name === "http.request.failed");
    expect(failedCalls).toHaveLength(1);
  });
});
