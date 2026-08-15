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

/**
 * Metadata is a document fetched from a host the user named, and three fields
 * in it decide something security-relevant. Each is checked rather than
 * believed, and each check is here because believing it produces a flow that
 * looks completely normal while proving nothing.
 */
describe("what it refuses to believe about the metadata", () => {
  it("refuses an issuer that is not the address the metadata came from", async () => {
    const lying = fakeFetch({
      authorizationServer: () =>
        jsonResponse({ ...AS_METADATA, issuer: "https://attacker.example" }),
    });

    // `issuer` becomes the trust anchor for the callback's RFC 9207 `iss`
    // check. Recording the claim verbatim would have that check compare an
    // assertion with itself — a document naming any issuer it likes would
    // validate perfectly. RFC 8414 §3.3 says the issuer IS the address the
    // metadata was published at, so it is a comparison we can actually make.
    await expect(prepare(lying)).rejects.toMatchObject({
      code: "UNTRUSTWORTHY_METADATA",
    });
  });

  it("refuses metadata with no issuer at all", async () => {
    const anonymous = fakeFetch({
      authorizationServer: () => {
        const { issuer: _dropped, ...rest } = AS_METADATA;
        return jsonResponse(rest);
      },
    });

    await expect(prepare(anonymous)).rejects.toMatchObject({
      code: "UNTRUSTWORTHY_METADATA",
    });
  });

  it("accepts an issuer that differs only by a trailing slash", async () => {
    const trailing = fakeFetch({
      authorizationServer: () =>
        jsonResponse({ ...AS_METADATA, issuer: "https://auth.example.com/" }),
    });

    // A trailing slash is not a different issuer, and refusing over one would
    // reject a large share of real providers.
    await expect(prepare(trailing)).resolves.toMatchObject({
      issuer: "https://auth.example.com/",
    });
  });

  it("refuses a resource indicator pointing somewhere else", async () => {
    const misdirecting = fakeFetch({
      resource: () =>
        jsonResponse({
          resource: "https://other.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        }),
    });

    // RFC 8707's `resource` binds the token to one server. Passing an
    // advertised value through on trust would let a target's own metadata
    // obtain a token valid against a DIFFERENT resource than the one the user
    // approved.
    await expect(prepare(misdirecting)).rejects.toMatchObject({
      code: "UNTRUSTWORTHY_METADATA",
    });
  });

  it.each(["javascript:alert(document.domain)", "data:text/html,<h1>hi</h1>"])(
    "refuses an authorization endpoint the browser must never be sent to (%s)",
    async (endpoint) => {
      // `authorization_endpoint` comes out of the same attacker-authored
      // document as the issuer, and it flows into `window.location.assign` on
      // the handoff origin — next to the continuation cookie's routes. The
      // issuer check does nothing for this field, and "the browser blocks
      // script-initiated javascript: navigation" is the browser's mitigation,
      // not this module's excuse.
      const hostile = fakeFetch({
        authorizationServer: () =>
          jsonResponse({ ...AS_METADATA, authorization_endpoint: endpoint }),
      });

      await expect(prepare(hostile)).rejects.toMatchObject({
        code: "UNTRUSTWORTHY_METADATA",
      });
    }
  );

  it("refuses a plaintext authorization endpoint on a public host", async () => {
    // An http:// consent page would carry the authorization code back over
    // cleartext. Loopback is the one legitimate http: authorization server —
    // the same carve-out the transport itself makes.
    const plaintext = fakeFetch({
      authorizationServer: () =>
        jsonResponse({
          ...AS_METADATA,
          authorization_endpoint: "http://auth.example.com/authorize",
        }),
    });

    await expect(prepare(plaintext)).rejects.toMatchObject({
      code: "UNTRUSTWORTHY_METADATA",
    });
  });
});

describe("registering the client", () => {
  async function registrationBody(metadataOverride: Record<string, unknown>) {
    const seen: Array<Record<string, unknown>> = [];
    const base = fakeFetch({
      authorizationServer: () =>
        jsonResponse({ ...AS_METADATA, ...metadataOverride }),
    });
    const capturing = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).includes("/register")) {
        seen.push(JSON.parse(String(init.body)));
      }
      return await base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
    await prepare(capturing);
    return seen[0];
  }

  it("asks for an auth method the server says it supports", async () => {
    const body = await registrationBody({
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    });

    // Naming a method the server does not accept gets the registration
    // rejected outright, which reads to the user as "this server refused you".
    expect(body?.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("prefers client_secret_post when the server offers it", async () => {
    const body = await registrationBody({
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
      ],
    });

    expect(body?.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("refuses a method it cannot perform instead of registering one", async () => {
    // Registering with a method we cannot use buys a client record and then a
    // failure one step later, at the token exchange, reported as a credential
    // problem rather than a capability one.
    await expect(
      registrationBody({
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
      })
    ).rejects.toMatchObject({ code: "REGISTRATION_FAILED" });
  });

  it("does not register a client for an authorization it is about to refuse", async () => {
    const seen: string[] = [];
    const misdirecting = fakeFetch({
      resource: () =>
        jsonResponse({
          resource: "https://other.example.com/mcp",
          authorization_servers: ["https://auth.example.com"],
        }),
    });
    const watching = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST" && String(input).includes("/register")) {
        seen.push(String(input));
      }
      return await misdirecting(input as RequestInfo, init);
    }) as unknown as typeof fetch;

    await expect(prepare(watching)).rejects.toMatchObject({
      code: "UNTRUSTWORTHY_METADATA",
    });
    // Registration CREATES something on the provider's side. Checking the
    // resource afterwards would leave that record behind for an authorization
    // that was refused.
    expect(seen).toEqual([]);
  });

  it("says nothing when the server advertises nothing", async () => {
    const body = await registrationBody({
      token_endpoint_auth_methods_supported: undefined,
    });

    // Asserting a capability on the server's behalf is a guess. Omitting the
    // field lets it apply its own default, which it actually knows.
    expect(body).not.toHaveProperty("token_endpoint_auth_method");
  });
});

describe("the deadline", () => {
  it("aborts the work instead of only abandoning it", async () => {
    const seen: AbortSignal[] = [];
    const hanging = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.signal) seen.push(init.signal);
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted"))
        );
      });
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    try {
      const pending = prepare(hanging);
      const assertion = expect(pending).rejects.toMatchObject({
        code: "UNREACHABLE",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }

    // Racing alone leaves the work running, and one of the things it does is
    // register an OAuth client with a third party — a side effect for an
    // attempt nobody is waiting for any more.
    expect(seen[0]?.aborted).toBe(true);
  });
});
