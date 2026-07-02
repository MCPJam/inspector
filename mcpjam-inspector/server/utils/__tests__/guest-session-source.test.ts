import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};
const mockProvisionGuestAuthConfigToConvex = vi.fn();
const mockIsConvexProvisioningUnavailable = vi.fn();
const mockGetGuestSessionSharedSecret = vi.fn();

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

vi.mock("../convex-guest-auth-sync.js", () => ({
  provisionGuestAuthConfigToConvex: mockProvisionGuestAuthConfigToConvex,
  isConvexProvisioningUnavailable: mockIsConvexProvisioningUnavailable,
}));

vi.mock("../guest-session-secret.js", () => ({
  GUEST_SESSION_SECRET_HEADER: "x-mcpjam-guest-session-secret",
  getGuestSessionSharedSecret: mockGetGuestSessionSharedSecret,
}));

describe("guest-session-source", () => {
  const originalFetch = global.fetch;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalRemoteUrl = process.env.MCPJAM_GUEST_SESSION_URL;
  const originalRemoteJwksUrl = process.env.MCPJAM_GUEST_JWKS_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    delete process.env.MCPJAM_GUEST_SESSION_URL;
    delete process.env.MCPJAM_GUEST_JWKS_URL;
    mockProvisionGuestAuthConfigToConvex.mockResolvedValue(undefined);
    mockIsConvexProvisioningUnavailable.mockReturnValue(false);
    mockGetGuestSessionSharedSecret.mockReturnValue(
      "test-guest-session-secret"
    );
    global.fetch = vi.fn();
  });

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }
    if (originalRemoteUrl === undefined) {
      delete process.env.MCPJAM_GUEST_SESSION_URL;
    } else {
      process.env.MCPJAM_GUEST_SESSION_URL = originalRemoteUrl;
    }
    if (originalRemoteJwksUrl === undefined) {
      delete process.env.MCPJAM_GUEST_JWKS_URL;
    } else {
      process.env.MCPJAM_GUEST_JWKS_URL = originalRemoteJwksUrl;
    }
    global.fetch = originalFetch;
  });

  it("fetches hosted guest sessions and returns parsed session", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-remote",
          token: "remote-token",
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const { fetchRemoteGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchRemoteGuestSession();

    expect(result.kind).toBe("session");
    if (result.kind !== "session") return;
    expect(result.session.token).toBe("remote-token");
    expect(mockProvisionGuestAuthConfigToConvex).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.mcpjam.com/api/web/guest-session",
      expect.objectContaining({
        method: "POST",
        signal: expect.anything(),
      })
    );
  });

  it("waits for provisioning before fetching a Convex guest session", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-convex",
          token: "convex-token",
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchConvexGuestSession();

    expect(result.kind).toBe("session");
    if (result.kind !== "session") return;
    expect(result.session.token).toBe("convex-token");
    expect(mockProvisionGuestAuthConfigToConvex).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/session",
      expect.objectContaining({
        method: "POST",
        signal: expect.anything(),
      })
    );
  });

  it("falls back to the hosted mint when Convex provisioning is unavailable (OSS/local dev)", async () => {
    mockIsConvexProvisioningUnavailable.mockReturnValue(true);
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-hosted",
          token: "hosted-token",
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchConvexGuestSession();

    expect(result.kind).toBe("session");
    if (result.kind !== "session") return;
    expect(result.session.token).toBe("hosted-token");
    // Provisioning is still awaited (it's what sets the unavailable flag), but
    // the mint hits the hosted endpoint, not the deployment we can't write to.
    expect(mockProvisionGuestAuthConfigToConvex).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.mcpjam.com/api/web/guest-session",
      expect.objectContaining({ method: "POST", signal: expect.anything() })
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/session",
      expect.anything()
    );
  });

  it("returns kind:miss for upstream 204 (lookup_only)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchConvexGuestSession({
      body: { mode: "lookup_only" },
    });
    expect(result.kind).toBe("miss");
  });

  it("returns kind:miss for upstream 404 in lookup_only mode", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 404 })
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchConvexGuestSession({
      body: { mode: "lookup_only" },
    });
    expect(result.kind).toBe("miss");
  });

  it("returns kind:error for upstream 404 in lookup_or_create mode (not silent miss)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 404 })
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchConvexGuestSession({
      body: { mode: "lookup_or_create" },
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(404);
  });

  it("captures upstream Set-Cookie headers and forwards them in the result", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "__Host-mcpjam_guest_session=opaque; Path=/",
          },
        }
      )
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    const result = await fetchConvexGuestSession();
    expect(result.setCookies.length).toBeGreaterThan(0);
    expect(result.setCookies[0]).toContain(
      "__Host-mcpjam_guest_session=opaque"
    );
  });

  it("forwards browser cookie/UA and omits spoofable IP headers upstream", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    await fetchConvexGuestSession({
      cookie: "__Host-mcpjam_guest_session=raw",
      userAgent: "UA/1.0",
      body: { mode: "lookup_or_create", legacyToken: "legacy" },
    });

    const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Cookie"]).toBe("__Host-mcpjam_guest_session=raw");
    expect(headers["User-Agent"]).toBe("UA/1.0");
    expect(headers["X-Forwarded-For"]).toBeUndefined();
    expect(headers["X-Real-IP"]).toBeUndefined();
    expect(init.body).toBe(
      JSON.stringify({ mode: "lookup_or_create", legacyToken: "legacy" })
    );
  });

  it("forwards x-mcpjam-guest-ip-hash to Convex when ipHash is provided", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    await fetchConvexGuestSession({
      cookie: null,
      userAgent: null,
      ipHash: "abc-hash",
    });

    const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-mcpjam-guest-ip-hash"]).toBe("abc-hash");
  });

  it("omits x-mcpjam-guest-ip-hash when ipHash is null", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    await fetchConvexGuestSession({
      cookie: null,
      userAgent: null,
      ipHash: null,
    });

    const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();
  });

  it("uses the default 10_000ms fetch timeout when timeoutMs is omitted", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    await fetchConvexGuestSession();
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    timeoutSpy.mockRestore();
  });

  it("honors a shortened timeoutMs on the Convex fetch (defense-in-depth)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { fetchConvexGuestSession } = await import(
      "../guest-session-source.js"
    );
    await fetchConvexGuestSession(undefined, 1500);
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    timeoutSpy.mockRestore();
  });

  it("honors a shortened timeoutMs on the remote fetch", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const { fetchRemoteGuestSession } = await import(
      "../guest-session-source.js"
    );
    await fetchRemoteGuestSession(undefined, 1500);
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    timeoutSpy.mockRestore();
  });

  it("waits for provisioning before fetching Convex JWKS", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { fetchRemoteGuestJwks } = await import("../guest-session-source.js");
    const response = await fetchRemoteGuestJwks();

    expect(response?.status).toBe(200);
    expect(mockProvisionGuestAuthConfigToConvex).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/jwks",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
        signal: expect.anything(),
      })
    );
  });
});
