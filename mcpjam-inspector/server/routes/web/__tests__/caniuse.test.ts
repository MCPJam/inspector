import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import caniuseRoutes from "../caniuse";
import { mapRuntimeError, webError } from "../errors";

const LOCAL_REPORTS_PATH = join(
  process.cwd(),
  ".local",
  "caniuse-reports.jsonl"
);

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

  afterEach(async () => {
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
    await unlink(LOCAL_REPORTS_PATH).catch(() => undefined);
  });

  it("stores locally and succeeds in dev when backend and Resend are not configured", async () => {
    const response = await postReport(
      { message: "Something looks wrong" },
      { "x-real-ip": "192.0.2.1" }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      stored: { storage: "local" },
    });
    expect(global.fetch).not.toHaveBeenCalled();

    const contents = await readFile(LOCAL_REPORTS_PATH, "utf8");
    expect(contents).toContain("Something looks wrong");
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

  it("rate limits repeated reports from the same IP", async () => {
    const headers = { "x-real-ip": "192.0.2.4" };
    for (let i = 0; i < 5; i++) {
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
