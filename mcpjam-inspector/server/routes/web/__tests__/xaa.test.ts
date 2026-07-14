import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import xaaWeb from "../xaa.js";
import { createXaaRouter } from "../../mcp/xaa.js";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../../middleware/guest-rate-limit.js";
import { ErrorCode, WebRouteError } from "../errors.js";
import { initXAAIdpKeyPair, resetXAAIdpKeyPairForTests } from "@mcpjam/sdk";

function decodeJwtPayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

describe("web xaa routes", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-web-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    app = new Hono();
    app.route("/api/web/xaa", xaaWeb);
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

  it("serves public discovery endpoints without a bearer token", async () => {
    const jwksResponse = await app.request("/api/web/xaa/.well-known/jwks.json");
    const discoveryResponse = await app.request(
      "https://www.mcpjam.com/api/web/xaa/.well-known/openid-configuration",
    );

    expect(jwksResponse.status).toBe(200);
    expect(discoveryResponse.status).toBe(200);
    const discoveryBody = await discoveryResponse.json();
    expect(discoveryBody.issuer).toBe("https://www.mcpjam.com/api/web/xaa");
  });

  it("reconstructs an https issuer from X-Forwarded-Proto, ignoring X-Forwarded-Host", async () => {
    // Behind a TLS-terminating proxy the internal request is http://; only the
    // scheme is taken from X-Forwarded-Proto. The host comes from the request's
    // Host header (here app.mcpjam.com), NOT from X-Forwarded-Host, which an
    // attacker could spoof to forge the issuer/jwks_uri.
    const discoveryResponse = await app.request(
      "http://app.mcpjam.com/api/web/xaa/.well-known/openid-configuration",
      {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "evil.example.com",
        },
      },
    );

    expect(discoveryResponse.status).toBe(200);
    const discoveryBody = await discoveryResponse.json();
    expect(discoveryBody.issuer).toBe("https://app.mcpjam.com/api/web/xaa");
    expect(discoveryBody.jwks_uri).toBe(
      "https://app.mcpjam.com/api/web/xaa/.well-known/jwks.json",
    );
  });

  it("signs the ID-JAG iss with the forwarded https scheme and validated host", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer workos-token",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.example.com",
    };

    const authenticateResponse = await app.request(
      "http://app.mcpjam.com/api/web/xaa/authenticate",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: "user-12345" }),
      },
    );
    const authenticateBody = await authenticateResponse.json();

    const tokenExchangeResponse = await app.request(
      "http://app.mcpjam.com/api/web/xaa/token-exchange",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          identityAssertion: authenticateBody.id_token,
          audience: "https://auth.example.com",
          resource: "https://mcp.example.com",
          clientId: "mcpjam-debugger",
        }),
      },
    );

    expect(tokenExchangeResponse.status).toBe(200);
    const tokenExchangeBody = await tokenExchangeResponse.json();
    const payload = decodeJwtPayload(tokenExchangeBody.id_jag);
    expect(payload.iss).toBe("https://app.mcpjam.com/api/web/xaa");
  });

  it("requires a bearer token for protected endpoints", async () => {
    const response = await app.request("/api/web/xaa/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toEqual({
      code: "UNAUTHORIZED",
      message: "Bearer token required",
    });
  });

  it("allows protected endpoints with any bearer token and preserves negative modes", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer workos-token",
    };

    const authenticateResponse = await app.request("/api/web/xaa/authenticate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: "user-12345",
        email: "demo.user@example.com",
      }),
    });

    expect(authenticateResponse.status).toBe(200);
    const authenticateBody = await authenticateResponse.json();

    const tokenExchangeResponse = await app.request("/api/web/xaa/token-exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({
        identityAssertion: authenticateBody.id_token,
        audience: "https://auth.example.com",
        resource: "https://mcp.example.com",
        clientId: "mcpjam-debugger",
        negativeTestMode: "unknown_kid",
      }),
    });

    expect(tokenExchangeResponse.status).toBe(200);
    const tokenExchangeBody = await tokenExchangeResponse.json();
    const payload = decodeJwtPayload(tokenExchangeBody.id_jag);
    expect(payload.client_id).toBe("mcpjam-debugger");
    expect(tokenExchangeBody.negative_test_mode).toBe("unknown_kid");
  });
});

describe("org-scoped issuer routes", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const ORG_ID = "org_a1B2-c3";
  let tempDir: string;
  let app: Hono;
  let authorizeOrgIssuer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-scoped-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    authorizeOrgIssuer = vi.fn().mockResolvedValue(undefined);
    app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: true,
        trustForwardedHeaders: true,
        protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
        authorizeOrgIssuer,
      }),
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

  it("serves scoped discovery publicly with the scoped issuer and shared JWKS", async () => {
    const discoveryResponse = await app.request(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}/.well-known/openid-configuration`,
    );
    const jwksResponse = await app.request(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}/.well-known/jwks.json`,
    );
    const unscopedJwksResponse = await app.request(
      "https://app.mcpjam.com/api/web/xaa/.well-known/jwks.json",
    );

    expect(discoveryResponse.status).toBe(200);
    const discoveryBody = await discoveryResponse.json();
    expect(discoveryBody.issuer).toBe(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}`,
    );
    expect(discoveryBody.jwks_uri).toBe(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}/.well-known/jwks.json`,
    );

    expect(jwksResponse.status).toBe(200);
    // Same signing key on every issuer path — containment comes from gating
    // the mint, not from key separation.
    expect(await jwksResponse.json()).toEqual(await unscopedJwksResponse.json());
    // Public documents never trigger a membership check.
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });

  it("rejects a malformed org segment on public and mint routes", async () => {
    const badSegment = encodeURIComponent("org/../../etc");
    const discoveryResponse = await app.request(
      `/api/web/xaa/o/${badSegment}/.well-known/openid-configuration`,
    );
    expect(discoveryResponse.status).toBe(400);

    const mintResponse = await app.request(
      `/api/web/xaa/o/${badSegment}/authenticate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer workos-token",
        },
        body: JSON.stringify({ userId: "user-12345" }),
      },
    );
    expect(mintResponse.status).toBe(400);
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });

  it("requires a bearer on scoped mint endpoints", async () => {
    const response = await app.request(`/api/web/xaa/o/${ORG_ID}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(401);
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });

  it("rejects the mint when the membership check fails", async () => {
    authorizeOrgIssuer.mockRejectedValueOnce(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "Not a member"),
    );

    const response = await app.request(`/api/web/xaa/o/${ORG_ID}/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer workos-token",
      },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(403);
    expect(authorizeOrgIssuer).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      bearerToken: "workos-token",
      issuerKind: "org",
      clientIp: null,
    });
  });

  it("mints the ID token and ID-JAG with the org-scoped issuer", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer workos-token",
      "x-forwarded-proto": "https",
    };

    const authenticateResponse = await app.request(
      `http://app.mcpjam.com/api/web/xaa/o/${ORG_ID}/authenticate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: "user-12345" }),
      },
    );
    expect(authenticateResponse.status).toBe(200);
    const authenticateBody = await authenticateResponse.json();
    expect(decodeJwtPayload(authenticateBody.id_token).iss).toBe(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}`,
    );

    const tokenExchangeResponse = await app.request(
      `http://app.mcpjam.com/api/web/xaa/o/${ORG_ID}/token-exchange`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          identityAssertion: authenticateBody.id_token,
          audience: "https://auth.example.com",
          resource: "https://mcp.example.com",
          clientId: "mcpjam-debugger",
        }),
      },
    );

    expect(tokenExchangeResponse.status).toBe(200);
    const payload = decodeJwtPayload(
      (await tokenExchangeResponse.json()).id_jag,
    );
    expect(payload.iss).toBe(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}`,
    );
    expect(authorizeOrgIssuer).toHaveBeenCalledTimes(2);
  });

  it("leaves the unscoped endpoints unchanged", async () => {
    const response = await app.request(
      "https://app.mcpjam.com/api/web/xaa/.well-known/openid-configuration",
    );
    expect(response.status).toBe(200);
    expect((await response.json()).issuer).toBe(
      "https://app.mcpjam.com/api/web/xaa",
    );
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });
});

describe("anonymous test issuer routes (/g/)", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const ORG_ID = "org_guest-1";
  let tempDir: string;
  let app: Hono;
  let authorizeOrgIssuer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-anon-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    authorizeOrgIssuer = vi.fn().mockResolvedValue(undefined);
    app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: true,
        trustForwardedHeaders: true,
        protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
        authorizeOrgIssuer,
      }),
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

  it("marks the /g/ discovery document as an anonymous test issuer", async () => {
    const discoveryResponse = await app.request(
      `https://app.mcpjam.com/api/web/xaa/g/${ORG_ID}/.well-known/openid-configuration`,
    );

    expect(discoveryResponse.status).toBe(200);
    const body = await discoveryResponse.json();
    expect(body.issuer).toBe(
      `https://app.mcpjam.com/api/web/xaa/g/${ORG_ID}`,
    );
    // The marker a RAS keys its explicit allowlisting on.
    expect(body["mcpjam:issuer_kind"]).toBe("anonymous-test");
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });

  it("does NOT mark the /o/ discovery document", async () => {
    const discoveryResponse = await app.request(
      `https://app.mcpjam.com/api/web/xaa/o/${ORG_ID}/.well-known/openid-configuration`,
    );
    const body = await discoveryResponse.json();
    expect(body["mcpjam:issuer_kind"]).toBeUndefined();
  });

  it("requires a bearer on /g/ mint endpoints", async () => {
    const response = await app.request(`/api/web/xaa/g/${ORG_ID}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(401);
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });

  it("authorizes /g/ mints with the anonymous issuer kind", async () => {
    authorizeOrgIssuer.mockRejectedValueOnce(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "Not your personal org"),
    );

    const response = await app.request(`/api/web/xaa/g/${ORG_ID}/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer guest-token",
      },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(403);
    expect(authorizeOrgIssuer).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      bearerToken: "guest-token",
      issuerKind: "anonymous",
      clientIp: null,
    });
  });

  it("mints the ID token and ID-JAG with the /g/ issuer", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer guest-token",
      "x-forwarded-proto": "https",
    };

    const authenticateResponse = await app.request(
      `http://app.mcpjam.com/api/web/xaa/g/${ORG_ID}/authenticate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ userId: "user-12345" }),
      },
    );
    expect(authenticateResponse.status).toBe(200);
    const authenticateBody = await authenticateResponse.json();
    expect(decodeJwtPayload(authenticateBody.id_token).iss).toBe(
      `https://app.mcpjam.com/api/web/xaa/g/${ORG_ID}`,
    );

    const tokenExchangeResponse = await app.request(
      `http://app.mcpjam.com/api/web/xaa/g/${ORG_ID}/token-exchange`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          identityAssertion: authenticateBody.id_token,
          audience: "https://auth.example.com",
          resource: "https://mcp.example.com",
          clientId: "mcpjam-debugger",
        }),
      },
    );

    expect(tokenExchangeResponse.status).toBe(200);
    const payload = decodeJwtPayload(
      (await tokenExchangeResponse.json()).id_jag,
    );
    expect(payload.iss).toBe(
      `https://app.mcpjam.com/api/web/xaa/g/${ORG_ID}`,
    );
    expect(authorizeOrgIssuer).toHaveBeenCalledTimes(2);
    expect(authorizeOrgIssuer).toHaveBeenLastCalledWith(
      expect.objectContaining({ issuerKind: "anonymous" }),
    );
  });
});

describe("mock OIDC IdP gating on the hosted router", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const ORG_ID = "org_a1B2";
  const BASE = "https://app.mcpjam.com/api/web/xaa";
  let tempDir: string;
  let app: Hono;
  let authorizeOrgIssuer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-oidc-hosted-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    authorizeOrgIssuer = vi.fn().mockResolvedValue(undefined);
    app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: true,
        trustForwardedHeaders: true,
        protectedMiddlewares: [bearerAuthMiddleware, guestRateLimitMiddleware],
        authorizeOrgIssuer,
      }),
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

  function tokenRequest(fields: Record<string, string>, ip: string) {
    return {
      method: "POST" as const,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-for": ip,
      },
      body: new URLSearchParams(fields).toString(),
    };
  }

  const exchangeFields = (subjectToken: string) => ({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    client_id: "client-1",
    audience: "https://as.example.com",
    resource: "https://rs.example.com",
  });

  it("refuses standard token exchange at the unscoped hosted /token", async () => {
    const response = await app.request(
      `${BASE}/token`,
      tokenRequest(exchangeFields("a.b.c"), "11.0.0.1"),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("unsupported_grant_type");
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });

  it("advertises code-only at the unscoped hosted issuer, both grants at the scoped issuer", async () => {
    const unscopedDoc = await (
      await app.request(`${BASE}/.well-known/openid-configuration`)
    ).json();
    expect(unscopedDoc.grant_types_supported).toEqual(["authorization_code"]);
    expect(
      unscopedDoc.identity_chaining_requested_token_types_supported,
    ).toBeUndefined();

    const scopedDoc = await (
      await app.request(
        `${BASE}/o/${ORG_ID}/.well-known/openid-configuration`,
      )
    ).json();
    expect(scopedDoc.grant_types_supported).toEqual([
      "authorization_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ]);
    expect(scopedDoc.userinfo_endpoint).toBe(
      `${BASE}/o/${ORG_ID}/userinfo`,
    );
  });

  it("gates scoped token exchange on a bearer + membership, mapped to OAuth errors", async () => {
    const noBearer = await app.request(
      `${BASE}/o/${ORG_ID}/token`,
      tokenRequest(exchangeFields("a.b.c"), "11.0.0.2"),
    );
    expect(noBearer.status).toBe(401);
    expect((await noBearer.json()).error).toBe("invalid_client");

    authorizeOrgIssuer.mockRejectedValueOnce(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "Not a member"),
    );
    const rejected = await app.request(`${BASE}/o/${ORG_ID}/token`, {
      ...tokenRequest(exchangeFields("a.b.c"), "11.0.0.3"),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "11.0.0.3",
        Authorization: "Bearer workos-token",
      },
    });
    expect(rejected.status).toBe(403);
    expect((await rejected.json()).error).toBe("access_denied");
  });

  it("serves the authorization_code flow unauthenticated on the scoped path", async () => {
    const confirmResponse = await app.request(
      `${BASE}/o/${ORG_ID}/authorize/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-forwarded-proto": "https",
          "x-forwarded-for": "11.0.0.4",
        },
        body: new URLSearchParams({
          client_id: "client-1",
          redirect_uri: "https://rp.example.com/callback",
          response_type: "code",
          subject: "bob-1",
          email: "bob@example.com",
        }).toString(),
      },
    );
    expect(confirmResponse.status).toBe(302);
    const code = new URL(
      confirmResponse.headers.get("location")!,
    ).searchParams.get("code")!;

    const tokenResponse = await app.request(
      `${BASE}/o/${ORG_ID}/token`,
      tokenRequest(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://rp.example.com/callback",
          client_id: "client-1",
        },
        "11.0.0.5",
      ),
    );
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();
    expect(decodeJwtPayload(body.id_token).iss).toBe(`${BASE}/o/${ORG_ID}`);
    // The front-channel flow never consults the membership gate.
    expect(authorizeOrgIssuer).not.toHaveBeenCalled();
  });
});
