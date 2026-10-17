import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { webErrorFromRoute } from "../../../routes/web/errors.js";
import { mapWebBoundaryError } from "../../../routes/web/boundary-error.js";
import { assertAdmitting, refuseWhileDraining } from "../admission.js";
import { createDrainCoordinator } from "../drain.js";

function appWith(drain: ReturnType<typeof createDrainCoordinator>) {
  const app = new Hono();
  app.on("POST", ["/run"], refuseWhileDraining(drain));
  app.post("/run", (c) => c.json({ started: true }, 202));
  app.get("/run", (c) => c.json({ status: "running" }));
  app.onError((error, c) => webErrorFromRoute(c, mapWebBoundaryError(error)));
  return app;
}

describe("drain admission", () => {
  it("admits while the process is not draining", async () => {
    const drain = createDrainCoordinator();
    expect(() => assertAdmitting(drain)).not.toThrow();

    const res = await appWith(drain).request("/run", { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("refuses a listed route once draining, asking the caller to retry", async () => {
    const drain = createDrainCoordinator();
    drain.begin();

    const res = await appWith(drain).request("/run", { method: "POST" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toMatchObject({
      code: "RATE_LIMITED",
      details: { reason: "SERVER_DRAINING" },
    });
  });

  it("leaves the other methods on the same path alone", async () => {
    const drain = createDrainCoordinator();
    drain.begin();

    const res = await appWith(drain).request("/run");
    expect(res.status).toBe(200);
  });
});
