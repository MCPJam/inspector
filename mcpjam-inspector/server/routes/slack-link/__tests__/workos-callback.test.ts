/**
 * The Slack link page's last leg: after the person signs in to the link app,
 * the page forwards that sign-in's access token and nothing else about who
 * they are. It looks up no user or organization, mints no token for anyone,
 * and turns each refusal the backend names into one of the pages it had.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import slackLink from "../index.js";
import { hashOauthState, signSlackLinkState } from "../state.js";

const SECRET = "slack-link-test-secret";
const CONVEX = "https://convex.test";
const ISSUER = "https://authkit.test";
const WORKOS_STATE = "workos-state";

type Call = { url: string; init: RequestInit };

function cookieFor(linkSessionId: string): string {
  const exp = Date.now() + 60_000;
  return signSlackLinkState(
    {
      linkSessionId: JSON.stringify({
        linkSessionId,
        workosState: WORKOS_STATE,
        exp,
      }),
      exp,
    },
    SECRET,
  );
}

describe("GET /workos/callback", () => {
  let calls: Call[];
  let consumeAnswer: () => Response;

  beforeEach(() => {
    vi.stubEnv("SLACK_LINK_STATE_SECRET", SECRET);
    vi.stubEnv("SLACK_LINK_PUBLIC_ORIGIN", "https://inspector.test");
    vi.stubEnv("SLACK_CLIENT_ID", "slack-client");
    vi.stubEnv("SLACK_CLIENT_SECRET", "slack-secret");
    vi.stubEnv("SLACK_LINK_WORKOS_CLIENT_ID", "client_link_app");
    vi.stubEnv("SLACK_LINK_WORKOS_CLIENT_SECRET", "link-app-secret");
    vi.stubEnv("WORKOS_CLIENT_ID", "client_environment");
    vi.stubEnv("AUTHKIT_DOMAIN", new URL(ISSUER).host);
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc");
    calls = [];
    consumeAnswer = () =>
      Response.json({ ok: true, relinked: false, organizationId: "org_1" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        switch (url) {
          case `${CONVEX}/slack/link-sessions/get`:
            return Response.json({
              ok: true,
              session: {
                linkSessionId: "ls_1",
                status: "slack_verified",
                expired: false,
                workosStateHash: hashOauthState(WORKOS_STATE),
              },
            });
          case `${CONVEX}/slack/link-sessions/workos-verified`:
          case `${CONVEX}/slack/link-sessions/fail`:
            return Response.json({ ok: true });
          case `${ISSUER}/oauth2/token`:
            return Response.json({ access_token: "link-app-token" });
          case `${CONVEX}/slack/link-sessions/consume`:
            return consumeAnswer();
          case `${CONVEX}/v1/projects?organizationId=org_1`:
            return Response.json({ data: [{ id: "p1", name: "Payments" }] });
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

  function callback() {
    return slackLink.request(
      `/workos/callback?state=${WORKOS_STATE}&code=auth-code`,
      { headers: { cookie: `mcpjam_slack_link=${cookieFor("ls_1")}` } },
    );
  }

  it("consumes with the access token alone and lists projects with it", async () => {
    const response = await callback();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Slack is connected");
    expect(html).toContain("Payments");

    const consume = calls.find((call) => call.url.endsWith("/consume"))!;
    expect(JSON.parse(String(consume.init.body))).toEqual({
      linkSessionId: "ls_1",
      accessToken: "link-app-token",
    });
    expect(
      (consume.init.headers as Record<string, string>)[
        "x-inspector-service-token"
      ],
    ).toBe("svc");
    const projects = calls.find((call) => call.url.includes("/v1/projects"))!;
    expect(projects.init.headers).toEqual({
      Authorization: "Bearer link-app-token",
    });
    // No lookups and no token minted to act as the person.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/slack/link-sessions/get",
      "/slack/link-sessions/workos-verified",
      "/oauth2/token",
      "/slack/link-sessions/consume",
      "/v1/projects",
    ]);
  });

  it.each([
    ["unknown_mcpjam_user", 400, "No MCPJam account yet"],
    ["org_unresolved", 400, "Couldn’t tell which organization to use"],
    ["not_an_org_member", 400, "That link didn’t work"],
    ["token_reused", 400, "That link didn’t work"],
  ])("shows the page for a %s refusal", async (reason, status, title) => {
    consumeAnswer = () => Response.json({ ok: false, reason });
    const response = await callback();
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(title);
    expect(calls.some((call) => call.url.includes("/v1/projects"))).toBe(false);
  });

  it("asks for a retry when the backend can't finish the consume", async () => {
    consumeAnswer = () => new Response("down", { status: 503 });
    const response = await callback();
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("MCPJam is having a moment");
  });
});
