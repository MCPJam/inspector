import { describe, expect, it, vi } from "vitest";
import { executeOAuthProxy, OAuthProxyError } from "../oauth-proxy.js";

// Mock dns.resolve4/resolve6 to return empty by default (public hostname)
vi.mock("node:dns/promises", () => ({
  default: {
    resolve4: vi.fn().mockResolvedValue([]),
    resolve6: vi.fn().mockResolvedValue([]),
  },
}));

// Mock fetch globally so valid URLs don't make real requests
const fetchMock = vi.fn().mockResolvedValue({
  status: 200,
  statusText: "OK",
  headers: new Headers(),
  json: async () => ({ ok: true }),
  text: async () => "",
});
vi.stubGlobal("fetch", fetchMock);

describe("validateUrl — private IP blocking (httpsOnly)", () => {
  const privateHosts = [
    "https://127.0.0.1/foo",
    "https://10.0.0.1/foo",
    "https://172.16.0.1/foo",
    "https://192.168.1.1/foo",
    "https://169.254.169.254/foo",
    "https://[::1]/foo",
    "https://0.0.0.0/foo",
    "https://localhost/foo",
    "https://[::]/foo",
    "https://[fc00::1]/foo",
    "https://[fd12::1]/foo",
    "https://[fe80::1]/foo",
    "https://[fe90::1]/foo",
    "https://[fea0::1]/foo",
    "https://[febf::1]/foo",
  ];

  for (const url of privateHosts) {
    it(`blocks ${url} when httpsOnly`, async () => {
      await expect(executeOAuthProxy({ url, httpsOnly: true })).rejects.toThrow(
        OAuthProxyError,
      );

      await expect(
        executeOAuthProxy({ url, httpsOnly: true }),
      ).rejects.toMatchObject({ status: 400 });
    });
  }

  it("allows https://example.com/foo when httpsOnly", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "https://example.com/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows http://127.0.0.1 when httpsOnly is false (no IP blocking)", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "http://127.0.0.1",
      httpsOnly: false,
    });
    expect(result.status).toBe(200);
  });
});

describe("IPv6 checks must not false-positive on hostnames", () => {
  it("allows https://fdroid.org (hostname starts with 'fd')", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "https://fdroid.org/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows https://fc-example.com (hostname starts with 'fc')", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "https://fc-example.com/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows https://fe90.example.com (hostname matches fe80::/10 regex)", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    const result = await executeOAuthProxy({
      url: "https://fe90.example.com/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("still blocks actual IPv6 private addresses like [fc00::1]", async () => {
    await expect(
      executeOAuthProxy({ url: "https://[fc00::1]/foo", httpsOnly: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("still blocks actual IPv6 link-local like [fe80::1]", async () => {
    await expect(
      executeOAuthProxy({ url: "https://[fe80::1]/foo", httpsOnly: true }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("DNS validation — fetch preserves original hostname for TLS", () => {
  it("uses the original hostname in the fetch URL (not the resolved IP)", async () => {
    const dns = await import("node:dns/promises");
    vi.mocked(dns.default.resolve4).mockResolvedValueOnce(["93.184.216.34"]);
    vi.mocked(dns.default.resolve6).mockResolvedValueOnce([]);

    fetchMock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ ok: true }),
      text: async () => "",
    });

    await executeOAuthProxy({
      url: "https://example.com/path",
      httpsOnly: true,
    });

    // fetch must use the original hostname so TLS cert validation works
    const calledUrl = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0];
    expect(calledUrl).toContain("example.com");
    expect(calledUrl).not.toContain("93.184.216.34");
  });
});

describe("DNS rebinding protection (httpsOnly)", () => {
  it("blocks a hostname that resolves to a private IPv4", async () => {
    const dns = await import("node:dns/promises");
    vi.mocked(dns.default.resolve4).mockResolvedValueOnce(["127.0.0.1"]);
    vi.mocked(dns.default.resolve6).mockResolvedValueOnce([]);

    await expect(
      executeOAuthProxy({
        url: "https://evil.example.com/foo",
        httpsOnly: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks a hostname that resolves to a private IPv6", async () => {
    const dns = await import("node:dns/promises");
    vi.mocked(dns.default.resolve4).mockResolvedValueOnce([]);
    vi.mocked(dns.default.resolve6).mockResolvedValueOnce(["::1"]);

    await expect(
      executeOAuthProxy({
        url: "https://evil.example.com/bar",
        httpsOnly: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
