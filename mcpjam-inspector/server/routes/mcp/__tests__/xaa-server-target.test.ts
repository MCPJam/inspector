import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import {
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../../../services/xaa-idp-keypair.js";
import { createXaaRouter } from "../xaa.js";

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
