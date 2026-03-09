import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/context", () => ({
  getHostedAuthorizationHeader: vi.fn(),
  isGuestMode: vi.fn(),
}));

vi.mock("@/lib/guest-session", () => ({
  clearGuestSession: vi.fn(),
  getGuestBearerToken: vi.fn(),
}));

import { authFetch } from "../session-token";
import {
  getHostedAuthorizationHeader,
  isGuestMode,
} from "@/lib/apis/web/context";
import { clearGuestSession, getGuestBearerToken } from "@/lib/guest-session";

describe("authFetch hosted guest retry", () => {
  beforeEach(() => {
    vi.mocked(global.fetch).mockReset();
    vi.mocked(getHostedAuthorizationHeader).mockReset();
    vi.mocked(isGuestMode).mockReset();
    vi.mocked(clearGuestSession).mockReset();
    vi.mocked(getGuestBearerToken).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes the guest token and retries once after a hosted guest 401", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValue(
      "Bearer stale-guest-token",
    );
    vi.mocked(isGuestMode).mockReturnValue(true);
    vi.mocked(getGuestBearerToken).mockResolvedValue("fresh-guest-token");

    const unauthorized = new Response(
      JSON.stringify({ message: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
    const okResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(unauthorized)
      .mockResolvedValueOnce(okResponse);

    const response = await authFetch("/api/web/tools/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverUrl: "https://example.com/mcp" }),
    });

    expect(response).toBe(okResponse);
    expect(clearGuestSession).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenNthCalledWith(1, "/api/web/tools/list", {
      method: "POST",
      headers: {
        Authorization: "Bearer stale-guest-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverUrl: "https://example.com/mcp" }),
    });
    expect(global.fetch).toHaveBeenNthCalledWith(2, "/api/web/tools/list", {
      method: "POST",
      headers: {
        Authorization: "Bearer fresh-guest-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverUrl: "https://example.com/mcp" }),
    });
  });

  it("returns the second 401 without retrying again", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValue(
      "Bearer stale-guest-token",
    );
    vi.mocked(isGuestMode).mockReturnValue(true);
    vi.mocked(getGuestBearerToken).mockResolvedValue("fresh-guest-token");

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    const response = await authFetch("/api/web/servers/validate", {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(clearGuestSession).toHaveBeenCalledTimes(1);
    expect(getGuestBearerToken).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh when the request is not in guest mode", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValue(
      "Bearer workos-token",
    );
    vi.mocked(isGuestMode).mockReturnValue(false);
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(null, { status: 401 }),
    );

    const response = await authFetch("/api/web/tools/list");

    expect(response.status).toBe(401);
    expect(clearGuestSession).not.toHaveBeenCalled();
    expect(getGuestBearerToken).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the caller overrides Authorization", async () => {
    vi.mocked(getHostedAuthorizationHeader).mockResolvedValue(
      "Bearer stale-guest-token",
    );
    vi.mocked(isGuestMode).mockReturnValue(true);
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(null, { status: 401 }),
    );

    const response = await authFetch("/api/web/tools/list", {
      headers: {
        Authorization: "Bearer caller-token",
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(401);
    expect(clearGuestSession).not.toHaveBeenCalled();
    expect(getGuestBearerToken).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("/api/web/tools/list", {
      headers: {
        Authorization: "Bearer caller-token",
        "Content-Type": "application/json",
      },
    });
  });
});
