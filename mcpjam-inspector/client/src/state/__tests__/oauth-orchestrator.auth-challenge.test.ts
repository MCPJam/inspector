import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthChallengeSignal } from "@mcpjam/sdk/browser";
import type { ServerWithName } from "../app-types";

const {
  clearOAuthDataMock,
  clearOAuthFlowStateMock,
  initiateOAuthMock,
  readStoredOAuthConfigMock,
  resolveStoredIssuerMock,
} = vi.hoisted(() => ({
  clearOAuthDataMock: vi.fn(),
  clearOAuthFlowStateMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  resolveStoredIssuerMock: vi.fn(),
}));

const readStoredDiscoveryScopesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  clearOAuthData: clearOAuthDataMock,
  clearOAuthFlowState: clearOAuthFlowStateMock,
  hasOAuthConfig: vi.fn(),
  initiateOAuth: initiateOAuthMock,
  readStoredDiscoveryScopes: readStoredDiscoveryScopesMock,
  readStoredOAuthConfig: readStoredOAuthConfigMock,
  resolveStoredIssuer: resolveStoredIssuerMock,
}));

import {
  applyToolCallAuthChallenge,
  gateAuthChallenge,
  hasAuthChallengeAwaitingCallback,
  markAuthChallengeSignedIn,
  resetAuthChallenge,
} from "../oauth-orchestrator";
import { persistRequestedScopes } from "@/lib/oauth/requested-scopes";
import { authorizationFlowDigest } from "@/lib/oauth/flow-digest";

const ISSUER = "https://as.example";
const PRM = "https://orders.example/.well-known/oauth-protected-resource/mcp";
const OPERATION = { method: "tools/call" as const, operation: "list_orders" };

function signal(
  overrides: Partial<AuthChallengeSignal> = {},
): AuthChallengeSignal {
  return {
    source: "http_401",
    error: "invalid_token",
    requiredScope: "orders:read",
    resourceMetadataUrl: PRM,
    effectiveAuth: "discover",
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: true,
      hasScope: true,
      hasErrorParams: false,
    },
    ...overrides,
  };
}

const createServer = (
  overrides: Partial<ServerWithName> = {},
): ServerWithName =>
  ({
    name: "orders",
    config: { type: "http", url: "https://orders.example/mcp" },
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    retryCount: 0,
    enabled: true,
    // A tokenless Auto server: the client mirror says "no OAuth".
    useOAuth: false,
    ...overrides,
  }) as ServerWithName;

function ledgerKeys(): string[] {
  return Object.keys(sessionStorage).filter((key) =>
    key.startsWith("mcp-auth-challenge-ledger-v1-"),
  );
}

describe("gateAuthChallenge (the server-stamped auth method)", () => {
  it.each(["discover", "oauth"] as const)("allows %s", (effectiveAuth) => {
    expect(gateAuthChallenge(effectiveAuth)).toEqual({ kind: "allowed" });
  });

  it.each(["none", "bearer", "xaa", undefined] as const)(
    "blocks %s with a hint",
    (effectiveAuth) => {
      const gate = gateAuthChallenge(effectiveAuth);
      expect(gate.kind).toBe("blocked");
      expect(gate.kind === "blocked" && gate.hint).toBeTruthy();
    },
  );
});

describe("applyToolCallAuthChallenge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    readStoredOAuthConfigMock.mockReturnValue({});
    resolveStoredIssuerMock.mockReturnValue(ISSUER);
    initiateOAuthMock.mockResolvedValue({ success: true });
  });

  it("presents without side effects: no ledger, no OAuth", async () => {
    const outcome = await applyToolCallAuthChallenge(createServer(), signal(), {
      operation: OPERATION,
      confirmed: false,
    });
    expect(outcome).toEqual({ kind: "pendingConnect" });
    expect(ledgerKeys()).toEqual([]);
    expect(initiateOAuthMock).not.toHaveBeenCalled();
    expect(clearOAuthDataMock).not.toHaveBeenCalled();
    expect(clearOAuthFlowStateMock).not.toHaveBeenCalled();
  });

  it.each(["none", "bearer", "xaa"] as const)(
    "never signs in under %s, even when confirmed, and spends nothing",
    async (effectiveAuth) => {
      const outcome = await applyToolCallAuthChallenge(
        createServer(),
        signal({ effectiveAuth }),
        { operation: OPERATION, confirmed: true },
      );
      expect(outcome.kind).toBe("blocked");
      expect(ledgerKeys()).toEqual([]);
      expect(initiateOAuthMock).not.toHaveBeenCalled();
    },
  );

  it("never signs in without a server stamp", async () => {
    const outcome = await applyToolCallAuthChallenge(
      createServer(),
      signal({ effectiveAuth: undefined }),
      { operation: OPERATION, confirmed: true },
    );
    expect(outcome).toMatchObject({ kind: "blocked", reason: "unknown" });
    expect(initiateOAuthMock).not.toHaveBeenCalled();
  });

  it("a confirmed click on a tokenless Auto server signs in despite the client mirror", async () => {
    const outcome = await applyToolCallAuthChallenge(createServer(), signal(), {
      operation: OPERATION,
      confirmed: true,
    });
    expect(outcome).toMatchObject({
      kind: "started",
      reauthorization: { kind: "redirect" },
      scopes: ["orders:read"],
    });
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "orders",
        scopes: ["orders:read"],
        resourceMetadataUrl: PRM,
      }),
    );
    expect(ledgerKeys()).toHaveLength(1);
  });

  it("keeps an OAuth server's tokens until the callback succeeds", async () => {
    await applyToolCallAuthChallenge(
      createServer({
        useOAuth: true,
        oauthTokens: { access_token: "a", refresh_token: "r" } as never,
      }),
      signal({ effectiveAuth: "oauth" }),
      { operation: OPERATION, confirmed: true },
    );
    expect(clearOAuthFlowStateMock).toHaveBeenCalledWith("orders");
    expect(clearOAuthDataMock).not.toHaveBeenCalled();
  });

  it("unions the challenge scope with an existing grant", async () => {
    persistRequestedScopes("orders", ISSUER, ["profile"]);
    const outcome = await applyToolCallAuthChallenge(
      createServer({
        useOAuth: true,
        oauthTokens: { access_token: "a" } as never,
      }),
      signal({ effectiveAuth: "oauth" }),
      { operation: OPERATION, confirmed: true },
    );
    expect(outcome).toMatchObject({ scopes: ["profile", "orders:read"] });
  });

  it("lets discovery choose the scopes for a scope-less challenge", async () => {
    const outcome = await applyToolCallAuthChallenge(
      createServer(),
      signal({ requiredScope: undefined }),
      { operation: OPERATION, confirmed: true },
    );
    expect(outcome).toMatchObject({ kind: "started", scopes: undefined });
    expect(initiateOAuthMock.mock.calls[0][0]).not.toHaveProperty(
      "scopes",
      expect.anything(),
    );
  });

  it("drops a non-https resource_metadata hint", async () => {
    await applyToolCallAuthChallenge(
      createServer(),
      signal({ resourceMetadataUrl: "http://orders.example/prm" }),
      { operation: OPERATION, confirmed: true },
    );
    expect(initiateOAuthMock.mock.calls[0][0].resourceMetadataUrl).toBe(
      undefined,
    );
  });

  it("a Back-button re-click retries instead of being refused", async () => {
    const server = createServer();
    await applyToolCallAuthChallenge(server, signal(), {
      operation: OPERATION,
      confirmed: true,
    });
    // The user came back without completing sign-in and clicks again.
    const again = await applyToolCallAuthChallenge(server, signal(), {
      operation: OPERATION,
      confirmed: true,
    });
    expect(again.kind).toBe("started");
    expect(initiateOAuthMock).toHaveBeenCalledTimes(2);
  });

  it("a repeat challenge after sign-in is permanent for the window", async () => {
    const server = createServer();
    await applyToolCallAuthChallenge(server, signal(), {
      operation: OPERATION,
      confirmed: true,
    });
    expect(hasAuthChallengeAwaitingCallback("orders")).toBe(true);
    expect(markAuthChallengeSignedIn("orders")).toBe(1);
    expect(hasAuthChallengeAwaitingCallback("orders")).toBe(false);

    const repeat = await applyToolCallAuthChallenge(server, signal(), {
      operation: OPERATION,
      confirmed: false,
    });
    expect(repeat).toEqual({ kind: "permanent" });

    // A later success forgets it.
    resetAuthChallenge(server, OPERATION);
    const fresh = await applyToolCallAuthChallenge(server, signal(), {
      operation: OPERATION,
      confirmed: false,
    });
    expect(fresh).toEqual({ kind: "pendingConnect" });
  });

  it("binds the attempt to a digest of its flow's state, never the state", async () => {
    initiateOAuthMock.mockImplementation(async (options) => {
      await options.onAuthorizationRedirect?.({ state: "state-1" });
      return { success: true };
    });
    const server = createServer();
    const flows: Array<{ digest: string }> = [];
    await applyToolCallAuthChallenge(server, signal(), {
      operation: OPERATION,
      confirmed: true,
      onAuthorizationFlow: (flow) => flows.push(flow),
    });
    const digest = await authorizationFlowDigest("state-1");
    expect(flows).toEqual([{ digest }]);
    // Nothing stored holds the state itself.
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("state-1");
    // A callback for another flow does not complete this attempt.
    expect(
      markAuthChallengeSignedIn(
        "orders",
        await authorizationFlowDigest("state-other"),
      ),
    ).toBe(0);
    expect(markAuthChallengeSignedIn("orders", digest)).toBe(1);
  });

  it("does not spend the click when OAuth never started", async () => {
    initiateOAuthMock.mockResolvedValue({ success: false, error: "boom" });
    const outcome = await applyToolCallAuthChallenge(createServer(), signal(), {
      operation: OPERATION,
      confirmed: true,
    });
    expect(outcome).toMatchObject({
      kind: "started",
      reauthorization: { kind: "error" },
    });
    expect(ledgerKeys()).toEqual([]);
  });
});
