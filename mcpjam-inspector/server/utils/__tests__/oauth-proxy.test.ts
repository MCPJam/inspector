import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { executeOAuthProxy, OAuthProxyError } from "../oauth-proxy.js";

const httpRequestMock = vi.hoisted(() => vi.fn());
const httpsRequestMock = vi.hoisted(() => vi.fn());
const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns", () => ({
  lookup: dnsLookupMock,
}));
vi.mock("node:http", () => ({
  default: { request: httpRequestMock },
  request: httpRequestMock,
}));
vi.mock("node:https", () => ({
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

function installSuccessfulRequestMock(requestMock: ReturnType<typeof vi.fn>) {
  requestMock.mockImplementation(
    (
      _url: URL,
      _options: unknown,
      onResponse: (response: Readable) => void,
    ) => {
      const request = new EventEmitter() as EventEmitter & {
        end: () => void;
        write: () => void;
      };
      request.write = vi.fn();
      request.end = () => {
        queueMicrotask(() => {
          const response = Readable.from([JSON.stringify({ ok: true })]);
          Object.assign(response, {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "content-type": "application/json" },
          });
          onResponse(response);
        });
      };
      return request;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dnsLookupMock.mockImplementation(
    (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: unknown) => void,
    ) => callback(null, [{ address: "93.184.216.34", family: 4 }]),
  );
  installSuccessfulRequestMock(httpRequestMock);
  installSuccessfulRequestMock(httpsRequestMock);
});

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
    const result = await executeOAuthProxy({
      url: "https://example.com/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows an explicit loopback URL when httpsOnly is false", async () => {
    const result = await executeOAuthProxy({
      url: "http://127.0.0.1",
      httpsOnly: false,
    });
    expect(result.status).toBe(200);
  });
});

describe("IPv6 checks must not false-positive on hostnames", () => {
  it("allows https://fdroid.org (hostname starts with 'fd')", async () => {
    const result = await executeOAuthProxy({
      url: "https://fdroid.org/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows https://fc-example.com (hostname starts with 'fc')", async () => {
    const result = await executeOAuthProxy({
      url: "https://fc-example.com/foo",
      httpsOnly: true,
    });
    expect(result.status).toBe(200);
  });

  it("allows https://fe90.example.com (hostname matches fe80::/10 regex)", async () => {
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

describe("DNS validation — pinned request preserves original hostname for TLS", () => {
  it("uses the original hostname while pinning the validated address", async () => {
    await executeOAuthProxy({
      url: "https://example.com/path",
      httpsOnly: true,
    });

    expect(httpsRequestMock.mock.calls[0][0]).toEqual(
      new URL("https://example.com/path"),
    );
    expect(httpsRequestMock.mock.calls[0][1].servername).toBe("example.com");
    expect(httpsRequestMock.mock.calls[0][1].lookup).toBeTypeOf("function");
  });
});

describe("DNS rebinding protection (httpsOnly)", () => {
  it("blocks a hostname that resolves to a private IPv4", async () => {
    dnsLookupMock.mockImplementationOnce(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void,
      ) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
    );

    await expect(
      executeOAuthProxy({
        url: "https://evil.example.com/foo",
        httpsOnly: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks a hostname that resolves to a private IPv6", async () => {
    dnsLookupMock.mockImplementationOnce(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void,
      ) => callback(null, [{ address: "::1", family: 6 }]),
    );

    await expect(
      executeOAuthProxy({
        url: "https://evil.example.com/bar",
        httpsOnly: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
