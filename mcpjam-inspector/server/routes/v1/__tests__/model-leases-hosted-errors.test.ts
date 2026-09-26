/**
 * MJ-020: in hosted mode the model-lease proxy answers a broker failure with
 * its own words — the broker's error text goes to the log, not the wire.
 * Local-mode passthrough of the broker text stays covered by
 * `model-leases.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const config = vi.hoisted(() => ({ hosted: true }));

vi.mock("../../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return config.hosted;
    },
  };
});

const { validateGuestTokenMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

const BROKER_DETAIL = "UNEXPECTED_MARKER: harnessModelBrokerStart blew up";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function requestLease(app: Hono): Promise<Response> {
  return Promise.resolve(
    app.request("/api/v1/projects/default/model-leases", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4.5" }),
    }),
  );
}

describe("v1 model leases, hosted", () => {
  const originalEnv = { CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL };
  const originalFetch = global.fetch;

  beforeEach(() => {
    config.hosted = true;
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: BROKER_DETAIL }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    ) as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalEnv.CONVEX_HTTP_URL) {
      process.env.CONVEX_HTTP_URL = originalEnv.CONVEX_HTTP_URL;
    } else {
      delete process.env.CONVEX_HTTP_URL;
    }
  });

  it("withholds the broker's error text from the caller", async () => {
    const res = await requestLease(makeApp());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "FORBIDDEN",
      message: "Could not complete the model lease operation",
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("logs the broker text it does not return", async () => {
    await requestLease(makeApp());

    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("UNEXPECTED_MARKER");
  });

  it("keeps the broker text when not hosted", async () => {
    config.hosted = false;

    const res = await requestLease(makeApp());

    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe(BROKER_DETAIL);
  });
});
