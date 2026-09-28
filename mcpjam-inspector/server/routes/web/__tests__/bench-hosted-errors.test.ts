/**
 * MJ-020: in hosted mode the bench relay answers a backend verdict with its
 * own words — the backend's error text goes to the log, not the wire.
 * Local-mode passthrough of the backend text stays covered by `bench.test.ts`.
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

vi.mock("@mcpjam/sdk/operations", () => ({
  listAllTools: vi.fn(),
}));

vi.mock("../auth.js", () => ({
  runEphemeralConnection: vi.fn(),
}));

import benchRoutes from "../bench.js";
import { mapRuntimeError, webErrorFromRoute } from "../errors.js";
import { logger } from "../../../utils/logger.js";

const BACKEND_DETAIL =
  "UNEXPECTED_MARKER: benchQuote rejected by internal validator";

const AUTHED = {
  "content-type": "application/json",
  authorization: "Bearer caller-token",
};

function createApp(): Hono {
  const app = new Hono();
  app.route("/api/web/bench", benchRoutes);
  app.onError((error, c) => webErrorFromRoute(c, mapRuntimeError(error)));
  return app;
}

function postQuote(app: Hono): Promise<Response> {
  return Promise.resolve(
    app.request("/api/web/bench/quotes", {
      method: "POST",
      headers: AUTHED,
      body: JSON.stringify({
        projectId: "p",
        serverId: "s",
        benchmarkTargetId: "tgt_1",
        profileId: "connector-bench/crm/standard",
      }),
    }),
  );
}

describe("bench relay, hosted", () => {
  const originalFetch = global.fetch;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;
  const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  beforeEach(() => {
    config.hosted = true;
    process.env.CONVEX_HTTP_URL = "https://convex.test";
    process.env.INSPECTOR_SERVICE_TOKEN = "svc-tok";
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false, error: BACKEND_DETAIL }, { status: 403 }),
    ) as never;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const [key, value] of [
      ["CONVEX_HTTP_URL", originalConvexUrl],
      ["INSPECTOR_SERVICE_TOKEN", originalServiceToken],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("withholds the backend's error text from the caller", async () => {
    const res = await postQuote(createApp());

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "FORBIDDEN",
      message: "You do not have access to this benchmark.",
    });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_MARKER");
  });

  it("logs the backend text it does not return", async () => {
    await postQuote(createApp());

    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("UNEXPECTED_MARKER");
  });

  it("keeps the backend text when not hosted", async () => {
    config.hosted = false;

    const res = await postQuote(createApp());

    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe(BACKEND_DETAIL);
  });
});
