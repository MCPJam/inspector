import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "../app-types";

const {
  clearOAuthDataMock,
  initiateOAuthMock,
  readStoredOAuthConfigMock,
  resolveStoredIssuerMock,
} = vi.hoisted(() => ({
  clearOAuthDataMock: vi.fn(),
  initiateOAuthMock: vi.fn(),
  readStoredOAuthConfigMock: vi.fn(),
  resolveStoredIssuerMock: vi.fn(),
}));

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  clearOAuthData: clearOAuthDataMock,
  hasOAuthConfig: vi.fn(),
  initiateOAuth: initiateOAuthMock,
  readStoredOAuthConfig: readStoredOAuthConfigMock,
  resolveStoredIssuer: resolveStoredIssuerMock,
}));

import {
  ensureAuthorizedForReconnect,
  resolveInsufficientScopeStepUp,
  resetInsufficientScopeStepUp,
  applyToolCallStepUp,
  resetToolCallStepUp,
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
    // The bounded counter now lives in sessionStorage — clear it too so
    // counter state never leaks between tests.
    sessionStorage.clear();
    readStoredOAuthConfigMock.mockReturnValue({});
    resolveStoredIssuerMock.mockReturnValue(ISSUER);
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

  it("includes the ORIGINAL OAuth scopes on the first step-up (nothing persisted yet)", () => {
    // No prior step-up → nothing persisted. Without originalScopes the union
    // would collapse to just the challenged scope and DROP the grant's scopes.
    const decision = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      originalScopes: ["read", "write"],
      authMode: "interactive",
      maxRetries: 1,
    });
    expect(decision.action).toBe("reauthorize");
    // original ∪ challenged, original first, de-duplicated.
    expect(decision.scopes).toEqual(["read", "write", "admin"]);
  });

  it("unions original ∪ persisted ∪ challenged without duplicating overlap", () => {
    persistRequestedScopes("asana", ISSUER, ["read", "extra"]);
    const decision = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin", "read"],
      originalScopes: ["read", "write"],
      authMode: "interactive",
      maxRetries: 1,
    });
    expect(decision.scopes).toEqual(["read", "write", "extra", "admin"]);
  });

  it("bounds the counter PER SESSION (sessionStorage, not localStorage)", () => {
    resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive",
      maxRetries: 1,
    });
    // The counter is written to sessionStorage (survives a redirect within the
    // session) and NOT localStorage (would block a fresh browser session).
    expect(sessionStorage.getItem("mcp-stepup-attempts-asana")).toContain(
      ISSUER,
    );
    expect(localStorage.getItem("mcp-stepup-attempts-asana")).toBeNull();
  });

  it("applyToolCallStepUp drives the resolver and the union-scope re-authorization", async () => {
    // Original grant scopes come from the stored OAuth config.
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read", "write"] });
    initiateOAuthMock.mockResolvedValue({ success: true });

    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
    });

    expect(outcome.action).toBe("reauthorize");
    expect(outcome.scopes).toEqual(["read", "write", "admin"]);
    expect(outcome.reauthorization).toEqual({ kind: "redirect" });
    // The fresh flow requests the widened union.
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["read", "write", "admin"] }),
    );
  });

  it("applyToolCallStepUp consumes the attempt when the reauth actually redirects", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    initiateOAuthMock.mockResolvedValue({ success: true }); // → { kind: "redirect" }

    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
    });
    expect(outcome.reauthorization).toEqual({ kind: "redirect" });

    // A genuine re-authorization was initiated, so the attempt is consumed: a
    // second challenge in the same session is now bounded to `throw`.
    const retry = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive",
      maxRetries: 1,
    });
    expect(retry.action).toBe("throw");
  });

  it("applyToolCallStepUp KEEPS the attempt on a no-op `ready` (prevents an infinite step-up loop)", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    // initiateOAuth resolves WITHOUT navigating: an already-authorized server
    // returns a serverConfig immediately → ensureAuthorizedForReconnect `ready`.
    // This is NOT a genuine widened-scope grant (that needs the redirect
    // round-trip), so the consumed attempt MUST stick — otherwise a server
    // stuck returning `insufficient_scope` would loop forever as each retry
    // rolled the budget back to zero.
    initiateOAuthMock.mockResolvedValue({
      success: true,
      serverConfig: { type: "http", url: "https://mcp.asana.com/sse" },
    });

    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
    });
    expect(outcome.action).toBe("reauthorize");
    expect(outcome.reauthorization?.kind).toBe("ready");

    // The attempt was consumed (NOT reset): a second challenge in the same
    // session is now bounded to `throw` rather than re-authorizing forever.
    const retry = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive",
      maxRetries: 1,
    });
    expect(retry.action).toBe("throw");
  });

  it("applyToolCallStepUp does NOT consume the attempt on a transient reauth/init failure", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    // ensureAuthorizedForReconnect clears stored OAuth data then the OAuth init
    // fails transiently → an `error` outcome that never navigated away.
    initiateOAuthMock.mockResolvedValue({ success: false, error: "init boom" });

    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
    });
    expect(outcome.action).toBe("reauthorize");
    expect(outcome.reauthorization?.kind).toBe("error");

    // The counter was rolled back: a retry in the SAME session still
    // re-authorizes rather than being blocked by a wasted attempt.
    const retry = resolveInsufficientScopeStepUp({
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive",
      maxRetries: 1,
    });
    expect(retry.action).toBe("reauthorize");
  });

  it("applyToolCallStepUp with m2m throws and never opens a browser", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    const outcome = await applyToolCallStepUp(
      createServer(),
      { requiredScope: "admin" },
      { authMode: "m2m" },
    );
    expect(outcome.action).toBe("throw");
    expect(outcome.reauthorization).toBeUndefined();
    expect(initiateOAuthMock).not.toHaveBeenCalled();
  });

  it("resetToolCallStepUp clears the counter after a successful call", () => {
    const input = {
      serverName: "asana",
      issuer: ISSUER,
      challengedScopes: ["admin"],
      authMode: "interactive" as const,
      maxRetries: 1,
    };
    resolveInsufficientScopeStepUp(input); // counter → 1
    expect(resolveInsufficientScopeStepUp(input).action).toBe("throw");

    resetToolCallStepUp(createServer());

    expect(resolveInsufficientScopeStepUp(input).action).toBe("reauthorize");
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

  it("applyToolCallStepUp forwards a SAME-ORIGIN resourceMetadataUrl into the fresh OAuth flow", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    initiateOAuthMock.mockResolvedValue({ success: true });

    // Same origin as the server URL (https://mcp.asana.com/sse) — RFC 9728.
    const resourceMetadataUrl =
      "https://mcp.asana.com/.well-known/oauth-protected-resource/tenant-a/sse";

    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
      resourceMetadataUrl,
    });

    expect(outcome.action).toBe("reauthorize");
    // The challenge's metadata URL is threaded down to PRM discovery.
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceMetadataUrl }),
    );
  });

  it("applyToolCallStepUp THREADS a valid cross-origin https resourceMetadataUrl (RFC 9728 allows a separate metadata origin)", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    initiateOAuthMock.mockResolvedValue({ success: true });

    // A legitimate deployment can advertise PRM on a dedicated metadata origin,
    // DIFFERENT from the server URL. It must be threaded — the SDK's outbound
    // guard + cross-origin header stripping enforce fetch safety downstream.
    const resourceMetadataUrl =
      "https://metadata.asana.com/.well-known/oauth-protected-resource/sse";

    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
      resourceMetadataUrl,
    });

    expect(outcome.action).toBe("reauthorize");
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceMetadataUrl }),
    );
  });

  it("applyToolCallStepUp DROPS a non-https resourceMetadataUrl (falls back to derived discovery)", async () => {
    readStoredOAuthConfigMock.mockReturnValue({ scopes: ["read"] });
    initiateOAuthMock.mockResolvedValue({ success: true });

    // RFC 9728 mandates https; a non-https (or malformed/relative) hint is not
    // threaded — discovery derives the URL itself.
    const outcome = await applyToolCallStepUp(createServer(), {
      requiredScope: "admin",
      resourceMetadataUrl:
        "http://evil.example/.well-known/oauth-protected-resource",
    });

    expect(outcome.action).toBe("reauthorize");
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceMetadataUrl: undefined }),
    );
  });

  it("applyToolCallStepUp threads a resourceMetadataUrl-only challenge (no requiredScope) once the gate broadens", async () => {
    // The server previously requested read+write; a metadata-only challenge
    // still re-authorizes with those scopes and carries the metadata URL down.
    persistRequestedScopes("asana", ISSUER, ["read", "write"]);
    initiateOAuthMock.mockResolvedValue({ success: true });

    const resourceMetadataUrl =
      "https://mcp.asana.com/.well-known/oauth-protected-resource/tenant-b/sse";

    const outcome = await applyToolCallStepUp(createServer(), {
      resourceMetadataUrl,
    });

    expect(outcome.action).toBe("reauthorize");
    expect(initiateOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["read", "write"],
        resourceMetadataUrl,
      }),
    );
  });
});
