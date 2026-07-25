import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  executeDebugOAuthProxy,
  executeOAuthProxy,
  fetchOAuthMetadata,
  fetchPinnedPublicDocument,
  isDisallowedIpAddress,
  OAuthProxyError,
} from "../src/oauth-proxy.js";

const httpRequestMock = vi.hoisted(() => vi.fn());
const httpsRequestMock = vi.hoisted(() => vi.fn());
const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  __esModule: true,
  default: {
    resolve4: vi.fn().mockResolvedValue([]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("node:dns", () => ({
  __esModule: true,
  lookup: dnsLookupMock,
}));
vi.mock("node:http", () => ({
  __esModule: true,
  default: { request: httpRequestMock },
  request: httpRequestMock,
}));
vi.mock("node:https", () => ({
  __esModule: true,
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

interface MockMetadataResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  response?: Readable;
}

function queueMetadataResponses(
  requestMock: ReturnType<typeof vi.fn>,
  responses: MockMetadataResponse[]
): void {
  requestMock.mockImplementation(
    (
      _url: URL,
      options: { signal?: AbortSignal },
      onResponse: (response: Readable) => void
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        destroy: () => void;
      };
      request.end = () => {
        const next = responses.shift();
        if (!next) {
          options.signal?.addEventListener(
            "abort",
            () => request.emit("error", options.signal?.reason),
            { once: true }
          );
          return;
        }
        queueMicrotask(() => {
          const response =
            next.response ?? Readable.from(next.body ? [next.body] : []);
          Object.assign(response, {
            statusCode: next.status ?? 200,
            statusMessage: next.statusText ?? "OK",
            headers: next.headers ?? {
              "content-type": "application/json",
            },
          });
          onResponse(response);
        });
      };
      request.destroy = () => {};
      return request;
    }
  );
}

describe("oauth-proxy helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn() as unknown as typeof fetch;
    vi.mocked(dns.resolve4).mockResolvedValue(["93.184.216.34"]);
    vi.mocked(dns.resolve6).mockResolvedValue([]);
    dnsLookupMock.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) => callback(null, [{ address: "93.184.216.34", family: 4 }])
    );
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

  it("reports the upstream final URL for generic OAuth proxy responses", async () => {
    const upstreamResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(upstreamResponse, "url", {
      value: "https://cdn.example.com/oauth/token",
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce(upstreamResponse);

    await expect(
      executeOAuthProxy({ url: "https://auth.example.com/oauth/token" })
    ).resolves.toMatchObject({
      finalUrl: "https://cdn.example.com/oauth/token",
    });
  });

  it("returns metadata for valid JSON responses", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        body: JSON.stringify({ issuer: "https://auth.example.com" }),
      },
    ]);

    await expect(
      fetchOAuthMetadata("https://auth.example.com/.well-known/oauth")
    ).resolves.toEqual({
      metadata: { issuer: "https://auth.example.com" },
      finalUrl: "https://auth.example.com/.well-known/oauth",
    });
    expect(httpsRequestMock.mock.calls[0][1].headers).toMatchObject({
      "Accept-Encoding": "identity",
    });
  });

  it("rejects a public metadata request redirected to loopback", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: {
          location: "http://127.0.0.1:8787/.well-known/oauth",
        },
      },
    ]);

    await expect(
      fetchOAuthMetadata("https://auth.example.com/.well-known/oauth")
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("private/reserved host"),
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("allows loopback metadata to remain on loopback for an explicit local flow", async () => {
    dnsLookupMock.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) => callback(null, [{ address: "127.0.0.1", family: 4 }])
    );
    queueMetadataResponses(httpRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: {
          location: "http://127.0.0.1:8787/.well-known/oauth",
        },
      },
      {
        body: JSON.stringify({ issuer: "http://127.0.0.1:8787" }),
      },
    ]);

    await expect(
      fetchOAuthMetadata("http://localhost:8787/.well-known/oauth")
    ).resolves.toEqual({
      metadata: { issuer: "http://127.0.0.1:8787" },
      finalUrl: "http://127.0.0.1:8787/.well-known/oauth",
    });
  });

  it("rejects loopback metadata in hosted HTTPS-only mode", async () => {
    await expect(
      fetchOAuthMetadata("https://localhost/.well-known/oauth", true)
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("private/reserved host"),
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("rejects a public-looking metadata hostname that resolves privately in local mode", async () => {
    dnsLookupMock.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) => callback(null, [{ address: "10.0.0.5", family: 4 }])
    );

    await expect(
      fetchOAuthMetadata("http://attacker.example/.well-known/oauth")
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(
        "resolves to a private/reserved IP address"
      ),
    });
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("validates and pins each public redirect hop before connecting", async () => {
    const redirectResponse = new Readable({
      read() {
        // Deliberately never end: redirect bodies must be destroyed after the
        // headers rather than drained without a bound.
      },
    });
    dnsLookupMock
      .mockImplementationOnce(
        (
          _hostname: string,
          _options: unknown,
          callback: (error: Error | null, addresses: unknown) => void
        ) => callback(null, [{ address: "93.184.216.34", family: 4 }])
      )
      .mockImplementationOnce(
        (
          _hostname: string,
          _options: unknown,
          callback: (error: Error | null, addresses: unknown) => void
        ) => callback(null, [{ address: "1.1.1.1", family: 4 }])
      );
    queueMetadataResponses(httpsRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: { location: "https://cdn.example/oauth-metadata" },
        response: redirectResponse,
      },
      {
        body: JSON.stringify({ issuer: "https://auth.example.com" }),
      },
    ]);

    await expect(
      fetchOAuthMetadata("https://auth.example.com/.well-known/oauth")
    ).resolves.toEqual({
      metadata: { issuer: "https://auth.example.com" },
      finalUrl: "https://cdn.example/oauth-metadata",
    });

    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    const firstLookup = httpsRequestMock.mock.calls[0][1].lookup;
    const secondLookup = httpsRequestMock.mock.calls[1][1].lookup;
    expect(firstLookup).toBeTypeOf("function");
    expect(secondLookup).toBeTypeOf("function");
    expect(firstLookup).not.toBe(secondLookup);
    await expect(
      new Promise((resolve, reject) =>
        firstLookup(
          "auth.example.com",
          { all: true },
          (
            error: Error | null,
            addresses: Array<{ address: string; family: number }>
          ) => (error ? reject(error) : resolve(addresses))
        )
      )
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      new Promise((resolve, reject) =>
        secondLookup(
          "cdn.example",
          { all: true },
          (
            error: Error | null,
            addresses: Array<{ address: string; family: number }>
          ) => (error ? reject(error) : resolve(addresses))
        )
      )
    ).resolves.toEqual([{ address: "1.1.1.1", family: 4 }]);
    expect(redirectResponse.destroyed).toBe(true);
  });

  it("includes DNS resolution in the metadata timeout", async () => {
    dnsLookupMock.mockImplementation(() => {
      // Simulate a resolver that never calls back.
    });

    await expect(
      fetchOAuthMetadata("https://example.com/.well-known/oauth", false, 10)
    ).rejects.toThrow(/timeout/i);
    expect(httpsRequestMock).not.toHaveBeenCalled();
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
    queueMetadataResponses(httpsRequestMock, []);
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
