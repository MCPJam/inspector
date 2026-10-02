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
      "test-guest-session-secret",
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
        },
      ),
    );

    const { fetchRemoteGuestSession } =
      await import("../guest-session-source.js");
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
      }),
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
        },
      ),
    );

    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
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
      }),
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
        },
      ),
    );

    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    const result = await fetchConvexGuestSession();

    expect(result.kind).toBe("session");
    if (result.kind !== "session") return;
    expect(result.session.token).toBe("hosted-token");
    // Provisioning is still awaited (it's what sets the unavailable flag), but
    // the mint hits the hosted endpoint, not the deployment we can't write to.
    expect(mockProvisionGuestAuthConfigToConvex).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.mcpjam.com/api/web/guest-session",
      expect.objectContaining({ method: "POST", signal: expect.anything() }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/session",
      expect.anything(),
    );
  });

  it("returns kind:miss for upstream 204 (lookup_only)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    const result = await fetchConvexGuestSession({
      body: { mode: "lookup_only" },
    });
    expect(result.kind).toBe("miss");
  });

  it("returns kind:miss for upstream 404 in lookup_only mode", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    const result = await fetchConvexGuestSession({
      body: { mode: "lookup_only" },
    });
    expect(result.kind).toBe("miss");
  });

  it("returns kind:error for upstream 404 in lookup_or_create mode (not silent miss)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    const result = await fetchConvexGuestSession({
      body: { mode: "lookup_or_create" },
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(404);
  });

  it("carries the upstream Retry-After on a 429 refusal", async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "capped" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": "120" },
      }),
    );
    const { fetchRemoteGuestSession } =
      await import("../guest-session-source.js");
    const result = await fetchRemoteGuestSession(undefined);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" ? result.status : 0).toBe(429);
    expect(result.kind === "error" ? result.retryAfterSeconds : 0).toBe(120);
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
        },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    const result = await fetchConvexGuestSession();
    expect(result.setCookies.length).toBeGreaterThan(0);
    expect(result.setCookies[0]).toContain(
      "__Host-mcpjam_guest_session=opaque",
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
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
      JSON.stringify({ mode: "lookup_or_create", legacyToken: "legacy" }),
    );
  });

  it("forwards x-mcpjam-guest-ip-hash to Convex when ipHash is provided", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    await fetchConvexGuestSession({
      cookie: null,
      userAgent: null,
      ipHash: "abc-hash",
    });

    const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-mcpjam-guest-ip-hash"]).toBe("abc-hash");
    vi.unstubAllEnvs();
  });

  it("sends the service token with the IP hash so Convex trusts it", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
    await fetchConvexGuestSession({
      cookie: null,
      userAgent: null,
      ipHash: "abc-hash",
    });

    const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-mcpjam-guest-ip-hash"]).toBe("abc-hash");
    expect(headers["x-inspector-service-token"]).toBe("inspector-secret");
    vi.unstubAllEnvs();
  });

  it("omits x-mcpjam-guest-ip-hash when ipHash is null", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "g",
          token: "t",
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchConvexGuestSession } =
      await import("../guest-session-source.js");
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
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { fetchRemoteGuestSession } =
      await import("../guest-session-source.js");
    await fetchRemoteGuestSession(undefined, 1500);
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    timeoutSpy.mockRestore();
  });

  it("waits for provisioning before fetching Convex JWKS", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
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
      }),
    );
  });

  // A self-hosted install makes its 503 locally, so the reason on the result is
  // the only way the browser's error report can say why the relay failed.
  describe("failure reasons", () => {
    async function fetchRemote() {
      const { fetchRemoteGuestSession } =
        await import("../guest-session-source.js");
      const result = await fetchRemoteGuestSession(undefined);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("expected an error result");
      return result;
    }

    it("names an upstream non-ok status", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response("bad gateway", { status: 502 }),
      );
      const result = await fetchRemote();
      expect(result.status).toBe(502);
      expect(result.reason).toBe("upstream_status");
      expect(result.upstreamStatus).toBe(502);
    });

    it("names a 200 whose body is not JSON", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response("<html>captive portal</html>", { status: 200 }),
      );
      const result = await fetchRemote();
      expect(result.status).toBe(503);
      expect(result.reason).toBe("bad_json");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[guest-auth] Failed to read MCPJam guest session response",
        { reason: "bad_json" },
      );
    });

    it("names a 200 JSON body without a token", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ guestId: "g" }), { status: 200 }),
      );
      const result = await fetchRemote();
      expect(result.status).toBe(503);
      expect(result.reason).toBe("bad_payload");
    });

    it("names a network failure and its code", async () => {
      vi.mocked(global.fetch).mockRejectedValue(
        new TypeError("fetch failed", {
          cause: Object.assign(
            new Error("getaddrinfo ENOTFOUND app.mcpjam.com"),
            { code: "ENOTFOUND" },
          ),
        }),
      );
      const result = await fetchRemote();
      expect(result.status).toBe(503);
      expect(result.reason).toBe("network");
      expect(result.networkCode).toBe("ENOTFOUND");
    });

    it("names our timeout", async () => {
      vi.mocked(global.fetch).mockRejectedValue(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
      const result = await fetchRemote();
      expect(result.reason).toBe("timeout");
      expect(result.networkCode).toBeUndefined();
    });

    it("names a timeout that fires while reading the body", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          Promise.reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError",
            ),
          ),
      } as unknown as Response);
      const result = await fetchRemote();
      expect(result.reason).toBe("timeout");
    });

    it("names a timeout from the aborted signal when the error does not say so", async () => {
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(
          AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
        );
      try {
        vi.mocked(global.fetch).mockRejectedValue(new TypeError("terminated"));
        const result = await fetchRemote();
        expect(result.reason).toBe("timeout");
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it("names a provisioning failure without fetching", async () => {
      mockProvisionGuestAuthConfigToConvex.mockRejectedValue(
        new Error("convex env set failed"),
      );
      const { fetchConvexGuestSession } =
        await import("../guest-session-source.js");
      const result = await fetchConvexGuestSession();
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.status).toBe(503);
      expect(result.reason).toBe("provisioning");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
