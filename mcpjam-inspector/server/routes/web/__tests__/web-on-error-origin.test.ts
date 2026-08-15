import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: vi.fn(),
    isMCPAuthError: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

import webRoutes from "../index.js";
import { reportRouteFailure } from "../../../utils/route-error-report.js";
import { ErrorCode, WebRouteError } from "../errors.js";

/**
 * The THROW path through the real router. `effective-origin.test.ts` proves
 * `webErrorFromRoute` serializes a promoted origin — but the /api/web
 * catch-all used to hand-roll its `webError` call with only `normalized`,
 * so every handler that threw (rather than returned) a promoted error had
 * the promotion discarded at the very last step. This mounts the actual
 * `web` router so a regression in that wiring, not just in the serializer,
 * fails a test.
 */
describe("web.onError effective-origin propagation", () => {
  it("keeps a promoted origin when a handler throws instead of returning", async () => {
    const raw = new TypeError("cannot read properties of undefined");
    const { normalized, origin } = reportRouteFailure("boom", raw, {
      source: "test.internal",
      hop: "mcpjam_internal",
    });
    // Precondition: the promotion actually diverges from the declared value,
    // otherwise this test cannot distinguish effective from recomputed.
    expect(origin).toBe("mcpjam");

    webRoutes.get("/__test/throws-promoted", () => {
      const err = new WebRouteError(
        500,
        ErrorCode.INTERNAL_ERROR,
        "boom",
        undefined,
        normalized,
      );
      err.origin = origin;
      throw err;
    });

    const app = new Hono();
    app.route("/api/web", webRoutes);
    const res = await app.request("/api/web/__test/throws-promoted");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { origin?: string };
    expect(body.origin).toBe("mcpjam");
    expect(res.headers.get("x-mcpjam-error-origin")).toBe("mcpjam");
  });
});
