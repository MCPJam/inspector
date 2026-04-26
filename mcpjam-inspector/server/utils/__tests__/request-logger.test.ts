import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Context } from "hono";
import type { RequestLogContext } from "../log-events.js";

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

function makeContext(ctx?: Partial<RequestLogContext>): Context {
  const vars: Record<string, unknown> = {};
  if (ctx) {
    vars["requestLogContext"] = ctx;
  }
  return {
    var: new Proxy(vars, {
      get: (target, prop) => target[prop as string],
    }),
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
  } as unknown as Context;
}

const baseContext: RequestLogContext = {
  event: "http.request.completed",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "http",
  requestId: "req-123",
  route: "/api/web/test",
  method: "GET",
  authType: "unknown",
};

describe("getRequestLogger", () => {
  it("calls logger.event with the request context merged with component", async () => {
    vi.stubEnv("AXIOM_TOKEN", "test-token");
    vi.stubEnv("AXIOM_DATASET", "test-dataset");
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();

    const { getRequestLogger } = await import("../request-logger.js");
    const { logger } = await import("../logger.js");
    const eventSpy = vi.spyOn(logger, "event");

    const c = makeContext(baseContext);
    const reqLogger = getRequestLogger(c, "routes.web.test");

    reqLogger.event("http.request.completed", { statusCode: 200 });

    expect(eventSpy).toHaveBeenCalledWith(
      "http.request.completed",
      expect.objectContaining({ component: "routes.web.test", requestId: "req-123" }),
      { statusCode: 200 },
      undefined,
    );

    vi.unstubAllEnvs();
  });
});

describe("setRequestLogContext", () => {
  it("merges partial fields into existing requestLogContext", async () => {
    vi.resetModules();
    const { setRequestLogContext } = await import("../request-logger.js");

    const vars: Record<string, unknown> = { requestLogContext: { ...baseContext } };
    const c = {
      var: new Proxy(vars, { get: (t, p) => t[p as string] }),
      set: (key: string, value: unknown) => { vars[key] = value; },
    } as unknown as Context;

    setRequestLogContext(c, { authType: "signedIn", userId: "user-abc" });

    const updated = vars["requestLogContext"] as RequestLogContext;
    expect(updated.authType).toBe("signedIn");
    expect(updated.userId).toBe("user-abc");
    expect(updated.requestId).toBe("req-123");
  });

  it("does nothing when requestLogContext is not set", async () => {
    vi.resetModules();
    const { setRequestLogContext } = await import("../request-logger.js");

    const vars: Record<string, unknown> = {};
    const c = {
      var: new Proxy(vars, { get: (t, p) => t[p as string] }),
      set: (key: string, value: unknown) => { vars[key] = value; },
    } as unknown as Context;

    expect(() => setRequestLogContext(c, { authType: "signedIn" })).not.toThrow();
    expect(vars["requestLogContext"]).toBeUndefined();
  });
});

describe("getSystemLogger", () => {
  it("calls logger.systemEvent with system envelope", async () => {
    vi.resetModules();
    const { getSystemLogger } = await import("../request-logger.js");
    const { logger } = await import("../logger.js");
    const systemEventSpy = vi.spyOn(logger, "systemEvent");

    const sysLogger = getSystemLogger("process");
    sysLogger.event(
      "mcp.connection.closed_with_pending_requests",
      {
        environment: "test",
        release: null,
        requestId: null,
        route: null,
        method: null,
        authType: "system" as const,
      },
      { errorCode: "connection_closed" },
    );

    expect(systemEventSpy).toHaveBeenCalledWith(
      "mcp.connection.closed_with_pending_requests",
      expect.objectContaining({
        component: "process",
        authType: "system",
        requestId: null,
        route: null,
        method: null,
      }),
      { errorCode: "connection_closed" },
      undefined,
    );
  });
});
