import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import type { RequestLogContext } from "../../../utils/log-events.js";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Spy on the mint so the test can prove the identity error blocks the mint
// BEFORE it starts (no ID-JAG issuance, no token-endpoint exchange).
const { mintXaaAccessTokenMock } = vi.hoisted(() => ({
  mintXaaAccessTokenMock: vi.fn(),
}));
vi.mock("../../../services/xaa-mint.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/xaa-mint.js")>();
  return {
    ...actual,
    mintXaaAccessToken: mintXaaAccessTokenMock,
  };
});

import { createAuthorizedManager, callerContextFromHono } from "../auth.js";

const baseContext: RequestLogContext = {
  event: "http.request.completed",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "http",
  requestId: "req-xaa-identity-error",
  route: "/api/web/test",
  method: "POST",
  authType: "unknown",
};

function makeContext(): Context {
  const vars: Record<string, unknown> = {
    requestLogContext: { ...baseContext },
  };
  return {
    var: new Proxy(vars, { get: (t, p) => t[p as string] }),
    get: (key: string) => vars[key],
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
  } as unknown as Context;
}

describe("createAuthorizedManager — backend-resolved XAA identity error", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    mintXaaAccessTokenMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fails the connect with the backend's message and never mints", async () => {
    const identityError =
      "Complete or clear the server identity override: this server has a partial legacy override";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            "srv-xaa": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://xaa.example.com/mcp",
                useOAuth: false,
                useXaa: true,
                authServerMode: "mcpjam",
                // Backend omitted BOTH identity members and sent the
                // actionable error instead (legacy partial override).
                xaaIdentityError: identityError,
              },
            },
          },
        }),
      } as unknown as Response),
    );

    await expect(
      createAuthorizedManager(
        callerContextFromHono(makeContext()),
        "bearer-token",
        "ws-1",
        ["srv-xaa"],
        30_000,
        undefined,
        undefined,
        { xaaIssuer: "https://app.mcpjam.com/api/web" },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: identityError,
    });

    // The configuration error surfaces as a distinct failure BEFORE any mint
    // work — no silent fallback to the demo identity, no silent XAA→OAuth
    // fallback.
    expect(mintXaaAccessTokenMock).not.toHaveBeenCalled();
  });

  it("surfaces the actionable 400 even when the caller omits xaaIssuer (eval routes)", async () => {
    const identityError =
      "Complete or clear the server identity override: this server has a partial legacy override";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            "srv-xaa": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://xaa.example.com/mcp",
                useOAuth: false,
                useXaa: true,
                authServerMode: "mcpjam",
                xaaIdentityError: identityError,
              },
            },
          },
        }),
      } as unknown as Response),
    );

    // No options.xaaIssuer (eval/registration surfaces don't thread it). The
    // identity check must run BEFORE the issuer guard, so this stays a 400
    // configuration error rather than the caller-contract "Missing XAA issuer"
    // 500 that would otherwise mask it.
    await expect(
      createAuthorizedManager(
        callerContextFromHono(makeContext()),
        "bearer-token",
        "ws-1",
        ["srv-xaa"],
        30_000,
        undefined,
        undefined,
        {},
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: identityError,
    });

    expect(mintXaaAccessTokenMock).not.toHaveBeenCalled();
  });
});

describe("createAuthorizedManager — batch-wide validation before any mint", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    mintXaaAccessTokenMock.mockReset();
    mintXaaAccessTokenMock.mockResolvedValue({ accessToken: "minted-token" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function batchOf(results: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ results }),
      } as unknown as Response),
    );
  }

  const okBase = {
    ok: true,
    role: "member",
    accessLevel: "project_member",
    permissions: { chatOnly: false },
  };

  // The mint pass runs concurrently (Promise.all), so a per-server check
  // inside it fails only its own server — a sibling's XAA mint (a REAL token
  // issued at the resource AS) would already be in flight. Validation is
  // hoisted to a batch-wide pass so no server mints when any server in the
  // batch is misconfigured.
  it("does not mint the CONFIGURED sibling when another server fails the policy preflight", async () => {
    batchOf({
      // Configured XAA server — would mint if the batch weren't validated first.
      "srv-configured": {
        ...okBase,
        serverConfig: {
          transportType: "http",
          url: "https://configured.example.com/mcp",
          authMethod: "auto",
          authServerMode: "mcpjam",
          clientId: "client-1",
        },
      },
      // Unconfigured `auto` server — 409s under the host policy.
      "srv-unconfigured": {
        ...okBase,
        serverConfig: {
          transportType: "http",
          url: "https://unconfigured.example.com/mcp",
          authMethod: "auto",
        },
      },
    });

    await expect(
      createAuthorizedManager(
        callerContextFromHono(makeContext()),
        "bearer-token",
        "ws-1",
        ["srv-configured", "srv-unconfigured"],
        30_000,
        undefined,
        undefined,
        {
          xaaIssuer: "https://app.mcpjam.com/api/web",
          xaaPolicy: { idp: "mcpjam" },
        },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "XAA_CONNECTION_NOT_CONFIGURED",
      details: { serverId: "srv-unconfigured" },
    });

    // The whole point: no side effects anywhere in the batch.
    expect(mintXaaAccessTokenMock).not.toHaveBeenCalled();
  });

  it("does not mint the CONFIGURED sibling when another server has an identity error", async () => {
    batchOf({
      "srv-configured": {
        ...okBase,
        serverConfig: {
          transportType: "http",
          url: "https://configured.example.com/mcp",
          authMethod: "auto",
          authServerMode: "mcpjam",
          clientId: "client-1",
        },
      },
      "srv-identity-broken": {
        ...okBase,
        serverConfig: {
          transportType: "http",
          url: "https://broken.example.com/mcp",
          useXaa: true,
          authServerMode: "mcpjam",
          xaaIdentityError: "Complete or clear the server identity override",
        },
      },
    });

    await expect(
      createAuthorizedManager(
        callerContextFromHono(makeContext()),
        "bearer-token",
        "ws-1",
        ["srv-configured", "srv-identity-broken"],
        30_000,
        undefined,
        undefined,
        { xaaIssuer: "https://app.mcpjam.com/api/web" },
      ),
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });

    expect(mintXaaAccessTokenMock).not.toHaveBeenCalled();
  });

  it("still mints when the whole batch is valid", async () => {
    batchOf({
      "srv-configured": {
        ...okBase,
        serverConfig: {
          transportType: "http",
          url: "https://configured.example.com/mcp",
          authMethod: "auto",
          authServerMode: "mcpjam",
          clientId: "client-1",
        },
      },
    });

    await createAuthorizedManager(
      callerContextFromHono(makeContext()),
      "bearer-token",
      "ws-1",
      ["srv-configured"],
      30_000,
      undefined,
      undefined,
      {
        xaaIssuer: "https://app.mcpjam.com/api/web",
        xaaPolicy: { idp: "mcpjam" },
      },
    );

    expect(mintXaaAccessTokenMock).toHaveBeenCalledTimes(1);
  });
});
