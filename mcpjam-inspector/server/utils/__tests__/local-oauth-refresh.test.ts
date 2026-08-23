import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostedModeMock = vi.hoisted(() => ({ value: false }));
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedModeMock.value;
    },
  };
});

import { refreshTokensAgainstPrivateAuthorizationServer } from "../local-oauth-refresh.js";

const MATERIAL = {
  authorizationServerUrl: "http://localhost:8001",
  serverUrl: "http://localhost:8001/mcp",
  oauthResourceUrl: "http://localhost:8001",
  clientId: "client-1",
  refreshToken: "stored-refresh-token",
};

/**
 * The hosts actually dialed, compared exactly.
 *
 * Deliberately not `url.includes("evil.example.com")`: these assertions are the
 * whole point of the guard tests, and a substring match is a bad way to make
 * them. It passes for `http://localhost:8001/?next=evil.example.com` (no
 * request reached the attacker, but the URL mentions them) and fails to catch
 * `http://evil.example.com.attacker.test` (a different host that contains the
 * string). CodeQL flags the pattern for exactly this reason.
 */
function hostnamesOf(urls: string[]): string[] {
  return urls.map((url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  });
}

describe("refreshTokensAgainstPrivateAuthorizationServer", () => {
  beforeEach(() => {
    hostedModeMock.value = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses in hosted mode, before dialing anything", async () => {
    // A deployed instance has no user machine on the other end of a private
    // address, whatever a caller asks for.
    hostedModeMock.value = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshTokensAgainstPrivateAuthorizationServer(MATERIAL)
    ).rejects.toThrow(/hosted mode/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a public authorization server, before dialing anything", async () => {
    // The URL arrives in a response body. Re-asserting it locally is what stops
    // a wrong or malicious backend response from steering this refresh at an
    // attacker's host WITH THE USER'S REFRESH TOKEN.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshTokensAgainstPrivateAuthorizationServer({
        ...MATERIAL,
        authorizationServerUrl: "https://evil.example.com",
      })
    ).rejects.toThrow(/not on a private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a metadata document that advertises a public token endpoint", async () => {
    // The starting URL being private proves nothing about where the grant
    // goes: fetchToken POSTs to metadata.token_endpoint, which the (possibly
    // compromised) server itself controls. Every dialed URL must be private,
    // or the refresh token walks out.
    const dialed: string[] = [];
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      dialed.push(url);
      if (url.includes("/.well-known/")) {
        return new Response(
          JSON.stringify({
            issuer: "http://localhost:8001",
            authorization_endpoint: "http://localhost:8001/authorize",
            token_endpoint: "https://evil.example.com/token",
            response_types_supported: ["code"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ access_token: "should-never-arrive" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshTokensAgainstPrivateAuthorizationServer(MATERIAL)
    ).rejects.toThrow(/token endpoint is not on a private address/i);
    expect(hostnamesOf(dialed)).not.toContain("evil.example.com");
  });

  it("refuses a cloud-metadata address even though it is technically private", async () => {
    // GUARDRAIL. 169.254.169.254 is link-local, so "is the backend unable to
    // reach it?" says yes — but it is never a legitimate target in any mode,
    // and answering it is an IAM credential leak. The refresh path must
    // intersect "private" with the never-dial tier the rest of the codebase
    // already enforces, not just trust the first answer.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const authorizationServerUrl of [
      "http://169.254.169.254",
      "http://metadata.google.internal",
      "http://0.0.0.0:8001",
    ]) {
      await expect(
        refreshTokensAgainstPrivateAuthorizationServer({
          ...MATERIAL,
          authorizationServerUrl,
        })
      ).rejects.toThrow(/never dials/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts loopback spellings the backend also calls private", async () => {
    // A trailing dot is the same NAME to a resolver, and `new URL()` rewrites
    // an IPv4-mapped IPv6 literal into hex. Both used to be refused as "not on
    // a private address" for a perfectly ordinary localhost server.
    for (const host of [
      "http://localhost.:8001",
      "http://[::ffff:127.0.0.1]",
    ]) {
      const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        refreshTokensAgainstPrivateAuthorizationServer({
          ...MATERIAL,
          authorizationServerUrl: host,
        })
      ).rejects.not.toThrow(/private address|never dials/i);
      expect(fetchMock).toHaveBeenCalled();
    }
  });

  it("follows a redirecting authorization server during discovery", async () => {
    // A private AS behind a proxy legitimately 301s http→https or redirects
    // one well-known path to another. Refusing every 3xx made discovery yield
    // NO metadata, sent the grant to a guessed origin-relative /token, and
    // told the user the server could not be reached — for a server that
    // answered every request.
    const dialed: string[] = [];
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      dialed.push(url);
      if (
        url === "http://localhost:8001/.well-known/oauth-authorization-server"
      ) {
        return new Response(null, {
          status: 302,
          headers: { location: "/.well-known/openid-configuration" },
        });
      }
      if (url.includes("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "http://localhost:8001",
            authorization_endpoint: "http://localhost:8001/authorize",
            token_endpoint: "http://localhost:8001/oauth/token",
            response_types_supported: ["code"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/.well-known/")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({ access_token: "fresh", token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshTokensAgainstPrivateAuthorizationServer(
      MATERIAL
    );

    expect(tokens.access_token).toBe("fresh");
    // The redirect was followed, and the grant reached the endpoint the
    // metadata named rather than a guessed default.
    expect(dialed).toContain(
      "http://localhost:8001/.well-known/openid-configuration"
    );
    expect(dialed).toContain("http://localhost:8001/oauth/token");
  });

  it("refuses a discovery redirect that leaves the private network", async () => {
    // Following redirects is what makes a proxied AS work; re-checking every
    // hop is what keeps it from becoming an open redirect to anywhere.
    const dialed: string[] = [];
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      dialed.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/.well-known/x" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshTokensAgainstPrivateAuthorizationServer(MATERIAL)
    ).rejects.toThrow();
    expect(hostnamesOf(dialed)).not.toContain("evil.example.com");
  });

  it("performs a refresh_token grant against the private authorization server", async () => {
    let tokenRequestBody: string | null = null;
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/.well-known/")) {
        return new Response(
          JSON.stringify({
            issuer: "http://localhost:8001",
            authorization_endpoint: "http://localhost:8001/authorize",
            token_endpoint: "http://localhost:8001/token",
            response_types_supported: ["code"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      tokenRequestBody =
        typeof init?.body === "string" ? init.body : String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          token_type: "Bearer",
          refresh_token: "rotated-refresh-token",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshTokensAgainstPrivateAuthorizationServer(
      MATERIAL
    );

    expect(tokens.access_token).toBe("fresh-access-token");
    expect(tokens.refresh_token).toBe("rotated-refresh-token");
    const params = new URLSearchParams(tokenRequestBody ?? "");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("stored-refresh-token");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0] instanceof Request ? call[0].url : call[0]);
      // Every request went to the private address and nowhere else.
      expect(url.startsWith("http://localhost:8001")).toBe(true);
      // ...and none of them may silently follow a redirect off it. The
      // per-request URL check above only sees the URL we ASK for. Discovery
      // uses "manual" because it re-checks each hop itself (see the redirect
      // tests below); the token POST refuses outright, because replaying a
      // body carrying a refresh token to a new location must never be
      // automatic.
      const redirect = (call[1] as RequestInit | undefined)?.redirect;
      expect(url.includes("/.well-known/") ? "manual" : "error").toBe(redirect);
    }
  });
});
