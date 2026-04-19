import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import xaaWeb from "../xaa.js";
import {
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../../../services/xaa-idp-keypair.js";

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
