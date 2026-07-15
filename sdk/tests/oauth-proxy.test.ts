import dns from "node:dns/promises";
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
  fetchPinnedPublicDocument,
  isDisallowedIpAddress,
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

describe("isDisallowedIpAddress (RFC 6890 special-use)", () => {
  const disallowed = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1", // CGNAT
    "127.0.0.1",
    "169.254.1.1", // link-local
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.5", // TEST-NET-1
    "192.168.1.1",
    "198.18.0.1", // benchmarking
    "198.51.100.7", // TEST-NET-2
    "203.0.113.9", // TEST-NET-3
    "224.0.0.1", // multicast
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback (dotted)
    "::ffff:10.0.0.1",
    "::ffff:7f00:1", // IPv4-mapped loopback (HEX form — the P0 bypass)
    "::ffff:7f00:0001",
    "[::ffff:7f00:1]", // bracketed literal
    "::7f00:1", // deprecated IPv4-compatible loopback
    "100:0:0:0:0:0:0:1", // 100::/64 discard, fully expanded
    "fe80:0:0:0:0:0:0:1", // link-local expanded
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.0.1", // just outside 172.16/12
    "172.32.0.1",
    "100.63.255.255", // just outside CGNAT
    "100.128.0.1",
    "198.20.0.1", // just outside 198.18/15
    "2606:4700:4700::1111",
  ];

  it.each(disallowed)("rejects %s", (ip) => {
    expect(isDisallowedIpAddress(ip)).toBe(true);
  });
  it.each(allowed)("allows %s", (ip) => {
    expect(isDisallowedIpAddress(ip)).toBe(false);
  });
});

describe("fetchPinnedPublicDocument guards", () => {
  it("rejects a non-HTTPS URL before any connection", async () => {
    await expect(
      fetchPinnedPublicDocument("http://example.com/meta.json")
    ).rejects.toThrow(/HTTPS/i);
  });

  it("rejects a literal private/reserved host before any connection", async () => {
    await expect(
      fetchPinnedPublicDocument("https://127.0.0.1/meta.json")
    ).rejects.toThrow(/private or reserved/i);
  });
});
