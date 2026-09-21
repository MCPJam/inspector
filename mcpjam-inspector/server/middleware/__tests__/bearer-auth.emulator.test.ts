/**
 * The `sk_` branch of bearer auth, against a real WorkOS API.
 *
 * The sibling suite (`bearer-auth.test.ts`) replaces the SDK entirely:
 *
 *   vi.mock("../../services/workos-client.js", () => ({
 *     getWorkOSClient: () => ({ apiKeys: { createValidation: mock } }),
 *   }));
 *
 * That is the right shape for the rate-limiter and orphan-binding cases it
 * covers, and it cannot tell us whether `createValidation` is called correctly
 * or whether a revoked key stops validating — the mock answers whatever the
 * test told it to. Here the SDK is REAL and the key is one the emulator
 * actually minted, so "valid key" means WorkOS said so.
 *
 * Identity and org-binding lookups stay mocked: both are HTTP calls to the
 * Convex backend, which is a different service and out of scope.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";

const { resolveUserByExternalIdMock, lookupWorkosKeyBindingMock } = vi.hoisted(
  () => ({
    resolveUserByExternalIdMock: vi.fn(),
    lookupWorkosKeyBindingMock: vi.fn(),
  }),
);

vi.mock("../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));

vi.mock("../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));

// Only the sk_ branch is under test; the real guest validator does network I/O.
vi.mock("../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({
    valid: false,
    reason: "not_guest",
  })),
}));

import {
  bearerAuthMiddleware,
  resetWorkOSRateLimitForTests,
} from "../bearer-auth.js";
import {
  SEED,
  emulatorRest,
  mintUserApiKey,
  startWorkosEmulator,
  type WorkosEmulatorHandle,
} from "../../test/support/workos-emulator.js";

let h: WorkosEmulatorHandle;
let key: { id: string; value: string };

beforeAll(async () => {
  h = await startWorkosEmulator();
  key = await mintUserApiKey(h, {
    userId: SEED.user.id,
    organizationId: SEED.org.id,
  });
}, 30_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  resolveUserByExternalIdMock.mockReset();
  lookupWorkosKeyBindingMock.mockReset();
  resolveUserByExternalIdMock.mockResolvedValue({ _id: "mcpjam_user_1" });
  lookupWorkosKeyBindingMock.mockResolvedValue({
    mcpjamOrganizationId: "org_convex_1",
  });
  resetWorkOSRateLimitForTests();
});

function createApp(): Hono {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.get("/test", (c) =>
    c.json({
      authMethod: c.get("authMethod") ?? null,
      workosApiKeyId: c.get("workosApiKeyId") ?? null,
      workosUserId: c.get("workosUserId") ?? null,
      mcpjamUserId: c.get("mcpjamUserId") ?? null,
      mcpjamOrganizationId: c.get("mcpjamOrganizationId") ?? null,
    }),
  );
  return app;
}

const request = (token: string) =>
  createApp().request("/test", {
    headers: { Authorization: `Bearer ${token}` },
  });

describe("sk_ validation against a real WorkOS", () => {
  it("admits a key WorkOS recognises and populates the request context", async () => {
    const res = await request(key.value);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authMethod: "workos_api_key",
      workosApiKeyId: key.id,
      // The owner id comes back from WorkOS, not from our own fixture — which
      // is what makes this a check of the call and not of the test.
      workosUserId: SEED.user.id,
      mcpjamUserId: "mcpjam_user_1",
      mcpjamOrganizationId: "org_convex_1",
    });
    expect(resolveUserByExternalIdMock).toHaveBeenCalledWith(SEED.user.id);
    expect(lookupWorkosKeyBindingMock).toHaveBeenCalledWith(key.id);
  }, 30_000);

  it("rejects a well-formed key WorkOS has never issued", async () => {
    const res = await request("sk_test_never_issued");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: "Invalid API key" });
    // Nothing downstream should be consulted for a key that does not exist.
    expect(resolveUserByExternalIdMock).not.toHaveBeenCalled();
  }, 30_000);

  it("stops admitting a key the moment it is revoked", async () => {
    // No cross-request caching of a validation result: revocation has to take
    // effect immediately, not at the next deploy.
    const revocable = await mintUserApiKey(h, {
      userId: SEED.user.id,
      organizationId: SEED.org.id,
      name: "revocable",
    });
    expect((await request(revocable.value)).status).toBe(200);

    const { status } = await emulatorRest(
      h,
      "DELETE",
      `/api_keys/${revocable.id}`,
    );
    expect(status).toBe(204);

    expect((await request(revocable.value)).status).toBe(401);
  }, 30_000);

  it("fails closed when WorkOS is down, and recovers when it returns", async () => {
    const hook = h.emulator.addErrorHook({
      method: "POST",
      path: "/api_keys/validations",
      status: 503,
    });
    try {
      const res = await request(key.value);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ message: "Invalid API key" });
    } finally {
      h.emulator.removeErrorHook(hook.id);
    }

    // The outage must not be sticky — the same key works once WorkOS answers.
    expect((await request(key.value)).status).toBe(200);
  }, 30_000);

  it("reports an upstream rate limit as an invalid key", async () => {
    // Pinning CURRENT behaviour, not endorsing it: a 429 from WorkOS reaches
    // the caller as 401 "Invalid API key", which is indistinguishable from a
    // revoked key and will send them to rotate a credential that is fine. Our
    // OWN per-key limit is the separate 429 covered in bearer-auth.test.ts.
    // Worth fixing; deliberately not folded into a test-infrastructure change.
    const hook = h.emulator.addErrorHook({
      method: "POST",
      path: "/api_keys/validations",
      status: 429,
    });
    try {
      const res = await request(key.value);
      expect(res.status).toBe(401);
    } finally {
      h.emulator.removeErrorHook(hook.id);
    }
  }, 30_000);

  it("rejects a valid key that is bound to no organization", async () => {
    lookupWorkosKeyBindingMock.mockResolvedValue(null);

    const res = await request(key.value);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      details: { reason: "ORPHANED_KEY" },
    });
  }, 30_000);

  it("rejects a valid key whose WorkOS user has no MCPJam account", async () => {
    resolveUserByExternalIdMock.mockResolvedValue(null);

    const res = await request(key.value);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: "Unknown user" });
  }, 30_000);
});
