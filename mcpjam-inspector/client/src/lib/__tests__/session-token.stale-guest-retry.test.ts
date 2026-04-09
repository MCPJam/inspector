/**
 * authFetch — retry when caller provides a stale guest bearer
 *
 * The chat transport captures an Authorization header at render time.
 * During the guest→signed-in transition, the transport may still hold
 * a stale guest bearer that gets passed as init.headers.Authorization.
 *
 * Previously, authFetch treated ANY caller-provided Authorization as
 * intentional and skipped the 401 retry. This test verifies that
 * authFetch detects stale guest bearers and still retries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/guest-session", () => ({
  getGuestBearerToken: vi.fn(),
  forceRefreshGuestSession: vi.fn(),
  peekStoredGuestToken: vi.fn(),
}));

vi.mock("@/lib/apis/web/context", async () => {
  const actual = await vi.importActual<typeof import("@/lib/apis/web/context")>(
    "@/lib/apis/web/context",
  );
  return {
    ...actual,
    getHostedAuthorizationHeader: vi.fn(),
    resetTokenCache: vi.fn(),
    shouldRetryHostedAuth401: vi.fn(),
  };
});

import { authFetch } from "../session-token";
import {
  forceRefreshGuestSession,
  peekStoredGuestToken,
} from "@/lib/guest-session";
import {
  getHostedAuthorizationHeader,
  resetTokenCache,
  shouldRetryHostedAuth401,
} from "@/lib/apis/web/context";

describe("authFetch stale guest bearer retry", () => {
  beforeEach(() => {
    vi.mocked(getHostedAuthorizationHeader).mockReset();
    vi.mocked(resetTokenCache).mockReset();
    vi.mocked(forceRefreshGuestSession).mockReset();
    vi.mocked(peekStoredGuestToken).mockReset();
    vi.mocked(shouldRetryHostedAuth401).mockReturnValue(true);
    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries on 401 when caller-provided Authorization matches a stale guest token", async () => {
    const staleGuestToken = "guest-jwt-stale-abc123";

    // The hosted auth header is now a WorkOS token (user just signed in)
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer workos-fresh-token",
    );

    // But the caller (chat transport) still passes the old guest bearer
    // peekStoredGuestToken returns the same token — confirming it's a guest token
    vi.mocked(peekStoredGuestToken).mockReturnValue(staleGuestToken);

    vi.mocked(forceRefreshGuestSession).mockResolvedValue("fresh-guest-token");

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
      } as Response);

    const response = await authFetch("/api/web/chat-v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${staleGuestToken}` },
      body: JSON.stringify({ chatSessionId: "sess-1" }),
    });

    expect(response.status).toBe(200);
    expect(resetTokenCache).toHaveBeenCalled();
    expect(forceRefreshGuestSession).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry when caller-provided Authorization is a non-guest token", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer workos-token",
    );

    // peekStoredGuestToken returns null — no guest token in localStorage
    vi.mocked(peekStoredGuestToken).mockReturnValue(null);

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 401,
      ok: false,
    } as Response);

    const response = await authFetch("/api/web/tools/list", {
      headers: { Authorization: "Bearer some-oauth-token" },
    });

    expect(response.status).toBe(401);
    expect(resetTokenCache).not.toHaveBeenCalled();
    expect(forceRefreshGuestSession).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
