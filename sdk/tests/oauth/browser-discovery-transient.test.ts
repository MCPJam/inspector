import { discoverOAuthServerInfo } from "../../src/oauth/browser-auth.js";

describe("browser discovery transient failures", () => {
  it.each([429, 500, 502, 503])(
    "does not cache a fallback issuer after resource metadata HTTP %s",
    async (status) => {
      const fetchFn = vi.fn(
        async () => new Response("unavailable", { status })
      );
      await expect(
        discoverOAuthServerInfo("https://mcp.example.com/mcp", { fetchFn })
      ).rejects.toThrow(`HTTP ${status}`);
      expect(fetchFn.mock.calls).toHaveLength(1);
    }
  );
  it.each([429, 502, 503])(
    "does not treat an issuer HTTP %s as absent metadata",
    async (status) => {
      const fetchFn = vi
        .fn(async () => new Response("unavailable", { status }))
        .mockResolvedValueOnce(
          Response.json({
            resource: "https://mcp.example.com",
            authorization_servers: ["https://auth.example.com"],
          })
        );
      await expect(
        discoverOAuthServerInfo("https://mcp.example.com/mcp", { fetchFn })
      ).rejects.toThrow(`HTTP ${status}`);
    }
  );
  it.each([401, 403, 405])(
    "falls back to the origin's metadata when resource metadata answers HTTP %s",
    async (status) => {
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return url.includes("oauth-protected-resource")
          ? new Response("nope", { status })
          : Response.json({
              issuer: "https://mcp.example.com",
              authorization_endpoint: "https://mcp.example.com/authorize",
              token_endpoint: "https://mcp.example.com/token",
              response_types_supported: ["code"],
            });
      });
      await expect(
        discoverOAuthServerInfo("https://mcp.example.com/mcp", { fetchFn })
      ).resolves.toMatchObject({
        authorizationServerUrl: "https://mcp.example.com/",
      });
    }
  );
  it.each([
    ["null", null],
    [
      "an empty authorization_servers list",
      { resource: "https://mcp.example.com/mcp", authorization_servers: [] },
    ],
    ["a non-string authorization server", { authorization_servers: [42] }],
    [
      "an unparseable authorization server",
      { authorization_servers: ["not a url"] },
    ],
    [
      "authorization_servers that is not a list",
      { authorization_servers: "https://auth.example.com" },
    ],
  ])(
    "falls back to the origin's metadata when resource metadata is %s",
    async (_label, document) => {
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return url.includes("oauth-protected-resource")
          ? Response.json(document)
          : Response.json({
              issuer: "https://mcp.example.com",
              authorization_endpoint: "https://mcp.example.com/authorize",
              token_endpoint: "https://mcp.example.com/token",
              response_types_supported: ["code"],
            });
      });
      const info = await discoverOAuthServerInfo(
        "https://mcp.example.com/mcp",
        { fetchFn }
      );
      expect(info.authorizationServerUrl).toBe("https://mcp.example.com/");
      expect(info.resourceMetadata).toBeUndefined();
      expect(info.authorizationServerMetadata).toMatchObject({
        issuer: "https://mcp.example.com",
      });
    }
  );
});
