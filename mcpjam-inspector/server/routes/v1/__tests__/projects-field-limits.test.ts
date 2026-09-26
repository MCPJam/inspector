import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * Length limits on the public project write routes (MJ-013). The backend
 * enforces the same limits on every project write; these pin the gateway's
 * field-level 400 and that nothing oversized reaches Convex.
 */

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_ICON_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "../projects.js";

function request(
  method: string,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer jwt-session-token",
      },
      body: JSON.stringify(body),
    })
  );
}

describe("project write routes: field length limits", () => {
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockResolvedValue([
      { _id: "proj_1", name: "Alpha project", organizationId: "org_a" },
    ]);
    convexMutationMock.mockResolvedValue("proj_1");
  });

  afterEach(() => {
    if (originalConvexUrl) process.env.CONVEX_URL = originalConvexUrl;
    else delete process.env.CONVEX_URL;
  });

  it.each([
    ["name", { name: "n".repeat(PROJECT_NAME_MAX_LENGTH + 1) }],
    [
      "description",
      {
        name: "Fine",
        description: "d".repeat(PROJECT_DESCRIPTION_MAX_LENGTH + 1),
      },
    ],
    ["icon", { name: "Fine", icon: "i".repeat(PROJECT_ICON_MAX_LENGTH + 1) }],
  ])("POST refuses an oversized %s with a 400", async (_field, body) => {
    const res = await request("POST", "/api/v1/projects", body);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "VALIDATION_ERROR"
    );
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it.each([
    ["name", { name: "n".repeat(PROJECT_NAME_MAX_LENGTH + 1) }],
    [
      "description",
      { description: "d".repeat(PROJECT_DESCRIPTION_MAX_LENGTH + 1) },
    ],
    ["icon", { icon: "i".repeat(PROJECT_ICON_MAX_LENGTH + 1) }],
  ])("PATCH refuses an oversized %s with a 400", async (_field, body) => {
    const res = await request("PATCH", "/api/v1/projects/proj_1", body);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "VALIDATION_ERROR"
    );
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("accepts fields at their limits", async () => {
    const res = await request("POST", "/api/v1/projects", {
      name: "n".repeat(PROJECT_NAME_MAX_LENGTH),
      description: "d".repeat(PROJECT_DESCRIPTION_MAX_LENGTH),
      icon: "i".repeat(PROJECT_ICON_MAX_LENGTH),
    });

    expect(res.status).toBe(201);
    expect(convexMutationMock).toHaveBeenCalledWith(
      "projects:createProject",
      expect.objectContaining({
        name: "n".repeat(PROJECT_NAME_MAX_LENGTH),
        description: "d".repeat(PROJECT_DESCRIPTION_MAX_LENGTH),
      })
    );
  });
});
