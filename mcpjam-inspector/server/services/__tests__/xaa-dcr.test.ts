import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { postMock, proxyMock, validateMock, warnMock, errorMock } = vi.hoisted(
  () => ({
    postMock: vi.fn(),
    proxyMock: vi.fn(),
    validateMock: vi.fn(),
    warnMock: vi.fn(),
    errorMock: vi.fn(),
  })
);

vi.mock("../../utils/server-secrets.js", () => ({
  postToConvexAuthorized: (...args: unknown[]) => postMock(...args),
}));

vi.mock("../../utils/oauth-proxy.js", () => ({
  executeOAuthProxy: (...args: unknown[]) => proxyMock(...args),
  validateUrl: (...args: unknown[]) => validateMock(...args),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { warn: warnMock, error: errorMock },
}));

import {
  buildXaaConnectDcrFingerprint,
  ensureXaaDcrRegistration,
  normalizeXaaDcrScope,
} from "../xaa-dcr.js";

const savedConvexUrl = process.env.CONVEX_HTTP_URL;
const savedServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

const base = {
  bearerToken: "user-bearer",
  projectId: "project-1",
  serverId: "server-1",
  resource: "https://resource.example/mcp",
  registrationEndpoint: "https://as.example/register",
  issuer: "https://as.example",
  scope: "write read read",
  httpsOnly: true,
};

const emptyState = {
  clientId: null,
  tokenEndpointAuthMethod: null,
  issuer: null,
  clientSecretExpiresAt: null,
  fingerprint: null,
  registeredAt: null,
  status: null,
  attemptFingerprint: null,
  attemptStartedAt: null,
  leaseExpiresAt: null,
};

function validRegistrationBody(overrides: Record<string, unknown> = {}) {
  return {
    client_id: "dcr-client",
    client_secret: "dcr-secret",
    token_endpoint_auth_method: "client_secret_post",
    authorization_grant_profiles_supported: [
      "urn:ietf:params:oauth:grant-profile:id-jag",
    ],
    grant_types: [
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ],
    ...overrides,
  };
}

function proxyResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? "Created" : "Error",
    headers: { "content-type": "application/json" },
    body,
  };
}

function installFreshBackend() {
  postMock.mockImplementation(
    async (args: { body: Record<string, unknown> }) => {
      switch (args.body.action) {
        case "get":
          return { success: true, state: emptyState, clientSecret: null };
        case "claim":
          return { success: true, acquired: true, reason: "acquired" };
        case "markStarted":
          return { success: true, started: true };
        case "store":
          return { success: true, stored: true };
        case "release":
          return { success: true, released: true };
        case "markUncertain":
          return { success: true, marked: true };
        default:
          throw new Error(`unexpected action ${String(args.body.action)}`);
      }
    }
  );
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
  postMock.mockReset();
  proxyMock.mockReset();
  validateMock.mockReset();
  validateMock.mockImplementation(async (url: string) => ({ url }));
  warnMock.mockReset();
  errorMock.mockReset();
  installFreshBackend();
});

afterEach(() => {
  if (savedConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = savedConvexUrl;
  if (savedServiceToken === undefined)
    delete process.env.INSPECTOR_SERVICE_TOKEN;
  else process.env.INSPECTOR_SERVICE_TOKEN = savedServiceToken;
});

describe("XAA Connect DCR fingerprint", () => {
  it("normalizes scope whitespace, duplicates, and ordering", () => {
    expect(normalizeXaaDcrScope(" b   a b\ta ")).toBe("a b");
    expect(
      buildXaaConnectDcrFingerprint({
        resource: base.resource,
        registrationEndpoint: base.registrationEndpoint,
        scope: "b a b",
      })
    ).toBe(
      buildXaaConnectDcrFingerprint({
        resource: base.resource,
        registrationEndpoint: base.registrationEndpoint,
        scope: "a b",
      })
    );
  });
});

describe("ensureXaaDcrRegistration", () => {
  it("fails before registration when persistence infrastructure is unavailable", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await expect(ensureXaaDcrRegistration(base)).rejects.toThrow(
      /persistence is not configured/i
    );
    expect(postMock).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("reuses a matching unexpired registration without a remote POST", async () => {
    const fingerprint = buildXaaConnectDcrFingerprint(base);
    postMock.mockResolvedValue({
      success: true,
      state: {
        ...emptyState,
        clientId: "stored-client",
        tokenEndpointAuthMethod: "client_secret_post",
        issuer: base.issuer,
        fingerprint,
        status: "registered",
        clientSecretExpiresAt: Date.now() + 120_000,
      },
      clientSecret: "stored-secret",
    });

    await expect(ensureXaaDcrRegistration(base)).resolves.toEqual({
      clientId: "stored-client",
      clientSecret: "stored-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(proxyMock).not.toHaveBeenCalled();
    expect(validateMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a stored registration before validating its registration endpoint", async () => {
    const fingerprint = buildXaaConnectDcrFingerprint(base);
    postMock.mockResolvedValue({
      success: true,
      state: {
        ...emptyState,
        clientId: "stored-client",
        tokenEndpointAuthMethod: "client_secret_post",
        issuer: `${base.issuer}/`,
        fingerprint,
        status: "registered",
        clientSecretExpiresAt: Date.now() + 120_000,
      },
      clientSecret: "stored-secret",
    });
    validateMock.mockRejectedValue(new Error("registration host unavailable"));

    await expect(ensureXaaDcrRegistration(base)).resolves.toMatchObject({
      clientId: "stored-client",
      clientSecret: "stored-secret",
    });
    expect(validateMock).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
  });

  it("refuses to reuse a client registered for a different issuer", async () => {
    const fingerprint = buildXaaConnectDcrFingerprint(base);
    postMock.mockResolvedValue({
      success: true,
      state: {
        ...emptyState,
        clientId: "stored-client",
        tokenEndpointAuthMethod: "client_secret_post",
        issuer: "https://previous-issuer.example",
        fingerprint,
        status: "registered",
        clientSecretExpiresAt: Date.now() + 120_000,
      },
      clientSecret: "stored-secret",
    });

    await expect(ensureXaaDcrRegistration(base)).rejects.toThrow(
      /different authorization server issuer/i
    );
    expect(validateMock).not.toHaveBeenCalled();
    expect(proxyMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it("registers once, validates metadata, and stores normalized credentials", async () => {
    proxyMock.mockResolvedValue(proxyResponse(201, validRegistrationBody()));

    await expect(ensureXaaDcrRegistration(base)).resolves.toEqual({
      clientId: "dcr-client",
      clientSecret: "dcr-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(proxyMock).toHaveBeenCalledTimes(1);
    expect(proxyMock.mock.calls[0]?.[0]).toMatchObject({
      redirect: "manual",
      timeoutMs: 15_000,
      httpsOnly: true,
    });
    const actions = postMock.mock.calls.map((call) => call[0].body.action);
    expect(actions).toEqual(["get", "claim", "markStarted", "store"]);
    const store = postMock.mock.calls.at(-1)?.[0].body;
    expect(store).toMatchObject({
      clientId: "dcr-client",
      clientSecret: "dcr-secret",
      tokenEndpointAuthMethod: "client_secret_post",
      issuer: base.issuer,
    });
  });

  it("performs one registration POST across reconnect and 401-style re-mint", async () => {
    let persistedState: Record<string, unknown> = emptyState;
    let persistedSecret: string | null = null;
    postMock.mockImplementation(
      async (args: { body: Record<string, unknown> }) => {
        if (args.body.action === "get") {
          return {
            success: true,
            state: persistedState,
            clientSecret: persistedSecret,
          };
        }
        if (args.body.action === "claim") {
          return { success: true, acquired: true, reason: "acquired" };
        }
        if (args.body.action === "markStarted") {
          return { success: true, started: true };
        }
        if (args.body.action === "store") {
          persistedSecret = String(args.body.clientSecret);
          persistedState = {
            ...emptyState,
            clientId: String(args.body.clientId),
            tokenEndpointAuthMethod: "client_secret_post",
            issuer: String(args.body.issuer),
            fingerprint: String(args.body.fingerprint),
            registeredAt: Date.now(),
            status: "registered",
          };
          return { success: true, stored: true };
        }
        throw new Error(`unexpected action ${String(args.body.action)}`);
      }
    );
    proxyMock.mockResolvedValue(proxyResponse(201, validRegistrationBody()));

    await ensureXaaDcrRegistration(base);
    await ensureXaaDcrRegistration(base);
    expect(proxyMock).toHaveBeenCalledTimes(1);
  });

  it("supports a public client and stores no client secret", async () => {
    proxyMock.mockResolvedValue(
      proxyResponse(
        201,
        validRegistrationBody({
          client_secret: undefined,
          token_endpoint_auth_method: "none",
        })
      )
    );
    await expect(ensureXaaDcrRegistration(base)).resolves.toEqual({
      clientId: "dcr-client",
      tokenEndpointAuthMethod: "none",
    });
    const store = postMock.mock.calls.at(-1)?.[0].body;
    expect(store).not.toHaveProperty("clientSecret");
  });

  it("infers the auth method when the registration response omits it", async () => {
    proxyMock.mockResolvedValue(
      proxyResponse(
        201,
        validRegistrationBody({ token_endpoint_auth_method: undefined })
      )
    );
    await expect(ensureXaaDcrRegistration(base)).resolves.toMatchObject({
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringMatching(/omitted client auth method/i),
      expect.objectContaining({ inferredMethod: "client_secret_post" })
    );
  });

  it("releases only an allowlisted RFC 7591 4xx rejection", async () => {
    proxyMock.mockResolvedValue(
      proxyResponse(400, {
        error: "invalid_client_metadata",
        error_description: "metadata rejected",
      })
    );
    await expect(ensureXaaDcrRegistration(base)).rejects.toThrow(
      /invalid_client_metadata/
    );
    const actions = postMock.mock.calls.map((call) => call[0].body.action);
    expect(actions).toContain("release");
    expect(actions).not.toContain("markUncertain");
  });

  it.each([
    [429, "HTTP 429", { error: "slow_down" }],
    [500, "HTTP 500", { error: "server_error" }],
    [200, "invalid 2xx", "not-json"],
    [201, "missing client id", validRegistrationBody({ client_id: undefined })],
    [
      201,
      "unsupported auth method",
      validRegistrationBody({ token_endpoint_auth_method: "private_key_jwt" }),
    ],
    [
      201,
      "contradicted profile",
      validRegistrationBody({
        authorization_grant_profiles_supported: ["another-profile"],
      }),
    ],
    [
      201,
      "contradicted JWT Bearer grant",
      validRegistrationBody({
        grant_types: ["urn:ietf:params:oauth:grant-type:token-exchange"],
      }),
    ],
    [
      201,
      "secret with public method",
      validRegistrationBody({ token_endpoint_auth_method: "none" }),
    ],
    [
      201,
      "secret method without secret",
      validRegistrationBody({
        client_secret: undefined,
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ],
    [
      201,
      "expired secret",
      validRegistrationBody({
        client_secret_expires_at: Math.floor(Date.now() / 1000) - 10,
      }),
    ],
  ])("marks %s ambiguous — %s", async (status, _description, body) => {
    proxyMock.mockResolvedValue(proxyResponse(status as number, body));
    await expect(ensureXaaDcrRegistration(base)).rejects.toThrow();
    const actions = postMock.mock.calls.map((call) => call[0].body.action);
    expect(actions).toContain("markUncertain");
    expect(actions).not.toContain("release");
  });

  it("marks transport failures and store failures uncertain", async () => {
    proxyMock.mockRejectedValueOnce(new Error("socket closed"));
    await expect(ensureXaaDcrRegistration(base)).rejects.toThrow(/uncertain/i);
    expect(postMock.mock.calls.map((call) => call[0].body.action)).toContain(
      "markUncertain"
    );

    postMock.mockReset();
    installFreshBackend();
    proxyMock.mockResolvedValue(proxyResponse(201, validRegistrationBody()));
    postMock.mockImplementation(
      async (args: { body: Record<string, unknown> }) => {
        if (args.body.action === "store") throw new Error("vault unavailable");
        if (args.body.action === "get")
          return { success: true, state: emptyState, clientSecret: null };
        if (args.body.action === "claim")
          return { success: true, acquired: true, reason: "acquired" };
        if (args.body.action === "markStarted")
          return { success: true, started: true };
        if (args.body.action === "markUncertain")
          return { success: true, marked: true };
        throw new Error("unexpected action");
      }
    );
    await expect(ensureXaaDcrRegistration(base)).rejects.toThrow(
      /vault unavailable/
    );
    expect(postMock.mock.calls.map((call) => call[0].body.action)).toContain(
      "markUncertain"
    );
  });
});
