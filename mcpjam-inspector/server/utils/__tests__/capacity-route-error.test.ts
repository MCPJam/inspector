import { ConvexError } from "convex/values";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { v1OnError } from "../../routes/v1/envelope.js";
import { asCapacityRouteError } from "../capacity-route-error.js";

it("sends a retry header and a structured capacity refusal over HTTP", async () => {
  const app = new Hono();
  app.onError(v1OnError);
  app.post("/v1/eval-suites/suite/runs", () => {
    throw asCapacityRouteError(new ConvexError({
      kind: "at_capacity", resource: "eval_runs", message: "Wait for a running eval to finish and try again.",
    }));
  });
  const response = await app.request("/v1/eval-suites/suite/runs", { method: "POST" });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({
    code: "RATE_LIMITED", details: { code: "at_capacity", resource: "eval_runs" },
  });
});

it("leaves unrelated failures for the existing error handling", () => {
  expect(asCapacityRouteError(new Error("connection failed"))).toBeNull();
  expect(asCapacityRouteError(new ConvexError("not authorized"))).toBeNull();
});
