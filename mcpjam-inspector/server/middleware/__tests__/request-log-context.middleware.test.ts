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

  // Regression: hosted connect 502s were logged as `errorCode: "internal_error"`
  // with the cause discarded, because these routes *return* a `webError`
  // response instead of throwing — so the middleware only ever saw a status
  // code. A week of user-facing failures was undiagnosable as a result.
  it("logs the route's own error code and message for a returned 5xx", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/connect", (c) => {
      c.set("webErrorMeta", {
        status: 502,
        code: "SERVER_UNREACHABLE",
        message: "Failed to reach MCP server: fetch failed",
      });
      return c.json({ code: "SERVER_UNREACHABLE" }, 502);
    });

    await app.request("/api/web/connect");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0][2] as any;
    expect(payload.statusCode).toBe(502);
    expect(payload.errorCode).toBe("SERVER_UNREACHABLE");
    expect(payload.errorMessage).toBe(
      "Failed to reach MCP server: fetch failed",
    );
  });

  // 4xx classes are incident signals at abnormal RATES (the 401 half of the
  // 2026-08-06 incident; #3948's 403 reclassification), and the Axiom class
  // monitors fingerprint on coalesce(errorMessage, errorCode, route+status).
  // Untyped 4xx rows collapse into one bucket per route.
  it("types a returned 4xx with the route's own code, origin, and slug", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/tools/list", (c) => {
      c.set("webErrorMeta", {
        status: 403,
        code: "UPSTREAM_AUTH_FAILED",
        message: "Authentication failed for MCP server acme",
        origin: "user_config",
        slug: "auth/upstream_rejected",
      });
      return c.json({ code: "UPSTREAM_AUTH_FAILED" }, 403);
    });

    await app.request("/api/web/tools/list");

    const completed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.completed");
    expect(completed).toHaveLength(1);
    const payload = completed[0][2] as any;
    expect(payload.statusCode).toBe(403);
    expect(payload.errorCode).toBe("UPSTREAM_AUTH_FAILED");
    expect(payload.errorMessage).toBe(
      "Authentication failed for MCP server acme",
    );
    expect(payload.origin).toBe("user_config");
    expect(payload.slug).toBe("auth/upstream_rejected");
  });

  it("leaves a metaless 4xx bare rather than inventing a code", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.use("/api/*", async (c) => c.json({ error: "unauthorized" }, 401));
    app.get("/api/web/test", (c) => c.json({ ok: true }));

    await app.request("/api/web/test");

    const payload = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.completed")[0][2] as any;
    expect(payload.statusCode).toBe(401);
    expect(payload.errorCode).toBeUndefined();
    expect(payload.errorMessage).toBeUndefined();
    expect(payload.origin).toBeUndefined();
  });

  it("never attaches error fields to a 2xx", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/ok", (c) => {
      // Meta from an earlier failed attempt inside the same request must not
      // leak onto a response that ultimately succeeded.
      c.set("webErrorMeta", {
        status: 200,
        code: "UNAUTHORIZED",
        message: "no bearer",
      });
      return c.json({ ok: true });
    });

    await app.request("/api/web/ok");

    const payload = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.completed")[0][2] as any;
    expect(payload.statusCode).toBe(200);
    expect(payload.errorCode).toBeUndefined();
    expect(payload.errorMessage).toBeUndefined();
  });

  it("ignores stale webErrorMeta from a different status on a 4xx", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/mixed4xx", (c) => {
      c.set("webErrorMeta", {
        status: 502,
        code: "SERVER_UNREACHABLE",
        message: "fetch failed",
      });
      return c.json({ error: "nope" }, 404);
    });

    await app.request("/api/web/mixed4xx");

    const payload = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.completed")[0][2] as any;
    expect(payload.statusCode).toBe(404);
    expect(payload.errorCode).toBeUndefined();
  });

  // The same regression, one status down. `mapTargetServerError` moves a
  // connection failure to 424 so the edge stops eating the response — and that
  // must not also drop the failure out of this event, which is where the
  // `origin`/`slug` slice that makes the bucket measurable lives.
  it("logs a returned 424 as a failure, not a completed request", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/chat-v2", (c) => {
      c.set("webErrorMeta", {
        status: 424,
        code: "SERVER_UNREACHABLE",
        message: "Couldn't reach the MCP server (fetch failed)",
        origin: "ambiguous",
        slug: "transport/fetch_failed",
      });
      return c.json({ code: "SERVER_UNREACHABLE" }, 424);
    });

    await app.request("/api/web/chat-v2");

    const events = vi.mocked(logger.event).mock.calls;
    expect(events.filter(([name]) => name === "http.request.completed")).toHaveLength(
      0,
    );
    const failed = events.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0][2] as any;
    expect(payload.statusCode).toBe(424);
    expect(payload.errorCode).toBe("SERVER_UNREACHABLE");
    expect(payload.origin).toBe("ambiguous");
    expect(payload.slug).toBe("transport/fetch_failed");
  });

  // `hop` is the axis `origin` cannot carry: `ambiguous` is the catalog
  // refusing to guess from the wire shape, and only the catch site knows which
  // boundary it wrapped. Without this the fact travelled as far as the Sentry
  // decision and was then discarded.
  it("carries a declared hop onto http.request.failed", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/tools/list", (c) => {
      c.set("webErrorMeta", {
        status: 502,
        code: "SERVER_UNREACHABLE",
        message: "Couldn't reach the MCP server (fetch failed)",
        origin: "ambiguous",
        slug: "transport/fetch_failed",
        hop: "user_server_hop",
      });
      return c.json({ code: "SERVER_UNREACHABLE" }, 502);
    });

    await app.request("/api/web/tools/list");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0][2] as any;
    expect(payload.hop).toBe("user_server_hop");
    // Orthogonal, not folded together: the hop says which boundary broke and
    // `origin` still says nobody has attributed the failure to anyone.
    expect(payload.origin).toBe("ambiguous");
  });

  // ABSENT MEANS UNKNOWN. If a missing hop emitted as anything a consumer
  // could read as "the user's", every route that has not declared one yet
  // would silently drop out of the mcpjam-fault monitor.
  it("omits hop entirely when the catch site declared none", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/resources/read", (c) => {
      c.set("webErrorMeta", {
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Method not found",
        origin: "ambiguous",
        slug: "internal/unknown",
      });
      return c.json({ code: "INTERNAL_ERROR" }, 500);
    });

    await app.request("/api/web/resources/read");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0][2] as any;
    expect(payload.hop).toBeUndefined();
    expect("hop" in payload).toBe(false);
  });

  it("ignores stale webErrorMeta from a different status", async () => {
    // A route may emit a 4xx webError and then fail with an unrelated 500;
    // attributing the earlier code to the later failure would be a lie.
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/mixed", (c) => {
      c.set("webErrorMeta", {
        status: 401,
        code: "UNAUTHORIZED",
        message: "no bearer",
      });
      return c.json({ error: "boom" }, 500);
    });

    await app.request("/api/web/mixed");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    const payload = failed[0][2] as any;
    expect(payload.errorCode).toBe("internal_error");
    expect(payload.errorMessage).toBeUndefined();
  });

  // Hono runs `onError` INSIDE `next()`, so this middleware's catch block never
  // fires for a route exception — it only ever sees the resulting 500 response.
  // That is why the cause has to be handed over via `webErrorMeta`, and why the
  // `thrown` branch cannot be relied on. Locking the ordering here so a Hono
  // upgrade that changes it doesn't silently reintroduce blind 5xx logging.
  it("captures the cause of a route exception via the error handler", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/throws", () => {
      throw new Error("ECONNRESET talking to upstream");
    });
    // Mirrors the real handlers (web router + global app onError), which stash
    // the mapped code/message before returning the response.
    app.onError((err, c) => {
      c.set("webErrorMeta", {
        status: 500,
        code: "unhandled_exception",
        message: (err as Error).message,
      });
      return c.json({ error: (err as Error).message }, 500);
    });

    await app.request("/api/web/throws");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect(failed).toHaveLength(1);
    const payload = failed[0][2] as any;
    expect(payload.errorCode).toBe("unhandled_exception");
    expect(payload.errorMessage).toBe("ECONNRESET talking to upstream");
  });

  it("caps a huge error message at 500 chars", async () => {
    const app = new Hono();
    app.use("/api/*", requestLogContextMiddleware);
    app.get("/api/web/huge", (c) => {
      c.set("webErrorMeta", {
        status: 502,
        code: "SERVER_UNREACHABLE",
        message: "x".repeat(5000),
      });
      return c.json({ code: "SERVER_UNREACHABLE" }, 502);
    });

    await app.request("/api/web/huge");

    const failed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.request.failed");
    expect((failed[0][2] as any).errorMessage).toHaveLength(500);
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
    expect((closed[0][2] as any).outcome).toBe("completed");
    expect((closed[0][2] as any).errorMessage).toBeUndefined();
  });

  it("delivers stream bytes unchanged through the close-tracking wrapper", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      return c.body("data: hello\n\ndata: world\n\n");
    });

    const res = await app.request("/api/web/stream");
    expect(await res.text()).toBe("data: hello\n\ndata: world\n\n");
  });

  // Regression: the old TransformStream hook only had flush(), which runs on
  // a NORMAL end-of-stream — a consumer cancel (client disconnect) or a
  // producer error left no http.stream.closed at all. The most common
  // streaming failure produced zero telemetry rows.
  it("emits http.stream.closed with outcome 'aborted' when the consumer cancels", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      // A stream that never ends on its own, so only cancel can close it.
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("data: tick\n\n"));
        },
      });
      return c.body(endless);
    });

    const res = await app.request("/api/web/stream");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(new Error("client went away"));

    const closed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.stream.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0][2] as any).outcome).toBe("aborted");
    // An abort is not a failure; no message is recorded for it.
    expect((closed[0][2] as any).errorMessage).toBeUndefined();
  });

  it("emits http.stream.closed with outcome 'errored' when the producer errors", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      const dying = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          controller.error(new Error("upstream connection reset"));
        },
      });
      return c.body(dying);
    });

    const res = await app.request("/api/web/stream");
    const reader = res.body!.getReader();
    await expect(async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }).rejects.toThrow("upstream connection reset");

    const closed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.stream.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0][2] as any).outcome).toBe("errored");
    expect((closed[0][2] as any).errorMessage).toBe(
      "upstream connection reset",
    );
  });

  it("still emits the closed row when the error value cannot be stringified", async () => {
    // A rejection reason can be a value whose string coercion throws (a
    // null-prototype object here). The closed row must survive with a
    // fallback instead of the telemetry code throwing and eating the row.
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      const dying = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(Object.create(null));
        },
      });
      return c.body(dying);
    });

    const res = await app.request("/api/web/stream");
    const reader = res.body!.getReader();
    await reader.read().catch(() => undefined);

    const closed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.stream.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0][2] as any).outcome).toBe("errored");
    expect((closed[0][2] as any).errorMessage).toBe("[unreadable error value]");
  });

  it("caps the errored stream message at 500 chars", async () => {
    const app = createTestApp();
    app.get("/api/web/stream", (c) => {
      c.header("Content-Type", "text/event-stream");
      const dying = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("x".repeat(2000)));
        },
      });
      return c.body(dying);
    });

    const res = await app.request("/api/web/stream");
    const reader = res.body!.getReader();
    await expect(reader.read()).rejects.toThrow();

    const closed = vi
      .mocked(logger.event)
      .mock.calls.filter(([name]) => name === "http.stream.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0][2] as any).errorMessage).toHaveLength(500);
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
