import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Service-token-gated guest minting for the platform MCP worker. Mocks the
// guest-session source so the suite asserts the route's gate / lockdown /
// rate-limit / passthrough behavior without a real Convex round-trip.

const { fetchConvexGuestSessionMock, fetchRemoteGuestSessionMock } = vi.hoisted(
  () => ({
    fetchConvexGuestSessionMock: vi.fn(),
    fetchRemoteGuestSessionMock: vi.fn(),
  })
);

vi.mock("../../../utils/guest-session-source.js", () => ({
  fetchConvexGuestSession: fetchConvexGuestSessionMock,
  fetchRemoteGuestSession: fetchRemoteGuestSessionMock,
}));

import guestToken from "../guest-token.js";

const SERVICE_TOKEN = "svc_test_token";
// Must match LOCAL_DEV_SERVICE_TOKEN in ../guest-token.ts.
const LOCAL_DEV_SERVICE_TOKEN = "mcpjam-local-dev-service-token";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/guest-token", guestToken);
  return app;
}

function mint(
  app: Hono,
  headers: Record<string, string> = {}
): Promise<Response> {
  return Promise.resolve(
    app.request("/guest-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    })
  );
}

describe("POST /api/web/guest-token", () => {
  const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  const originalLockdown = process.env.MCPJAM_NONPROD_LOCKDOWN;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowLocalDev = process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INSPECTOR_SERVICE_TOKEN = SERVICE_TOKEN;
    delete process.env.MCPJAM_NONPROD_LOCKDOWN;
    delete process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN;
    fetchConvexGuestSessionMock.mockResolvedValue({
      kind: "session",
      session: { guestId: "g1", token: "guest.jwt.token", expiresAt: 123 },
      setCookies: [],
    });
  });

  afterEach(() => {
    if (originalServiceToken === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = originalServiceToken;
    }
    if (originalLockdown === undefined) {
      delete process.env.MCPJAM_NONPROD_LOCKDOWN;
    } else {
      process.env.MCPJAM_NONPROD_LOCKDOWN = originalLockdown;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalAllowLocalDev === undefined) {
      delete process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN;
    } else {
      process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN = originalAllowLocalDev;
    }
  });

  it("rejects a missing service token (401)", async () => {
    const res = await mint(makeApp(), { "x-mcpjam-client-ip": "1.1.1.1" });
    expect(res.status).toBe(401);
    expect(fetchConvexGuestSessionMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong service token (401)", async () => {
    const res = await mint(makeApp(), {
      "x-inspector-service-token": "wrong",
      "x-mcpjam-client-ip": "1.1.1.2",
    });
    expect(res.status).toBe(401);
    expect(fetchConvexGuestSessionMock).not.toHaveBeenCalled();
  });

  it("returns 403 when guest access is locked down", async () => {
    process.env.MCPJAM_NONPROD_LOCKDOWN = "true";
    const res = await mint(makeApp(), {
      "x-inspector-service-token": SERVICE_TOKEN,
      "x-mcpjam-client-ip": "1.1.1.3",
    });
    expect(res.status).toBe(403);
    expect(fetchConvexGuestSessionMock).not.toHaveBeenCalled();
  });

  it("mints a guest token for a valid service token", async () => {
    const res = await mint(makeApp(), {
      "x-inspector-service-token": SERVICE_TOKEN,
      "x-mcpjam-client-ip": "1.1.1.4",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: "guest.jwt.token",
      expiresAt: 123,
    });
    expect(fetchConvexGuestSessionMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the local-dev sentinel when opted in (non-production + flag)", async () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN = "true";
    // Even with a different configured secret, the opted-in sentinel works.
    const res = await mint(makeApp(), {
      "x-inspector-service-token": LOCAL_DEV_SERVICE_TOKEN,
      "x-mcpjam-client-ip": "3.3.3.1",
    });
    expect(res.status).toBe(200);
    expect(fetchConvexGuestSessionMock).toHaveBeenCalledTimes(1);
  });

  it("rejects the local-dev sentinel without the opt-in flag (non-production)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN;
    const res = await mint(makeApp(), {
      "x-inspector-service-token": LOCAL_DEV_SERVICE_TOKEN,
      "x-mcpjam-client-ip": "3.3.3.4",
    });
    expect(res.status).toBe(401);
    expect(fetchConvexGuestSessionMock).not.toHaveBeenCalled();
  });

  it("rejects the local-dev sentinel in production even with the flag set", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_LOCAL_DEV_SERVICE_TOKEN = "true";
    const res = await mint(makeApp(), {
      "x-inspector-service-token": LOCAL_DEV_SERVICE_TOKEN,
      "x-mcpjam-client-ip": "3.3.3.2",
    });
    expect(res.status).toBe(401);
    expect(fetchConvexGuestSessionMock).not.toHaveBeenCalled();
  });

  it("still accepts the configured secret in production", async () => {
    process.env.NODE_ENV = "production";
    // Production mints through the remote source, not Convex (shouldUseConvex).
    fetchRemoteGuestSessionMock.mockResolvedValue({
      kind: "session",
      session: { guestId: "g1", token: "guest.jwt.token", expiresAt: 123 },
      setCookies: [],
    });
    const res = await mint(makeApp(), {
      "x-inspector-service-token": SERVICE_TOKEN,
      "x-mcpjam-client-ip": "3.3.3.3",
    });
    expect(res.status).toBe(200);
    expect(fetchRemoteGuestSessionMock).toHaveBeenCalledTimes(1);
  });

  it("rate-limits per forwarded client IP (429 after the cap)", async () => {
    const app = makeApp();
    const ip = "9.9.9.9";
    let last: Response | undefined;
    // 10/min cap → the 11th request from the same IP is throttled.
    for (let i = 0; i < 11; i++) {
      last = await mint(app, {
        "x-inspector-service-token": SERVICE_TOKEN,
        "x-mcpjam-client-ip": ip,
      });
    }
    expect(last?.status).toBe(429);
  });

  it("surfaces an upstream mint failure as 503", async () => {
    fetchConvexGuestSessionMock.mockResolvedValue({
      kind: "error",
      status: 503,
      setCookies: [],
    });
    const res = await mint(makeApp(), {
      "x-inspector-service-token": SERVICE_TOKEN,
      "x-mcpjam-client-ip": "2.2.2.2",
    });
    expect(res.status).toBe(503);
  });
});
