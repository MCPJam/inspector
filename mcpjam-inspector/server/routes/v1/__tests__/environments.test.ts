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
  opts: { body?: unknown; token?: string | null } = {},
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
    }),
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
    fn in map ? map[fn] : null,
  );
}

/**
 * A rejection shaped like a `ConvexError`: the structured `{ code, message }`
 * rides on `.data`, which is what the route branches on.
 */
function convexError(
  code: string,
  message: string,
  details?: Record<string, string>,
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
        "UNAUTHORIZED",
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
        { token: "guest-jwt", body: { expectedRevision: 3 } },
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
        { projectId: "p1", includeArchived: false },
      );

      convexQueryMock.mockClear();
      await request(
        "GET",
        "/api/v1/projects/p1/environments?includeArchived=true",
      );
      expect(convexQueryMock).toHaveBeenCalledWith(
        "projectEnvironments:listEnvironments",
        { projectId: "p1", includeArchived: true },
      );
    });

    it("derives `archived` from archivedAt so callers need not know the encoding", async () => {
      mockQuery({ "projectEnvironments:listEnvironments": [ARCHIVED_ROW] });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments?includeArchived=true",
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
        { projectId: "p1", environmentId: "env1" },
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
        convexError("NOT_FOUND", "Environment not found"),
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
        "VALIDATION_ERROR",
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

    it("accepts and forwards exact authored-skill version pins", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: {
          name: "Skill v1",
          hostId: "h1",
          skillSelection: {
            mode: "explicit",
            skillIds: ["sk1"],
            versionPins: [{ skillId: "sk1", versionId: "sk1-v1" }],
          },
        },
      });
      expect(res.status).toBe(201);
      expect(mutationArgs("projectEnvironments:createEnvironment")).toEqual({
        projectId: "p1",
        name: "Skill v1",
        hostId: "h1",
        skillSelection: {
          mode: "explicit",
          skillIds: ["sk1"],
          versionPins: [{ skillId: "sk1", versionId: "sk1-v1" }],
        },
      });
    });

    it("surfaces the admin gate as 403, not a misleading 404", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "FORBIDDEN",
          "Managing environments requires project admin (shared execution config).",
        ),
      );
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1" },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("FORBIDDEN");
    });

    it("hides non-membership as 404 so project existence never leaks", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("FORBIDDEN", "Not authorized for this project"),
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
        { body: { name: "Renamed" } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a revision-only body with no field to change (400)", async () => {
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        { body: { expectedRevision: 3 } },
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
        },
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

    it("accepts and forwards exact authored-skill version pins", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        {
          body: {
            expectedRevision: 3,
            skillSelection: {
              mode: "explicit",
              skillIds: ["sk1"],
              versionPins: [{ skillId: "sk1", versionId: "sk1-v2" }],
            },
          },
        },
      );
      expect(res.status).toBe(200);
      expect(mutationArgs("projectEnvironments:updateEnvironment")).toEqual({
        projectId: "p1",
        environmentId: "env1",
        expectedRevision: 3,
        skillSelection: {
          mode: "explicit",
          skillIds: ["sk1"],
          versionPins: [{ skillId: "sk1", versionId: "sk1-v2" }],
        },
      });
    });

    it("maps a stale revision to 409 CONFLICT with the backend's message", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "CONFLICT",
          "Environment changed since you loaded it (expected revision 3, current 5). Reload and retry.",
        ),
      );
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        { body: { expectedRevision: 3, name: "Renamed" } },
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
          'Skill "notes" has supporting files, which can\'t be pinned into runs yet.',
        ),
      );
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        {
          body: {
            expectedRevision: 3,
            skillSelection: { mode: "explicit", skillIds: ["sk1"] },
          },
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message?: string }).message).toMatch(
        /supporting files/,
      );
    });
  });

  describe("model override", () => {
    it("emits the STORED override on the DTO, never the effective model", async () => {
      // A row that carries an override and a row that inherits one must be
      // distinguishable from a list read alone — an editor cannot render
      // "Use client default" correctly otherwise.
      mockQuery({
        "projectEnvironments:listEnvironments": [
          { ...ENV_ROW, modelId: "openai/gpt-5" },
          { ...ENV_ROW, environmentId: "env2", name: "Inherits" },
        ],
      });
      const res = await request("GET", "/api/v1/projects/p1/environments");
      const body = (await res.json()) as {
        items: Array<{ modelId?: string }>;
      };
      expect(body.items[0]!.modelId).toBe("openai/gpt-5");
      expect(body.items[1]!.modelId).toBeUndefined();
    });

    it("round-trips modelId through create", async () => {
      convexMutationMock.mockResolvedValue({
        ...ENV_ROW,
        modelId: "openai/gpt-5",
      });
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1", modelId: "openai/gpt-5" },
      });
      expect(res.status).toBe(201);
      expect(mutationArgs("projectEnvironments:createEnvironment")).toEqual({
        projectId: "p1",
        name: "Staging",
        hostId: "h1",
        modelId: "openai/gpt-5",
      });
      expect(((await res.json()) as { modelId?: string }).modelId).toBe(
        "openai/gpt-5",
      );
    });

    it("rejects a blank modelId on create — clearing is a PATCH null", async () => {
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1", modelId: "   " },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("forwards an explicit null modelId as a CLEAR", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      await request("PATCH", "/api/v1/projects/p1/environments/env1", {
        body: { expectedRevision: 3, modelId: null },
      });
      expect(mutationArgs("projectEnvironments:updateEnvironment")).toEqual({
        projectId: "p1",
        environmentId: "env1",
        expectedRevision: 3,
        modelId: null,
      });
    });

    it("omits modelId entirely when the PATCH does not mention it", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      await request("PATCH", "/api/v1/projects/p1/environments/env1", {
        body: { expectedRevision: 3, name: "Renamed" },
      });
      expect(
        "modelId" in mutationArgs("projectEnvironments:updateEnvironment"),
      ).toBe(false);
    });

    it("carries effectiveModelId and modelSource through resolve", async () => {
      mockQuery({
        "projectEnvironments:resolveEnvironmentForLaunch": {
          ...RESOLVED_ROW,
          modelId: "openai/gpt-5",
          effectiveModelId: "openai/gpt-5",
          modelSource: "environment",
        },
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
      );
      expect(await res.json()).toMatchObject({
        modelId: "openai/gpt-5",
        effectiveModelId: "openai/gpt-5",
        modelSource: "environment",
      });
    });

    it("carries a HOST-derived effective model with no stored override", async () => {
      mockQuery({
        "projectEnvironments:resolveEnvironmentForLaunch": {
          ...RESOLVED_ROW,
          effectiveModelId: "anthropic/claude-sonnet-4-5",
          modelSource: "host",
        },
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
      );
      const body = (await res.json()) as {
        modelId?: string;
        effectiveModelId?: string;
        modelSource?: string;
      };
      // Inheriting must stay distinguishable from pinning: no stored override.
      expect(body.modelId).toBeUndefined();
      expect(body.effectiveModelId).toBe("anthropic/claude-sonnet-4-5");
      expect(body.modelSource).toBe("host");
    });

    it("maps ENV_MODEL_REQUIRED to 409 with a branchable reason", async () => {
      // The one resolution failure a caller is expected to ACT on rather than
      // display: pick a model on the environment or on its client.
      convexQueryMock.mockRejectedValue(
        convexError(
          "ENV_MODEL_REQUIRED",
          'Environment "Staging" has no model to run.',
          { environmentId: "env1", hostId: "h1", hostConfigId: "hc1" },
        ),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code?: string;
        details?: Record<string, string>;
      };
      expect(body.code).toBe("CONFLICT");
      expect(body.details).toMatchObject({
        code: "ENV_MODEL_REQUIRED",
        reason: "environment_model_required",
        hostId: "h1",
      });
    });
  });

  describe("capabilities", () => {
    it("reports what the deployment accepts", async () => {
      mockQuery({
        "projectEnvironments:getCapabilities": {
          modelOverrides: true,
          modelMatrix: true,
          skillVersionPins: true,
        },
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/capabilities",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        modelOverrides: true,
        modelMatrix: true,
        skillVersionPins: true,
      });
    });

    it("reports skillVersionPins false when the backend predates version pins", async () => {
      // A backend that HAS getCapabilities but not this flag is the ordinary
      // skew case: every flag is normalized with `=== true`, so an absent one
      // reads false rather than undefined and a client that probes it gets a
      // usable answer instead of a falsy-but-unknown.
      mockQuery({
        "projectEnvironments:getCapabilities": {
          modelOverrides: true,
          modelMatrix: true,
        },
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/capabilities",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ skillVersionPins: false });
    });

    it("answers false — not an error — when the deployment is too OLD", async () => {
      // ABSENCE IS THE SIGNAL. An older deployment does not export the query;
      // a 500 here would break clients that are perfectly able to fall back.
      convexQueryMock.mockRejectedValue(
        new Error(
          "Could not find public function for 'projectEnvironments:getCapabilities'",
        ),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/capabilities",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        modelOverrides: false,
        modelMatrix: false,
      });
    });

    it("does NOT disguise an access failure as an old deployment", async () => {
      // The dangerous version of the fallback above: collapsing every error
      // into a cheerful 200 tells the caller "upgrade your platform" when the
      // real problem is that they cannot read this project.
      convexQueryMock.mockRejectedValue(
        convexError("FORBIDDEN", "Not authorized for this project"),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/capabilities",
      );
      expect(res.status).not.toBe(200);
      expect(((await res.json()) as { code?: string }).code).not.toBe(
        "VALIDATION_ERROR",
      );
    });

    it("does NOT disguise an upstream outage as an old deployment", async () => {
      convexQueryMock.mockRejectedValue(new Error("fetch failed: ECONNRESET"));
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/capabilities",
      );
      expect(res.status).not.toBe(200);
    });

    it("is not mistaken for an environment id", async () => {
      // The literal segment is registered before `/:environmentId`; without
      // that ordering this reads as a lookup of an environment called
      // "capabilities" and 404s.
      mockQuery({
        "projectEnvironments:getCapabilities": { modelOverrides: true },
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/capabilities",
      );
      expect(res.status).toBe(200);
      expect(convexQueryMock).toHaveBeenCalledWith(
        "projectEnvironments:getCapabilities",
        { projectId: "p1" },
      );
    });
  });

  describe("archive + restore", () => {
    it("archives with the revision precondition", async () => {
      convexMutationMock.mockResolvedValue(ARCHIVED_ROW);
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: { expectedRevision: 3 } },
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
        { body: { expectedRevision: 4 } },
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
        { body: {} },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a stray field in the archive body (400)", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: { expectedRevision: 3, force: true } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("maps already-archived to 409, not 400", async () => {
      convexMutationMock.mockRejectedValue(
        convexError("CONFLICT", "Environment is already archived."),
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/archive",
        { body: { expectedRevision: 3 } },
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
        "/api/v1/projects/p1/environments/env1/resolve",
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
        { projectId: "p1", environmentId: "env1" },
      );
    });

    it("maps ENV_NOT_FOUND to 404", async () => {
      convexQueryMock.mockRejectedValue(
        convexError("ENV_NOT_FOUND", "Environment not found"),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
      );
      expect(res.status).toBe(404);
    });

    it("maps an unresolvable pinned plugin to 409 carrying the machine code", async () => {
      convexQueryMock.mockRejectedValue(
        convexError(
          "ENV_PLUGIN_UNAVAILABLE",
          'Plugin "linear" is disabled; enable it before running.',
          { reason: "disabled" },
        ),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
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
        convexError("ENV_NO_SERVERS", "Environment resolves to no servers."),
      );
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
      );
      expect(res.status).toBe(409);
    });
  });

  describe("sandboxImageId boundary rename", () => {
    it("exposes the row's computerEnvironmentId as sandboxImageId in DTOs", async () => {
      mockQuery({
        "projectEnvironments:getEnvironment": {
          ...ENV_ROW,
          computerEnvironmentId: "img1",
        },
      });
      const res = await request("GET", "/api/v1/projects/p1/environments/env1");
      expect(res.status).toBe(200);
      const dto = (await res.json()) as Record<string, unknown>;
      expect(dto.sandboxImageId).toBe("img1");
      // The internal name never leaks.
      expect(dto).not.toHaveProperty("computerEnvironmentId");
    });

    it("create maps sandboxImageId -> computerEnvironmentId and never forwards the public name", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      const res = await request("POST", "/api/v1/projects/p1/environments", {
        body: { name: "Staging", hostId: "h1", sandboxImageId: "img1" },
      });
      expect(res.status).toBe(201);
      const args = mutationArgs("projectEnvironments:createEnvironment");
      expect(args.computerEnvironmentId).toBe("img1");
      expect(args).not.toHaveProperty("sandboxImageId");
    });

    it("PATCH tri-state: null clears, value sets, omitted stays absent", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      await request("PATCH", "/api/v1/projects/p1/environments/env1", {
        body: { expectedRevision: 3, sandboxImageId: null },
      });
      expect(
        mutationArgs("projectEnvironments:updateEnvironment")
          .computerEnvironmentId,
      ).toBeNull();

      convexMutationMock.mockClear();
      convexMutationMock.mockResolvedValue(ENV_ROW);
      await request("PATCH", "/api/v1/projects/p1/environments/env1", {
        body: { expectedRevision: 3, sandboxImageId: "img2" },
      });
      expect(
        mutationArgs("projectEnvironments:updateEnvironment")
          .computerEnvironmentId,
      ).toBe("img2");

      convexMutationMock.mockClear();
      convexMutationMock.mockResolvedValue(ENV_ROW);
      await request("PATCH", "/api/v1/projects/p1/environments/env1", {
        body: { expectedRevision: 3, name: "Renamed" },
      });
      const args = mutationArgs("projectEnvironments:updateEnvironment");
      expect(args).not.toHaveProperty("computerEnvironmentId");
      expect(args).not.toHaveProperty("sandboxImageId");
    });

    it("a sandboxImageId-only PATCH satisfies the at-least-one-field refine", async () => {
      convexMutationMock.mockResolvedValue(ENV_ROW);
      const res = await request(
        "PATCH",
        "/api/v1/projects/p1/environments/env1",
        { body: { expectedRevision: 3, sandboxImageId: "img1" } },
      );
      expect(res.status).toBe(200);
    });

    it("rejects blank and whitespace-only ids (matches the published minLength/pattern)", async () => {
      for (const value of ["", "   "]) {
        convexMutationMock.mockClear();
        const created = await request(
          "POST",
          "/api/v1/projects/p1/environments",
          {
            body: { name: "Staging", hostId: "h1", sandboxImageId: value },
          },
        );
        expect(created.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();

        const patched = await request(
          "PATCH",
          "/api/v1/projects/p1/environments/env1",
          { body: { expectedRevision: 3, sandboxImageId: value } },
        );
        expect(patched.status).toBe(400);
        expect(convexMutationMock).not.toHaveBeenCalled();
      }
    });

    it("resolve exposes the pin as sandboxImageId when the backend carries it", async () => {
      mockQuery({
        "projectEnvironments:resolveEnvironmentForLaunch": {
          ...RESOLVED_ROW,
          computerEnvironmentId: "img1",
        },
      });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/environments/env1/resolve",
      );
      expect(res.status).toBe(200);
      const dto = (await res.json()) as Record<string, unknown>;
      expect(dto.sandboxImageId).toBe("img1");
      expect(dto).not.toHaveProperty("computerEnvironmentId");
    });
  });

  describe("POST /environments/ensure-adhoc", () => {
    const ADHOC_ROW = {
      environmentId: "env-adhoc",
      projectId: "p1",
      origin: "adhoc" as const,
      hostId: "h1",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    it("forwards the stack, renames sandboxImageId, and marks the row unnamed", async () => {
      convexMutationMock.mockResolvedValue({
        environment: ADHOC_ROW,
        created: true,
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/ensure-adhoc",
        {
          body: {
            hostId: "h1",
            sandboxImageId: "img1",
            modelId: "anthropic/claude-haiku-4.5",
          },
        },
      );

      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projectEnvironments:ensureAdhocEnvironment",
        {
          projectId: "p1",
          hostId: "h1",
          modelId: "anthropic/claude-haiku-4.5",
          // The public name is renamed at the boundary; the internal one must
          // not leak and the public one must not be forwarded.
          computerEnvironmentId: "img1",
        },
      );
      const body = (await res.json()) as any;
      // EXPLICIT, so a reader can tell "unnamed by construction" from "the
      // platform forgot to send a name".
      expect(body.environment.name).toBeNull();
      expect(body.environment.adhoc).toBe(true);
      expect(body.environment.sandboxImageId).toBeUndefined();
      expect(body.created).toBe(true);
    });

    it("answers 200 with created:false on the dedupe path, not 201", async () => {
      // Get-or-create cannot honestly answer 201 when nothing was minted.
      convexMutationMock.mockResolvedValue({
        environment: ADHOC_ROW,
        created: false,
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/ensure-adhoc",
        { body: { hostId: "h1" } },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).created).toBe(false);
    });

    it("translates a deployment without ad-hoc environments into an instruction", async () => {
      convexMutationMock.mockRejectedValue(
        new Error("Could not find public function for 'projectEnvironments'"),
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/ensure-adhoc",
        { body: { hostId: "h1" } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.details.reason).toBe("ADHOC_UNAVAILABLE");
      expect(body.message).toContain("named environment");
    });

    it("rejects unknown keys rather than silently dropping them", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/ensure-adhoc",
        { body: { hostId: "h1", computerEnvironmentId: "img1" } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /environments/:environmentId/name", () => {
    it("promotes in place, keeping the id every existing run points at", async () => {
      convexMutationMock.mockResolvedValue({
        ...ENV_ROW,
        environmentId: "env-adhoc",
        name: "Promoted",
        revision: 2,
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env-adhoc/name",
        { body: { expectedRevision: 1, name: "Promoted" } },
      );
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "projectEnvironments:nameEnvironment",
        {
          projectId: "p1",
          environmentId: "env-adhoc",
          expectedRevision: 1,
          name: "Promoted",
        },
      );
      const body = (await res.json()) as any;
      expect(body.id).toBe("env-adhoc");
      expect(body.name).toBe("Promoted");
    });

    it("requires the revision precondition, like every other mutation", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env-adhoc/name",
        { body: { name: "Promoted" } },
      );
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("passes the backend's refusal through for an already-named row", async () => {
      convexMutationMock.mockRejectedValue(
        convexError(
          "CONFLICT",
          "This environment already has a name. Rename it from the Environments list.",
        ),
      );
      const res = await request(
        "POST",
        "/api/v1/projects/p1/environments/env1/name",
        { body: { expectedRevision: 3, name: "Nope" } },
      );
      expect(res.status).toBe(409);
    });
  });
});
