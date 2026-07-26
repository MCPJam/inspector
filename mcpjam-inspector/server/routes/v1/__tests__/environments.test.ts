import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 PROJECT ENVIRONMENT surface (server/routes/v1/environments.ts):
// auth + guest gating, the public DTO mapping (no Convex `environmentId` leak),
// the project-scoped Convex calls (every read/write forwards the path
// `projectId`, so cross-project ids 404 inside Convex), and the two contracts
// the public surface must not smooth over — the required `expectedRevision`
// precondition (stale ⇒ 409) and the omitted-vs-null tri-state on PATCH.
//
// Convex is mocked at the `convex/browser` boundary, so these tests prove the
// gateway's behavior and the ARGS it forwards — NOT that the backend accepts
// them. The backend validators, admin gate, and project scoping live in
// mcpjam-backend/convex/projectEnvironments.ts and are covered there.

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
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";

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

const ENV_ROW = {
  environmentId: "env1",
  projectId: "p1",
  name: "Staging",
  description: "Staging bundle",
  hostId: "h1",
  serverAttachmentId: "sa1",
  skillSelection: { mode: "explicit" as const, skillIds: ["sk1"] },
  pluginVersionIds: ["pv1"],
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
};

const ARCHIVED_ROW = { ...ENV_ROW, archivedAt: 99, revision: 4 };

const RESOLVED_ROW = {
  environmentRef: { environmentId: "env1", name: "Staging", revision: 3 },
  hostId: "h1",
  hostName: "Alpha",
  hostConfigId: "hc1",
  serverAttachmentId: "sa1",
  selectedServerIds: ["s1"],
  effectiveServerIds: ["s1", "s2"],
  pluginVersions: [
    {
      pluginId: "pl1",
      pluginVersionId: "pv1",
      name: "linear",
      bundleHash: "abc",
    },
  ],
  servers: [
    { serverId: "s1", name: "one" },
    { serverId: "s2", name: "two" },
  ],
};

/** Dispatch the mocked Convex query by function name. */
function mockQuery(map: Record<string, unknown>) {
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn in map ? map[fn] : null
  );
}

/**
 * A rejection shaped like a `ConvexError`: the structured `{ code, message }`
 * rides on `.data`, which is what the route branches on.
 */
function convexError(
  code: string,
  message: string,
  details?: Record<string, string>
): Error {
  const error = new Error(`Uncaught ConvexError: ${message}`);
  (error as unknown as { data: unknown }).data = {
    code,
    message,
    ...(details ? { details } : {}),
  };
  return error;
}

/** Args forwarded to a mocked Convex mutation. */
function mutationArgs(fn: string): Record<string, unknown> {
  const call = convexMutationMock.mock.calls.find(([name]) => name === fn);
  if (!call) throw new Error(`${fn} was not called`);
  return call[1] as Record<string, unknown>;
}

describe("v1 project environment routes", () => {
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
      const res = await request("GET", "/api/v1/projects/p1/environments", {
        token: null,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
    });

    it("denies guest callers — environments are not on the guest allowlist (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("GET", "/api/v1/projects/p1/environments", {
        token: "guest-jwt",
      });
      expect(res.status).toBe(401);
      expect(convexQueryMock).not.toHaveBeenCalled();
    });

    it("denies guest writes to the archive sub-action (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { token: "guest-jwt", body: { expectedRevision: 3 } }
      );
      expect(res.status).toBe(401);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("GET list", () => {
    it("lists environments in the public DTO shape (id, no environmentId leak)", async () => {
      mockQuery({ "projectEnvironments:listEnvironments": [ENV_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/environments");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        id: "env1",
        name: "Staging",
        hostId: "h1",
        revision: 3,
        archived: false,
      });
      expect(body.items[0]).not.toHaveProperty("environmentId");
    });

    it("excludes archived rows unless includeArchived=true is asked for", async () => {
      mockQuery({ "projectEnvironments:listEnvironments": [] });
      await request("GET", "/api/v1/projects/p1/environments");
      expect(convexQueryMock).toHaveBeenCalledWith(
        "projectEnvironments:listEnvironments",
        { projectId: "p1", includeArchived: false }
      );

      convexQueryMock.mockClear();
      await request(
        "GET",
        "/api/v1/projects/p1/environments?includeArchived=true"
      );
      expect(convexQueryMock).toHaveBeenCalledWith(
        "projectEnvironments:listEnvironments",
        { projectId: "p1", includeArchived: true }
      );
    });

    it("derives `archived` from archivedAt so callers need not know the encoding", async () => {
      mockQuery({ "projectEnvironments:listEnvironments": [ARCHIVED_ROW] });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments?includeArchived=true"
      );
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items[0]).toMatchObject({ archived: true, archivedAt: 99 });
    });
  });

  describe("GET detail", () => {
    it("returns detail and forwards the path projectId for scope enforcement", async () => {
      mockQuery({ "projectEnvironments:getEnvironment": ENV_ROW });
      const res = await request("GET", "/api/v1/projects/p1/environments/env1");
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: "env1",
        name: "Staging",
      });
      // Project scope is enforced inside Convex — the route must pass projectId.
      expect(convexQueryMock).toHaveBeenCalledWith(
        "projectEnvironments:getEnvironment",
        { projectId: "p1", environmentId: "env1" }
      );
    });

    it("404s when the environment is null (missing or cross-project id)", async () => {
      mockQuery({});
      const res = await request("GET", "/api/v1/projects/p1/environments/env1");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });

    it("maps a structured NOT_FOUND ConvexError to 404", async () => {
      convexQueryMock.mockRejectedValue(
        convexError("NOT_FOUND", "Environment not found")
      );
      const res = await request("GET", "/api/v1/projects/p1/environments/env1");
      expect(res.status).toBe(404);
    });
  });

  describe("POST create", () => {
    it("creates and returns 201 with the forwarded args", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1" },
      });
      expect(res.status).toBe(201);
      expect(mutationArgs("projectEnvironments:createEnvironment")).toEqual({
        projectId: "p1",
        name: "Staging",
        hostId: "h1",
      });
    });

    it("rejects an unknown field rather than silently dropping it (400)", async () => {
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1", pluginVersions: ["pv1"] },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an empty pluginVersionIds list — clearing is a PATCH null, not []", async () => {
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1", pluginVersionIds: [] },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("surfaces the admin gate as 403, not a misleading 404", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "FORBIDDEN",
          "Managing environments requires project admin (shared execution config)."
        )
      );
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1" },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("FORBIDDEN");
    });

    it("hides non-membership as 404 so project existence never leaks", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("FORBIDDEN", "Not authorized for this project")
      );
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1" },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });
  });

  describe("PATCH update", () => {
    it("requires expectedRevision — the precondition is never inferred (400)", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        { body: { name: "Renamed" } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a revision-only body with no field to change (400)", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        { body: { expectedRevision: 3 } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("forwards an explicit null as a CLEAR and omits untouched fields", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        {
          body: {
            expectedRevision: 3,
            serverAttachmentId: null,
            name: "Renamed",
          },
        }
      );
      expect(res.status).toBe(200);
      const args = mutationArgs("projectEnvironments:updateEnvironment");
      expect(args).toEqual({
        projectId: "p1",
        environmentId: "env1",
        expectedRevision: 3,
        name: "Renamed",
        serverAttachmentId: null,
      });
      // Untouched clearable fields must be ABSENT, not null — a null would
      // clear them.
      expect(args).not.toHaveProperty("skillSelection");
      expect(args).not.toHaveProperty("pluginVersionIds");
    });

    it("forwards a null skillSelection and pluginVersionIds clear", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      await request("PATCH", "/api/v1/projects/p1/environments/env1", {
        body: {
          expectedRevision: 3,
          skillSelection: null,
          pluginVersionIds: null,
        },
      });
      const args = mutationArgs("projectEnvironments:updateEnvironment");
      expect(args.skillSelection).toBeNull();
      expect(args.pluginVersionIds).toBeNull();
    });

    it("maps a stale revision to 409 CONFLICT with the backend's message", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "CONFLICT",
          "Environment changed since you loaded it (expected revision 3, current 5). Reload and retry."
        )
      );
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        { body: { expectedRevision: 3, name: "Renamed" } }
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("CONFLICT");
      expect(body.message).toMatch(/current 5/);
    });

    it("maps a backend VALIDATION rejection to 400 with its message", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "VALIDATION",
          'Skill "notes" has supporting files, which can\'t be pinned into runs yet.'
        )
      );
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        {
          body: {
            expectedRevision: 3,
            skillSelection: { mode: "explicit", skillIds: ["sk1"] },
          },
        }
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toMatch(
        /supporting files/
      );
    });
  });

  describe("archive + restore", () => {
    it("archives with the revision precondition", async () => {
      convexMutationMock.mockResolvedValue(ARCHIVED_ROW);
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: { expectedRevision: 3 } }
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        archived: true,
      });
      expect(mutationArgs("projectEnvironments:archiveEnvironment")).toEqual({
        projectId: "p1",
        environmentId: "env1",
        expectedRevision: 3,
      });
    });

    it("restores with the revision precondition", async () => {
      convexMutationMock.mockResolvedValue({ ...ENV_ROW, revision: 5 });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/restore",
        { body: { expectedRevision: 4 } }
      );
      expect(res.status).toBe(200);
      expect(mutationArgs("projectEnvironments:restoreEnvironment")).toEqual({
        projectId: "p1",
        environmentId: "env1",
        expectedRevision: 4,
      });
    });

    it("requires expectedRevision on archive (400)", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: {} }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a stray field in the archive body (400)", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: { expectedRevision: 3, force: true } }
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("maps already-archived to 409, not 400", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("CONFLICT", "Environment is already archived.")
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: { expectedRevision: 3 } }
      );
      expect(res.status).toBe(409);
    });
  });

  describe("GET resolve", () => {
    it("returns the launch resolution including plugin-contributed servers", async () => {
      mockQuery({
        "projectEnvironments:resolveEnvironmentForLaunch": RESOLVED_ROW,
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve"
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.environment).toEqual({
        id: "env1",
        name: "Staging",
        revision: 3,
      });
      expect(body.selectedServerIds).toEqual(["s1"]);
      expect(body.effectiveServerIds).toEqual(["s1", "s2"]);
      expect(body.pluginVersions).toHaveLength(1);
      expect(convexQueryMock).toHaveBeenCalledWith(
        "projectEnvironments:resolveEnvironmentForLaunch",
        { projectId: "p1", environmentId: "env1" }
      );
    });

    it("maps ENV_NOT_FOUND to 404", async () => {
      convexQueryMock.mockRejectedValue(
        convexError("ENV_NOT_FOUND", "Environment not found")
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve"
      );
      expect(res.status).toBe(404);
    });

    it("maps an unresolvable pinned plugin to 409 carrying the machine code", async () => {
      convexQueryMock.mockRejectedValue(
        convexError(
          "ENV_PLUGIN_UNAVAILABLE",
          'Plugin "linear" is disabled; enable it before running.',
          { reason: "disabled" }
        )
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve"
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code?: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe("CONFLICT");
      // The specific ENV_* reason must survive for callers that branch on it.
      expect(body.details).toMatchObject({ code: "ENV_PLUGIN_UNAVAILABLE" });
    });

    it("maps an empty resolved server set to 409", async () => {
      convexQueryMock.mockRejectedValue(
        convexError("ENV_NO_SERVERS", "Environment resolves to no servers.")
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve"
      );
      expect(res.status).toBe(409);
    });
  });
});
