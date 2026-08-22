import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 HOST surface (server/routes/v1/hosts.ts): auth + guest gating,
// the public DTO mapping (no Convex `hostId` leak), the project-scoped Convex
// calls (every detail/write forwards the path `projectId` so cross-project ids
// 404 inside Convex), and the body contracts — create's template-XOR-config
// rule and delete's "no body, reject stray fields like a legacy `force`".
//
// Convex is mocked at the `convex/browser` boundary, so these tests prove the
// gateway's behavior and the ARGS it forwards — NOT that the backend accepts
// those args. The backend validators + project scoping are covered separately
// by mcpjam-backend/tests/convex/hostsProjectScope.test.ts.

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

// The host routes build their Convex clients via `new ConvexHttpClient(...)`
// (directly and through `createConvexClients`), so a single mock here backs
// both the read (`query`) and write (`mutation`) paths.
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
  })),
}));

import v1Routes from "../index.js";
import {
  bundledHostCompatCatalog,
  getCatalogTemplate,
  SUPPORTED_CATALOG_SCHEMA_VERSION,
  type HostCompatCatalog,
} from "@mcpjam/sdk/host-compat";
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

const LIST_ROW = {
  hostId: "h1",
  name: "Alpha",
  hostConfigId: "hc1",
  modelId: "gpt-4o-mini",
  serverCount: 2,
  createdAt: 1,
  updatedAt: 2,
};
const DETAIL_ROW = {
  hostId: "h1",
  name: "Alpha",
  config: { modelId: "gpt-4o-mini" },
};

/** Dispatch the mocked Convex query by function name. */
function mockQuery(map: Record<string, unknown>) {
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn in map ? map[fn] : null
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function catalogEnvelope(catalog: HostCompatCatalog) {
  return {
    schemaVersion: SUPPORTED_CATALOG_SCHEMA_VERSION,
    version: 99,
    contentHash: "test-hash",
    publishedAt: 1,
    catalog,
  };
}

function createdHostInput(): Record<string, unknown> {
  const call = convexMutationMock.mock.calls.find(
    ([fn]) => fn === "hosts:createHost"
  );
  if (!call) throw new Error("hosts:createHost was not called");
  return (call[1] as { input: Record<string, unknown> }).input;
}

describe("v1 host routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    // Default: the bearer is neither a guest token nor an `sk_` key, so the
    // middleware treats it as a WorkOS JWT and passes it through to Convex.
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
      const res = await request("GET", "/api/v1/projects/p1/hosts", {
        token: null,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
    });

    it("denies guest callers — hosts are not on the guest allowlist (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("GET", "/api/v1/projects/p1/hosts", {
        token: "guest-jwt",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
      expect(convexQueryMock).not.toHaveBeenCalled();
    });
  });

  describe("GET list + detail", () => {
    it("lists hosts in the public DTO shape (id, no hostId leak)", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/hosts");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ id: "h1", name: "Alpha" });
      expect(body.items[0]).not.toHaveProperty("hostId");
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:listHosts", {
        projectId: "p1",
      });
    });

    it("returns host detail and forwards the path projectId to getHost", async () => {
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("GET", "/api/v1/projects/p1/hosts/h1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: "h1", name: "Alpha" });
      expect(body).not.toHaveProperty("hostId");
      // Project scope is enforced inside Convex — the route must pass projectId.
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:getHost", {
        hostId: "h1",
        projectId: "p1",
      });
    });

    it("returns 404 when getHost yields null (missing or cross-project id)", async () => {
      mockQuery({ "hosts:getHost": null });
      const res = await request("GET", "/api/v1/projects/p1/hosts/other");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });
  });

  describe("POST create", () => {
    it("creates a host from a full config and returns 201", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Alpha", config: { modelId: "gpt-4o-mini" } },
      });
      expect(res.status).toBe(201);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        id: "h1",
      });
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:createHost", {
        projectId: "p1",
        name: "Alpha",
        input: { modelId: "gpt-4o-mini" },
      });
    });

    it("creates a template host from the live backend catalog first", async () => {
      const catalog = clone(bundledHostCompatCatalog());
      catalog.hostsById.claude = {
        ...catalog.hostsById.claude,
        modelId: "backend/claude-live",
        hostContext: {
          ...(catalog.hostsById.claude.hostContext as Record<string, unknown>),
          backendOnly: true,
        },
      };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(catalogEnvelope(catalog)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });

      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Claude", template: "claude", theme: "light" },
      });

      expect(res.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://convex-http.example.com/public/host-catalog",
        expect.objectContaining({ method: "GET" })
      );
      expect(createdHostInput()).toMatchObject({
        hostStyle: "claude",
        modelId: "backend/claude-live",
        hostContext: expect.objectContaining({
          theme: "light",
          backendOnly: true,
        }),
      });
    });

    it("accepts template ids that exist only in the live backend catalog", async () => {
      const catalog = clone(bundledHostCompatCatalog());
      catalog.hostsById["future-host"] = {
        ...catalog.hostsById.claude,
        id: "future-host",
        label: "Future Host",
        hostStyle: "future-host",
        modelId: "backend/future-host",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(catalogEnvelope(catalog)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        )
      );
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });

      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Future Host", template: "future-host" },
      });

      expect(res.status).toBe(201);
      expect(createdHostInput()).toMatchObject({
        hostStyle: "future-host",
        modelId: "backend/future-host",
      });
    });

    it("falls back to the bundled SDK catalog when the backend catalog is unavailable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }))
      );
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const fallbackTemplate = getCatalogTemplate(
        bundledHostCompatCatalog(),
        "mistral"
      );

      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Mistral", template: "mistral" },
      });

      expect(res.status).toBe(201);
      expect(createdHostInput()).toMatchObject({
        hostStyle: "mistral",
        modelId: fallbackTemplate?.modelId,
        modelVisibleMcpToolResults:
          fallbackTemplate?.modelVisibleMcpToolResults,
        mcpToolResultImageRendering:
          fallbackTemplate?.mcpToolResultImageRendering,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[host-catalog] v1 host template fallback",
        expect.objectContaining({ reason: "unavailable" })
      );
    });

    it("falls back to the bundled SDK catalog when CONVEX_HTTP_URL is missing", async () => {
      delete process.env.CONVEX_HTTP_URL;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const fallbackTemplate = getCatalogTemplate(
        bundledHostCompatCatalog(),
        "mistral"
      );

      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Mistral", template: "mistral" },
      });

      expect(res.status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createdHostInput()).toMatchObject({
        hostStyle: "mistral",
        modelId: fallbackTemplate?.modelId,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[host-catalog] v1 host template fallback",
        expect.objectContaining({ reason: "missing_convex_http_url" })
      );
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: {
          name: "Alpha",
          config: { modelId: "gpt-4o-mini" },
          hostIds: ["h1"],
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("hostIds");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a body with neither template nor config (400)", async () => {
      const res = await request("POST", "/api/v1/projects/p1/hosts", {
        body: { name: "Alpha" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    // ── FORWARD-CLIENT INVARIANT ─────────────────────────────────────────
    // A client with no model cannot back a headless environment: resolution
    // falls through to `ENV_MODEL_REQUIRED` at LAUNCH, long after creation.
    // These hold the failure at the moment the choice is made.
    describe("the model invariant", () => {
      it.each([
        ["missing", {}],
        ["null", { modelId: null }],
        ["empty", { modelId: "" }],
        ["whitespace-only", { modelId: "   " }],
        ["a non-string", { modelId: 42 }],
      ])(
        "rejects a config whose modelId is %s (400)",
        async (_label, extra) => {
          const res = await request("POST", "/api/v1/projects/p1/hosts", {
            body: { name: "Alpha", config: { systemPrompt: "hi", ...extra } },
          });
          expect(res.status).toBe(400);
          expect(((await res.json()) as { code?: string }).code).toBe(
            "VALIDATION_ERROR"
          );
          expect(convexMutationMock).not.toHaveBeenCalled();
        }
      );

      it("reports the XOR problem — not the model — for an empty config", async () => {
        // `{}` picked neither branch. Naming the model would send the caller
        // to add one field when they need to choose a shape.
        const res = await request("POST", "/api/v1/projects/p1/hosts", {
          body: { name: "Alpha", config: {} },
        });
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(
          /exactly one of .template. or a non-empty .config./i
        );
      });

      it("TRIMS a padded model rather than persisting it verbatim", async () => {
        // The id is stored and compared verbatim downstream, so a padded value
        // would be persisted as a distinct — and unrecognized — model.
        convexMutationMock.mockResolvedValue({ hostId: "h1" });
        mockQuery({ "hosts:getHost": DETAIL_ROW });
        const res = await request("POST", "/api/v1/projects/p1/hosts", {
          body: { name: "Alpha", config: { modelId: "  openai/gpt-5  " } },
        });
        // Assert the create SUCCEEDED before reading the mutation args: a
        // rejected request never calls the mutation, and `createdHostInput()`
        // would then throw on a missing call — a confusing failure for what is
        // really "the route 400'd".
        expect(res.status).toBe(201);
        expect(createdHostInput()).toMatchObject({
          modelId: "openai/gpt-5",
        });
      });

      it("TRIMS a padded model on the TEMPLATE branch too", async () => {
        // The trim belongs to the write boundary, not to one of the two ways of
        // reaching it. A catalog entry is authored data as much as a posted
        // config, and a padded id from either side persists a model that no
        // downstream verbatim comparison recognizes.
        const catalog = clone(bundledHostCompatCatalog());
        catalog.hostsById.claude = {
          ...catalog.hostsById.claude,
          modelId: "  anthropic/claude-sonnet-4-5  ",
        };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify(catalogEnvelope(catalog)), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          )
        );
        convexMutationMock.mockResolvedValue({ hostId: "h1" });
        mockQuery({ "hosts:getHost": DETAIL_ROW });
        const res = await request("POST", "/api/v1/projects/p1/hosts", {
          body: { name: "Alpha", template: "claude" },
        });
        expect(res.status).toBe(201);
        expect(createdHostInput()).toMatchObject({
          modelId: "anthropic/claude-sonnet-4-5",
        });
      });

      it("refuses a template that resolves without a model", async () => {
        // A guard, never a substitution: templates carry their OWN model, and
        // one that lost it is a catalog bug.
        const catalog = clone(bundledHostCompatCatalog());
        catalog.hostsById.claude = {
          ...catalog.hostsById.claude,
          modelId: "",
        };
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify(catalogEnvelope(catalog)), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          )
        );
        const res = await request("POST", "/api/v1/projects/p1/hosts", {
          body: { name: "Alpha", template: "claude" },
        });
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(
          /does not pin a model/i
        );
        expect(convexMutationMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("PATCH update", () => {
    it("updates a host and forwards the path projectId to updateHost", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
        body: { name: "Renamed" },
      });
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:updateHost", {
        hostId: "h1",
        projectId: "p1",
        name: "Renamed",
      });
    });

    it("rejects an empty update (no name or config) with 400", async () => {
      const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
        body: {},
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
        body: { name: "Renamed", theme: "dark" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("theme");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    describe("the model invariant", () => {
      it.each([
        ["empty", ""],
        ["whitespace-only", "   "],
      ])(
        "refuses to CLEAR a pinned model with an %s one (400)",
        async (_label, modelId) => {
          // A config PATCH replaces the config, so it is the one write here
          // that can strip the model off an existing host — the invariant
          // `create` enforces would otherwise be one PATCH wide open.
          mockQuery({ "hosts:getHost": DETAIL_ROW });
          const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
            body: { config: { systemPrompt: "hi", modelId } },
          });
          expect(res.status).toBe(400);
          expect(((await res.json()) as { code?: string }).code).toBe(
            "VALIDATION_ERROR"
          );
          expect(convexMutationMock).not.toHaveBeenCalled();
        }
      );

      it("still lets a LEGACY modelless host be edited", async () => {
        // Those rows predate the invariant and are deliberately not
        // backfilled; holding their unrelated edits hostage to a model choice
        // is the lockout the rule exists to avoid.
        convexMutationMock.mockResolvedValue({ hostId: "h1" });
        mockQuery({
          "hosts:getHost": { ...DETAIL_ROW, config: { modelId: "" } },
        });
        const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
          body: { config: { systemPrompt: "edited", modelId: "" } },
        });
        expect(res.status).toBe(200);
        expect(convexMutationMock).toHaveBeenCalledWith(
          "hosts:updateHost",
          expect.objectContaining({
            input: { systemPrompt: "edited", modelId: "" },
          })
        );
      });

      it("TRIMS a padded model on the PATCH boundary too", async () => {
        convexMutationMock.mockResolvedValue({ hostId: "h1" });
        mockQuery({ "hosts:getHost": DETAIL_ROW });
        const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
          body: { config: { modelId: "  openai/gpt-5  " } },
        });
        expect(res.status).toBe(200);
        expect(convexMutationMock).toHaveBeenCalledWith(
          "hosts:updateHost",
          expect.objectContaining({ input: { modelId: "openai/gpt-5" } })
        );
      });
    });
  });

  describe("POST servers", () => {
    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/hosts/h1/servers",
        { body: { serverIds: ["s1"], serverNames: ["Echo"] } }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("serverNames");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("POST duplicate", () => {
    it("refuses to duplicate a modelless host (400)", async () => {
      // Duplication MINTS a host, so it is held to the same invariant as
      // create — otherwise copying a legacy row is a supported way to keep
      // producing the state create now refuses.
      mockQuery({
        "hosts:getHost": { ...DETAIL_ROW, config: { modelId: "" } },
      });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/hosts/h1/duplicate",
        { body: {} }
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/does not pin a model/i);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/hosts/h1/duplicate",
        { body: { name: "Copy", force: true } }
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("force");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("duplicates a host that pins one", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h2" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/hosts/h1/duplicate",
        { body: {} }
      );
      expect(res.status).toBe(201);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:duplicateHost",
        expect.objectContaining({ hostId: "h1", projectId: "p1" })
      );
    });
  });

  describe("DELETE", () => {
    it("deletes a host, forwarding only { hostId, projectId } (no force)", async () => {
      convexMutationMock.mockResolvedValue(undefined);
      const res = await request("DELETE", "/api/v1/projects/p1/hosts/h1");
      expect(res.status).toBe(200);
      expect((await res.json()) as Record<string, unknown>).toEqual({
        id: "h1",
        deleted: true,
      });
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:deleteHost", {
        hostId: "h1",
        projectId: "p1",
      });
    });

    it("rejects a delete body carrying a legacy `force` field (400)", async () => {
      const res = await request("DELETE", "/api/v1/projects/p1/hosts/h1", {
        body: { force: true },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe("VALIDATION_ERROR");
      expect(body.message).toContain("force");
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a delete body even with only a synthesized-looking key (400)", async () => {
      // The route reads the raw body, so a payload like `{ "projectId": "p1" }`
      // is still a body and is rejected — DELETE is truly bodyless, not merely
      // "no fields other than the ones synthesizeServerBody would inject".
      const res = await request("DELETE", "/api/v1/projects/p1/hosts/h1", {
        body: { projectId: "p1" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });
});
