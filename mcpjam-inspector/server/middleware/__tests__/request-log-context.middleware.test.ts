import { describe, it, expect, vi, beforeEach } from "vitest";
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
  });

  it("sets x-request-id response header via c.header()", async () => {
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

  it("rejects an inbound x-request-id that is too short", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/web/test", {
      headers: { "x-request-id": "short" },
    });
    expect(res.headers.get("x-request-id")).not.toBe("short");
    expect(res.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("rejects an inbound x-request-id that is excessively long (cardinality blowup)", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    const oversized = "a".repeat(2048);
    const res = await app.request("/api/web/test", {
      headers: { "x-request-id": oversized },
    });
    expect(res.headers.get("x-request-id")).not.toBe(oversized);
    expect(res.headers.get("x-request-id")?.length).toBeLessThanOrEqual(128);
  });

  it("rejects an inbound x-request-id with disallowed characters", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    const res = await app.request("/api/web/test", {
      headers: { "x-request-id": "abc def!@#$%" },
    });
    expect(res.headers.get("x-request-id")).not.toBe("abc def!@#$%");
    expect(res.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("emits exactly one http.request.completed for a 200 response", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    await app.request("/api/web/test");

    const calls = vi.mocked(logger.event).mock.calls;
    const completedCalls = calls.filter(
      ([name]) => name === "http.request.completed",
    );
    const failedCalls = calls.filter(
      ([name]) => name === "http.request.failed",
    );

    expect(completedCalls).toHaveLength(1);
    expect(failedCalls).toHaveLength(0);
    expect((completedCalls[0][2] as any).statusCode).toBe(200);
  });

  it("emits exactly one http.request.failed for a 500 response with no Sentry forwarding", async () => {
    const app = createTestApp();
    app.get("/api/web/test", (c) => c.json({ error: "boom" }, 500));

    await app.request("/api/web/test");

    const calls = vi.mocked(logger.event).mock.calls;
    const failedCalls = calls.filter(
      ([name]) => name === "http.request.failed",
    );
    expect(failedCalls).toHaveLength(1);

    // Sentry forwarding must NOT be opted into by middleware — the route's
    // error handler / Sentry middleware owns capture for this exception.
    const options = failedCalls[0][3] as { sentry?: boolean } | undefined;
    expect(options?.sentry).not.toBe(true);
  });

  it("emits http.request.failed when an upstream short-circuit returns 5xx (auth-failure scenario)", async () => {
    // Simulates a security middleware (e.g. session auth) returning 503 before
    // the route handler runs. With the middleware mounted before the security
    // stack, that response must still be observed.
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.use("/api/*", async (c) => c.json({ error: "service down" }, 503));
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    await app.request("/api/web/test");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0][2] as any).statusCode).toBe(503);
  });

  it("emits http.request.completed when an upstream short-circuit returns 401/403", async () => {
    // 4xx short-circuits (e.g. unauthenticated requests) are not failures from
    // the server's perspective but still need to be observed for traffic
    // accounting and security-incident triage.
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.use("/api/*", async (c) => c.json({ error: "unauthorized" }, 401));
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    await app.request("/api/web/test");

    const completed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.completed");
    expect(completed).toHaveLength(1);
    expect((completed[0][2] as any).statusCode).toBe(401);
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

  it("treats any */health or */healthz suffix as a probe (broader than the exact set)", async () => {
    const app = createTestApp();
    app.get("/api/web/health", (c) => c.json({ ok: true }));
    app.get("/api/web/probe/healthz", (c) => c.json({ ok: true }));

    await app.request("/api/web/health");
    await app.request("/api/web/probe/healthz");

    expect(vi.mocked(logger.event)).not.toHaveBeenCalled();
  });

  it("normalizes a trailing slash in the health-path check", async () => {
    const app = createTestApp();
    app.get("/api/mcp/health/", (c) => c.json({ ok: true }));

    await app.request("/api/mcp/health/");

    expect(vi.mocked(logger.event)).not.toHaveBeenCalled();
  });

  it("does not use raw URL as route for a 404 (uses pattern or 'unmatched')", async () => {
    const app = createTestApp();

    await app.request("/api/web/nonexistent");

    const calls = vi.mocked(logger.event).mock.calls;
    const completedCalls = calls.filter(
      ([name]) => name === "http.request.completed",
    );
    if (completedCalls.length > 0) {
      const base = completedCalls[0][1] as any;
      expect(base.route).not.toContain("nonexistent");
    }
  });

  it("emits http.stream.opened for SSE responses (no longer silently dropped)", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      return c.body("data: hello\n\n");
    });

    await app.request("/api/web/stream");

    const calls = vi.mocked(logger.event).mock.calls;
    const opened = calls.filter(([name]) => name === "http.stream.opened");
    const completed = calls.filter(
      ([name]) => name === "http.request.completed",
    );
    const failed = calls.filter(([name]) => name === "http.request.failed");

    expect(opened).toHaveLength(1);
    expect(completed).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });

  it("emits http.stream.closed when the consumer finishes reading the SSE body", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      return c.body("data: hello\n\n");
    });

    const res = await app.request("/api/web/stream");
    // Drain the body so the TransformStream's flush() fires.
    if (res.body) {
      const reader = res.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const closed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.stream.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0][2] as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  it("re-throws exceptions after emitting http.request.failed", async () => {
    const app = createTestApp();
    app.get("/api/web/explode", () => {
      throw new Error("unexpected failure");
    });
    app.onError((err, c) => c.json({ error: err.message }, 500));

    const res = await app.request("/api/web/explode");
    expect(res.status).toBe(500);

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
  });
});
