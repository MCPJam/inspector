import dns from "node:dns/promises";
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
} from "../src/oauth-proxy.js";

vi.mock("node:dns/promises", () => ({
  __esModule: true,
  default: {
    resolve4: vi.fn().mockResolvedValue([]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

describe("oauth-proxy helpers", () => {
  beforeEach(() => {
    global.fetch = vi.fn() as unknown as typeof fetch;
  });

  it("blocks private hosts when httpsOnly is enabled", async () => {
    await expect(
      executeOAuthProxy({
        url: "https://127.0.0.1/foo",
        httpsOnly: true,
      })
    ).rejects.toBeInstanceOf(OAuthProxyError);

    await expect(
      executeOAuthProxy({
        url: "https://127.0.0.1/foo",
        httpsOnly: true,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("preserves the original hostname when fetching a validated URL", async () => {
    vi.mocked(dns.resolve4).mockResolvedValueOnce(["93.184.216.34"]);
    vi.mocked(dns.resolve6).mockResolvedValueOnce([]);

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await executeOAuthProxy({
      url: "https://example.com/path",
      httpsOnly: true,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://example.com/path"),
      expect.any(Object)
    );
  });

  it("returns metadata for valid JSON responses", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      fetchOAuthMetadata("https://auth.example.com/.well-known/oauth")
    ).resolves.toEqual({
      metadata: { issuer: "https://auth.example.com" },
    });
  });

  it("bounds regular, debug, and metadata requests with timeoutMs", async () => {
    global.fetch = vi.fn(async (_input, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      executeOAuthProxy({ url: "https://example.com", timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
    await expect(
      executeDebugOAuthProxy({ url: "https://example.com", timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
    await expect(
      fetchOAuthMetadata("https://example.com/.well-known/oauth", false, 10)
    ).rejects.toThrow(/timeout/i);
  });

  describe("redirect option plumbing", () => {
    const jsonResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const lastFetchRedirect = () =>
      (global.fetch as jest.Mock).mock.calls.at(-1)?.[1]?.redirect;

    it.each([executeOAuthProxy, executeDebugOAuthProxy])(
      "%o honors an explicit manual redirect without httpsOnly",
      async (proxyFn) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse());
        await proxyFn({
          url: "http://localhost:3000/client.json",
          redirect: "manual",
        });
        expect(lastFetchRedirect()).toBe("manual");
      }
    );

    it("preserves the historical follow default when redirect is omitted", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse());
      await executeDebugOAuthProxy({ url: "http://localhost:3000/metadata" });
      expect(lastFetchRedirect()).toBe("follow");
    });

    it("cannot weaken httpsOnly to follow with an explicit redirect", async () => {
      vi.mocked(dns.resolve4).mockResolvedValueOnce(["93.184.216.34"]);
      vi.mocked(dns.resolve6).mockResolvedValueOnce([]);
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse());
      await executeDebugOAuthProxy({
        url: "https://example.com/metadata",
        httpsOnly: true,
        redirect: "follow",
      });
      expect(lastFetchRedirect()).toBe("manual");
    });
  });
});
