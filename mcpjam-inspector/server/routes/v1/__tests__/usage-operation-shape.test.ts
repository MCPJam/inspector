/**
 * `api_v1_request_completed` carries `operation` ("METHOD /api/v1/:pattern")
 * only when the analytics allowlist accepts its shape. Every route this router
 * serves must pass, or its events arrive without one; a request path holding
 * an id or a value must not.
 */
import { describe, expect, it } from "vitest";
import v1Routes from "../index.js";
import { rebuildServerAnalytics } from "../../../../shared/strict-server-analytics.js";

const ACTOR = "user_01J9ZXQ4M8V2N6P3R5T7W9Y1A3";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function keptOperation(operation: string): unknown {
  return rebuildServerAnalytics("api_v1_request_completed", ACTOR, {
    operation,
  })?.properties.operation;
}

describe("api_v1_request_completed operation", () => {
  it("keeps the operation for every route the v1 router serves", () => {
    const operations = v1Routes.routes
      .filter((route) => METHODS.has(route.method.toUpperCase()))
      .map((route) => `${route.method.toUpperCase()} /api/v1${route.path}`);
    expect(operations.length).toBeGreaterThan(200);
    expect(operations.filter((op) => keptOperation(op) !== op)).toEqual([]);
  });

  it("keeps HEAD, which Hono serves with the GET route", () => {
    const op = "HEAD /api/v1/projects/:projectId/eval-runs";
    expect(keptOperation(op)).toBe(op);
  });

  it.each([
    "GET /api/v1/projects/k57a8bq3m2x9y4z1w6v5t0s7r8p2n3d4/eval-runs",
    "GET /api/v1/projects/123/eval-runs",
    "GET /api/v1/users/user_01J9ZXQ4M8V2N6P3R5T7W9Y1A3",
    "GET /api/v1/search?q=secret",
    "GET /api/v1/files/report.pdf",
    "TRACE /api/v1/projects",
    "GET /api/web/projects",
    "GET /api/v1/projects extra",
  ])("drops %s", (operation) => {
    expect(keptOperation(operation)).toBeUndefined();
  });
});
