import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../../../services/xaa-idp-keypair.js";
import xaa from "../xaa.js";

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
      "http://localhost/api/mcp/xaa/.well-known/openid-configuration",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe("http://localhost/api/mcp/xaa");
    expect(body.jwks_uri).toBe(
      "http://localhost/api/mcp/xaa/.well-known/jwks.json",
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

    const authenticateResponse = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: "user-12345",
        email: "demo.user@example.com",
      }),
    });

    expect(authenticateResponse.status).toBe(200);
    const authenticateBody = await authenticateResponse.json();
    expect(authenticateBody.id_token).toEqual(expect.any(String));

    const tokenExchangeResponse = await app.request("/api/mcp/xaa/token-exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({
        identityAssertion: authenticateBody.id_token,
        audience: "https://auth.example.com",
        resource: "https://mcp.example.com",
        clientId: "mcpjam-debugger",
        negativeTestMode: "wrong_audience",
      }),
    });

    expect(tokenExchangeResponse.status).toBe(200);
    const tokenExchangeBody = await tokenExchangeResponse.json();
    const payload = decodeJwtPayload(tokenExchangeBody.id_jag);
    expect(payload.aud).toBe("https://wrong-audience.example.com");
  });
});
