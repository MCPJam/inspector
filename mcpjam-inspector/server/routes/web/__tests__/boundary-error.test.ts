import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MCPAuthError } from "@mcpjam/sdk";
import { mapWebBoundaryError } from "../boundary-error.js";
import { ErrorCode, WebRouteError, webErrorFromRoute } from "../errors.js";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function refusal(code: string, message: string) {
  return Object.assign(
    new Error("[Request ID: synthetic] Server Error\nUncaught ConvexError"),
    {
      data: { code, message },
    },
  );
}

async function responseFor(error: Error) {
  const app = new Hono();
  app.get("/", () => {
    throw error;
  });
  app.onError((failure, c) =>
    webErrorFromRoute(c, mapWebBoundaryError(failure)),
  );
  return app.request("/");
}

describe("web boundary errors", () => {
  it.each([
    ["FORBIDDEN", "Not a member of this project", 404],
    ["FORBIDDEN", "Requires admin permissions", 403],
    ["NOT_FOUND", "Missing project", 404],
    ["VALIDATION", "Choose a supported value", 400],
    ["CONFLICT", "The resource changed", 409],
  ])("translates structured %s refusals", async (code, message, status) => {
    const response = await responseFor(refusal(code, message));
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain("Request ID");
    expect(text).not.toContain("Uncaught ConvexError");
  });

  it("retains actionable copy from a wrapped structured refusal", async () => {
    const response = await responseFor(
      new Error("wrapped failure", {
        cause: refusal("VALIDATION", "Choose a supported value"),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe("Choose a supported value");
  });

  it("preserves a route's explicit status, details and retry headers", async () => {
    const response = await responseFor(
      new WebRouteError(429, ErrorCode.RATE_LIMITED, "Try later", {
        retryAfter: 10,
      }).withHeaders({ "Retry-After": "10" }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("10");
    expect((await response.json()).details).toEqual({ retryAfter: 10 });
  });

  it("does not reinterpret upstream authentication as a platform refusal", () => {
    const result = mapWebBoundaryError(
      new MCPAuthError("Upstream authentication failed", 403),
    );
    expect(result.code).toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
    expect(result.details?.upstreamAuthRequired).toBe(true);
  });

  it("does not treat an incomplete payload as a deliberate refusal", () => {
    const result = mapWebBoundaryError(
      Object.assign(new Error("Unexpected failure"), {
        data: { code: "VALIDATION" },
      }),
    );
    expect(result.status).toBe(500);
  });
});
