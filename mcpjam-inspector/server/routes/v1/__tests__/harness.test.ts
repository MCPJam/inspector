import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const localVenue = vi.hoisted(() => ({ harnesses: new Set<string>() }));
vi.mock("../../../utils/harness/local/run-resources.js", () => ({
  isLocalHarnessVenue: (harness: string | undefined) =>
    harness !== undefined && localVenue.harnesses.has(harness),
}));

// Covers the v1 HARNESS surface (server/routes/v1/harness.ts): auth + guest
// gating and the read-only built-in-tools catalog. No Convex — the data is
// static published-package metadata read from the harness registry — so the
// auth seams are stubbed only to satisfy the shared bearer middleware.

const {
  validateGuestTokenMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
  verifyAuthKitTokenMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
  verifyAuthKitTokenMock: vi.fn(),
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
// This route mounts `requireVerifiedAuth` (it never calls Convex, so nothing
// downstream would re-check the bearer). The JWT here is a placeholder string,
// so verification is stubbed; the middleware's own branches — verified,
// rejected, and AuthKit-unconfigured — are covered in
// server/middleware/__tests__/require-verified-auth.test.ts.
vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAuthKitToken: verifyAuthKitTokenMock,
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
    verifyAuthKitTokenMock.mockResolvedValue({ sub: "user_harness" });
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
      expect(((await res.json()) as { code?: string }).code).toBe(
        "UNAUTHORIZED",
      );
    });

    it("allows guests — the catalog is static, non-sensitive metadata (GET-only allowlist)", async () => {
      validateGuestTokenMock.mockResolvedValue({
        valid: true,
        guestId: "guest_1",
      });
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

  describe("GET capabilities", () => {
    type Capabilities = {
      harnessId: string;
      transport?: string;
      supportsNativeToolApproval: boolean;
      supportsHostExecutedToolApproval: boolean;
      supportsMcpToolApproval: boolean;
      mcpDelivery: string;
    };

    async function capabilities(harnessId: string) {
      const res = await request(
        "GET",
        `/api/v1/harness/${harnessId}/capabilities`,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as Capabilities;
    }

    it("reports what claude-code can be asked to do", async () => {
      const body = await capabilities("claude-code");
      expect(body.harnessId).toBe("claude-code");
      // One transport, so the field is absent rather than invented.
      expect(body.transport).toBeUndefined();
      expect(body.supportsNativeToolApproval).toBe(true);
      expect(body.mcpDelivery).toBe("native");
    });

    it("reports that Codex can pause for approval on both surfaces", async () => {
      // The host editor enables the approval switch from this answer.
      const caps = await capabilities("codex");
      expect(caps.transport).toBe("app-server");
      expect(caps.supportsNativeToolApproval).toBe(true);
      expect(caps.supportsHostExecutedToolApproval).toBe(true);
      expect(caps.mcpDelivery).toBe("host-executed");
    });

    it("answers for the local arm when this Inspector runs the harness locally", async () => {
      // Same adapter in either venue; the route also says it runs here.
      localVenue.harnesses.add("codex");
      try {
        const caps = (await capabilities("codex")) as Capabilities & { localExecution?: boolean };
        expect(caps.localExecution).toBe(true);
        expect(caps.transport).toBe("app-server");
        expect(caps.supportsNativeToolApproval).toBe(true);
      } finally {
        localVenue.harnesses.clear();
      }
    });

    it("404s for an unknown harness id", async () => {
      const res = await request("GET", "/api/v1/harness/pi/capabilities");
      expect(res.status).toBe(404);
    });

    it("reports the MCP-surface flag, which is not the host-executed one", async () => {
      // The distinction the refusal logic turns on: for a `native` harness the
      // MCP flag governs, for a `host-executed` one it says nothing and the
      // host-executed flag governs. Reading the wrong one is the bypass the
      // capability set exists to make unrepresentable, so both are asserted.
      const claude = await capabilities("claude-code");
      expect(claude.mcpDelivery).toBe("native");
      expect(claude.supportsMcpToolApproval).toBe(true);

      const codex = await capabilities("codex");
      expect(codex.mcpDelivery).toBe("host-executed");
      // False, and inert: nothing reads it for a host-executed harness.
      expect(codex.supportsMcpToolApproval).toBe(false);
    });

    it("404s for an empty harness id rather than resolving a default", async () => {
      const res = await request("GET", "/api/v1/harness//capabilities");
      expect([404, 400]).toContain(res.status);
    });

    it("refuses a request with no bearer", async () => {
      // `requireVerifiedAuth` covers this route because it never calls Convex,
      // so nothing downstream would otherwise re-check the token.
      const res = await request("GET", "/api/v1/harness/codex/capabilities", {
        token: null,
      });
      expect(res.status).toBe(401);
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

    it("reports the codex catalog: typed items for shell, patches and web search", async () => {
      const res = await request("GET", "/api/v1/harness/codex/builtin-tools");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: ToolInfo[] };
      const keys = new Set(body.items.map((t) => t.key));
      for (const expected of ["bash", "webSearch", "fileChange"]) {
        expect(keys).toContain(expected);
      }
      // Native names measured against the pinned binary.
      const names = new Set(body.items.map((t) => t.name));
      expect(names).toContain("exec_command");
      expect(names).toContain("apply_patch");
    });

    it("returns the cursor built-in tools (bash, read, edit, webSearch)", async () => {
      const res = await request("GET", "/api/v1/harness/cursor/builtin-tools");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: ToolInfo[] };
      expect(Array.isArray(body.items)).toBe(true);
      const keys = new Set(body.items.map((t) => t.key));
      for (const expected of ["bash", "read", "edit", "webSearch"]) {
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
