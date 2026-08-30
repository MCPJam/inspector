import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 CLIENT surface (server/routes/v1/clients.ts): auth + guest
// gating, the public DTO mapping (no Convex `hostId` leak), the project-scoped
// Convex calls (every detail/write forwards the path `projectId` so
// cross-project ids 404 inside Convex), the body contracts — create's
// template-XOR-config rule, the compare-and-set tokens the canonical writes
// require, and delete's "no body, reject stray fields like a legacy `force`" —
// and the DEPRECATED `/hosts` aliases, whose whole job is to keep behaving
// exactly as they did.
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
  ownerScope: null,
  hasComputer: false,
  createdAt: 1,
  updatedAt: 2,
};
/** A User Testing scenario's private backing client — hidden by default. */
const PRIVATE_BACKING_ROW = {
  ...LIST_ROW,
  hostId: "h9",
  name: "Backing",
  ownerScope: { type: "user_testing" },
};
const IMPACT = {
  liveEnvironmentCount: 3,
  scenarioAttachmentCount: 1,
  activeLegacyJourneyCount: 0,
};
const DETAIL_ROW = {
  hostId: "h1",
  name: "Alpha",
  hostConfigId: "hc1",
  config: { modelId: "gpt-4o-mini" },
  ownerScope: null,
  hasComputer: false,
  createdAt: 1,
  updatedAt: 2,
  impact: IMPACT,
};

/**
 * Dispatch the mocked Convex query by function name.
 *
 * `hosts:resolveHostByNameOrId` is answered by default with the selector echoed
 * back as an id, so every canonical `:client` route resolves the way an ID
 * lookup does. Tests about resolution override it explicitly.
 */
function mockQuery(map: Record<string, unknown>) {
  convexQueryMock.mockImplementation(async (fn: string, args: any) => {
    if (fn in map) return map[fn];
    if (fn === "hosts:resolveHostByNameOrId") {
      return { hostId: args.selector, name: args.selector };
    }
    return null;
  });
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

describe("v1 client routes", () => {
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
      const res = await request("GET", "/api/v1/projects/p1/clients", {
        token: null,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED"
      );
    });

    it("denies guest callers — clients are not on the guest allowlist (401)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
      const res = await request("GET", "/api/v1/projects/p1/clients", {
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
      const res = await request("GET", "/api/v1/projects/p1/clients");
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
      const res = await request("GET", "/api/v1/projects/p1/clients/h1");
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
      const res = await request("GET", "/api/v1/projects/p1/clients/other");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });
  });

  describe("POST create", () => {
    it("creates a host from a full config and returns 201", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("POST", "/api/v1/projects/p1/clients", {
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

      const res = await request("POST", "/api/v1/projects/p1/clients", {
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

      const res = await request("POST", "/api/v1/projects/p1/clients", {
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

      const res = await request("POST", "/api/v1/projects/p1/clients", {
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
        "[host-catalog] v1 client template fallback",
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

      const res = await request("POST", "/api/v1/projects/p1/clients", {
        body: { name: "Mistral", template: "mistral" },
      });

      expect(res.status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(createdHostInput()).toMatchObject({
        hostStyle: "mistral",
        modelId: fallbackTemplate?.modelId,
      });
      expect(warnSpy).toHaveBeenCalledWith(
        "[host-catalog] v1 client template fallback",
        expect.objectContaining({ reason: "missing_convex_http_url" })
      );
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request("POST", "/api/v1/projects/p1/clients", {
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
      const res = await request("POST", "/api/v1/projects/p1/clients", {
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
          const res = await request("POST", "/api/v1/projects/p1/clients", {
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
        const res = await request("POST", "/api/v1/projects/p1/clients", {
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
        const res = await request("POST", "/api/v1/projects/p1/clients", {
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
        const res = await request("POST", "/api/v1/projects/p1/clients", {
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
        const res = await request("POST", "/api/v1/projects/p1/clients", {
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
    it("renames through the partial mutation, carrying the name token", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { name: "Renamed", expectedName: "Alpha" },
      });
      expect(res.status).toBe(200);
      // `updateHostFields`, not `updateHost`: it owns the "no effective change
      // writes nothing" rule that a rename through the replacement mutation
      // would violate by bumping `updatedAt`.
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHostFields",
        {
          hostId: "h1",
          projectId: "p1",
          name: "Renamed",
          expectedName: "Alpha",
        }
      );
    });

    it("applies a partial `set` edit with the config token", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { expectedConfigId: "hc1", set: { temperature: 0.2 } },
      });
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHostFields",
        {
          hostId: "h1",
          projectId: "p1",
          set: { temperature: 0.2 },
          expectedHostConfigId: "hc1",
        }
      );
    });

    it("forwards a null in `set` verbatim — it is the clear/reset signal", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { expectedConfigId: "hc1", set: { harness: null } },
      });
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHostFields",
        expect.objectContaining({ set: { harness: null } })
      );
    });

    it("rejects a config edit with no `expectedConfigId` (400)", async () => {
      // The whole point of the canonical surface: an unpreconditioned config
      // write can silently revert a concurrent edit.
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { set: { temperature: 0.2 } },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/expectedConfigId/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects a rename with no `expectedName` (400)", async () => {
      // A rename does not rotate the config, so the config token is blind to a
      // concurrent one — it needs its own.
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { name: "Renamed" },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/expectedName/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects `config` and `set` together (400)", async () => {
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: {
          expectedConfigId: "hc1",
          config: { modelId: "gpt-4o-mini" },
          set: { temperature: 0.2 },
        },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/not both/i);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown field inside `set` (400)", async () => {
      // `set` is a named field list, not a passthrough: an unrecognized key is
      // a caller mistake the route can name, not something to forward.
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { expectedConfigId: "hc1", set: { hostStyle: "claude" } },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/hostStyle/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("translates a backend CONFLICT into a 409 carrying the current value", async () => {
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      convexMutationMock.mockRejectedValue(
        Object.assign(new Error("Uncaught ConvexError: stale"), {
          data: {
            code: "CONFLICT",
            message: "This client changed since you read it.",
            data: { currentConfigId: "hc2" },
          },
        })
      );
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { expectedConfigId: "hc1", set: { temperature: 0.2 } },
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code?: string;
        details?: Record<string, unknown>;
      };
      expect(body.code).toBe("CONFLICT");
      // Recoverable without a second round-trip: the live id comes back.
      expect(body.details).toMatchObject({ currentConfigId: "hc2" });
    });

    it("rejects an empty update (no name, config or set) with 400", async () => {
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: {},
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: { name: "Renamed", expectedName: "Alpha", theme: "dark" },
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
          const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
            body: {
              expectedConfigId: "hc1",
              config: { systemPrompt: "hi", modelId },
            },
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
        const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
          body: {
            expectedConfigId: "hc1",
            config: { systemPrompt: "edited", modelId: "" },
          },
        });
        expect(res.status).toBe(200);
        expect(convexMutationMock).toHaveBeenCalledWith(
          "hosts:updateHost",
          expect.objectContaining({
            input: { systemPrompt: "edited", modelId: "" },
            expectedHostConfigId: "hc1",
          })
        );
      });

      it("TRIMS a padded model on the PATCH boundary too", async () => {
        convexMutationMock.mockResolvedValue({ hostId: "h1" });
        mockQuery({ "hosts:getHost": DETAIL_ROW });
        const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
          body: {
            expectedConfigId: "hc1",
            config: { modelId: "  openai/gpt-5  " },
          },
        });
        expect(res.status).toBe(200);
        expect(convexMutationMock).toHaveBeenCalledWith(
          "hosts:updateHost",
          expect.objectContaining({ input: { modelId: "openai/gpt-5" } })
        );
      });
    });
  });

  describe("the read/write round-trip", () => {
    // The `get` → edit one field → `update` loop is what every CLI and agent
    // caller does. It used to fail: the GET projection carries the config row's
    // `id` and `schemaVersion`, the backend's input validator is a strict
    // `v.object` that accepts neither, and its argument-validation error is
    // deliberately not forwarded — so the caller got a bare 500 naming no field
    // for a body this same API had just emitted.
    it("strips the read-only projection keys on PATCH", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: {
          expectedConfigId: "hc1",
          config: {
            id: "hc1",
            schemaVersion: 2,
            modelId: "openai/gpt-5",
            systemPrompt: "edited",
          },
        },
      });
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHost",
        expect.objectContaining({
          input: { modelId: "openai/gpt-5", systemPrompt: "edited" },
        })
      );
    });

    it("strips them on create too", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("POST", "/api/v1/projects/p1/clients", {
        body: {
          name: "Alpha",
          config: { id: "hc1", schemaVersion: 2, modelId: "gpt-4o-mini" },
        },
      });
      expect(res.status).toBe(201);
      expect(convexMutationMock).toHaveBeenCalledWith("hosts:createHost", {
        projectId: "p1",
        name: "Alpha",
        input: { modelId: "gpt-4o-mini" },
      });
    });

    // Only the two derived keys are dropped. Anything else the caller invents
    // still reaches the backend validator and still fails closed there.
    it("leaves an unrecognized key alone", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("PATCH", "/api/v1/projects/p1/clients/h1", {
        body: {
          expectedConfigId: "hc1",
          config: { modelId: "openai/gpt-5", typodField: 1 },
        },
      });
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHost",
        expect.objectContaining({
          input: { modelId: "openai/gpt-5", typodField: 1 },
        })
      );
    });
  });

  describe("POST servers", () => {
    it("forwards the config token to updateHostServers", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/clients/h1/servers",
        { body: { serverIds: ["s1"], expectedConfigId: "hc1" } }
      );
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHostServers",
        expect.objectContaining({
          hostId: "h1",
          projectId: "p1",
          serverIds: ["s1"],
          expectedHostConfigId: "hc1",
        })
      );
    });

    it("requires `expectedConfigId` (400)", async () => {
      // Server-only composition already stops a stale caller clobbering an
      // unrelated field. It does not stop two concurrent server replacements
      // from losing one — that is what the token is for.
      const res = await request(
        "POST",
        "/api/v1/projects/p1/clients/h1/servers",
        { body: { serverIds: ["s1"] } }
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/expectedConfigId/);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("rejects an unknown key rather than silently dropping it (400)", async () => {
      const res = await request(
        "POST",
        "/api/v1/projects/p1/clients/h1/servers",
        {
          body: {
            serverIds: ["s1"],
            expectedConfigId: "hc1",
            serverNames: ["Echo"],
          },
        }
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
        "/api/v1/projects/p1/clients/h1/duplicate",
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
        "/api/v1/projects/p1/clients/h1/duplicate",
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
        "/api/v1/projects/p1/clients/h1/duplicate",
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
      const res = await request("DELETE", "/api/v1/projects/p1/clients/h1");
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
      const res = await request("DELETE", "/api/v1/projects/p1/clients/h1", {
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
      const res = await request("DELETE", "/api/v1/projects/p1/clients/h1", {
        body: { projectId: "p1" },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "VALIDATION_ERROR"
      );
      expect(convexMutationMock).not.toHaveBeenCalled();
    });
  });

  describe("read-backs and the private-backing filter", () => {
    it("emits configId, ownerScope, hasComputer, timestamps and impact", async () => {
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("GET", "/api/v1/projects/p1/clients/h1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        id: "h1",
        name: "Alpha",
        // The concurrency token, under the canonical name.
        configId: "hc1",
        ownerScope: null,
        hasComputer: false,
        createdAt: 1,
        updatedAt: 2,
        impact: IMPACT,
      });
      expect(body).not.toHaveProperty("hostConfigId");
    });

    it("hides User Testing backing clients from the list by default", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW, PRIVATE_BACKING_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/clients");
      const body = (await res.json()) as { items: Array<{ id: string }> };
      expect(body.items.map((item) => item.id)).toEqual(["h1"]);
    });

    it("includes them with ?includePrivateBacking=true", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW, PRIVATE_BACKING_ROW] });
      const res = await request(
        "GET",
        "/api/v1/projects/p1/clients?includePrivateBacking=true"
      );
      const body = (await res.json()) as { items: Array<{ id: string }> };
      expect(body.items.map((item) => item.id)).toEqual(["h1", "h9"]);
    });

    it("404s a backing client reached by ID, not just by name", async () => {
      // The default-exclusion rule is about what a client IS. If it held for
      // names and lapsed for ids, the detail route would be a way to read one
      // by guessing.
      mockQuery({
        "hosts:getHost": {
          ...DETAIL_ROW,
          hostId: "h9",
          ownerScope: { type: "user_testing" },
        },
      });
      const res = await request("GET", "/api/v1/projects/p1/clients/h9");
      expect(res.status).toBe(404);
    });
  });

  describe("name resolution on the canonical detail path", () => {
    it("resolves a name through the backend resolver, then reads by id", async () => {
      convexQueryMock.mockImplementation(async (fn: string) => {
        if (fn === "hosts:resolveHostByNameOrId") return { hostId: "h1" };
        if (fn === "hosts:getHost") return DETAIL_ROW;
        return null;
      });
      const res = await request("GET", "/api/v1/projects/p1/clients/Alpha");
      expect(res.status).toBe(200);
      expect(convexQueryMock).toHaveBeenCalledWith(
        "hosts:resolveHostByNameOrId",
        { projectId: "p1", selector: "Alpha", includePrivateBacking: false }
      );
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:getHost", {
        hostId: "h1",
        projectId: "p1",
      });
    });

    it("falls back to list-and-scan ONLY when the resolver does not exist", async () => {
      convexQueryMock.mockImplementation(async (fn: string) => {
        if (fn === "hosts:resolveHostByNameOrId") {
          throw new Error(
            "Could not find public function hosts:resolveHostByNameOrId"
          );
        }
        if (fn === "hosts:listHosts") return [LIST_ROW, PRIVATE_BACKING_ROW];
        if (fn === "hosts:getHost") return DETAIL_ROW;
        return null;
      });
      const res = await request("GET", "/api/v1/projects/p1/clients/alpha");
      expect(res.status).toBe(200);
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:listHosts", {
        projectId: "p1",
      });
    });

    it("does NOT treat an authorization failure as version skew", async () => {
      // Catching every resolver error as skew would swallow a refusal into a
      // list-and-scan that answers a different question.
      const calls: string[] = [];
      convexQueryMock.mockImplementation(async (fn: string) => {
        calls.push(fn);
        if (fn === "hosts:resolveHostByNameOrId") {
          throw Object.assign(new Error("Uncaught ConvexError: forbidden"), {
            data: { code: "FORBIDDEN", message: "Not a member" },
          });
        }
        return null;
      });
      const res = await request("GET", "/api/v1/projects/p1/clients/Alpha");
      expect(res.status).not.toBe(200);
      expect(calls).not.toContain("hosts:listHosts");
    });

    it("refuses an ambiguous name in the fallback rather than picking one", async () => {
      convexQueryMock.mockImplementation(async (fn: string) => {
        if (fn === "hosts:resolveHostByNameOrId") {
          throw new Error("Could not find public function");
        }
        if (fn === "hosts:listHosts") {
          return [LIST_ROW, { ...LIST_ROW, hostId: "h2", name: "alpha" }];
        }
        return null;
      });
      const res = await request("GET", "/api/v1/projects/p1/clients/Alpha");
      expect(res.status).toBe(409);
      expect(JSON.stringify(await res.json())).toMatch(/matches 2 clients/i);
    });
  });

  // ── The DEPRECATED `/hosts` aliases ───────────────────────────────────────
  //
  // Their entire job is to keep behaving as they did, so what is pinned here is
  // the OLD shape and the OLD (tokenless) contract — the two things a rename is
  // most likely to break by accident.
  describe("deprecated /hosts aliases", () => {
    it("still returns `hostConfigId`, not `configId`, on the list", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/hosts");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      expect(body.items[0]).toMatchObject({ id: "h1", hostConfigId: "hc1" });
      expect(body.items[0]).not.toHaveProperty("configId");
      // And the read-backs the canonical surface added stay off it: adding a
      // field to a deprecated DTO is still a change to a deprecated DTO.
      expect(body.items[0]).not.toHaveProperty("impact");
      expect(body.items[0]).not.toHaveProperty("ownerScope");
    });

    it("does NOT filter private backing rows — the old surface never did", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW, PRIVATE_BACKING_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/hosts");
      const body = (await res.json()) as { items: Array<{ id: string }> };
      expect(body.items.map((item) => item.id)).toEqual(["h1", "h9"]);
    });

    it("returns the old three-field detail shape", async () => {
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request("GET", "/api/v1/projects/p1/hosts/h1");
      expect(await res.json()).toEqual({
        id: "h1",
        name: "Alpha",
        config: { modelId: "gpt-4o-mini" },
      });
    });

    it("marks every alias response `Deprecation: true`", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/hosts");
      expect(res.headers.get("Deprecation")).toBe("true");
      expect(res.headers.get("Link")).toContain("successor-version");
    });

    it("leaves the canonical surface unmarked", async () => {
      mockQuery({ "hosts:listHosts": [LIST_ROW] });
      const res = await request("GET", "/api/v1/projects/p1/clients");
      expect(res.headers.get("Deprecation")).toBeNull();
    });

    it("still accepts a tokenless PATCH and still calls updateHost", async () => {
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

    it("rejects the canonical token fields it never accepted (400)", async () => {
      // The alias body is strict and unchanged: a caller sending the new
      // contract to the old path is making a mistake worth naming, not one to
      // quietly half-honor.
      const res = await request("PATCH", "/api/v1/projects/p1/hosts/h1", {
        body: { expectedConfigId: "hc1", set: { temperature: 0.2 } },
      });
      expect(res.status).toBe(400);
      expect(convexMutationMock).not.toHaveBeenCalled();
    });

    it("still accepts a tokenless server replacement", async () => {
      convexMutationMock.mockResolvedValue({ hostId: "h1" });
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      const res = await request(
        "POST",
        "/api/v1/projects/p1/hosts/h1/servers",
        { body: { serverIds: ["s1"] } }
      );
      expect(res.status).toBe(200);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "hosts:updateHostServers",
        expect.objectContaining({ hostId: "h1", serverIds: ["s1"] })
      );
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "hosts:updateHostServers",
        expect.objectContaining({ expectedHostConfigId: expect.anything() })
      );
    });

    it("is ID-ONLY: it does not resolve names", async () => {
      // Teaching the deprecated surface to resolve names would hand it a
      // capability the canonical one is meant to be the reason to move to.
      mockQuery({ "hosts:getHost": DETAIL_ROW });
      await request("GET", "/api/v1/projects/p1/hosts/Alpha");
      expect(convexQueryMock).not.toHaveBeenCalledWith(
        "hosts:resolveHostByNameOrId",
        expect.anything()
      );
      expect(convexQueryMock).toHaveBeenCalledWith("hosts:getHost", {
        hostId: "Alpha",
        projectId: "p1",
      });
    });
  });
});
