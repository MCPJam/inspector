/**
 * authFetch Hosted 401 Retry Tests
 *
 * Tests that authFetch automatically refreshes the guest token
 * and retries once when a 401 is received in hosted mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

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
    getHostedAuthorizationHeader: vi.fn(),
    resetTokenCache: vi.fn(),
    shouldRetryHostedAuth401: vi.fn(),
  };
});

import { authFetch } from "../session-token";
import { forceRefreshGuestSession } from "@/lib/guest-session";
import {
  getHostedAuthorizationHeader,
  resetTokenCache,
  shouldRetryHostedAuth401,
} from "@/lib/apis/web/context";

describe("authFetch hosted 401 retry", () => {
  beforeEach(() => {
    vi.mocked(getHostedAuthorizationHeader).mockReset();
    vi.mocked(resetTokenCache).mockReset();
    vi.mocked(forceRefreshGuestSession).mockReset();
    vi.mocked(shouldRetryHostedAuth401).mockReturnValue(true);
    vi.mocked(global.fetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries with fresh token on 401 when hosted auth is guest-backed", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer stale-token",
    );
    vi.mocked(forceRefreshGuestSession).mockResolvedValue("fresh-token");

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ success: true }),
      } as Response);

    const response = await authFetch("/api/web/tools/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(resetTokenCache).toHaveBeenCalledTimes(1);
    expect(forceRefreshGuestSession).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/web/tools/list",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
      }),
    );
  });

  it("returns 401 if retry also fails (no infinite loop)", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer stale-token",
    );
    vi.mocked(forceRefreshGuestSession).mockResolvedValue("still-bad-token");

    vi.mocked(global.fetch)
      .mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce({ status: 401, ok: false } as Response);

    const response = await authFetch("/api/web/test");

    expect(response.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-401 errors", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValue(
      "Bearer some-token",
    );

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 500,
      ok: false,
    } as Response);

    const response = await authFetch("/api/web/test");

    expect(response.status).toBe(500);
    expect(resetTokenCache).not.toHaveBeenCalled();
    expect(forceRefreshGuestSession).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry when caller provided Authorization header", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer stale-token",
    );

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 401,
      ok: false,
    } as Response);

    const response = await authFetch("/api/web/test", {
      headers: { Authorization: "Bearer caller-token" },
    });

    expect(response.status).toBe(401);
    expect(resetTokenCache).not.toHaveBeenCalled();
    expect(forceRefreshGuestSession).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry when hosted auth is fully authenticated", async () => {
    vi.mocked(shouldRetryHostedAuth401).mockReturnValue(false);
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer workos-token",
    );

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 401,
      ok: false,
    } as Response);

    const response = await authFetch("/api/web/test");

    expect(response.status).toBe(401);
    expect(resetTokenCache).not.toHaveBeenCalled();
    expect(forceRefreshGuestSession).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns original 401 when forceRefresh returns null", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValueOnce(
      "Bearer stale-token",
    );
    vi.mocked(forceRefreshGuestSession).mockResolvedValue(null);

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 401,
      ok: false,
    } as Response);

    const response = await authFetch("/api/web/test");

    expect(response.status).toBe(401);
    expect(resetTokenCache).toHaveBeenCalledTimes(1);
    expect(forceRefreshGuestSession).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1); // no retry
  });

  it("passes through successful responses without retry", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValue(
      "Bearer good-token",
    );

    vi.mocked(global.fetch).mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ data: "ok" }),
    } as Response);

    const response = await authFetch("/api/web/test");

    expect(response.status).toBe(200);
    expect(resetTokenCache).not.toHaveBeenCalled();
    expect(forceRefreshGuestSession).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
