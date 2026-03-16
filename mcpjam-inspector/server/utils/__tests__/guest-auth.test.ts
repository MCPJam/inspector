import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};
const mockProvisionGuestAuthConfigToConvex = vi.fn();
const mockGetGuestSessionSharedSecret = vi.fn();

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

vi.mock("../convex-guest-auth-sync.js", () => ({
  provisionGuestAuthConfigToConvex: mockProvisionGuestAuthConfigToConvex,
}));

vi.mock("../guest-session-secret.js", () => ({
  GUEST_SESSION_SECRET_HEADER: "x-mcpjam-guest-session-secret",
  getGuestSessionSharedSecret: mockGetGuestSessionSharedSecret,
}));

describe("guest-auth", () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalRemoteUrl = process.env.MCPJAM_GUEST_SESSION_URL;
  const originalSharedSecret = process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
    delete process.env.MCPJAM_GUEST_SESSION_URL;
    delete process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;
    mockProvisionGuestAuthConfigToConvex.mockResolvedValue(undefined);
    mockGetGuestSessionSharedSecret.mockReturnValue("test-guest-session-secret");
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
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
    if (originalSharedSecret === undefined) {
      delete process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET;
    } else {
      process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = originalSharedSecret;
    }
    global.fetch = originalFetch;
  });

  it("fetches a Convex guest session in development by default", async () => {
    process.env.NODE_ENV = "development";
    process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET = "test-guest-session-secret";
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-dev",
          token: "remote-dev-token",
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { getProductionGuestAuthHeader } = await import("../guest-auth.js");
    const header = await getProductionGuestAuthHeader();

    expect(header).toBe("Bearer remote-dev-token");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-mcpjam-guest-session-secret": "test-guest-session-secret",
        },
      },
    );
  });

  it("fetches a hosted guest session in production by default", async () => {
    process.env.NODE_ENV = "production";
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-prod",
          token: "remote-prod-token",
          expiresAt: Date.now() + 60_000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { getProductionGuestAuthHeader } = await import("../guest-auth.js");
    const header = await getProductionGuestAuthHeader();

    expect(header).toBe("Bearer remote-prod-token");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.mcpjam.com/api/web/guest-session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  });

  it("reuses the cached guest token until refresh is needed", async () => {
    process.env.NODE_ENV = "production";
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-prod",
          token: "cached-token",
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const { getProductionGuestAuthHeader } = await import("../guest-auth.js");
    expect(await getProductionGuestAuthHeader()).toBe("Bearer cached-token");
    expect(await getProductionGuestAuthHeader()).toBe("Bearer cached-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses a still-valid cached token when refresh fails", async () => {
    process.env.NODE_ENV = "production";
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            guestId: "guest-prod",
            token: "stale-but-valid-token",
            expiresAt: Date.now() + 60_000,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "nope" }), { status: 503 }),
      );

    const { getProductionGuestAuthHeader } = await import("../guest-auth.js");
    expect(await getProductionGuestAuthHeader()).toBe(
      "Bearer stale-but-valid-token",
    );
    expect(await getProductionGuestAuthHeader()).toBe(
      "Bearer stale-but-valid-token",
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[guest-auth] Failed to refresh guest token; reusing cached token until expiry",
    );
  });
});
