import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the v1 HARNESS surface (server/routes/v1/harness.ts): auth + guest
// gating and the read-only built-in-tools catalog. No Convex — the data is
// static published-package metadata read from the harness registry — so the
// auth seams are stubbed only to satisfy the shared bearer middleware.

const { validateGuestTokenMock, validateApiKeyMock, resolveUserByExternalIdMock, lookupWorkosKeyBindingMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    validateApiKeyMock: vi.fn(),
    resolveUserByExternalIdMock: vi.fn(),
    lookupWorkosKeyBindingMock: vi.fn(),
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

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  opts: { token?: string | null } = {},
): Promise<Response> {
  const { token = "tok" } = opts;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(makeApp().request(path, { method, headers }));
}

type ToolInfo = {
  key: string;
  name: string;
  commonName?: string;
  toolUseKind?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

describe("v1 harness routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Non-guest WorkOS JWT (neither a guest token nor an `sk_` key).
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });
  afterEach(() => vi.clearAllMocks());

  describe("auth", () => {
    it("rejects a request with no bearer token (401)", async () => {
      const res = await request(
        "GET",
        "/api/v1/harness/claude-code/builtin-tools",
        { token: null },
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code?: string }).code).toBe("UNAUTHORIZED");
    });

    it("allows guests — the catalog is static, non-sensitive metadata (GET-only allowlist)", async () => {
      validateGuestTokenMock.mockResolvedValue({ valid: true, guestId: "guest_1" });
      const res = await request(
        "GET",
        "/api/v1/harness/claude-code/builtin-tools",
        { token: "guest-jwt" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  describe("GET builtin-tools", () => {
    it("returns the claude-code native tool catalog as a page of display DTOs", async () => {
      const res = await request(
        "GET",
        "/api/v1/harness/claude-code/builtin-tools",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: ToolInfo[] };
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);

      const keys = new Set(body.items.map((t) => t.key));
      for (const expected of ["bash", "read", "edit", "webSearch"]) {
        expect(keys).toContain(expected);
      }
      // Display invariants: every row has a name; bash exposes an input schema.
      for (const t of body.items) expect(t.name.length).toBeGreaterThan(0);
      const bash = body.items.find((t) => t.key === "bash");
      expect(bash?.inputSchema).toBeTruthy();
      expect((bash?.inputSchema as { type?: string }).type).toBe("object");
    });

    it("returns the codex built-in tools (bash, webSearch)", async () => {
      const res = await request("GET", "/api/v1/harness/codex/builtin-tools");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: ToolInfo[] };
      expect(Array.isArray(body.items)).toBe(true);
      const keys = new Set(body.items.map((t) => t.key));
      for (const expected of ["bash", "webSearch"]) {
        expect(keys).toContain(expected);
      }
      for (const t of body.items) expect(t.name.length).toBeGreaterThan(0);
    });

    it("404s for an unknown / not-yet-installed harness id", async () => {
      // `pi` is a plausible-but-unregistered runtime (codex is now installed).
      const res = await request("GET", "/api/v1/harness/pi/builtin-tools");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe("NOT_FOUND");
    });
  });
});
