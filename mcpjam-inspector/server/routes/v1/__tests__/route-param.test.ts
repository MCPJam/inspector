import { Hono } from "hono";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { routeParam } from "../route-param.js";

/** One plain handler on two paths, the way the canonical/alias pairs register. */
function appReading(name: string) {
  const app = new Hono();
  const handler = (c: Context) => c.text(routeParam(c, name));
  app.get("/projects/:projectId/goals/:goalId", handler);
  app.get("/projects/:projectId/journeys/:journeyId", handler);
  app.onError((error, c) => c.text(error.message, 500));
  return app;
}

describe("routeParam", () => {
  it("returns a segment the matched path declares", async () => {
    const response = await appReading("goalId").request(
      "/projects/p1/goals/g1",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("g1");
  });

  it("throws when the matched path does not declare the segment", async () => {
    const response = await appReading("goalId").request(
      "/projects/p1/journeys/j1",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(
      "Route does not declare the :goalId parameter",
    );
  });
});
