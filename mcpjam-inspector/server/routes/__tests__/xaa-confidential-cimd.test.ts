import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, type JsonWebKey } from "node:crypto";
import {
  buildConfidentialCimdUrl,
  createDerivedConfidentialCimdProviderFactory,
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
function samplePublicJwk(): JsonWebKey & { kid: string; alg: string; use: string } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  return { ...jwk, kid: "xaa-client-1", alg: "ES256", use: "sig" };
}

/** The path portion of the URL the CLI would present as client_id. */
function cimdPath(jwk: JsonWebKey): string {
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

  it("serves an org-derived URL without an org id, database, or master key", async () => {
    // The reflector receives only the public JWK encoded in the URL. This
    // factory call models the hosted signer; nothing from it is passed to the
    // reflector route besides the resulting public client_id URL.
    const clientId = createDerivedConfidentialCimdProviderFactory(
      Buffer.alloc(32, 9),
    )("org-derived-example").getClientIdMetadataUrl("http://localhost");
    const response = await buildApp().request(clientId);

    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.client_id).toBe(clientId);
    expect(document.jwks.keys[0].d).toBeUndefined();
  });

  it("rejects a key carrying a private `d` field with 400 (fails closed)", async () => {
    // A well-formed public key plus a private scalar — hand-encoded, since the
    // client-side builder refuses to serialize `d` at all.
    const jwk = samplePublicJwk();
    const encoded = Buffer.from(
      JSON.stringify({ ...jwk, d: "AAAA" }),
    ).toString("base64url");
    const response = await buildApp().request(
      `http://localhost${XAA_CONFIDENTIAL_CIMD_PATH_PREFIX}${encoded}`,
    );
    expect(response.status).toBe(400);
  });

  it("ignores benign unknown members but still serves the public key", async () => {
    const jwk = samplePublicJwk();
    const encoded = Buffer.from(
      JSON.stringify({ ...jwk, evil: "x" }),
    ).toString("base64url");
    const response = await buildApp().request(
      `http://localhost${XAA_CONFIDENTIAL_CIMD_PATH_PREFIX}${encoded}`,
    );
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.jwks.keys[0].x).toBe(jwk.x);
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
    // x-real-ip is a trusted header getClientIp honors (above x-forwarded-for).
    const headers = { "x-real-ip": "203.0.113.9" };
    let sawLimit = false;
    let okCount = 0;
    // Well over the per-window budget must eventually 429.
    for (let i = 0; i < 700; i++) {
      const r = await app.request(`http://localhost${path}`, { headers });
      if (r.status === 429) {
        sawLimit = true;
        break;
      }
      okCount++;
    }
    expect(sawLimit).toBe(true);
    // A generous budget is allowed through before the limit trips (shared-AS
    // headroom), so this isn't tripping on a handful of requests.
    expect(okCount).toBeGreaterThan(100);
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

  it("uses the FIRST hop of a comma-separated forwarded chain", async () => {
    const jwk = samplePublicJwk();
    const path = cimdPath(jwk);
    const response = await buildApp().request(`http://localhost${path}`, {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "app.mcpjam.com, internal.lb",
      },
    });
    const document = await response.json();
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
