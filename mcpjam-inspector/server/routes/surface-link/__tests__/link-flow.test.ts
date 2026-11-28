/**
 * The Discord link pages talk to the backend with the Inspector's own service
 * credential, so they work with no `DISCORD_SERVICE_TOKEN` in this process,
 * and finish by forwarding the person's link-app access token instead of
 * looking up and naming who they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import surfaceLink from "../index.js";
import { hashOauthState, signSlackLinkState } from "../../slack-link/state.js";

const SECRET = "discord-link-test-secret";
const CONVEX = "https://convex.test";
const ISSUER = "https://authkit.test";

type Call = { url: string; init: RequestInit };

describe("Discord link pages", () => {
  let calls: Call[];
  let session: Record<string, unknown>;
  let consumeAnswer: () => Response;

  beforeEach(() => {
    vi.stubEnv("DISCORD_LINK_STATE_SECRET", SECRET);
    vi.stubEnv("DISCORD_LINK_PUBLIC_ORIGIN", "https://inspector.test");
    vi.stubEnv("DISCORD_CLIENT_ID", "discord-client");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "discord-secret");
    vi.stubEnv("SLACK_LINK_WORKOS_CLIENT_ID", "client_link_app");
    vi.stubEnv("SLACK_LINK_WORKOS_CLIENT_SECRET", "link-app-secret");
    vi.stubEnv("WORKOS_CLIENT_ID", "client_environment");
    vi.stubEnv("AUTHKIT_DOMAIN", new URL(ISSUER).host);
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc");
    vi.stubEnv("DISCORD_SERVICE_TOKEN", "");
    calls = [];
    session = {
      sessionId: "ds_1",
      surfaceKind: "discord",
      surfaceTenantId: "guild_1",
      surfaceUserId: "discord_1",
      status: "pending_surface",
      expiresAt: Date.now() + 60_000,
    };
    consumeAnswer = () => Response.json({ ok: true, relinked: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        switch (url) {
          case `${CONVEX}/agent/link-sessions/get`:
            return Response.json({ ok: true, session });
          case `${CONVEX}/agent/link-sessions/set-status`:
            return Response.json({ ok: true });
          case `${CONVEX}/agent/link-sessions/consume`:
            return consumeAnswer();
          case `${ISSUER}/oauth2/token`:
            return Response.json({ access_token: "link-app-token" });
          default:
            throw new Error(`unexpected fetch ${url}`);
        }
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function backendCalls() {
    return calls.filter((call) => call.url.startsWith(CONVEX));
  }

  function expectInspectorCredential() {
    expect(backendCalls().length).toBeGreaterThan(0);
    for (const call of backendCalls()) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["x-inspector-service-token"]).toBe("svc");
      expect(headers).not.toHaveProperty("x-discord-service-token");
    }
  }

  it("starts the Discord leg without a Discord credential", async () => {
    const signed = signSlackLinkState(
      { linkSessionId: "ds_1", exp: Date.now() + 60_000 },
      SECRET,
    );
    const response = await surfaceLink.request(
      `/start?s=${encodeURIComponent(signed)}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize/,
    );
    expectInspectorCredential();
  });

  describe("GET /workos/callback", () => {
    function callback() {
      const exp = Date.now() + 60_000;
      const cookie = signSlackLinkState(
        {
          linkSessionId: JSON.stringify({
            sessionId: "ds_1",
            surfaceState: "surface-state",
            workosState: "workos-state",
            exp,
          }),
          exp,
        },
        SECRET,
      );
      session = {
        ...session,
        status: "surface_verified",
        workosStateHash: hashOauthState("workos-state"),
      };
      return surfaceLink.request(
        "/workos/callback?state=workos-state&code=auth-code",
        { headers: { cookie: `mcpjam_discord_link=${cookie}` } },
      );
    }

    it("consumes with the access token alone", async () => {
      const response = await callback();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Discord is connected");
      const consume = calls.find((call) => call.url.endsWith("/consume"))!;
      expect(JSON.parse(String(consume.init.body))).toEqual({
        sessionId: "ds_1",
        accessToken: "link-app-token",
      });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/agent/link-sessions/get",
        "/oauth2/token",
        "/agent/link-sessions/set-status",
        "/agent/link-sessions/consume",
      ]);
      expectInspectorCredential();
    });

    it.each([
      ["unknown_mcpjam_user", 400, "No MCPJam account yet"],
      ["org_unresolved", 400, "Couldn’t tell which organization to use"],
      ["not_an_org_member", 400, "That link didn’t work"],
      ["token_invalid", 400, "That link didn’t work"],
    ])("shows the page for a %s refusal", async (reason, status, title) => {
      consumeAnswer = () => Response.json({ ok: false, reason });
      const response = await callback();
      expect(response.status).toBe(status);
      expect(await response.text()).toContain(title);
    });

    it("asks for a retry when the backend can't finish the consume", async () => {
      consumeAnswer = () => new Response("down", { status: 500 });
      const response = await callback();
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("MCPJam is having a moment");
    });
  });
});
