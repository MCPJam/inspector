/**
 * `/api/web/api-keys` against a real WorkOS API, authenticated by a real
 * AuthKit token.
 *
 * The sibling suite (`api-keys.test.ts`) mocks `verifyAuthKitToken` to a fixed
 * `sub` and stubs `global.fetch` with a matcher keyed on pathname alone. That
 * is deliberate there — it isolates the ownership-walk logic — and it means the
 * suite would pass unchanged if the route sent its requests to the wrong host,
 * with the wrong method, or with a body WorkOS rejects. Here the token is
 * minted by the emulator through a genuine PKCE login and every WorkOS call is
 * really served, so the mint/list/revoke round trip is checked against the API
 * rather than against a fixture of it.
 *
 * The Convex-facing helpers (identity, org readiness, key bindings) stay
 * mocked: they are HTTP calls to the backend service, not to WorkOS.
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
import { SignJWT, generateKeyPair } from "jose";
import { createWebTestApp, expectJson } from "./helpers/test-app.js";
import {
  createWorkosKeyBinding,
  lookupWorkosKeyBinding,
  removeWorkosKeyBinding,
  WorkosKeyBindingError,
} from "../../../services/workos-key-bindings.js";

vi.mock("../../../services/workos-key-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual, // keeps the real WorkosKeyBindingError class
    createWorkosKeyBinding: vi.fn().mockResolvedValue(undefined),
    lookupWorkosKeyBinding: vi
      .fn()
      .mockResolvedValue({ mcpjamOrganizationId: "org_convex_1" }),
    removeWorkosKeyBinding: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../../services/identity.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveUserByExternalId: vi
      .fn()
      .mockResolvedValue({ _id: "mcpjam_user_1" }),
  };
});

const mockResolveApiKeyReadiness = vi.fn();
vi.mock("../../../services/organizations.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveApiKeyReadiness: (...args: unknown[]) =>
      mockResolveApiKeyReadiness(...args),
  };
});

// The bearer here is an AuthKit JWT, so the guest branch of bearerAuthMiddleware
// would otherwise try to validate it over the network.
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({
    valid: false,
    reason: "not_guest",
  })),
}));

import {
  SEED,
  listUserApiKeys,
  loginWithPkce,
  startWorkosEmulator,
  type WorkosEmulatorHandle,
} from "../../../test/support/workos-emulator.js";

let h: WorkosEmulatorHandle;
let bearer: string;

beforeAll(async () => {
  h = await startWorkosEmulator();
  const session = await loginWithPkce(h, { email: SEED.user.email });
  bearer = session.accessToken;
}, 30_000);

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  vi.mocked(createWorkosKeyBinding).mockReset().mockResolvedValue(undefined);
  vi.mocked(lookupWorkosKeyBinding)
    .mockReset()
    .mockResolvedValue({ mcpjamOrganizationId: "org_convex_1" });
  vi.mocked(removeWorkosKeyBinding).mockReset().mockResolvedValue(undefined);
  mockResolveApiKeyReadiness.mockReset().mockResolvedValue({
    ready: true,
    workosOrganizationId: SEED.org.id,
  });
});

/** `bearer` is assigned in beforeAll, so the header is built per call. */
function authHeader() {
  return { Authorization: `Bearer ${bearer}` };
}

function app() {
  return createWebTestApp().app;
}

async function mint(name = "ci key") {
  return app().request("/api/web/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ name, organizationId: "org_convex_1" }),
  });
}

describe("mint", () => {
  it("creates a key at WorkOS and binds it to the caller's organization", async () => {
    const { status, data } = await expectJson<{ id: string; value: string }>(
      await mint(),
    );

    expect(status).toBe(200);
    expect(data.id).toMatch(/^api_key_/);
    expect(data.value).toMatch(/^sk_/);
    expect(createWorkosKeyBinding).toHaveBeenCalledWith({
      workosApiKeyId: data.id,
      mcpjamOrganizationId: "org_convex_1",
      mintedByUserId: "mcpjam_user_1",
    });

    // WorkOS agrees the key exists and belongs to this user — the fixture
    // cannot fake this.
    const keys = await listUserApiKeys(h, SEED.user.id);
    expect(keys.map((k) => k.id)).toContain(data.id);
  }, 30_000);

  it("revokes the WorkOS key when the org binding is refused", async () => {
    // A key with no binding is an orphan: it authenticates nothing and cannot
    // be revoked from the UI, so the route must not leave one behind.
    const before = await listUserApiKeys(h, SEED.user.id);
    vi.mocked(createWorkosKeyBinding).mockRejectedValueOnce(
      new WorkosKeyBindingError(409, "already bound"),
    );

    const { status, data } = await expectJson<{ code: string }>(
      await mint("doomed"),
    );

    expect(status).toBe(409);
    expect(data.code).toBe("CONFLICT");
    const after = await listUserApiKeys(h, SEED.user.id);
    expect(after).toHaveLength(before.length);
  }, 30_000);

  it("maps a WorkOS rate limit to a rate-limit response", async () => {
    const hook = h.emulator.addErrorHook({
      method: "POST",
      path: `/user_management/users/${SEED.user.id}/api_keys`,
      status: 429,
    });
    try {
      const { status, data } = await expectJson<{ code: string }>(
        await mint("throttled"),
      );
      expect(status).toBe(429);
      expect(data.code).toBe("RATE_LIMITED");
    } finally {
      h.emulator.removeErrorHook(hook.id);
    }
  }, 30_000);
});

describe("list and revoke", () => {
  it("lists a freshly minted key and revokes it for real", async () => {
    const { data: created } = await expectJson<{ id: string; value: string }>(
      await mint("round-trip"),
    );

    const listed = await expectJson<{
      items: Array<{ id: string; organizationId: string | null }>;
    }>(await app().request("/api/web/api-keys", { headers: authHeader() }));
    expect(listed.status).toBe(200);
    expect(listed.data.items.map((k) => k.id)).toContain(created.id);
    expect(
      listed.data.items.find((k) => k.id === created.id)?.organizationId,
    ).toBe("org_convex_1");
    expect(lookupWorkosKeyBinding).toHaveBeenCalledWith(created.id);

    const revoked = await app().request(`/api/web/api-keys/${created.id}`, {
      method: "DELETE",
      headers: authHeader(),
    });
    expect(revoked.status).toBe(200);
    expect(removeWorkosKeyBinding).toHaveBeenCalledWith(
      created.id,
      "mcpjam_user_1",
    );

    // Gone at WorkOS, not merely delisted by us.
    const remaining = await listUserApiKeys(h, SEED.user.id);
    expect(remaining.map((k) => k.id)).not.toContain(created.id);
  }, 30_000);

  it("reports an unknown key as not found rather than calling WorkOS", async () => {
    // The ownership walk is the authorization check: an id the caller does not
    // own must read as absent, whether it never existed or belongs elsewhere.
    const res = await app().request("/api/web/api-keys/api_key_not_yours", {
      method: "DELETE",
      headers: authHeader(),
    });

    const { status, data } = await expectJson<{ code: string }>(res);
    expect(status).toBe(404);
    expect(data.code).toBe("NOT_FOUND");
  }, 30_000);
});

describe("session verification", () => {
  it("rejects a forged token carrying the right issuer and audience", async () => {
    // The payload is entirely valid-looking; only the signing key is wrong.
    // Before verification was added here, a token like this drove key
    // lifecycle operations against the named `sub`.
    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(`https://api.workos.com/user_management/${h.clientId}`)
      .setAudience(h.clientId)
      .setSubject(SEED.user.id)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    const before = await listUserApiKeys(h, SEED.user.id);
    const res = await app().request("/api/web/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${forged}`,
      },
      body: JSON.stringify({ name: "forged", organizationId: "org_convex_1" }),
    });

    expect(res.status).toBe(401);
    expect(await listUserApiKeys(h, SEED.user.id)).toHaveLength(before.length);
  }, 30_000);
});
