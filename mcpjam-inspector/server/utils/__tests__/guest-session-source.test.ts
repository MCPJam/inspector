import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

const GUEST_ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "VITE_MCPJAM_HOSTED_MODE",
  "MCPJAM_GUEST_AUTHORITY",
  "MCPJAM_GUEST_AUTHORITY_ORIGIN",
  "MCPJAM_GUEST_SESSION_URL",
  "MCPJAM_GUEST_SESSION_REVOKE_URL",
  "MCPJAM_GUEST_PROMOTION_PROOF_URL",
  "MCPJAM_GUEST_JWKS_URL",
  "MCPJAM_GUEST_SESSION_SHARED_SECRET",
  "INSPECTOR_SERVICE_TOKEN",
] as const;

function sessionResponse(
  token = "t",
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ guestId: "g", token, expiresAt: Date.now() + 60_000 }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...headers },
    },
  );
}

async function load() {
  return await import("../guest-session-source.js");
}

describe("guest-session-source", () => {
  const originalFetch = global.fetch;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    for (const key of GUEST_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    global.fetch = vi.fn();
  });

  afterEach(() => {
    for (const key of GUEST_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    global.fetch = originalFetch;
  });

  describe("hosted authority (standard OSS profile)", () => {
    it("mints at the hosted Inspector, never at CONVEX_HTTP_URL", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        sessionResponse("hosted-token"),
      );
      const { fetchGuestSession } = await load();
      const result = await fetchGuestSession();

      expect(result.kind).toBe("session");
      if (result.kind !== "session") return;
      expect(result.session.token).toBe("hosted-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://app.mcpjam.com/api/web/guest-session",
        expect.objectContaining({ method: "POST", signal: expect.anything() }),
      );
    });

    it("reads the JWKS from the same authority that mints", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      );
      const { fetchGuestJwks } = await load();
      const response = await fetchGuestJwks();
      expect(response?.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://app.mcpjam.com/api/web/guest-jwks",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("sends revoke and promotion proof to the same authority", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ revoked: true }), { status: 200 }),
        )
        .mockResolvedValueOnce(sessionResponse("proof"));
      const { fetchGuestSessionRevoke, fetchGuestPromotionProof } =
        await load();
      await fetchGuestSessionRevoke();
      await fetchGuestPromotionProof();
      const urls = vi.mocked(global.fetch).mock.calls.map((call) => call[0]);
      expect(urls).toEqual([
        "https://app.mcpjam.com/api/web/guest-session/revoke",
        "https://app.mcpjam.com/api/web/guest-session/promotion-proof",
      ]);
    });

    it("never sends the backend shared secret or service token to a hosted authority", async () => {
      process.env.MCPJAM_GUEST_AUTHORITY = "hosted";
      process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = "backend-secret";
      process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
      vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
      const { fetchGuestSession } = await load();
      await fetchGuestSession({ ipHash: "abc-hash" });

      const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-mcpjam-guest-session-secret"]).toBeUndefined();
      expect(headers["x-inspector-service-token"]).toBeUndefined();
      expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();
    });

    it("performs no configuration writes of any kind", async () => {
      vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
      const { fetchGuestSession, fetchGuestJwks } = await load();
      await fetchGuestSession();
      await fetchGuestJwks();
      // Exactly the two reads, and nothing that looks like provisioning.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      for (const [url] of vi.mocked(global.fetch).mock.calls) {
        expect(String(url)).not.toMatch(/env|provision|deployment/i);
      }
    });
  });

  describe("backend authority (hosted mode / own deployment)", () => {
    beforeEach(() => {
      process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET =
        "test-guest-session-secret";
    });

    it("calls the configured deployment directly with the profile's shared secret", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        sessionResponse("convex-token"),
      );
      const { fetchGuestSession } = await load();
      const result = await fetchGuestSession();

      expect(result.kind).toBe("session");
      expect(global.fetch).toHaveBeenCalledWith(
        "https://test-deployment.convex.site/guest/session",
        expect.objectContaining({ method: "POST" }),
      );
      const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
      expect(
        (init.headers as Record<string, string>)[
          "x-mcpjam-guest-session-secret"
        ],
      ).toBe("test-guest-session-secret");
    });

    it("forwards the IP hash with the service token so Convex trusts it", async () => {
      process.env.INSPECTOR_SERVICE_TOKEN = "inspector-secret";
      vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
      const { fetchGuestSession } = await load();
      await fetchGuestSession({
        cookie: null,
        userAgent: null,
        ipHash: "abc-hash",
      });

      const headers = (vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers["x-mcpjam-guest-ip-hash"]).toBe("abc-hash");
      expect(headers["x-inspector-service-token"]).toBe("inspector-secret");
    });

    it("omits the IP hash when ipHash is null", async () => {
      vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
      const { fetchGuestSession } = await load();
      await fetchGuestSession({ cookie: null, userAgent: null, ipHash: null });
      const headers = (vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();
    });

    it("verifies against the deployment's own JWKS", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      );
      const { fetchGuestJwks } = await load();
      await fetchGuestJwks();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://test-deployment.convex.site/guest/jwks",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  it("an unresolvable authority fails as configuration, and never falls back to another backend", async () => {
    process.env.MCPJAM_GUEST_AUTHORITY = "backend";
    // No MCPJAM_GUEST_SESSION_SHARED_SECRET for the selected backend.
    const { fetchGuestSession, fetchGuestJwks } = await load();
    const result = await fetchGuestSession();
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(503);
    expect(result.reason).toBe("configuration");
    expect(await fetchGuestJwks()).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[guest-auth] Guest authority is not configured",
      expect.objectContaining({ event: "guest_auth.authority_config_error" }),
    );
    // The message names the missing setting, never a value.
    const [, meta] = mockLogger.warn.mock.calls[0]!;
    expect(String((meta as { message: string }).message)).toContain(
      "MCPJAM_GUEST_SESSION_SHARED_SECRET",
    );
  });

  it("returns kind:miss for upstream 204 (lookup_only)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const { fetchGuestSession } = await load();
    const result = await fetchGuestSession({ body: { mode: "lookup_only" } });
    expect(result.kind).toBe("miss");
  });

  it("returns kind:miss for upstream 404 in lookup_only mode", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const { fetchGuestSession } = await load();
    const result = await fetchGuestSession({ body: { mode: "lookup_only" } });
    expect(result.kind).toBe("miss");
  });

  it("returns kind:error for upstream 404 in lookup_or_create mode (not silent miss)", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const { fetchGuestSession } = await load();
    const result = await fetchGuestSession({
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
    const { fetchGuestSession } = await load();
    const result = await fetchGuestSession(undefined);
    expect(result.kind).toBe("error");
    expect(result.kind === "error" ? result.status : 0).toBe(429);
    expect(result.kind === "error" ? result.retryAfterSeconds : 0).toBe(120);
  });

  it("captures upstream Set-Cookie headers in the result", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      sessionResponse("t", {
        "Set-Cookie": "__Host-mcpjam_guest_session=opaque; Path=/",
      }),
    );
    const { fetchGuestSession } = await load();
    const result = await fetchGuestSession();
    expect(result.setCookies[0]).toContain(
      "__Host-mcpjam_guest_session=opaque",
    );
  });

  it("forwards the guest cookie and UA and omits spoofable IP headers upstream", async () => {
    vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
    const { fetchGuestSession } = await load();
    await fetchGuestSession({
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

  it("uses the default 10_000ms fetch timeout when timeoutMs is omitted", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
    const { fetchGuestSession } = await load();
    await fetchGuestSession();
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    timeoutSpy.mockRestore();
  });

  it("honors a shortened timeoutMs (defense-in-depth)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(global.fetch).mockResolvedValue(sessionResponse());
    const { fetchGuestSession } = await load();
    await fetchGuestSession(undefined, 1500);
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
    timeoutSpy.mockRestore();
  });

  // A self-hosted install makes its 503 locally, so the reason on the result is
  // the only way the browser's error report can say why the relay failed.
  describe("failure reasons", () => {
    async function fetchFailing() {
      const { fetchGuestSession } = await load();
      const result = await fetchGuestSession(undefined);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("expected an error result");
      return result;
    }

    it("names an upstream non-ok status", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response("bad gateway", { status: 502 }),
      );
      const result = await fetchFailing();
      expect(result.status).toBe(502);
      expect(result.reason).toBe("upstream_status");
      expect(result.upstreamStatus).toBe(502);
    });

    it("names a 200 whose body is not JSON", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response("<html>captive portal</html>", { status: 200 }),
      );
      const result = await fetchFailing();
      expect(result.status).toBe(503);
      expect(result.reason).toBe("bad_json");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "[guest-auth] Failed to read hosted guest session response",
        { reason: "bad_json" },
      );
    });

    it("names a 200 JSON body without a token", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(JSON.stringify({ guestId: "g" }), { status: 200 }),
      );
      const result = await fetchFailing();
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
      const result = await fetchFailing();
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
      const result = await fetchFailing();
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
      const result = await fetchFailing();
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
        const result = await fetchFailing();
        expect(result.reason).toBe("timeout");
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });
});
