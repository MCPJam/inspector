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
    // Every request went to the private address and nowhere else.
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0] instanceof Request ? call[0].url : call[0]);
      expect(url.startsWith("http://localhost:8001")).toBe(true);
    }
  });
});
