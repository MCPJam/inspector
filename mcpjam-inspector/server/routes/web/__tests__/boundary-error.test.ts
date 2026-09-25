import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MCPAuthError } from "@mcpjam/sdk";
import { mapWebBoundaryError } from "../boundary-error.js";
import { handleRoute } from "../auth.js";
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

  it("answers the backend's authorization refusal with 403", async () => {
    const response = await responseFor(
      Object.assign(
        new Error("[Request ID: synthetic] Server Error\nUncaught ConvexError"),
        { data: { kind: "forbidden" } },
      ),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(JSON.stringify(body)).not.toContain("Request ID");
  });

  it("keeps the backend's copy on an authorization refusal", () => {
    const result = mapWebBoundaryError(
      Object.assign(new Error("Uncaught ConvexError"), {
        data: { kind: "forbidden", message: "Not a member of this project" },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.message).toBe("Not a member of this project");
  });

  it.each(["", "  \n"])(
    "answers an authorization refusal with a blank message (%j) with the fallback copy",
    (message) => {
      const result = mapWebBoundaryError(
        Object.assign(new Error("Uncaught ConvexError"), {
          data: { kind: "forbidden", message },
        }),
      );
      expect(result.status).toBe(403);
      expect(result.message).toBe("You do not have permission to do that.");
    },
  );
});

describe("handleRoute errors", () => {
  async function handled(error: unknown) {
    const app = new Hono();
    app.get("/", (c) =>
      handleRoute(c, async () => {
        throw error;
      }),
    );
    return app.request("/");
  }

  it("keeps a route's explicit status, details and retry headers", async () => {
    const response = await handled(
      new WebRouteError(429, ErrorCode.RATE_LIMITED, "Try later", {
        retryAfter: 10,
      }).withHeaders({ "Retry-After": "10" }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(await response.json()).toMatchObject({
      code: ErrorCode.RATE_LIMITED,
      message: "Try later",
      details: { retryAfter: 10 },
    });
  });

  it.each([
    [400, ErrorCode.VALIDATION_ERROR, "projectId is required"],
    [401, ErrorCode.UNAUTHORIZED, "Missing or invalid bearer token"],
    [403, ErrorCode.FORBIDDEN, "Guests cannot use this"],
    [404, ErrorCode.NOT_FOUND, "Server not found"],
    [409, ErrorCode.CONFLICT, "Changed since loaded"],
  ] as const)(
    "keeps a route's %s %s as it was thrown",
    async (status, code, message) => {
      const response = await handled(new WebRouteError(status, code, message));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code, message });
    },
  );

  it.each([
    ["FORBIDDEN", "Requires admin permissions", 403],
    ["NOT_FOUND", "Missing project", 404],
    ["VALIDATION", "Choose a supported value", 400],
    ["CONFLICT", "The resource changed", 409],
  ])("translates a structured %s refusal", async (code, message, status) => {
    const response = await handled(refusal(code, message));
    expect(response.status).toBe(status);
    const text = await response.text();
    expect(text).not.toContain("Request ID");
    expect(text).not.toContain("Uncaught ConvexError");
  });

  it("answers the backend's authorization refusal with 403", async () => {
    const response = await handled(
      Object.assign(new Error("Uncaught ConvexError"), {
        data: { kind: "forbidden" },
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe(ErrorCode.FORBIDDEN);
  });
});
