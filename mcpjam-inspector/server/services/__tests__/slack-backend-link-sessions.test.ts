/**
 * The link-session wire: what the account-link pages send the backend.
 *
 * Every link-session call goes out with the Inspector's own service
 * credential (never a Discord bot credential), and a consume carries only the
 * session and the person's link-app access token: the backend takes the user
 * and organization from that token, so no id the page could get wrong (or be
 * told) is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeSlackLinkSession,
  consumeSurfaceLinkSession,
  createSurfaceLinkSession,
  getSurfaceLinkSession,
  setSurfaceLinkStatus,
} from "../slack-backend.js";

describe("link-session wire", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "http://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc");
    vi.stubEnv("DISCORD_SERVICE_TOKEN", "");
    fetchMock = vi.fn(async () => Response.json({ ok: true, session: null }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function calls() {
    return fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      headers: (init as RequestInit).headers as Record<string, string>,
      body: JSON.parse(String((init as RequestInit).body)),
    }));
  }

  it("calls every Discord link-session route with the Inspector's credential", async () => {
    await createSurfaceLinkSession({
      sessionId: "s1",
      surfaceKind: "discord",
      surfaceTenantId: "g1",
      surfaceUserId: "d1",
      expiresAt: 1,
    });
    await getSurfaceLinkSession("s1");
    await setSurfaceLinkStatus({ sessionId: "s1", status: "surface_verified" });
    await consumeSurfaceLinkSession({ sessionId: "s1", accessToken: "tok" });

    const sent = calls();
    expect(sent.map((call) => call.url)).toEqual([
      "http://convex.test/agent/link-sessions/create",
      "http://convex.test/agent/link-sessions/get",
      "http://convex.test/agent/link-sessions/set-status",
      "http://convex.test/agent/link-sessions/consume",
    ]);
    for (const call of sent) {
      expect(call.headers["x-inspector-service-token"]).toBe("svc");
      expect(call.headers).not.toHaveProperty("x-discord-service-token");
    }
  });

  it("sends a consume as the session and the access token, with no ids", async () => {
    await consumeSurfaceLinkSession({ sessionId: "s1", accessToken: "tok" });
    await consumeSlackLinkSession({ linkSessionId: "ls1", accessToken: "tok" });
    expect(calls().map((call) => call.body)).toEqual([
      { sessionId: "s1", accessToken: "tok" },
      { linkSessionId: "ls1", accessToken: "tok" },
    ]);
  });
});
