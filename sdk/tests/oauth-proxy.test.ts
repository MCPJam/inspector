import dns from "node:dns/promises";
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../src/oauth-proxy.js";

jest.mock("node:dns/promises", () => ({
  __esModule: true,
  default: {
    resolve4: jest.fn().mockResolvedValue([]),
    resolve6: jest.fn().mockResolvedValue([]),
  },
}));

describe("oauth-proxy helpers", () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it("blocks private hosts when httpsOnly is enabled", async () => {
    await expect(
      executeOAuthProxy({
        url: "https://127.0.0.1/foo",
        httpsOnly: true,
      }),
    ).rejects.toBeInstanceOf(OAuthProxyError);

    await expect(
      executeOAuthProxy({
        url: "https://127.0.0.1/foo",
        httpsOnly: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("preserves the original hostname when fetching a validated URL", async () => {
    jest.mocked(dns.resolve4).mockResolvedValueOnce(["93.184.216.34"]);
    jest.mocked(dns.resolve6).mockResolvedValueOnce([]);

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await executeOAuthProxy({
      url: "https://example.com/path",
      httpsOnly: true,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/path"),
      expect.any(Object),
    );
  });

  it("returns metadata for valid JSON responses", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      fetchOAuthMetadata("https://auth.example.com/.well-known/oauth"),
    ).resolves.toEqual({
      metadata: { issuer: "https://auth.example.com" },
    });
  });
});
