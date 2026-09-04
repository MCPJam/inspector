import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 SERVER GROUP surface (server/routes/v1/server-groups.ts): auth
// + guest gating, the public DTO mapping (no Convex `_id` leak, no
// `serverAttachment` vocabulary), the args forwarded to Convex, and the error
// contract — a duplicate name is a 409, not a 400 or a 500.
//
// Convex is mocked at the `convex/browser` boundary, so these prove the
// gateway's behavior and the ARGS it forwards, NOT that the backend accepts
// them. The backend's own validation (same-project servers, plugin-managed
// refusal, name uniqueness) is covered by
// mcpjam-backend/tests/convex/serverAttachments.test.ts.

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));
vi.mock("../../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));
vi.mock("../../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null } = {}
): Promise<Response> {
  const { body, token = "tok" } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}

const GROUP_ROW = {
  _id: "att1",
  name: "Vercel",
  description: "the vercel server",
  serverIds: ["srv1", "srv2"],
  resolvedServerNames: ["Vercel", "Sentry"],
  createdAt: 1,
  updatedAt: 2,
};

function mockQuery(map: Record<string, unknown>) {
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn in map ? map[fn] : null
  );
}

/** A structured Convex refusal, the way the backend raises one. */
function convexError(code: string, message: string) {
  return Object.assign(new Error(`Uncaught ConvexError: ${message}`), {
    data: { code, message },
  });
}

describe("v1 server-group routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
    warnSpy.mockRestore();
  });

  describe("auth", () => {
    it("rejects a request with no bearer token (401)", async () => {
      const res = await request("GET", "/api/v1/projects/p1/server-groups", {
        token: null,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
    });

    it("denies guest callers — server groups are not on the allowlist", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("GET", "/api/v1/projects/p1/server-groups", {
        token: "guest-jwt",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("GET /projects/:projectId/server-groups", () => {
    it("maps rows to the public DTO and scopes the read to the path project", async () => {
      mockQuery({ "serverAttachments:listServerAttachments": [GROUP_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/server-groups");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: "att1",
            name: "Vercel",
            description: "the vercel server",
            serverIds: ["srv1", "srv2"],
            serverNames: ["Vercel", "Sentry"],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      });
      expect(convexQueryMock).toHaveBeenCalledWith(
        "serverAttachments:listServerAttachments",
        { projectId: "p1" }
      );
    });

    it("answers an empty page when the project has no groups", async () => {
      mockQuery({ "serverAttachments:listServerAttachments": null });
      const res = await request("GET", "/api/v1/projects/p1/server-groups");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });
  });

  describe("POST /projects/:projectId/server-groups", () => {
    it("creates a group and answers 201 with its detail", async () => {
      convexMutationMock.mockResolvedValue(GROUP_ROW);
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: { name: "Vercel", serverIds: ["srv1", "srv2"] },
      });
      expect(res.status).toBe(201);
      expect((await res.json()) as { id?: string }).toMatchObject({
        id: "att1",
        name: "Vercel",
      });
      expect(convexMutationMock).toHaveBeenCalledWith(
        "serverAttachments:createServerAttachment",
        { projectId: "p1", name: "Vercel", serverIds: ["srv1", "srv2"] }
      );
    });

    it("takes projectId from the PATH, never the body", async () => {
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: {
          name: "Vercel",
          serverIds: ["srv1"],
          projectId: "someone-elses-project",
        },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an empty server list", async () => {
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: { name: "Vercel", serverIds: [] },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a missing name", async () => {
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: { serverIds: ["srv1"] },
      });
      expect(res.status).toBe(400);
    });

    it("answers 409 for a duplicate name, not 400 or 500", async () => {
      // The SDK's create-then-reuse path keys off this status: a 409 means
      // "re-list and adopt the winner", anything else aborts the compose.
      convexMutationMock.mockRejectedValue(
        convexError(
          "CONFLICT",
          'a server attachment named "Vercel" already exists in this project'
        )
      );
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: { name: "Vercel", serverIds: ["srv1"] },
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code?: string }).code).toBe("CONFLICT");
    });

    it("answers 409 for a legacy deployment's prose conflict too", async () => {
      convexMutationMock.mockRejectedValue(
        new Error('a server attachment named "Vercel" already exists')
      );
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: { name: "Vercel", serverIds: ["srv1"] },
      });
      expect(res.status).toBe(409);
    });

    it("surfaces a plugin-managed server refusal as a 400", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "VALIDATION",
          "Plugin-managed servers cannot be added to a server group."
        )
      );
      const res = await request("POST", "/api/v1/projects/p1/server-groups", {
        body: { name: "Vercel", serverIds: ["srv1"] },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toContain(
        "Plugin-managed"
      );
    });
  });
});
