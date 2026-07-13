import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { securityHeadersMiddleware } from "../../../middleware/security-headers.js";
import { originValidationMiddleware } from "../../../middleware/origin-validation.js";
import { sessionAuthMiddleware } from "../../../middleware/session-auth.js";
import {
  generateSessionToken,
  getSessionToken,
} from "../../../services/session-token.js";
import { initXAAIdpKeyPair, resetXAAIdpKeyPairForTests } from "@mcpjam/sdk";
import xaa, { createXaaRouter } from "../xaa.js";

function jsonResponse(
  body: unknown,
  init?: { status?: number; contentType?: string }
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": init?.contentType ?? "application/json",
    },
  });
}

function decodeJwtPayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

describe("mcp xaa routes", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;
  let app: Hono;
  let token: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
    token = generateSessionToken();

    app = new Hono();
    app.use("*", securityHeadersMiddleware);
    app.use("*", originValidationMiddleware);
    app.use("*", sessionAuthMiddleware);
    app.route("/api/mcp/xaa", xaa);
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  it("serves JWKS publicly without a session token", async () => {
    const response = await app.request("/api/mcp/xaa/.well-known/jwks.json");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kid).toBe("xaa-idp-1");
  });

  it("serves the discovery document publicly without a session token", async () => {
    const response = await app.request(
      "http://localhost/api/mcp/xaa/.well-known/openid-configuration"
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe("http://localhost/api/mcp/xaa");
    expect(body.jwks_uri).toBe(
      "http://localhost/api/mcp/xaa/.well-known/jwks.json"
    );
  });

  it("ignores forwarded proxy headers for the local router", async () => {
    // The local desktop router has no proxy in front of it, so a spoofed
    // X-Forwarded-Proto must not flip the issuer to https.
    const response = await app.request(
      "http://localhost/api/mcp/xaa/.well-known/openid-configuration",
      {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "evil.example.com",
        },
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe("http://localhost/api/mcp/xaa");
    expect(body.jwks_uri).toBe(
      "http://localhost/api/mcp/xaa/.well-known/jwks.json"
    );
  });

  it("requires a session token for protected endpoints", async () => {
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(401);
  });

  it("authenticates and exchanges an ID token for a broken ID-JAG", async () => {
    const headers = {
      "Content-Type": "application/json",
      "X-MCP-Session-Auth": `Bearer ${getSessionToken() || token}`,
    };

    const authenticateResponse = await app.request(
      "/api/mcp/xaa/authenticate",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          userId: "user-12345",
          email: "demo.user@example.com",
        }),
      }
    );

    expect(authenticateResponse.status).toBe(200);
    const authenticateBody = await authenticateResponse.json();
    expect(authenticateBody.id_token).toEqual(expect.any(String));

    const tokenExchangeResponse = await app.request(
      "/api/mcp/xaa/token-exchange",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          identityAssertion: authenticateBody.id_token,
          audience: "https://auth.example.com",
          resource: "https://mcp.example.com",
          clientId: "mcpjam-debugger",
          negativeTestMode: "wrong_audience",
        }),
      }
    );

    expect(tokenExchangeResponse.status).toBe(200);
    const tokenExchangeBody = await tokenExchangeResponse.json();
    const payload = decodeJwtPayload(tokenExchangeBody.id_jag);
    expect(payload.aud).toBe("https://wrong-audience.example.com");
    // The ID token's email rides into the ID-JAG (spec RECOMMENDED) so the
    // Resource AS can use it for subject resolution.
    expect(payload.email).toBe("demo.user@example.com");
  });

  describe("POST /discover-as", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function authHeaders() {
      return {
        "Content-Type": "application/json",
        "X-MCP-Session-Auth": `Bearer ${getSessionToken() || token}`,
      };
    }

    it("resolves metadata via the root well-known form", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = input.toString();
        if (url === "https://as.example.com/.well-known/openid-configuration") {
          return jsonResponse({
            issuer: "https://as.example.com",
            token_endpoint: "https://as.example.com/oauth/token",
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          });
        }
        return new Response(null, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ issuer: "https://as.example.com" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.issuer).toBe("https://as.example.com");
      expect(body.jwtBearerSupport).toBe("pass");
      expect(body.hasTokenEndpoint).toBe(true);
      expect(body.issuerMismatch).toBeNull();
    });

    it("resolves metadata via the path-insertion well-known form", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = input.toString();
        if (
          url ===
          "https://login.example.com/.well-known/openid-configuration/realms/acme"
        ) {
          return jsonResponse({
            issuer: "https://login.example.com/realms/acme",
            token_endpoint:
              "https://login.example.com/realms/acme/protocol/openid-connect/token",
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          });
        }
        return new Response(null, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          issuer: "https://login.example.com/realms/acme",
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.issuer).toBe("https://login.example.com/realms/acme");
      expect(body.jwtBearerSupport).toBe("pass");
    });

    it("reports a scheme-only issuer mismatch", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issuer: "http://as.example.com",
          token_endpoint: "http://as.example.com/oauth/token",
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ issuer: "https://as.example.com" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.issuerMismatch).toMatchObject({
        requested: "https://as.example.com",
        advertised: "http://as.example.com",
        schemeOnly: true,
      });
    });

    it("returns 404 when no well-known endpoint has metadata", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 }))
      );

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ issuer: "https://as.example.com" }),
      });

      expect(response.status).toBe(404);
    });
  });
});

describe("hosted xaa outbound guards", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-hosted-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    // Hosted-mode router: httpsOnlyProxy rejects http + private/reserved hosts.
    // No protected middlewares here so the test exercises the guard directly.
    app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: true,
        trustForwardedHeaders: true,
      })
    );
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

  it("rejects discovery against a reserved internal address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/discover-as", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issuer: "https://169.254.169.254" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe("URL not allowed");
    // The guard rejects before any outbound fetch is attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an http health-check target in hosted mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://example.com/health" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe("URL not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a health-check redirect to an internal address", async () => {
    // redirect: manual means the 3xx is returned without being followed, so
    // the internal Location is never fetched.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Public literal IP: passes validateUrl (IP literals skip DNS) without a
      // real network lookup.
      body: JSON.stringify({ url: "https://93.184.216.34/health" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("redirect_not_followed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("registration-backed /proxy/token", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-reg-proxy-"));
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

  function buildApp(options: {
    resolver?: (args: {
      registrationId: string;
      bearerToken: string;
    }) => Promise<{
      clientSecret: string;
      tokenEndpoint: string | null;
      targetClientId: string | null;
      scopes: string[] | null;
    }>;
  }) {
    const app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: false,
        resolveRegistrationSecret: options.resolver,
      })
    );
    return app;
  }

  it("rejects registrationId on an instance without a secret resolver", async () => {
    const app = buildApp({});

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("not available");
  });

  it("requires a bearer token before resolving the secret", async () => {
    const resolver = vi.fn();
    const app = buildApp({ resolver });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(401);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("forces the stored token endpoint and strips client-supplied endpoint/headers/secret", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      tokenEndpoint: "https://stored-as.example.com/oauth/token",
      targetClientId: "stored-client-id",
      scopes: null,
    }));
    const app = buildApp({ resolver });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
        // A caller must not be able to redirect the stored secret or smuggle
        // headers/credentials alongside it.
        tokenEndpoint: "https://attacker.example.com/exfil",
        headers: { "X-Evil": "1" },
        clientSecret: "attacker-secret",
        clientId: "attacker-client-id",
        scope: "read:tools",
        resource: "https://mcp.example.com",
      }),
    });

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({
      registrationId: "app_1",
      bearerToken: "user-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(calledUrl).toBe("https://stored-as.example.com/oauth/token");

    const headers = calledInit.headers as Record<string, string>;
    expect(headers["X-Evil"]).toBeUndefined();

    const form = new URLSearchParams(String(calledInit.body));
    expect(form.get("client_secret")).toBe("stored-secret");
    expect(form.get("client_id")).toBe("stored-client-id");
    expect(form.get("assertion")).toBe("aaa.bbb.ccc");
    expect(form.get("scope")).toBe("read:tools");
  });

  it("rejects a registration without a stored token endpoint", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      tokenEndpoint: null,
      targetClientId: null,
      scopes: null,
    }));
    const app = buildApp({ resolver });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("no stored token endpoint");
  });
});

describe("POST /negative-tests", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-negtest-"));
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

  function buildApp(
    resolver?: (args: {
      registrationId: string;
      bearerToken: string;
    }) => Promise<{
      clientSecret: string;
      tokenEndpoint: string | null;
      targetClientId: string | null;
      scopes: string[] | null;
    }>
  ) {
    const app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: false,
        resolveRegistrationSecret: resolver,
      })
    );
    return app;
  }

  const INLINE_BODY = {
    audience: "https://auth.example.com",
    resource: "https://mcp.example.com",
    clientId: "mcpjam-debugger",
    tokenEndpoint: "https://auth.example.com/oauth/token",
  };

  it("marks a case red when the auth server wrongly issues a token for a broken assertion", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INLINE_BODY),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{
        mode: string;
        verdict: string;
        diff?: { field: string; sent: string; expected: string };
      }>;
      failures: number;
    };
    expect(body.results).toHaveLength(11);
    expect(body.failures).toBe(11);
    const expired = body.results.find((r) => r.mode === "expired");
    expect(expired?.verdict).toBe("fail");

    // Each broken case carries a "sent vs expected" diff for the tampered field.
    const wrongAud = body.results.find((r) => r.mode === "wrong_audience");
    expect(wrongAud?.diff).toEqual({
      field: "aud",
      sent: "https://wrong-audience.example.com",
      expected: "https://auth.example.com",
    });
  });

  it("marks cases green when the auth server rejects broken assertions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INLINE_BODY),
    });

    const body = (await response.json()) as {
      results: Array<{ verdict: string }>;
      failures: number;
    };
    expect(body.failures).toBe(0);
    expect(body.results.every((r) => r.verdict === "pass")).toBe(true);
  });

  it("yields partial results when a case times out (one slow case doesn't sink the run)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error("aborted");
            err.name = "TimeoutError";
            reject(err);
          }, 5);
        });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INLINE_BODY),
    });

    const body = (await response.json()) as {
      results: Array<{ outcome: string; verdict: string }>;
    };
    expect(body.results).toHaveLength(11);
    expect(body.results.some((r) => r.outcome === "timeout")).toBe(true);
    expect(body.results.some((r) => r.verdict === "pass")).toBe(true);
  });

  it("rejects an mcpjam-issuer-only registration (no own auth server)", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "x",
      tokenEndpoint: null,
      targetClientId: null,
      scopes: null,
    }));
    const app = buildApp(resolver);

    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        audience: "https://auth.example.com",
        resource: "https://mcp.example.com",
        registrationId: "app_1",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("its own auth server");
  });
});

describe("org-scoped issuer paths on the local router", () => {
  it("does not register /o/:orgId routes when authorizeOrgIssuer is absent", async () => {
    const app = new Hono();
    app.route(
      "/api/mcp/xaa",
      createXaaRouter({
        issuerBasePath: "/api/mcp",
        httpsOnlyProxy: false,
      })
    );

    const discovery = await app.request(
      "/api/mcp/xaa/o/org-123/.well-known/openid-configuration"
    );
    const mint = await app.request("/api/mcp/xaa/o/org-123/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(discovery.status).toBe(404);
    expect(mint.status).toBe(404);
  });
});

describe("hosted-issuer forwarding on the local router", () => {
  const HOSTED_ORIGIN = "https://app.example.com";

  function buildApp() {
    const app = new Hono();
    app.route(
      "/api/mcp/xaa",
      createXaaRouter({
        issuerBasePath: "/api/mcp",
        httpsOnlyProxy: false,
        forwardHostedIssuer: { origin: HOSTED_ORIGIN },
      })
    );
    return app;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards issuerMode:hosted mints to the scoped hosted endpoint with the bearer", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id_token: "hosted-token", token_type: "Bearer" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer workos-token",
      },
      body: JSON.stringify({
        userId: "user-12345",
        issuerMode: "hosted",
        organizationId: "org_123",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id_token: "hosted-token" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HOSTED_ORIGIN}/api/web/xaa/o/org_123/authenticate`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer workos-token"
    );
    // The opt-in fields are stripped before the upstream call.
    const forwarded = JSON.parse(String(init.body));
    expect(forwarded).toEqual({ userId: "user-12345" });
  });

  it("fails closed (no unscoped fallback) when organizationId is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer workos-token",
      },
      body: JSON.stringify({ userId: "user-12345", issuerMode: "hosted" }),
    });

    // No org → reject rather than silently mint under the forgeable unscoped
    // issuer; never calls upstream.
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the upstream status + WWW-Authenticate on a non-JSON hosted error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("forbidden", {
          status: 403,
          headers: { "WWW-Authenticate": "Bearer error=\"insufficient_scope\"" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer workos-token",
      },
      body: JSON.stringify({
        userId: "user-12345",
        issuerMode: "hosted",
        organizationId: "org_123",
      }),
    });

    // The real hosted 403 must survive the relay, not become a 502 outage.
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      "insufficient_scope"
    );
  });

  it("rejects a hosted mint without a bearer, without calling upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/mcp/xaa/token-exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identityAssertion: "a.b.c",
        audience: "https://auth.example.com",
        resource: "https://mcp.example.com",
        clientId: "mcpjam-debugger",
        issuerMode: "hosted",
      }),
    });

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed organizationId before calling upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer workos-token",
      },
      body: JSON.stringify({
        issuerMode: "hosted",
        organizationId: "not/valid",
      }),
    });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the upstream status verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { code: "RATE_LIMITED", message: "Too many requests" },
          { status: 429 }
        )
      )
    );

    const app = buildApp();
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer workos-token",
      },
      body: JSON.stringify({ issuerMode: "hosted", organizationId: "org1" }),
    });

    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe("RATE_LIMITED");
  });

  it("mints locally when issuerMode is absent, without touching fetch", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-fwd-local-"));
    const originalDir = process.env.XAA_IDP_KEY_DIR;
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const app = buildApp();
      const response = await app.request(
        "http://127.0.0.1:6274/api/mcp/xaa/authenticate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: "user-12345" }),
        }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(decodeJwtPayload(body.id_token).iss).toBe(
        "http://127.0.0.1:6274/api/mcp/xaa"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      resetXAAIdpKeyPairForTests();
      rmSync(tempDir, { recursive: true, force: true });
      if (originalDir === undefined) {
        delete process.env.XAA_IDP_KEY_DIR;
      } else {
        process.env.XAA_IDP_KEY_DIR = originalDir;
      }
    }
  });

  it("ignores issuerMode on a router without forwarding configured (hosted)", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-fwd-hosted-"));
    const originalDir = process.env.XAA_IDP_KEY_DIR;
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const app = new Hono();
      app.route(
        "/api/web/xaa",
        createXaaRouter({
          issuerBasePath: "/api/web",
          httpsOnlyProxy: true,
        })
      );
      const response = await app.request(
        "https://app.mcpjam.com/api/web/xaa/authenticate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: "user-12345", issuerMode: "hosted" }),
        }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(decodeJwtPayload(body.id_token).iss).toBe(
        "https://app.mcpjam.com/api/web/xaa"
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      resetXAAIdpKeyPairForTests();
      rmSync(tempDir, { recursive: true, force: true });
      if (originalDir === undefined) {
        delete process.env.XAA_IDP_KEY_DIR;
      } else {
        process.env.XAA_IDP_KEY_DIR = originalDir;
      }
    }
  });
});

describe("mock OIDC IdP endpoints", () => {
  const BASE = "http://127.0.0.1:6274/api/mcp/xaa";
  const ISSUER = BASE;
  const REDIRECT_URI = "https://rp.example.com/callback";
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-oidc-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    app = new Hono();
    app.route(
      "/api/mcp/xaa",
      createXaaRouter({
        issuerBasePath: "/api/mcp",
        httpsOnlyProxy: false,
      })
    );
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  function authorizeUrl(params: Record<string, string>): string {
    const url = new URL(`${BASE}/authorize`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async function getCode(extra: Record<string, string> = {}): Promise<{
    code: string;
    location: URL;
  }> {
    const form = new URLSearchParams({
      client_id: "client-1",
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      state: "state-1",
      nonce: "nonce-1",
      subject: "alice-123",
      email: "alice@example.com",
      ...extra,
    });
    const response = await app.request(`${BASE}/authorize/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}`,
      },
      body: form.toString(),
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    return { code: location.searchParams.get("code")!, location };
  }

  async function postToken(
    fields: Record<string, string>,
    ip = `10.1.0.${Math.floor(Math.random() * 250)}`
  ) {
    return app.request(`${BASE}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-for": ip,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("renders the authorize interstitial without redirecting", async () => {
    const response = await app.request(
      authorizeUrl({
        client_id: "client-1",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        state: "s",
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain("client-1");
    expect(html).toContain("rp.example.com");
    expect(html).toContain('action="' + ISSUER + '/authorize/confirm"');
  });

  it("escapes echoed values on the authorize page", async () => {
    const response = await app.request(
      authorizeUrl({
        client_id: '<script>alert(1)</script>',
        redirect_uri: REDIRECT_URI,
        response_type: "code",
      })
    );
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rejects non-code response types and bad redirect URIs with an error page, not a redirect", async () => {
    const implicit = await app.request(
      authorizeUrl({
        client_id: "client-1",
        redirect_uri: REDIRECT_URI,
        response_type: "token",
      })
    );
    expect(implicit.status).toBe(400);
    expect(implicit.headers.get("location")).toBeNull();

    const jsUri = await app.request(
      authorizeUrl({
        client_id: "client-1",
        redirect_uri: "javascript:alert(1)",
        response_type: "code",
      })
    );
    expect(jsUri.status).toBe(400);

    const plainPkce = await app.request(
      authorizeUrl({
        client_id: "client-1",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge: "abc",
        code_challenge_method: "plain",
      })
    );
    expect(plainPkce.status).toBe(400);
  });

  it("completes the code flow: confirm → code → tokens → userinfo", async () => {
    const { code, location } = await getCode();
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-1");

    const tokenResponse = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "client-1",
    });
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();
    expect(body.token_type).toBe("Bearer");

    const idTokenPayload = decodeJwtPayload(body.id_token);
    expect(idTokenPayload).toMatchObject({
      iss: ISSUER,
      sub: "alice-123",
      email: "alice@example.com",
      aud: "client-1",
      nonce: "nonce-1",
    });

    const userinfoResponse = await app.request(`${BASE}/userinfo`, {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    expect(userinfoResponse.status).toBe(200);
    expect(await userinfoResponse.json()).toEqual({
      sub: "alice-123",
      email: "alice@example.com",
      email_verified: true,
    });
  });

  it("enforces S256 PKCE when the code carries a challenge", async () => {
    const verifier = "test-verifier-0123456789-0123456789-0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { code } = await getCode({
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    const missingVerifier = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "client-1",
    });
    expect(missingVerifier.status).toBe(400);
    expect((await missingVerifier.json()).error).toBe("invalid_grant");

    const wrongVerifier = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "client-1",
      code_verifier: "wrong-verifier",
    });
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");

    const success = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "client-1",
      code_verifier: verifier,
    });
    expect(success.status).toBe(200);
  });

  it("rejects mismatched redemption parameters", async () => {
    const { code } = await getCode();

    const wrongRedirect = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://evil.example.com/callback",
      client_id: "client-1",
    });
    expect(wrongRedirect.status).toBe(400);
    expect((await wrongRedirect.json()).error).toBe("invalid_grant");

    const wrongClient = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "client-2",
    });
    expect((await wrongClient.json()).error).toBe("invalid_grant");

    const unsupported = await postToken({ grant_type: "password" });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).error).toBe("unsupported_grant_type");
  });

  it("serves standard form token exchange locally and mints an ID-JAG", async () => {
    // Mint a mock ID token via the debugger endpoint, aud = the client.
    const authenticateResponse = await app.request(`${BASE}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "alice-123",
        email: "alice@example.com",
        audience: "client-1",
      }),
    });
    const { id_token: subjectToken } = await authenticateResponse.json();

    const response = await postToken({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      client_id: "client-1",
      audience: "https://as.example.com",
      resource: "https://rs.example.com",
      scope: "chat.read",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issued_token_type).toBe(
      "urn:ietf:params:oauth:token-type:id-jag"
    );
    expect(body.token_type).toBe("N_A");
    const payload = decodeJwtPayload(body.access_token);
    expect(payload).toMatchObject({
      iss: ISSUER,
      sub: "alice-123",
      aud: "https://as.example.com",
      resource: "https://rs.example.com",
      client_id: "client-1",
      scope: "chat.read",
    });

    // aud mismatch between the subject token and the presenting client.
    const mismatch = await postToken({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      client_id: "other-client",
      audience: "https://as.example.com",
      resource: "https://rs.example.com",
    });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toBe("invalid_grant");

    // client_id is required.
    const missingClient = await postToken({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      audience: "https://as.example.com",
      resource: "https://rs.example.com",
    });
    expect(missingClient.status).toBe(400);
    expect((await missingClient.json()).error).toBe("invalid_request");
  });

  it("rejects an ID-JAG presented at /userinfo", async () => {
    const authenticateResponse = await app.request(`${BASE}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "alice-123" }),
    });
    const { id_token } = await authenticateResponse.json();
    const exchangeResponse = await app.request(`${BASE}/token-exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identityAssertion: id_token,
        audience: "https://as.example.com",
        resource: "https://rs.example.com",
        clientId: "client-1",
      }),
    });
    const { id_jag } = await exchangeResponse.json();

    const response = await app.request(`${BASE}/userinfo`, {
      headers: { Authorization: `Bearer ${id_jag}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("advertises the OIDC metadata, and only what this surface serves", async () => {
    const response = await app.request(
      `${BASE}/.well-known/openid-configuration`
    );
    const doc = await response.json();
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
    expect(doc.userinfo_endpoint).toBe(`${ISSUER}/userinfo`);
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    // Local serves token exchange at /token → advertised + identity chaining.
    expect(doc.grant_types_supported).toEqual([
      "authorization_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ]);
    expect(doc.identity_chaining_requested_token_types_supported).toEqual([
      "urn:ietf:params:oauth:token-type:id-jag",
    ]);
  });

  it("rate limits the token endpoint per IP", async () => {
    const ip = "9.9.9.9";
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const response = await postToken({ grant_type: "password" }, ip);
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("does not rate limit local (no X-Forwarded-For) requests", async () => {
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      const response = await app.request(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password" }).toString(),
      });
      lastStatus = response.status;
    }
    // No proxy in front → no shared "local" bucket self-DoS; unsupported grant
    // returns 400, never 429.
    expect(lastStatus).toBe(400);
  });

  it("rejects a cross-origin POST to /authorize/confirm (no open redirect)", async () => {
    const response = await app.request(`${BASE}/authorize/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example.com",
      },
      body: new URLSearchParams({
        client_id: "client-1",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
      }).toString(),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a cross-origin POST to /token (no unauthenticated mint via CSRF)", async () => {
    const response = await app.request(`${BASE}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example.com",
      },
      body: new URLSearchParams({ grant_type: "authorization_code" }).toString(),
    });
    expect(response.status).toBe(403);
  });

  it("allows a same-origin confirm POST", async () => {
    const response = await app.request(`${BASE}/authorize/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://127.0.0.1:6274",
      },
      body: new URLSearchParams({
        client_id: "client-1",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        subject: "alice-123",
        email: "alice@example.com",
      }).toString(),
    });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });

  it("rejects code_challenge_method without a code_challenge", async () => {
    const response = await app.request(
      authorizeUrl({
        client_id: "client-1",
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        code_challenge_method: "S256",
      })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("omits nonce from the id_token when the RP did not request one", async () => {
    const { code } = await getCode({ nonce: "" });
    const tokenResponse = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: "client-1",
    });
    const idToken = decodeJwtPayload((await tokenResponse.json()).id_token);
    expect(idToken.nonce).toBeUndefined();
  });

  it("registers the OIDC routes unconditionally (no enable flag)", async () => {
    // The mock OIDC IdP is always on — a router built with no OIDC option
    // still serves /authorize, and the discovery doc advertises the OIDC
    // shape rather than the retired token-exchange-only one.
    const plain = new Hono();
    plain.route(
      "/api/mcp/xaa",
      createXaaRouter({ issuerBasePath: "/api/mcp", httpsOnlyProxy: false })
    );
    const authorize = await plain.request(
      `${BASE}/authorize?client_id=c&redirect_uri=${encodeURIComponent(
        REDIRECT_URI
      )}&response_type=code`
    );
    expect(authorize.status).toBe(200);

    const doc = await (
      await plain.request(`${BASE}/.well-known/openid-configuration`)
    ).json();
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(doc.userinfo_endpoint).toBe(`${ISSUER}/userinfo`);
    expect(doc.response_types_supported).toEqual(["code"]);
  });
});
