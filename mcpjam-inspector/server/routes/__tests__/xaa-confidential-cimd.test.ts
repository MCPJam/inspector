import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync } from "node:crypto";
import {
  buildConfidentialCimdUrl,
  evaluateIdJagClientMetadata,
  UNVERIFIED_CONFIDENTIAL_CIMD_CLIENT_NAME,
  XAA_CONFIDENTIAL_CIMD_PATH_PREFIX,
} from "@mcpjam/sdk";
import {
  registerXaaConfidentialCimdRoute,
  resetXaaConfidentialCimdRateLimitForTests,
} from "../xaa-confidential-cimd";

beforeEach(() => resetXaaConfidentialCimdRateLimitForTests());

// Contract tests for the stateless confidential-CIMD reflector. It decodes the
// PUBLIC key from the URL and echoes it into a private_key_jwt Client ID
// Metadata Document. CIMD draft-02 requires doc.client_id === the fetched URL,
// so the pin below is what keeps a confidential cimd run redeemable.

function buildApp() {
  const app = new Hono();
  registerXaaConfidentialCimdRoute(app);
  return app;
}

/** A representative EC P-256 public JWK, exactly as the CLI publishes it. */
function samplePublicJwk() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid: "xaa-client-1", alg: "ES256", use: "sig" };
}

/** The path portion of the URL the CLI would present as client_id. */
function cimdPath(jwk: Record<string, unknown>): string {
  return new URL(buildConfidentialCimdUrl(jwk, "http://localhost")).pathname;
}

describe("XAA confidential CIMD reflector route", () => {
  it("serves a DIRECT 200 private_key_jwt document echoing the URL-embedded key", async () => {
    const jwk = samplePublicJwk();
    const path = cimdPath(jwk);
    const response = await buildApp().request(`http://localhost${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("max-age=3600");

    const document = await response.json();

    // The identity string MUST byte-match the fetched URL (simple string
    // comparison per draft-02), derived from the request itself.
    expect(document.client_id).toBe(`http://localhost${path}`);

    const evaluation = evaluateIdJagClientMetadata(document);
    expect(evaluation.profile).toBe("present");
    expect(evaluation.jwtBearerGrant).toBe("present");
    expect(evaluation.tokenExchangeGrant).toBe("present");
    expect(evaluation.tokenEndpointAuthMethod).toBe("private_key_jwt");

    // The reflected identity is EXPLICITLY UNTRUSTED and UNBRANDED — anyone can
    // publish any key here, so it must not impersonate the MCPJam debugger.
    expect(document.client_name).toBe(UNVERIFIED_CONFIDENTIAL_CIMD_CLIENT_NAME);
    expect(document.logo_uri).toBeUndefined();
    expect(document.client_uri).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain("mcpjam.com/mcp_jam");

    // The public key is echoed; no secret/private field ever appears.
    expect(document.jwks.keys[0].x).toBe(jwk.x);
    expect(document.jwks.keys[0].y).toBe(jwk.y);
    expect(document.jwks.keys[0].crv).toBe("P-256");
    expect(document.jwks.keys[0].d).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain('"d"');
    expect(JSON.stringify(document)).not.toContain("client_secret");
  });

  it("strips any private/unknown fields an attacker encodes into the key", async () => {
    // Encode a JWK carrying a private scalar `d` and a junk field.
    const jwk = samplePublicJwk();
    const poisoned = { ...jwk, d: "AAAA", evil: "x" };
    const path = new URL(
      buildConfidentialCimdUrl(poisoned, "http://localhost"),
    ).pathname;
    const response = await buildApp().request(`http://localhost${path}`);
    expect(response.status).toBe(200);
    const document = await response.json();
    // Only the sanitized public members survive.
    expect(document.jwks.keys[0].x).toBe(jwk.x);
    expect(document.jwks.keys[0].d).toBeUndefined();
    expect(document.jwks.keys[0].evil).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain("evil");
  });

  it("rejects a non-P-256 / malformed key coordinate with 400", async () => {
    const bad = buildConfidentialCimdUrl(
      { kty: "EC", crv: "P-384", x: "short", y: "short" } as never,
      "http://localhost",
    );
    const response = await buildApp().request(bad);
    expect(response.status).toBe(400);
  });

  it("rate-limits a single IP hammering the unbounded key space", async () => {
    const app = buildApp();
    const jwk = samplePublicJwk();
    const path = cimdPath(jwk);
    const headers = { "x-forwarded-for": "203.0.113.9" };
    let sawLimit = false;
    // The window budget is modest; well over it must eventually 429.
    for (let i = 0; i < 200; i++) {
      const r = await app.request(`http://localhost${path}`, { headers });
      if (r.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("honors proxy-forwarded host/proto when building client_id", async () => {
    const jwk = samplePublicJwk();
    const path = cimdPath(jwk);
    const response = await buildApp().request(`http://localhost${path}`, {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.mcpjam.com",
      },
    });
    const document = await response.json();
    // Behind the proxy the public URL is https://app.mcpjam.com/... — the
    // client presented exactly that, so it must byte-match.
    expect(document.client_id).toBe(`https://app.mcpjam.com${path}`);
  });

  it("rejects a malformed key segment with 400", async () => {
    const url = `http://localhost${XAA_CONFIDENTIAL_CIMD_PATH_PREFIX}not-a-valid-jwk`;
    const response = await buildApp().request(url);
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers OPTIONS with 204 and CORS headers only", async () => {
    const jwk = samplePublicJwk();
    const path = cimdPath(jwk);
    const response = await buildApp().request(`http://localhost${path}`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is mounted in both production entry points", () => {
    for (const entry of ["index.ts", "app.ts"]) {
      const source = readFileSync(
        fileURLToPath(new URL(`../../${entry}`, import.meta.url)),
        "utf-8",
      );
      expect(
        source.includes("registerXaaConfidentialCimdRoute(app)"),
        `${entry} must mount the XAA confidential CIMD reflector route`,
      ).toBe(true);
    }
  });
});
