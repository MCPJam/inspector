/**
 * A signed-in bearer the gateway refuses as expired, on a plugin App route:
 * renewed once and the same request sent again; a second refusal goes back
 * to the caller. Other routes, guests and revoked sessions are untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    renewSessionBearer: vi.fn(),
    resetTokenCache: vi.fn(),
    shouldRetryApiAuth401: vi.fn(),
  };
});

import { authFetch } from "../session-token";
import {
  getApiAuthorizationHeader,
  renewSessionBearer,
  shouldRetryApiAuth401,
} from "@/lib/apis/web/context";
import { resetSessionRevokedForTests } from "@/lib/auth/session-revoked";

const expired = () =>
  new Response(
    JSON.stringify({
      code: "UNAUTHORIZED",
      message: "Invalid or expired session token",
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
const ok = () => new Response("{}", { status: 200 });
const sentBearers = () =>
  vi
    .mocked(global.fetch)
    .mock.calls.map(([, init]) =>
      new Headers((init as RequestInit | undefined)?.headers).get(
        "Authorization",
      ),
    );

describe("authFetch — expired sign-in on plugin App routes", () => {
  beforeEach(() => {
    resetSessionRevokedForTests();
    vi.mocked(getApiAuthorizationHeader).mockResolvedValue("Bearer old-jwt");
    vi.mocked(shouldRetryApiAuth401).mockReturnValue(false);
    vi.mocked(renewSessionBearer).mockReset();
    vi.mocked(global.fetch).mockReset();
  });

  it("renews the bearer once and sends the same App call again", async () => {
    vi.mocked(renewSessionBearer).mockResolvedValue("new-jwt");
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(ok());
    const body = JSON.stringify({ instanceToken: "t", name: "tray.list" });

    const response = await authFetch("/api/web/apps/plugin-instances/call", {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(renewSessionBearer).toHaveBeenCalledOnce();
    expect(sentBearers()).toEqual(["Bearer old-jwt", "Bearer new-jwt"]);
    expect(vi.mocked(global.fetch).mock.calls[1][1]?.body).toBe(body);
  });

  it("re-sends an upload's form data", async () => {
    vi.mocked(renewSessionBearer).mockResolvedValue("new-jwt");
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(ok());
    const form = new FormData();
    form.append("files", new Blob(["x"]), "part.stl");

    const response = await authFetch(
      "/api/web/apps/plugin-instances/form-files/upload",
      { method: "POST", body: form },
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(global.fetch).mock.calls[1][1]?.body).toBe(form);
  });

  it("hands a second refusal back to the caller without another renewal", async () => {
    vi.mocked(renewSessionBearer).mockResolvedValue("new-jwt");
    vi.mocked(global.fetch).mockImplementation(async () => expired());

    const response = await authFetch("/api/web/apps/plugin-instances/renew", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(renewSessionBearer).toHaveBeenCalledOnce();
  });

  it("returns the refusal when no fresh token can be had", async () => {
    vi.mocked(renewSessionBearer).mockResolvedValue(null);
    vi.mocked(global.fetch).mockResolvedValue(expired());

    const response = await authFetch("/api/web/apps/plugin-instances/call", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("leaves other routes, upstream OAuth refusals and streams alone", async () => {
    vi.mocked(renewSessionBearer).mockResolvedValue("new-jwt");
    vi.mocked(global.fetch).mockImplementation(async () => expired());

    await authFetch("/api/web/tools/list", { method: "POST", body: "{}" });
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response("{}", {
        status: 401,
        headers: { "X-MCP-Auth-Required": "oauth" },
      }),
    );
    await authFetch("/api/web/apps/plugin-instances/call", {
      method: "POST",
      body: "{}",
    });
    await authFetch("/api/web/apps/plugin-instances/call", {
      method: "POST",
      body: new ReadableStream(),
    });

    expect(renewSessionBearer).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
