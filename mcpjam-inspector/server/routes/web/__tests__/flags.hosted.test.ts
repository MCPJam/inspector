import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocks = vi.hoisted(() => ({
  getAllFlags: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(() => ({
    getAllFlags: mocks.getAllFlags,
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

import clientFlags, {
  CLIENT_FLAGS_RATE_LIMIT_PER_MIN,
  resetClientFlagsRateLimitForTests,
} from "../flags.js";
import { shutdownAnalytics } from "../../../utils/analytics.js";

function createApp() {
  const app = new Hono();
  app.route("/api/web/flags", clientFlags);
  return app;
}

function getFlags(app: Hono, ip: string) {
  return app.request("/api/web/flags?distinct_id=anon-device-1", {
    headers: { "cf-connecting-ip": ip },
  });
}

describe("GET /api/web/flags per-address ceiling (hosted)", () => {
  beforeEach(() => {
    resetClientFlagsRateLimitForTests();
    mocks.getAllFlags.mockReset().mockResolvedValue({});
  });

  afterEach(async () => {
    await shutdownAnalytics();
  });

  it("answers 429 past the per-minute ceiling without evaluating flags", async () => {
    const app = createApp();
    for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN; i++) {
      const response = await getFlags(app, "203.0.113.7");
      expect(response.status).toBe(200);
    }
    const evaluations = mocks.getAllFlags.mock.calls.length;

    const refused = await getFlags(app, "203.0.113.7");

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.json()).toEqual({ flags: {} });
    expect(mocks.getAllFlags.mock.calls.length).toBe(evaluations);
  });

  it("keeps each address's window separate", async () => {
    const app = createApp();
    for (let i = 0; i < CLIENT_FLAGS_RATE_LIMIT_PER_MIN; i++) {
      await getFlags(app, "203.0.113.7");
    }
    expect((await getFlags(app, "203.0.113.7")).status).toBe(429);

    const other = await getFlags(app, "198.51.100.23");

    expect(other.status).toBe(200);
  });
});
