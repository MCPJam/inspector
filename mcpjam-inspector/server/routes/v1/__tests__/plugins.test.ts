import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 AGENT PLUGINS read surface (server/routes/v1/plugins.ts):
// auth + guest gating, the public DTO mapping (clean `id`, no Convex
// `pluginId`/`pluginVersionId` field leak), the forwarded Convex args, and
// the structured-ConvexError translation (NOT_FOUND and FORBIDDEN both 404,
// so the route is never an existence oracle). Convex is mocked at the
// `convex/browser` boundary — membership enforcement itself lives in
// mcpjam-backend/convex/plugins.ts.

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  convexQueryMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

// WorkOS API-key seams — only reached by `sk_` bearers (none here), but the
// auth middleware imports them at module load, so stub them out.
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
  })),
}));

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  path: string,
  opts: { token?: string | null } = {}
): Promise<Response> {
  const { token = "tok" } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(makeApp().request(path, { method: "GET", headers }));
}

const PLUGIN_ROW = {
  pluginId: "pl1",
  projectId: "p1",
  name: "linear-tools",
  displayName: "Linear Tools",
  description: "Linear helpers",
  enabled: true,
  activeVersionId: "pv1",
  createdAt: 1,
  updatedAt: 2,
};

const VERSION_ROW = {
  pluginVersionId: "pv1",
  pluginId: "pl1",
  declaredVersion: "1.2.0",
  bundleHash: "hash-abc",
  manifestHash: "hash-manifest",
  status: "ready" as const,
  componentCounts: { skills: 1, servers: 1, apps: 0, assets: 0, unsupported: 0 },
  createdAt: 1,
  readyAt: 2,
  servers: [
    {
      componentId: "psc1",
      componentKey: "server:linear",
      declaredName: "linear",
      placement: "remote" as const,
      authenticationPolicy: "on_use" as const,
      materializedServerId: "s1",
    },
  ],
  skills: [
    {
      componentId: "pskc1",
      componentKey: "skill:triage",
      declaredName: "triage",
      modelRef: "linear-tools/triage",
      materializedSkillId: "sk1",
    },
  ],
};

/**
 * A rejection shaped like a `ConvexError`: the structured `{ code, message }`
 * rides on `.data`, which is what the route branches on.
 */
function convexError(code: string, message: string): Error {
  const error = new Error(`Uncaught ConvexError: ${message}`);
  (error as unknown as { data: unknown }).data = { code, message };
  return error;
}

describe("v1 plugin routes", () => {
  const originalConvexUrl = process.env.CONVEX_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  afterEach(() => {
    if (originalConvexUrl) process.env.CONVEX_URL = originalConvexUrl;
    else delete process.env.CONVEX_URL;
  });

  describe("auth", () => {
    it("rejects a request with no bearer token (401)", async () => {
      const res = await request("/api/v1/projects/p1/plugins", { token: null });
      expect(res.status).toBe(401);
    });

    it("denies guest callers — plugins are not on the guest allowlist (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("/api/v1/projects/p1/plugins", {
        token: "guest-jwt",
      });
      expect(res.status).toBe(401);
      expect(convexQueryMock).not.toHaveBeenCalled();
    });

    it("denies guest reads of a plugin version (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("/api/v1/plugin-versions/pv1", {
        token: "guest-jwt",
      });
      expect(res.status).toBe(401);
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("GET /projects/:projectId/plugins", () => {
    it("lists plugins in the public DTO shape (clean id, no pluginId leak)", async () => {
      convexQueryMock.mockResolvedValue([PLUGIN_ROW]);
      const res = await request("/api/v1/projects/p1/plugins");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toEqual([
        {
          id: "pl1",
          projectId: "p1",
          name: "linear-tools",
          displayName: "Linear Tools",
          description: "Linear helpers",
          enabled: true,
          activeVersionId: "pv1",
          createdAt: 1,
          updatedAt: 2,
        },
      ]);
      expect(convexQueryMock).toHaveBeenCalledWith(
        "plugins:listProjectPlugins",
        { projectId: "p1" }
      );
    });

    it("omits the optional fields a sparse row does not carry", async () => {
      convexQueryMock.mockResolvedValue([
        {
          pluginId: "pl2",
          projectId: "p1",
          name: "bare",
          enabled: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]);
      const res = await request("/api/v1/projects/p1/plugins");
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items[0]).toEqual({
        id: "pl2",
        projectId: "p1",
        name: "bare",
        enabled: false,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    it("maps a non-member FORBIDDEN to 404, not 403", async () => {
      convexQueryMock.mockRejectedValue(
        convexError("FORBIDDEN", "Not a member of this project")
      );
      const res = await request("/api/v1/projects/p1/plugins");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /plugin-versions/:pluginVersionId", () => {
    it("returns the version detail in the public DTO shape", async () => {
      convexQueryMock.mockResolvedValue(VERSION_ROW);
      const res = await request("/api/v1/plugin-versions/pv1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        id: "pv1",
        pluginId: "pl1",
        declaredVersion: "1.2.0",
        bundleHash: "hash-abc",
        manifestHash: "hash-manifest",
        status: "ready",
        componentCounts: {
          skills: 1,
          servers: 1,
          apps: 0,
          assets: 0,
          unsupported: 0,
        },
        servers: VERSION_ROW.servers,
        skills: VERSION_ROW.skills,
        createdAt: 1,
        readyAt: 2,
      });
      expect(convexQueryMock).toHaveBeenCalledWith("plugins:getPluginVersion", {
        pluginVersionId: "pv1",
      });
    });

    it("maps a missing version's NOT_FOUND to 404", async () => {
      convexQueryMock.mockRejectedValue(
        convexError("NOT_FOUND", "Plugin version not found")
      );
      const res = await request("/api/v1/plugin-versions/missing");
      expect(res.status).toBe(404);
    });
  });
});
