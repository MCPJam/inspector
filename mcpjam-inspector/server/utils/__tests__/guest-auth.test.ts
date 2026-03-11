import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueGuestToken = vi.fn();
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

vi.mock("../../services/guest-token.js", () => ({
  issueGuestToken: mockIssueGuestToken,
}));

describe("guest-auth", () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLocalSigning = process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
  const originalPrivateKey = process.env.GUEST_JWT_PRIVATE_KEY;
  const originalPublicKey = process.env.GUEST_JWT_PUBLIC_KEY;
  const originalRemoteUrl = process.env.MCPJAM_GUEST_SESSION_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
    delete process.env.GUEST_JWT_PRIVATE_KEY;
    delete process.env.GUEST_JWT_PUBLIC_KEY;
    delete process.env.MCPJAM_GUEST_SESSION_URL;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLocalSigning === undefined) {
      delete process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING;
    } else {
      process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING = originalLocalSigning;
    }
    if (originalPrivateKey === undefined) {
      delete process.env.GUEST_JWT_PRIVATE_KEY;
    } else {
      process.env.GUEST_JWT_PRIVATE_KEY = originalPrivateKey;
    }
    if (originalPublicKey === undefined) {
      delete process.env.GUEST_JWT_PUBLIC_KEY;
    } else {
      process.env.GUEST_JWT_PUBLIC_KEY = originalPublicKey;
    }
    if (originalRemoteUrl === undefined) {
      delete process.env.MCPJAM_GUEST_SESSION_URL;
    } else {
      process.env.MCPJAM_GUEST_SESSION_URL = originalRemoteUrl;
    }
    global.fetch = originalFetch;
  });

  it("fetches a hosted guest session in development by default", async () => {
    process.env.NODE_ENV = "development";
    process.env.MCPJAM_GUEST_SESSION_URL =
      "https://app.mcpjam.com/api/web/guest-session";
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
      "https://app.mcpjam.com/api/web/guest-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(mockIssueGuestToken).not.toHaveBeenCalled();
  });

  it("uses local guest signing in development when explicitly enabled", async () => {
    process.env.NODE_ENV = "development";
    process.env.MCPJAM_USE_LOCAL_GUEST_SIGNING = "true";
    mockIssueGuestToken.mockReturnValue({
      token: "local-guest-token",
      expiresAt: Date.now() + 60_000,
    });

    const { getProductionGuestAuthHeader } = await import("../guest-auth.js");
    const header = await getProductionGuestAuthHeader();

    expect(header).toBe("Bearer local-guest-token");
    expect(mockIssueGuestToken).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches a hosted guest session in production when no local signing keys are configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.MCPJAM_GUEST_SESSION_URL =
      "https://app.mcpjam.com/api/web/guest-session";
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          guestId: "guest-1",
          token: "remote-guest-token",
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

    expect(header).toBe("Bearer remote-guest-token");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://app.mcpjam.com/api/web/guest-session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(mockIssueGuestToken).not.toHaveBeenCalled();
  });

  it("still uses local signing in production when explicit guest signing keys are configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.GUEST_JWT_PRIVATE_KEY = "private";
    process.env.GUEST_JWT_PUBLIC_KEY = "public";
    mockIssueGuestToken.mockReturnValue({
      token: "env-signed-guest-token",
      expiresAt: Date.now() + 60_000,
    });

    const { getProductionGuestAuthHeader } = await import("../guest-auth.js");
    const header = await getProductionGuestAuthHeader();

    expect(header).toBe("Bearer env-signed-guest-token");
    expect(mockIssueGuestToken).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
