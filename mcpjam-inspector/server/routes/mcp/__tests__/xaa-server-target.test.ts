import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { initXAAIdpKeyPair, resetXAAIdpKeyPairForTests } from "@mcpjam/sdk";
import { createXaaRouter } from "../xaa.js";

// This suite models the whole network with a `fetch` stub. The OAuth proxy now
// connects through raw node:http(s) so it can pin a validated DNS address, so
// route its two outbound calls back through `fetch`, and stub DNS for the
// `validateUrl` gate that stays real (it fails closed on an unresolvable host,
// and these synthetic `*.example.com` names NXDOMAIN).
vi.mock("../../../utils/oauth-proxy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/oauth-proxy.js")>();
  const { executeOAuthProxyViaFetch, fetchOAuthMetadataViaFetch } = await import(
    "../../../test/support/oauth-proxy-fetch-mock.js"
  );
  return {
    ...actual,
    executeOAuthProxy: vi.fn(executeOAuthProxyViaFetch),
    fetchOAuthMetadata: vi.fn(fetchOAuthMetadataViaFetch),
  };
});

const dnsLookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({
  lookup: dnsLookupMock,
}));

// Re-installed per test: the shared server setup clears all mocks in afterEach.
beforeEach(() => {
  dnsLookupMock.mockImplementation(
    (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: unknown) => void
    ) => callback(null, [{ address: "93.184.216.34", family: 4 }])
  );
});

const DISCOVERED_TOKEN_ENDPOINT = "https://discovered-as.example.com/oauth/token";

interface ServerSecretResolverResult {
  clientSecret: string | null;
  clientId: string | null;
  serverUrl: string | null;
  xaaAuthzIssuer: string | null;
}

function buildApp(resolver?: (args: {
  serverId: string;
  projectId: string;
  bearerToken: string;
}) => Promise<ServerSecretResolverResult>) {
  const app = new Hono();
  app.route(
    "/api/web/xaa",
    createXaaRouter({
      issuerBasePath: "/api/web",
      httpsOnlyProxy: false,
      resolveServerSecret: resolver,
    })
  );
  return app;
}

// Discovery GETs return metadata advertising the token endpoint; token POSTs
// return an issued token. Distinguishing on method lets one mock serve both
// legs of the server-side resolution.
function stubDiscoveryAndToken(options?: {
  tokenEndpoint?: string;
  onTokenPost?: (url: string, init: RequestInit) => void;
}) {
  const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          issuer: "https://stored-server.example.com",
          token_endpoint: options?.tokenEndpoint ?? DISCOVERED_TOKEN_ENDPOINT,
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    options?.onTokenPost?.(String(url), init as RequestInit);
    return new Response(
      JSON.stringify({ access_token: "issued-token", token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("server-target /proxy/token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects serverId on an instance without a server secret resolver", async () => {
    const app = buildApp();
    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("not available");
  });

  it("requires a bearer token before resolving the secret", async () => {
    const resolver = vi.fn();
    const app = buildApp(resolver);
    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });
    expect(response.status).toBe(401);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("discovers the token endpoint server-side and pins the stored secret/client id, discarding client-supplied values", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://stored-server.example.com",
      xaaAuthzIssuer: null,
    }));
    const app = buildApp(resolver);

    let tokenUrl = "";
    let tokenInit: RequestInit | undefined;
    const fetchMock = stubDiscoveryAndToken({
      onTokenPost: (url, init) => {
        tokenUrl = url;
        tokenInit = init;
      },
    });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
        // Attacker-controlled values that must all be discarded.
        tokenEndpoint: "https://attacker.example.com/exfil",
        clientId: "attacker-client",
        clientSecret: "attacker-secret",
        headers: { "X-Evil": "1" },
        scope: "read:tools",
        resource: "https://mcp.example.com",
      }),
    });

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({
      serverId: "srv_1",
      projectId: "proj_1",
      bearerToken: "user-token",
      clientIp: null,
    });

    // The token POST went to the server-discovered endpoint, never the
    // client-supplied one.
    expect(tokenUrl).toContain("discovered-as.example.com");
    expect(tokenUrl).not.toContain("attacker.example.com");

    const headers = (tokenInit?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Evil"]).toBeUndefined();

    const form = new URLSearchParams(String(tokenInit?.body));
    expect(form.get("client_secret")).toBe("stored-secret");
    expect(form.get("client_id")).toBe("stored-client-id");
    expect(form.get("assertion")).toBe("aaa.bbb.ccc");

    // The confidential secret is never echoed back to the browser.
    const responseText = JSON.stringify(await response.json());
    expect(responseText).not.toContain("stored-secret");

    // Discovery used the GET leg; the mock served both.
    expect(fetchMock).toHaveBeenCalled();
  });

  it("resolves the issuer from RFC 9728 protected-resource metadata when none is stored", async () => {
    // The resource URL is NOT the AS issuer: PRM points at a separate issuer,
    // and the token endpoint is only discoverable from that issuer's metadata.
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://stored-server.example.com/mcp",
      xaaAuthzIssuer: null,
    }));
    const app = buildApp(resolver);

    const getUrls: string[] = [];
    let tokenUrl = "";
    const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const href = String(url);
      if (method === "GET") {
        getUrls.push(href);
        // PRM document: names the protecting authorization server.
        if (href.includes("oauth-protected-resource")) {
          return new Response(
            JSON.stringify({
              resource: "https://stored-server.example.com/mcp",
              authorization_servers: ["https://issuer.example.com"],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // AS metadata: only served at the discovered issuer's well-known.
        if (href.startsWith("https://issuer.example.com/")) {
          return new Response(
            JSON.stringify({
              issuer: "https://issuer.example.com",
              token_endpoint: DISCOVERED_TOKEN_ENDPOINT,
              grant_types_supported: [
                "urn:ietf:params:oauth:grant-type:jwt-bearer",
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      tokenUrl = href;
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(200);
    // Probed the resource's PRM well-known (path-inserted, RFC 9728 §3.1)...
    expect(getUrls).toContain(
      "https://stored-server.example.com/.well-known/oauth-protected-resource/mcp"
    );
    // ...then the discovered issuer's AS metadata, and posted there.
    expect(getUrls.some((u) => u.startsWith("https://issuer.example.com/"))).toBe(
      true
    );
    expect(tokenUrl).toBe(DISCOVERED_TOKEN_ENDPOINT);
  });

  it("prefers the stored xaaAuthzIssuer over the server URL for discovery", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://stored-server.example.com",
      xaaAuthzIssuer: "https://issuer.example.com",
    }));
    const app = buildApp(resolver);

    let discoveryUrl = "";
    const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        discoveryUrl = String(url);
        return new Response(
          JSON.stringify({
            issuer: "https://issuer.example.com",
            token_endpoint: DISCOVERED_TOKEN_ENDPOINT,
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(200);
    expect(discoveryUrl).toContain("issuer.example.com");
    expect(discoveryUrl).not.toContain("stored-server.example.com");
  });

  it("fail-closes with a 409 naming both issuers when the metadata advertises a different issuer", async () => {
    // The stored issuer and the metadata's advertised issuer diverge — the
    // secret must never be posted, and the error must carry both values so
    // the user can fix the config. The status must stay out of the 502/504
    // family: CDN edges replace those bodies with a branded error page.
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://stored-server.example.com",
      xaaAuthzIssuer: "https://stored-issuer.example.com",
    }));
    const app = buildApp(resolver);

    let tokenPosted = false;
    // stubDiscoveryAndToken serves metadata advertising
    // https://stored-server.example.com — not the stored issuer above.
    stubDiscoveryAndToken({
      onTokenPost: () => {
        tokenPosted = true;
      },
    });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.message).toContain("https://stored-issuer.example.com");
    expect(body.message).toContain("https://stored-server.example.com");
    expect(body.details).toMatchObject({
      requestedIssuer: "https://stored-issuer.example.com",
      advertisedIssuer: "https://stored-server.example.com",
      schemeOnly: false,
    });
    expect(tokenPosted).toBe(false);
  });

  // A path-scoped AS shape: OAuth endpoints scoped under /resources/res_x
  // while the metadata advertises the origin root as issuer. Rejected by the
  // strict check unless the per-server opt-in is stored.
  function stubPathScopedAs(onTokenPost?: (url: string) => void) {
    const fetchMock = vi.fn(async (url: any, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            issuer: "https://env.example.com",
            token_endpoint:
              "https://env.example.com/resources/res_1/oauth/token",
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      onTokenPost?.(String(url));
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function pathScopedResolver(allow: boolean) {
    return vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://mcp.example.com/mcp",
      xaaAuthzIssuer: "https://env.example.com/resources/res_1",
      xaaAllowPathScopedIssuer: allow,
    }));
  }

  it("rejects a path-scoped AS with a 409 naming the opt-in when the server has not opted in", async () => {
    const app = buildApp(pathScopedResolver(false));
    let tokenPosted = false;
    stubPathScopedAs(() => {
      tokenPosted = true;
    });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      message?: string;
      details?: Record<string, unknown>;
    };
    expect(body.details).toMatchObject({ originPrefix: true });
    expect(body.message).toContain("Path-scoped authorization server");
    expect(tokenPosted).toBe(false);
  });

  it("accepts a path-scoped AS under the per-server opt-in and posts to its scoped token endpoint", async () => {
    const app = buildApp(pathScopedResolver(true));
    let tokenUrl = "";
    stubPathScopedAs((url) => {
      tokenUrl = url;
    });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(200);
    expect(tokenUrl).toBe("https://env.example.com/resources/res_1/oauth/token");
  });

  it("rejects an opted-in path-scoped AS whose token endpoint escapes the issuer origin", async () => {
    // Opt-in is ON and the issuer prefix matches, but the metadata points
    // token_endpoint at a different public host — the confidential secret must
    // NOT be posted off-origin.
    const app = buildApp(pathScopedResolver(true));
    let tokenPosted = false;
    const fetchMock = vi.fn(async (_url: any, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            issuer: "https://env.example.com",
            // Off-origin token endpoint — an attacker-controlled host.
            token_endpoint: "https://attacker.example.net/oauth/token",
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      tokenPosted = true;
      return new Response(
        JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      message?: string;
      details?: Record<string, unknown>;
    };
    expect(body.details).toMatchObject({ tokenEndpointOffOrigin: true });
    expect(body.message).toContain("off-origin");
    expect(tokenPosted).toBe(false);
  });

  it("returns 404 when no authorization server can be discovered", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://stored-server.example.com",
      xaaAuthzIssuer: null,
    }));
    const app = buildApp(resolver);

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(404);
  });
});

describe("server-target /negative-tests", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-srv-negtest-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  it("fires the broken assertions at the server-discovered endpoint with the stored secret", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      clientId: "stored-client-id",
      serverUrl: "https://stored-server.example.com",
      xaaAuthzIssuer: null,
    }));
    const app = buildApp(resolver);

    const tokenPosts: Array<{ url: string; body: string }> = [];
    stubDiscoveryAndToken({
      onTokenPost: (url, init) => {
        tokenPosts.push({ url, body: String(init.body) });
      },
    });

    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        audience: "https://issuer.example.com",
        resource: "https://mcp.example.com",
        // Attacker values that must be ignored.
        tokenEndpoint: "https://attacker.example.com/exfil",
        clientSecret: "attacker-secret",
        clientId: "attacker-client",
      }),
    });

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({
      serverId: "srv_1",
      projectId: "proj_1",
      bearerToken: "user-token",
      clientIp: null,
    });

    expect(tokenPosts.length).toBeGreaterThan(0);
    for (const post of tokenPosts) {
      expect(post.url).toContain("discovered-as.example.com");
      expect(post.url).not.toContain("attacker.example.com");
      const form = new URLSearchParams(post.body);
      expect(form.get("client_secret")).toBe("stored-secret");
    }
  });

  it("requires a bearer token for server-target negative tests", async () => {
    const resolver = vi.fn();
    const app = buildApp(resolver);

    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: "srv_1",
        projectId: "proj_1",
        audience: "https://issuer.example.com",
        resource: "https://mcp.example.com",
      }),
    });

    expect(response.status).toBe(401);
    expect(resolver).not.toHaveBeenCalled();
  });
});
