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

  it("fetches hosted guest sessions without the shared secret", async () => {
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
    const session = await fetchRemoteGuestSession();

    expect(session?.token).toBe("remote-token");
    expect(mockProvisionGuestAuthConfigToConvex).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.mcpjam.com/api/web/guest-session",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
    const session = await fetchConvexGuestSession();

    expect(session?.token).toBe("convex-token");
    expect(mockProvisionGuestAuthConfigToConvex).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://test-deployment.convex.site/guest/session",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-mcpjam-guest-session-secret": "test-guest-session-secret",
        },
        signal: expect.anything(),
      }),
    );
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
});
