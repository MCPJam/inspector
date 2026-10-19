import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapWebBoundaryError } from "../boundary-error.js";
import { webErrorFromRoute } from "../errors.js";

const { drainState } = vi.hoisted(() => ({ drainState: { draining: false } }));

vi.mock("../../../services/lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/lifecycle/drain.js")
  >("../../../services/lifecycle/drain.js");
  const real = actual.createDrainCoordinator();
  return {
    ...actual,
    serverDrain: { ...real, isDraining: () => drainState.draining },
  };
});

import evalsRoutes from "../evals.js";

/** The router as `routes/web/index.ts` mounts it, with the same error mapper. */
function createApp() {
  const app = new Hono();
  app.route("/api/web/evals", evalsRoutes);
  app.onError((error, c) => webErrorFromRoute(c, mapWebBoundaryError(error)));
  return app;
}

/** The POST routes in `evals.ts` that start a run or a quick run. */
const LAUNCHES = ["/run", "/replay-run", "/run-test-case", "/stream-test-case"];

/** The POST routes in `evals.ts` that start neither. */
const NOT_LAUNCHES = [
  "/authoring-v1",
  "/generate-tests",
  "/generate-negative-tests",
];

beforeEach(() => {
  drainState.draining = false;
});

describe("web eval launches while the server drains", () => {
  it.each(LAUNCHES)("refuses POST %s with a retryable answer", async (path) => {
    drainState.draining = true;

    const res = await createApp().request(`/api/web/evals${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toMatchObject({
      code: "RATE_LIMITED",
      details: { reason: "SERVER_DRAINING" },
    });
  });

  it("passes the same request through when not draining", async () => {
    const res = await createApp().request("/api/web/evals/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
      },
      body: "{}",
    });

    // Reaches the handler, which refuses the empty body on its own terms.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("lists every POST route in evals.ts as a launch or not", () => {
    // A route added there fails here until it is classified, so a new launch
    // route cannot start runs on a draining server unnoticed.
    const posts = new Set(
      evalsRoutes.routes
        .filter((route) => route.method === "POST")
        .map((route) => route.path),
    );
    expect([...posts].sort()).toEqual([...LAUNCHES, ...NOT_LAUNCHES].sort());
  });
});
