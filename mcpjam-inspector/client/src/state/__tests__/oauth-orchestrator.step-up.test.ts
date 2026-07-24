import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "../app-types";

const { clearOAuthDataMock, initiateOAuthMock, readStoredOAuthConfigMock } =
  vi.hoisted(() => ({
    clearOAuthDataMock: vi.fn(),
    initiateOAuthMock: vi.fn(),
    readStoredOAuthConfigMock: vi.fn(),
  }));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  clearOAuthData: clearOAuthDataMock,
  hasOAuthConfig: vi.fn(),
  initiateOAuth: initiateOAuthMock,
  readStoredOAuthConfig: readStoredOAuthConfigMock,
}));

import {
  ensureAuthorizedForReconnect,
  resolveInsufficientScopeStepUp,
  resetInsufficientScopeStepUp,
} from "../oauth-orchestrator";
import { persistRequestedScopes } from "@/lib/oauth/requested-scopes";

const ISSUER = "https://as.example";

const createServer = (
  overrides: Partial<ServerWithName> = {},
): ServerWithName =>
  ({
    name: "asana",
    config: { type: "http", url: "https://mcp.asana.com/sse" },
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    retryCount: 0,
    enabled: true,
    useOAuth: true,
    oauthTokens: { access_token: "access-token", refresh_token: "refresh" },
    ...overrides,
  }) as ServerWithName;

describe("resolveInsufficientScopeStepUp (SEP-2350)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    readStoredOAuthConfigMock.mockReturnValue({});
  });

  it("unions previously-requested and challenged scopes on reauthorize", () => {
    // The server previously requested read+write against this issuer.
    persistRequestedScopes("asana", ISSUER, ["read", "write"]);

    const decision = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive",
      maxRetries: 1,
    });

    expect(decision.action).toBe("reauthorize");
    expect(decision.attempt).toBe(0);
    // Previous-first, de-duplicated, challenged appended.
    expect(decision.scopes).toEqual(["read", "write", "admin"]);
  });

  it("feeds the union scopes into the fresh OAuth flow via stepUpScopes", async () => {
    persistRequestedScopes("asana", ISSUER, ["read", "write"]);
    initiateOAuthMock.mockResolvedValue({ success: true });

    const decision = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive",
      maxRetries: 1,
    });

    const result = await ensureAuthorizedForReconnect(createServer(), {
      allowInteractiveOAuthFlow: true,
      stepUpScopes: decision.scopes,
    });

    expect(result).toEqual({ kind: "redirect" });
    // The re-authorization requests the WIDENED union, not the stale scopes.
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "asana",
        scopes: ["read", "write", "admin"],
      }),
    );
  });

  it("stops re-authorizing after maxRetries (bounded cross-request loop)", () => {
    const input = {
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive" as const,
      maxRetries: 1,
    };

    // Attempt 0 → reauthorize (bumps the persisted counter to 1).
    const first = resolveInsufficientScopeStepUp(input);
    expect(first.action).toBe("reauthorize");
    expect(first.attempt).toBe(0);

    // Attempt 1 → the cap is reached, so throw instead of looping forever.
    const second = resolveInsufficientScopeStepUp(input);
    expect(second.action).toBe("throw");
    expect(second.attempt).toBe(1);
    // The union is still returned for display even when throwing.
    expect(second.scopes).toEqual(["admin"]);
  });

  it("honors a maxRetries of 2 before throwing", () => {
    const input = {
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive" as const,
      maxRetries: 2,
    };
    expect(resolveInsufficientScopeStepUp(input).action).toBe("reauthorize");
    expect(resolveInsufficientScopeStepUp(input).action).toBe("reauthorize");
    expect(resolveInsufficientScopeStepUp(input).action).toBe("throw");
  });

  it("resetInsufficientScopeStepUp clears the counter so a later step-up starts fresh", () => {
    const input = {
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive" as const,
      maxRetries: 1,
    };
    resolveInsufficientScopeStepUp(input); // attempt 0 → reauthorize (counter=1)
    expect(resolveInsufficientScopeStepUp(input).action).toBe("throw");

    resetInsufficientScopeStepUp("asana", ISSUER);

    const after = resolveInsufficientScopeStepUp(input);
    expect(after.action).toBe("reauthorize");
    expect(after.attempt).toBe(0);
  });

  it("m2m mode always throws (never opens a browser)", () => {
    const decision = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "m2m",
      maxRetries: 5,
    });
    expect(decision.action).toBe("throw");
    // No re-authorization performed → counter untouched.
    expect(decision.attempt).toBe(0);
  });

  it("debugger mode returns manual (advances explicitly, no auto-browser)", () => {
    const decision = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "debugger",
      maxRetries: 5,
    });
    expect(decision.action).toBe("manual");
    expect(decision.attempt).toBe(0);
  });

  it("counts step-up attempts per issuer (an AS switch starts fresh)", () => {
    const base = {
      serverName: "asana",
      challengedScopes: ["admin"],
      authMode: "interactive" as const,
      maxRetries: 1,
    };
    resolveInsufficientScopeStepUp({ ...base, issuer: ISSUER });
    expect(
      resolveInsufficientScopeStepUp({ ...base, issuer: ISSUER }).action,
    ).toBe("throw");
    // A different issuer has its own bucket → first attempt is reauthorize.
    expect(
      resolveInsufficientScopeStepUp({ ...base, issuer: "https://other.as" })
        .action,
    ).toBe("reauthorize");
  });
});
