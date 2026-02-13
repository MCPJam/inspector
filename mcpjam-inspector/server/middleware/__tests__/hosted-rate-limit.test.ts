import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

describe("hostedRateLimitMiddleware", () => {
  const originalHostedMode = process.env.VITE_MCPJAM_HOSTED_MODE;
  const originalLimit = process.env.MCPJAM_RATE_LIMIT_PER_WINDOW;
  const originalWindow = process.env.MCPJAM_RATE_LIMIT_WINDOW_MS;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalHostedMode === undefined) {
      delete process.env.VITE_MCPJAM_HOSTED_MODE;
    } else {
      process.env.VITE_MCPJAM_HOSTED_MODE = originalHostedMode;
    }

    if (originalLimit === undefined) {
      delete process.env.MCPJAM_RATE_LIMIT_PER_WINDOW;
    } else {
      process.env.MCPJAM_RATE_LIMIT_PER_WINDOW = originalLimit;
    }

    if (originalWindow === undefined) {
      delete process.env.MCPJAM_RATE_LIMIT_WINDOW_MS;
    } else {
      process.env.MCPJAM_RATE_LIMIT_WINDOW_MS = originalWindow;
    }

    const { resetHostedRateLimitBucketsForTests } =
      await import("../hosted-rate-limit.js");
    resetHostedRateLimitBucketsForTests();
  });

  it("returns 429 after tenant exceeds configured window limit", async () => {
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    process.env.MCPJAM_RATE_LIMIT_PER_WINDOW = "2";
    process.env.MCPJAM_RATE_LIMIT_WINDOW_MS = "60000";

    const { hostedRateLimitMiddleware } =
      await import("../hosted-rate-limit.js");

    const app = new Hono();
    app.use("/api/mcp/*", async (c, next) => {
      c.tenantId = "tenant-rate-limit-test";
      await next();
    });
    app.use("/api/mcp/*", hostedRateLimitMiddleware);
    app.get("/api/mcp/resources/list", (c) => c.json({ ok: true }));

    const first = await app.request("/api/mcp/resources/list");
    const second = await app.request("/api/mcp/resources/list");
    const third = await app.request("/api/mcp/resources/list");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
  });
});
