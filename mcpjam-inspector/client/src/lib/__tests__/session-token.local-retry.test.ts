/**
 * authFetch Local 401 Retry Tests
 *
 * In local (non-hosted) mode the backend regenerates its session token on every
 * restart. If it restarted since page load the browser holds a stale token and
 * every /api/* call 401s ("Backend debug proxy error: 401 Unauthorized") until
 * a manual refresh. authFetch should re-fetch the token and retry once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
  forceRefreshGuestSession: vi.fn(),
}));

vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: vi.fn(),
  resetTokenCache: vi.fn(),
  shouldRetryApiAuth401: vi.fn().mockReturnValue(true),
}));

const PROXY_PATH = "/api/mcp/oauth/debug/proxy";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function isSessionTokenCall(input: RequestInfo | URL): boolean {
  return String(input).includes("/api/session-token");
}

describe("authFetch local 401 retry", () => {
  let sessionToken: typeof import("../session-token");

  beforeEach(async () => {
    vi.resetModules();
    delete (window as any).__MCP_SESSION_TOKEN__;
    vi.mocked(global.fetch).mockReset();
    sessionToken = await import("../session-token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes the session token and retries once after a 401", async () => {
    // The backend's current token. Starts "stale" (matches what the page
    // cached), then a simulated restart rotates it to "fresh-token". The proxy
    // only accepts requests carrying the backend's current token.
    let backendToken = "stale-token";
    vi.mocked(global.fetch).mockImplementation((input, init) => {
      if (isSessionTokenCall(input)) {
        return Promise.resolve(jsonResponse(200, { token: backendToken }));
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.[
        "X-MCP-Session-Auth"
      ];
      return Promise.resolve(
        auth === `Bearer ${backendToken}`
          ? jsonResponse(200, { ok: true })
          : jsonResponse(401, { error: "Unauthorized" }),
      );
    });

    // Page load cached the (then-current) token, then the backend restarted.
    await sessionToken.initializeSessionToken();
    backendToken = "fresh-token";

    const response = await sessionToken.authFetch(PROXY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);

    const proxyCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter(([input]) => !isSessionTokenCall(input));
    expect(proxyCalls).toHaveLength(2);

    // The retry carries the refreshed token.
    expect(proxyCalls[1][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-MCP-Session-Auth": "Bearer fresh-token",
        }),
      }),
    );
  });

  it("does not retry when the refreshed token is unchanged", async () => {
    (window as any).__MCP_SESSION_TOKEN__ = "injected-token";
    vi.mocked(global.fetch).mockResolvedValue(
      jsonResponse(401, { error: "Unauthorized" }),
    );

    const response = await sessionToken.authFetch(PROXY_PATH, {
      method: "POST",
    });

    expect(response.status).toBe(401);
    // Injected token can't change, so no retry.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the original 401 when the token refresh fails", async () => {
    vi.mocked(global.fetch).mockImplementation((input) => {
      if (isSessionTokenCall(input)) {
        return Promise.resolve(jsonResponse(500, {}));
      }
      return Promise.resolve(jsonResponse(401, { error: "Unauthorized" }));
    });

    const response = await sessionToken.authFetch(PROXY_PATH, {
      method: "POST",
    });

    expect(response.status).toBe(401);
    const proxyCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter(([input]) => !isSessionTokenCall(input));
    expect(proxyCalls).toHaveLength(1);
  });

  it("does not retry when the caller provided an Authorization header", async () => {
    let sessionTokenValue = "stale-token";
    vi.mocked(global.fetch).mockImplementation((input) => {
      if (isSessionTokenCall(input)) {
        return Promise.resolve(jsonResponse(200, { token: sessionTokenValue }));
      }
      return Promise.resolve(jsonResponse(401, { error: "Unauthorized" }));
    });

    await sessionToken.initializeSessionToken();
    sessionTokenValue = "fresh-token";

    const response = await sessionToken.authFetch(PROXY_PATH, {
      method: "POST",
      headers: { Authorization: "Bearer caller-token" },
    });

    expect(response.status).toBe(401);
    const proxyCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter(([input]) => !isSessionTokenCall(input));
    expect(proxyCalls).toHaveLength(1);
  });

  it("does not retry when the 401 is flagged X-MCP-Auth-Required: oauth", async () => {
    let sessionTokenValue = "stale-token";
    vi.mocked(global.fetch).mockImplementation((input) => {
      if (isSessionTokenCall(input)) {
        return Promise.resolve(jsonResponse(200, { token: sessionTokenValue }));
      }
      return Promise.resolve({
        status: 401,
        ok: false,
        headers: new Headers({ "X-MCP-Auth-Required": "oauth" }),
        json: () => Promise.resolve({ error: "Unauthorized" }),
      } as unknown as Response);
    });

    await sessionToken.initializeSessionToken();
    sessionTokenValue = "fresh-token";

    const response = await sessionToken.authFetch(PROXY_PATH, {
      method: "POST",
    });

    expect(response.status).toBe(401);
    const proxyCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter(([input]) => !isSessionTokenCall(input));
    expect(proxyCalls).toHaveLength(1);
  });
});
