import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// CONVEX-HQ: one caller sent `projects/badid/…` across the API, and each read
// forwarded the segment to a Convex `v.id("projects")` argument. Convex
// rejected it before the handler ran and reported every rejection as an error
// of its own: a dozen events in a minute, although each caller already got a
// 4xx back. These routes now answer the 404 before any Convex call, the way
// `evals.ts` already did.

const { validateGuestTokenMock, convexQueryMock } = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));
vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: vi.fn(),
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

// The two malformed values CONVEX-HQ recorded, verbatim.
const MALFORMED = ["badid", "zzzznonexistent"];

// Every read that event touched through the Inspector: the ones that call a
// Convex query directly, and the ones proxied to the backend's `/v1`.
const ROUTES = [
  "capabilities",
  "clients",
  "hosts",
  "conformance-runs",
  "personas",
  "environments",
  "skills",
  "servers",
  "eval-suites",
  "scenarios",
  "registry/servers",
];

describe("a malformed :projectId never reaches Convex", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  for (const projectId of MALFORMED) {
    it.each(ROUTES)(
      `answers 404 for projects/${projectId}/%s`,
      async (route) => {
        const res = await makeApp().request(
          `/api/v1/projects/${projectId}/${route}`,
          { headers: { Authorization: "Bearer tok" } },
        );

        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({
          code: "NOT_FOUND",
          message: "Project not found",
        });
        expect(convexQueryMock).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  }

  it("still forwards an id-shaped project to the backend", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const projectId = "k57a1b2c3d4e5f6g7h8j9k0m1n2p3q4r";

    const res = await makeApp().request(
      `/api/v1/projects/${projectId}/servers`,
      { headers: { Authorization: "Bearer tok" } },
    );

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `projectId=${projectId}`,
    );
  });
});
