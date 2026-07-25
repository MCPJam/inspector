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

const requestWriteMocks: Array<ReturnType<typeof vi.fn>> = [];

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
        write: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn();
      requestWriteMocks.push(request.write);
      let activeResponse: Readable | undefined;
      const onAbort = () => {
        const reason =
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("Request aborted");
        if (activeResponse) {
          activeResponse.destroy(reason);
        } else {
          request.emit("error", reason);
        }
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      request.end = () => {
        const next = responses.shift();
        if (!next) {
          return;
        }
        queueMicrotask(() => {
          const response =
            next.response ?? Readable.from(next.body ? [next.body] : []);
          activeResponse = response;
          response.once("close", () =>
            options.signal?.removeEventListener("abort", onAbort)
          );
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
    requestWriteMocks.length = 0;
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

  it("rejects OAuth target URLs containing embedded credentials", async () => {
    await expect(
      executeOAuthProxy({
        url: "https://client:secret@auth.example.com/oauth/token",
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("must not contain credentials"),
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("preserves the original hostname when fetching a validated URL", async () => {
    queueMetadataResponses(httpsRequestMock, [
      { body: JSON.stringify({ ok: true }) },
    ]);

    await executeOAuthProxy({
      url: "https://example.com/path",
      httpsOnly: true,
    });

    expect(httpsRequestMock.mock.calls[0][0]).toEqual(
      new URL("https://example.com/path")
    );
    expect(httpsRequestMock.mock.calls[0][1]).toMatchObject({
      servername: "example.com",
      headers: {
        "accept-encoding": "identity",
      },
    });
    await expect(
      new Promise((resolve, reject) =>
        httpsRequestMock.mock.calls[0][1].lookup(
          "example.com",
          { all: true },
          (
            error: Error | null,
            addresses: Array<{ address: string; family: number }>
          ) => (error ? reject(error) : resolve(addresses))
        )
      )
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("reports the upstream final URL for generic OAuth proxy responses", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: { location: "https://cdn.example.com/oauth/token" },
      },
      { body: JSON.stringify({ ok: true }) },
    ]);

    await expect(
      executeOAuthProxy({ url: "https://auth.example.com/oauth/token" })
    ).resolves.toMatchObject({
      finalUrl: "https://cdn.example.com/oauth/token",
    });
  });

  it("rejects private or mixed DNS results before the generic proxy connects", async () => {
    dnsLookupMock.mockImplementation(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) =>
        callback(null, [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ])
    );

    await expect(
      executeOAuthProxy({ url: "https://attacker.example/oauth/token" })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("private/reserved IP address"),
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("fails closed when generic proxy DNS errors or returns no addresses", async () => {
    dnsLookupMock.mockImplementationOnce(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) => callback(new Error("ENOTFOUND"), [])
    );
    await expect(
      executeOAuthProxy({ url: "https://missing.example/oauth/token" })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Could not resolve"),
    });

    dnsLookupMock.mockImplementationOnce(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) => callback(null, [])
    );
    await expect(
      executeOAuthProxy({ url: "https://empty.example/oauth/token" })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Could not resolve"),
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", "http://127.0.0.1:8787/oauth/token"],
    ["LAN", "http://192.168.1.10/oauth/token"],
    ["link-local metadata service", "http://169.254.169.254/latest/meta-data"],
  ])(
    "rejects a generic public request redirected to %s before connecting",
    async (_destinationType, location) => {
      queueMetadataResponses(httpsRequestMock, [
        {
          status: 302,
          statusText: "Found",
          headers: { location },
        },
      ]);

      await expect(
        executeOAuthProxy({ url: "https://auth.example.com/oauth/token" })
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("private/reserved host"),
      });
      expect(httpsRequestMock).toHaveBeenCalledTimes(1);
      expect(httpRequestMock).not.toHaveBeenCalled();
    }
  );

  it("pins every generic public redirect hop", async () => {
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
        headers: { location: "https://cdn.example/oauth/token" },
      },
      { body: JSON.stringify({ access_token: "token" }) },
    ]);

    await expect(
      executeOAuthProxy({ url: "https://auth.example.com/oauth/token" })
    ).resolves.toMatchObject({
      status: 200,
      finalUrl: "https://cdn.example/oauth/token",
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);

    const resolvePinnedLookup = (
      lookup: (
        hostname: string,
        options: { all: true },
        callback: (
          error: Error | null,
          addresses: Array<{ address: string; family: number }>
        ) => void
      ) => void,
      hostname: string
    ) =>
      new Promise((resolve, reject) =>
        lookup(hostname, { all: true }, (error, addresses) =>
          error ? reject(error) : resolve(addresses)
        )
      );
    await expect(
      resolvePinnedLookup(
        httpsRequestMock.mock.calls[0][1].lookup,
        "auth.example.com"
      )
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      resolvePinnedLookup(
        httpsRequestMock.mock.calls[1][1].lookup,
        "cdn.example"
      )
    ).resolves.toEqual([{ address: "1.1.1.1", family: 4 }]);
  });

  it("allows an explicit loopback proxy flow to redirect to a validated public host", async () => {
    dnsLookupMock.mockImplementation(
      (
        hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) =>
        callback(null, [
          {
            address:
              hostname === "localhost" ? "127.0.0.1" : "93.184.216.34",
            family: 4,
          },
        ])
    );
    queueMetadataResponses(httpRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: { location: "https://public.example/oauth/token" },
      },
    ]);
    queueMetadataResponses(httpsRequestMock, [
      { body: JSON.stringify({ access_token: "token" }) },
    ]);

    await expect(
      executeOAuthProxy({ url: "http://localhost:8787/oauth/token" })
    ).resolves.toMatchObject({
      status: 200,
      finalUrl: "https://public.example/oauth/token",
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it("does not let an explicit loopback proxy flow redirect to a LAN host", async () => {
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
        headers: { location: "http://192.168.1.10/oauth/token" },
      },
    ]);

    await expect(
      executeOAuthProxy({ url: "http://localhost:8787/oauth/token" })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("private/reserved host"),
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("rewrites POST to GET and strips credentials on cross-origin 302", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: { location: "https://cdn.example/oauth/token" },
      },
      { body: JSON.stringify({ ok: true }) },
    ]);

    await executeOAuthProxy({
      url: "https://auth.example.com/oauth/token",
      method: "POST",
      headers: {
        Authorization: "Basic secret",
        Cookie: "session=secret",
        "Proxy-Authorization": "Basic proxy-secret",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: { grant_type: "authorization_code" },
    });

    expect(httpsRequestMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Basic secret",
        cookie: "session=secret",
        "content-type": "application/x-www-form-urlencoded",
      }),
    });
    expect(httpsRequestMock.mock.calls[0][1].headers).not.toHaveProperty(
      "proxy-authorization"
    );
    expect(requestWriteMocks[0]).toHaveBeenCalledWith(
      Buffer.from("grant_type=authorization_code")
    );
    expect(httpsRequestMock.mock.calls[1][1].method).toBe("GET");
    expect(httpsRequestMock.mock.calls[1][1].headers).not.toHaveProperty(
      "authorization"
    );
    expect(httpsRequestMock.mock.calls[1][1].headers).not.toHaveProperty(
      "cookie"
    );
    expect(httpsRequestMock.mock.calls[1][1].headers).not.toHaveProperty(
      "content-type"
    );
    expect(requestWriteMocks[1]).not.toHaveBeenCalled();
  });

  it("preserves POST body and strips credentials on cross-origin 307", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        status: 307,
        statusText: "Temporary Redirect",
        headers: { location: "https://cdn.example/oauth/token" },
      },
      { body: JSON.stringify({ ok: true }) },
    ]);

    await executeOAuthProxy({
      url: "https://auth.example.com/oauth/token",
      method: "POST",
      headers: {
        Authorization: "Basic secret",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: { grant_type: "refresh_token" },
    });

    expect(httpsRequestMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/x-www-form-urlencoded",
      }),
    });
    expect(httpsRequestMock.mock.calls[1][1].headers).not.toHaveProperty(
      "authorization"
    );
    expect(requestWriteMocks[1]).toHaveBeenCalledWith(
      Buffer.from("grant_type=refresh_token")
    );
  });

  it.each([
    { status: 301, expectedMethod: "GET", preservesBody: false },
    { status: 303, expectedMethod: "GET", preservesBody: false },
    { status: 308, expectedMethod: "POST", preservesBody: true },
  ])(
    "applies Fetch-compatible method semantics for $status redirects",
    async ({ status, expectedMethod, preservesBody }) => {
      queueMetadataResponses(httpsRequestMock, [
        {
          status,
          statusText: "Redirect",
          headers: { location: "/oauth/final" },
        },
        { body: JSON.stringify({ ok: true }) },
      ]);

      await executeOAuthProxy({
        url: "https://auth.example.com/oauth/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: { grant_type: "authorization_code" },
      });

      expect(httpsRequestMock.mock.calls[1][1].method).toBe(expectedMethod);
      if (preservesBody) {
        expect(requestWriteMocks[1]).toHaveBeenCalledWith(
          Buffer.from("grant_type=authorization_code")
        );
      } else {
        expect(requestWriteMocks[1]).not.toHaveBeenCalled();
        expect(httpsRequestMock.mock.calls[1][1].headers).not.toHaveProperty(
          "content-type"
        );
      }
    }
  );

  it("rejects a sixth generic OAuth redirect", async () => {
    queueMetadataResponses(
      httpsRequestMock,
      Array.from({ length: 6 }, (_, index) => ({
        status: 302,
        statusText: "Found",
        headers: { location: `/redirect-${index + 1}` },
      }))
    );

    await expect(
      executeOAuthProxy({ url: "https://auth.example.com/oauth/token" })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Too many"),
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(6);
  });

  it("caps generic proxy response bodies", async () => {
    queueMetadataResponses(httpsRequestMock, [
      { response: Readable.from([Buffer.alloc(1024 * 1024 + 1)]) },
    ]);

    await expect(
      executeOAuthProxy({ url: "https://auth.example.com/oauth/token" })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("byte cap"),
    });
  });

  it.each([executeOAuthProxy, executeDebugOAuthProxy])(
    "%o applies timeoutMs while reading a slow response body",
    async (proxyFn) => {
      const hangingResponse = new Readable({
        read() {
          // Keep the response open until the request signal aborts it.
        },
      });
      queueMetadataResponses(httpsRequestMock, [{ response: hangingResponse }]);

      await expect(
        proxyFn({
          url: "https://auth.example.com/oauth/token",
          timeoutMs: 10,
        })
      ).rejects.toThrow(/timeout/i);
      expect(hangingResponse.destroyed).toBe(true);
    }
  );

  it("parses one bounded debug SSE event", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        headers: { "content-type": "text/event-stream" },
        body: 'event: message\ndata: {"ok":true}\n\n',
      },
    ]);

    await expect(
      executeDebugOAuthProxy({ url: "https://auth.example.com/debug" })
    ).resolves.toMatchObject({
      body: {
        transport: "sse",
        events: [{ event: "message", data: { ok: true } }],
        mcpResponse: { ok: true },
      },
    });
  });

  it("includes generic proxy DNS resolution in timeoutMs", async () => {
    dnsLookupMock.mockImplementation(() => {
      // Simulate a resolver that never calls back.
    });

    await expect(
      executeOAuthProxy({
        url: "https://auth.example.com/oauth/token",
        timeoutMs: 10,
      })
    ).rejects.toThrow(/timeout/i);
    expect(httpsRequestMock).not.toHaveBeenCalled();
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

  it("rejects a metadata redirect whose target embeds credentials", async () => {
    queueMetadataResponses(httpsRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: {
          location: "https://user:pass@cdn.example/.well-known/oauth",
        },
      },
    ]);

    await expect(
      fetchOAuthMetadata("https://auth.example.com/.well-known/oauth")
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("must not contain credentials"),
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
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

  it("allows loopback metadata to redirect to a validated public host", async () => {
    dnsLookupMock.mockImplementation(
      (
        hostname: string,
        _options: unknown,
        callback: (error: Error | null, addresses: unknown) => void
      ) =>
        callback(null, [
          {
            address:
              hostname === "localhost" ? "127.0.0.1" : "93.184.216.34",
            family: 4,
          },
        ])
    );
    queueMetadataResponses(httpRequestMock, [
      {
        status: 302,
        statusText: "Found",
        headers: {
          location: "https://auth.example.com/.well-known/oauth",
        },
      },
    ]);
    queueMetadataResponses(httpsRequestMock, [
      {
        body: JSON.stringify({ issuer: "https://auth.example.com" }),
      },
    ]);

    await expect(
      fetchOAuthMetadata("http://localhost:8787/.well-known/oauth")
    ).resolves.toEqual({
      metadata: { issuer: "https://auth.example.com" },
      finalUrl: "https://auth.example.com/.well-known/oauth",
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it("does not let loopback metadata redirect to a LAN host", async () => {
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
          location: "http://192.168.1.10/.well-known/oauth",
        },
      },
    ]);

    await expect(
      fetchOAuthMetadata("http://localhost:8787/.well-known/oauth")
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("private/reserved host"),
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock).not.toHaveBeenCalled();
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
    queueMetadataResponses(httpsRequestMock, []);
    await expect(
      executeOAuthProxy({ url: "https://example.com", timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
    queueMetadataResponses(httpsRequestMock, []);
    await expect(
      executeDebugOAuthProxy({ url: "https://example.com", timeoutMs: 10 })
    ).rejects.toThrow(/timeout/i);
    queueMetadataResponses(httpsRequestMock, []);
    await expect(
      fetchOAuthMetadata("https://example.com/.well-known/oauth", false, 10)
    ).rejects.toThrow(/timeout/i);
  });

  describe("redirect option plumbing", () => {
    it.each([executeOAuthProxy, executeDebugOAuthProxy])(
      "%o honors an explicit manual redirect without httpsOnly",
      async (proxyFn) => {
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
            headers: { location: "http://localhost:3000/elsewhere" },
          },
        ]);
        await expect(
          proxyFn({
            url: "http://localhost:3000/client.json",
            redirect: "manual",
          })
        ).resolves.toMatchObject({
          status: 302,
          finalUrl: "http://localhost:3000/client.json",
        });
        expect(httpRequestMock).toHaveBeenCalledTimes(1);
      }
    );

    it("preserves the historical follow default when redirect is omitted", async () => {
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
          headers: { location: "/final" },
        },
        { body: JSON.stringify({ ok: true }) },
      ]);
      await expect(
        executeDebugOAuthProxy({
          url: "http://localhost:3000/client.json",
        })
      ).resolves.toMatchObject({
        status: 200,
        finalUrl: "http://localhost:3000/final",
      });
      expect(httpRequestMock).toHaveBeenCalledTimes(2);
    });

    it("cannot weaken httpsOnly to follow with an explicit redirect", async () => {
      queueMetadataResponses(httpsRequestMock, [
        {
          status: 302,
          statusText: "Found",
          headers: { location: "https://cdn.example.com/metadata" },
        },
      ]);
      await expect(
        executeDebugOAuthProxy({
          url: "https://example.com/metadata",
          httpsOnly: true,
          redirect: "follow",
        })
      ).resolves.toMatchObject({
        status: 302,
        finalUrl: "https://example.com/metadata",
      });
      expect(httpsRequestMock).toHaveBeenCalledTimes(1);
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
