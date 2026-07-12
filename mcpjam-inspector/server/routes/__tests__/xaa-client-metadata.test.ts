import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  evaluateIdJagClientMetadata,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
} from "@mcpjam/sdk";
import {
  registerXaaClientMetadataRoute,
  XAA_CLIENT_METADATA_PATH,
} from "../xaa-client-metadata";

// Contract tests for the hosted Client ID Metadata Document
// (draft-ietf-oauth-client-id-metadata-document-02). A regression here
// degrades the debugger's cimd strategy to an accurate preflight failure —
// these pins are what keep the fixed production URL redeemable.

function buildApp() {
  const app = new Hono();
  registerXaaClientMetadataRoute(app);
  return app;
}

describe("XAA client metadata document route", () => {
  it("serves a DIRECT 200 JSON document (no redirect) with cache and CORS headers", async () => {
    const response = await buildApp().request(XAA_CLIENT_METADATA_PATH);

    // Exactly 200, not merely 2xx/3xx — draft-02 forbids the AS from
    // following redirects, so a Location here would break every RAS fetch.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("publishes the exact production URL as client_id with the full ID-JAG profile", async () => {
    const response = await buildApp().request(XAA_CLIENT_METADATA_PATH);
    const document = await response.json();

    // Simple string identity: exactly the fixed production URL, even though
    // this request hit a local test app.
    expect(document.client_id).toBe(XAA_DEBUG_CLIENT_ID_METADATA_URL);

    const evaluation = evaluateIdJagClientMetadata(document);
    expect(evaluation.profile).toBe("present");
    expect(evaluation.jwtBearerGrant).toBe("present");
    expect(evaluation.tokenExchangeGrant).toBe("present");
    // A published document can never hold a shared secret.
    expect(evaluation.tokenEndpointAuthMethod).toBe("none");

    // No authorization-code shape leaks into the jwt-bearer client identity.
    expect(document.redirect_uris).toBeUndefined();
    expect(document.response_types).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain("client_secret");
  });

  it("answers OPTIONS with 204 and CORS headers only", async () => {
    const response = await buildApp().request(XAA_CLIENT_METADATA_PATH, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is mounted in both production entry points", () => {
    // The route must exist on BOTH server/index.ts and server/app.ts — a
    // missing mount in either deployment shape silently breaks cimd runs.
    // Reading the sources keeps this honest without booting the full servers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path");
    for (const entry of ["index.ts", "app.ts"]) {
      const source = readFileSync(
        join(__dirname, "..", "..", entry),
        "utf-8",
      );
      expect(
        source.includes("registerXaaClientMetadataRoute(app)"),
        `${entry} must mount the XAA client metadata route`,
      ).toBe(true);
    }
  });
});
