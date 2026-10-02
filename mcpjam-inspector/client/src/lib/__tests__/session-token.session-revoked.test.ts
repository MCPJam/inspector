/**
 * authFetch and a session signed out elsewhere (MJ-011): the gateway's
 * `401 SESSION_REVOKED` is reported once and handed back untouched — never
 * retried, and never swapped for a guest bearer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
  forceRefreshGuestSession: vi.fn(),
}));

vi.mock("@/lib/apis/web/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apis/web/context")>(
    "@/lib/apis/web/context",
  );
  return {
    ...actual,
    getApiAuthorizationHeader: vi.fn(),
    resetTokenCache: vi.fn(),
    shouldRetryApiAuth401: vi.fn(),
  };
});

import { authFetch } from "../session-token";
import { forceRefreshGuestSession } from "@/lib/guest-session";
import {
  getApiAuthorizationHeader,
  shouldRetryApiAuth401,
} from "@/lib/apis/web/context";
import {
  resetSessionRevokedForTests,
  setSessionRevokedHandler,
} from "@/lib/auth/session-revoked";

function revoked(
  body: unknown = {
    code: "SESSION_REVOKED",
    message: "This session has been signed out.",
  },
): Response {
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

describe("authFetch — revoked session", () => {
  const handler = vi.fn();

  beforeEach(() => {
    resetSessionRevokedForTests();
    handler.mockReset();
    setSessionRevokedHandler(handler);
    vi.mocked(getApiAuthorizationHeader).mockResolvedValue("Bearer user-jwt");
    // Would otherwise refresh a guest bearer and retry: proves the refusal
    // short-circuits that path.
    vi.mocked(shouldRetryApiAuth401).mockReturnValue(true);
    vi.mocked(forceRefreshGuestSession).mockReset();
    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    resetSessionRevokedForTests();
  });

  it("reports the refusal and returns it unread, without retrying", async () => {
    vi.mocked(global.fetch).mockResolvedValue(revoked());

    const response = await authFetch("/api/web/tools/list", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_REVOKED" });
    expect(global.fetch).toHaveBeenCalledOnce();
    expect(forceRefreshGuestSession).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("recognizes the /api/v1 envelope on the v1 paths the app calls", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      revoked({
        code: "UNAUTHORIZED",
        message: "This session has been signed out.",
        details: { reason: "SESSION_REVOKED" },
      }),
    );

    await authFetch("/api/v1/agent-ops");

    expect(handler).toHaveBeenCalledOnce();
  });

  it("reports once however many requests are refused", async () => {
    vi.mocked(global.fetch).mockImplementation(async () => revoked());

    await Promise.all(
      Array.from({ length: 5 }, () => authFetch("/api/web/servers/list")),
    );

    expect(handler).toHaveBeenCalledOnce();
  });

  it("leaves every other 401 on the existing path", async () => {
    vi.mocked(forceRefreshGuestSession).mockResolvedValue("fresh-guest");
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "UNAUTHORIZED" }), { status: 401 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const response = await authFetch("/api/web/tools/list");

    expect(response.status).toBe(200);
    expect(forceRefreshGuestSession).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores the code from a path or origin that never carries this tab's bearer", async () => {
    vi.mocked(global.fetch).mockImplementation(async () => revoked());

    await authFetch("/api/health");
    await authFetch("https://elsewhere.example.test/api/web/tools/list");

    expect(handler).not.toHaveBeenCalled();
  });
});
