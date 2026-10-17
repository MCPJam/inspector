import { discoverOAuthServerInfo } from "../../src/oauth/browser-auth.js";

describe("browser discovery transient failures", () => {
  it.each([429, 500, 502, 503])(
    "does not cache a fallback issuer after resource metadata HTTP %s",
    async (status) => {
      const fetchFn = vi.fn(async () => new Response("unavailable", { status }));
      await expect(
        discoverOAuthServerInfo("https://mcp.example.com/mcp", { fetchFn }),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(fetchFn.mock.calls).toHaveLength(1);
    },
  );
  it.each([429, 502, 503])(
    "does not treat an issuer HTTP %s as absent metadata",
    async (status) => {
      const fetchFn = vi
        .fn(async () => new Response("unavailable", { status }))
        .mockResolvedValueOnce(Response.json({
          resource: "https://mcp.example.com",
          authorization_servers: ["https://auth.example.com"],
        }));
      await expect(
        discoverOAuthServerInfo("https://mcp.example.com/mcp", { fetchFn }),
      ).rejects.toThrow(`HTTP ${status}`);
    },
  );
});
