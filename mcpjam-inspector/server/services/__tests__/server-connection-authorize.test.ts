/**
 * Preparing one browser authorization.
 *
 * The route tests above this mock this module out entirely, which is right for
 * them and would be a hole if nothing tested it directly: this is the module
 * that dials a URL the user supplied, so the refusals are the point.
 *
 * Two properties are pinned here that no route test can reach. A blocked target
 * must stay a REFUSAL rather than degrading into "we could not reach it" — the
 * difference is whether the page offers the user a "try again" button for an
 * address that will never be allowed. And the returned verifier must be the
 * companion of the challenge in the URL, because a mismatch there produces a
 * flow that works right up until the exchange and then fails with a message
 * about neither.
 *
 * The transport is injected. The pinned resolver is covered by its own tests
 * against real reserved addresses; what matters here is what this module does
 * with what the transport hands back.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationPrepareError,
  prepareAuthorization,
} from "../server-connection-authorize.js";
import { BlockedEgressTargetError } from "../../utils/hosted-egress-guard.js";

const SERVER_URL = "https://target.example.com/mcp";
const REDIRECT_URI = "https://app.mcpjam.test/oauth/callback";

const AS_METADATA = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A transport that answers by path shape rather than by exact URL.
 *
 * Discovery walks several `.well-known` candidates and the exact list is the
 * SDK's business, not this module's — matching on the shape keeps this test
 * from failing the next time a draft adds another candidate path.
 */
function fakeFetch(
  overrides: {
    resource?: () => Response;
    authorizationServer?: () => Response;
    register?: () => Response;
  } = {}
): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("oauth-protected-resource")) {
      return (
        overrides.resource?.() ??
        jsonResponse({
          resource: SERVER_URL,
          authorization_servers: ["https://auth.example.com"],
        })
      );
    }
    if (
      url.includes("oauth-authorization-server") ||
      url.includes("openid-configuration")
    ) {
      return overrides.authorizationServer?.() ?? jsonResponse(AS_METADATA);
    }
    if (init?.method === "POST" && url.includes("/register")) {
      return (
        overrides.register?.() ??
        jsonResponse({
          client_id: "generated-client-id",
          client_secret: "generated-client-secret",
        })
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function prepare(fetchFn: typeof fetch) {
  return await prepareAuthorization({
    serverUrl: SERVER_URL,
    redirectUri: REDIRECT_URI,
    requestedName: "Target",
    fetchFn,
  });
}

describe("prepareAuthorization", () => {
  it("builds an authorization url the browser can open", async () => {
    const prepared = await prepare(fakeFetch());
    const url = new URL(prepared.authorizationUrl);

    expect(url.origin + url.pathname).toBe(
      "https://auth.example.com/authorize"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("generated-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // RFC 8707: the token must be bound to the resource it is for, or a
    // provider serving several resources will happily issue one that works
    // against a different server than the user just approved.
    expect(url.searchParams.get("resource")).toBe(SERVER_URL);
    expect(prepared.issuer).toBe("https://auth.example.com");
    expect(prepared.clientSecret).toBe("generated-client-secret");
  });

  it("keeps the verifier out of the url and pairs it with the challenge", async () => {
    const prepared = await prepare(fakeFetch());
    const url = new URL(prepared.authorizationUrl);
    const challenge = url.searchParams.get("code_challenge");

    expect(prepared.codeVerifier).toBeTruthy();
    expect(prepared.authorizationUrl).not.toContain(prepared.codeVerifier);

    // The challenge must actually be S256 of the verifier this returns. If the
    // two ever came from different calls the flow would look correct until the
    // exchange, which fails with a message about neither of them.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(prepared.codeVerifier)
    );
    const expected = Buffer.from(digest).toString("base64url");
    expect(challenge).toBe(expected);
  });

  it("mints a fresh, unguessable state each time", async () => {
    const first = await prepare(fakeFetch());
    const second = await prepare(fakeFetch());

    expect(first.state).not.toBe(second.state);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
    expect(new URL(first.authorizationUrl).searchParams.get("state")).toBe(
      first.state
    );
  });

  it("keeps a blocked target a refusal the discovery walk cannot swallow", async () => {
    // Every leg against the target is refused, which is what actually happens
    // when its hostname resolves to a reserved address.
    const blocked = (async (input: URL | RequestInfo) => {
      if (String(input).includes("target.example.com")) {
        throw new BlockedEgressTargetError(
          "resolves to a private or reserved address"
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    // The discovery walk is half-swallowing here, and this pins which half.
    // `discoverOAuthServerInfo` catches a failed RESOURCE-metadata leg, so that
    // refusal is lost; the authorization-server walk that follows is outside
    // that catch and re-throws anything that is not a `TypeError`, so this one
    // survives. If that ever changed, a blocked target would arrive as an
    // ABSENCE of metadata and be reported as "this server does not publish
    // metadata" — a claim about the user's server we never actually asked, and
    // one that puts a "try again" button in front of an address the guard will
    // refuse every time.
    await expect(prepare(blocked)).rejects.toMatchObject({
      name: "AuthorizationPrepareError",
      code: "URL_NOT_ALLOWED",
    });
  });

  it("refuses to guess an endpoint when metadata is unreadable", async () => {
    const noMetadata = fakeFetch({
      resource: () => new Response("nope", { status: 404 }),
      authorizationServer: () => new Response("nope", { status: 404 }),
    });

    // The SDK will fall back to `/authorize` on the origin if asked. Sending a
    // user to a guessed path on a server that never advertised one is worse
    // than telling them the server did not publish metadata.
    await expect(prepare(noMetadata)).rejects.toMatchObject({
      code: "NO_AUTHORIZATION_SERVER",
    });
  });

  it("reports a refused registration as its own failure", async () => {
    const refused = fakeFetch({
      register: () => new Response("no dynamic registration", { status: 403 }),
    });

    await expect(prepare(refused)).rejects.toBeInstanceOf(
      AuthorizationPrepareError
    );
    await expect(prepare(refused)).rejects.toMatchObject({
      code: "REGISTRATION_FAILED",
    });
  });

  it("registers a client that can actually receive this callback", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const capturing = fakeFetch({
      register: () =>
        jsonResponse({ client_id: "cid", client_secret: undefined }),
    });
    const wrapped = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).includes("/register")) {
        seen.push(JSON.parse(String(init.body)));
      }
      return await capturing(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    await prepare(wrapped);

    // A registration that omitted this redirect URI would produce a client the
    // provider refuses to redirect back to — discovered only after the user
    // has already granted consent.
    expect(seen[0]?.redirect_uris).toEqual([REDIRECT_URI]);
    expect(seen[0]?.client_name).toBe("MCPJam - Target");
  });
});
