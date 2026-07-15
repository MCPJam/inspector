import { auth, selectResourceURL } from "../../src/oauth/browser-auth.js";

const SERVER_URL = "https://mcp.example.com/api/mcp";
const ADVERTISED_RESOURCE = "HTTPS://MCP.EXAMPLE.COM:443/api/";

function createProvider() {
  let tokens:
    | {
        access_token: string;
        refresh_token?: string;
        token_type: string;
      }
    | undefined;
  let redirectedTo: URL | undefined;

  const provider: any = {
    redirectUrl: "https://client.example.com/callback",
    clientMetadata: {
      client_name: "Resource wire-value test",
      redirect_uris: ["https://client.example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    discoveryState: jest.fn(async () => ({
      authorizationServerUrl: "https://auth.example.com",
      resourceMetadata: {
        resource: ADVERTISED_RESOURCE,
        authorization_servers: ["https://auth.example.com"],
      },
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        token_endpoint_auth_methods_supported: ["none"],
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
    })),
    clientInformation: jest.fn(async () => ({ client_id: "test-client" })),
    tokens: jest.fn(async () => tokens),
    saveTokens: jest.fn(async (nextTokens) => {
      tokens = nextTokens;
    }),
    state: jest.fn(async () => "test-state"),
    saveCodeVerifier: jest.fn(async () => undefined),
    codeVerifier: jest.fn(async () => "test-verifier"),
    redirectToAuthorization: jest.fn(async (url: URL) => {
      redirectedTo = url;
    }),
  };

  return {
    provider,
    getRedirectedTo: () => redirectedTo,
  };
}

describe("browser auth resource wire value", () => {
  it("preserves the advertised string across authorization, exchange, and refresh", async () => {
    const { provider, getRedirectedTo } = createProvider();
    const tokenRequests: URLSearchParams[] = [];
    const fetchFn: typeof fetch = jest.fn(async (_input, init) => {
      const params = new URLSearchParams(String(init?.body ?? ""));
      tokenRequests.push(params);
      return new Response(
        JSON.stringify({
          access_token: `access-${tokenRequests.length}`,
          refresh_token: "refresh-token",
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }) as typeof fetch;

    await expect(
      auth(provider, { serverUrl: SERVER_URL, fetchFn })
    ).resolves.toBe("REDIRECT");
    expect(getRedirectedTo()?.searchParams.get("resource")).toBe(
      ADVERTISED_RESOURCE
    );

    await expect(
      auth(provider, {
        serverUrl: SERVER_URL,
        authorizationCode: "authorization-code",
        fetchFn,
      })
    ).resolves.toBe("AUTHORIZED");
    expect(tokenRequests[0].get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0].get("resource")).toBe(ADVERTISED_RESOURCE);

    await expect(
      auth(provider, { serverUrl: SERVER_URL, fetchFn })
    ).resolves.toBe("AUTHORIZED");
    expect(tokenRequests[1].get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[1].get("resource")).toBe(ADVERTISED_RESOURCE);
  });

  it("keeps selectResourceURL's public URL return contract", async () => {
    const { provider } = createProvider();
    const resource = await selectResourceURL(
      SERVER_URL,
      provider,
      await provider
        .discoveryState()
        .then((state: any) => state.resourceMetadata)
    );

    expect(resource).toBeInstanceOf(URL);
  });
});
