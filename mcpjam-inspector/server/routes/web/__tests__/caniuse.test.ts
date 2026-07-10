import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import caniuseRoutes from "../caniuse";
import { mapRuntimeError, webError } from "../errors";

function createApp() {
  const app = new Hono();
  app.route("/api/web/caniuse", caniuseRoutes);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  });
  return app;
}

function postReport(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return createApp().request("/api/web/caniuse/report-inconsistency", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function postReportRaw(body: string, headers: Record<string, string> = {}) {
  return createApp().request("/api/web/caniuse/report-inconsistency", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/web/caniuse/report-inconsistency", () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalInspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "development";
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
    if (originalInspectorServiceToken === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = originalInspectorServiceToken;
    }
  });

  it("rejects in dev when backend storage is not configured", async () => {
    const response = await postReport(
      { message: "Something looks wrong" },
      { "x-real-ip": "192.0.2.1" }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Report storage is not configured",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stores in the backend and returns Convex email delivery status when configured", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          reportId: "report_1",
          emailDeliveryStatus: "sent",
        }),
        { status: 200 }
      )
    );

    const response = await postReport(
      {
        message: "Claude supports this, but the table says it doesn't.",
      },
      {
        "x-real-ip": "192.0.2.2",
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      stored: {
        storage: "backend",
        reportId: "report_1",
        emailDeliveryStatus: "sent",
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://convex.example/internal/v1/caniuse/reports",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-inspector-service-token": "service-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          message: "Claude supports this, but the table says it doesn't.",
        }),
      })
    );
  });

  it("rejects in production when backend config is missing", async () => {
    process.env.NODE_ENV = "production";

    const response = await postReport(
      { message: "Prod report without backend config" },
      { "x-real-ip": "192.0.2.20" }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Report storage is not configured",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects when backend report storage rejects", async () => {
    process.env.NODE_ENV = "production";
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
      })
    );

    const response = await postReport(
      { message: "Fallback after backend rejection" },
      { "x-real-ip": "192.0.2.21" }
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "SERVER_UNREACHABLE",
      message: "Unauthorized",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty report", async () => {
    const response = await postReport(
      { message: "   " },
      { "x-real-ip": "192.0.2.3" }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await postReportRaw("{", { "x-real-ip": "192.0.2.30" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Invalid JSON body",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rate limits repeated reports from the same IP", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.mocked(global.fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            reportId: "report_rate_limit",
            emailDeliveryStatus: "sent",
          }),
          { status: 200 }
        )
    );

    const headers = { "x-real-ip": "192.0.2.4" };
    for (let i = 0; i < 10; i++) {
      const response = await postReport({ message: `Report ${i}` }, headers);
      expect(response.status).toBe(200);
    }

    const response = await postReport({ message: "One too many" }, headers);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

function postSubscribe(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return createApp().request("/api/web/caniuse/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function postSubscribeRaw(body: string, headers: Record<string, string> = {}) {
  return createApp().request("/api/web/caniuse/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/web/caniuse/subscribe", () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalInspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "development";
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
    if (originalInspectorServiceToken === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = originalInspectorServiceToken;
    }
  });

  it("rejects in dev when backend storage is not configured", async () => {
    const response = await postSubscribe(
      { email: "dev@example.com" },
      { "x-real-ip": "192.0.2.10" }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Subscription storage is not configured",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("forwards to the backend subscribers endpoint when configured", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, created: true }), { status: 200 })
    );

    const response = await postSubscribe(
      { email: "user@example.com" },
      { "x-real-ip": "192.0.2.11" }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      stored: { storage: "backend", created: true },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://convex.example/internal/v1/caniuse/subscribers",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-inspector-service-token": "service-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ email: "user@example.com" }),
      })
    );
  });

  it("rejects an invalid email", async () => {
    const response = await postSubscribe(
      { email: "not-an-email" },
      { "x-real-ip": "192.0.2.12" }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await postSubscribeRaw("{", {
      "x-real-ip": "192.0.2.31",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Invalid JSON body",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rate limits repeated attempts from the same IP", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.mocked(global.fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, created: true }), {
          status: 200,
        })
    );

    const headers = { "x-real-ip": "192.0.2.13" };
    for (let i = 0; i < 10; i++) {
      const response = await postSubscribe(
        { email: `user${i}@example.com` },
        headers
      );
      expect(response.status).toBe(200);
    }

    const response = await postSubscribe(
      { email: "once@toomany.com" },
      headers
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
  });
});
