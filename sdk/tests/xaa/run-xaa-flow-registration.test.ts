import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { runXaaFlow } from "../../src/xaa/run-xaa-flow.js";
import * as oauthProxy from "../../src/oauth-proxy.js";
import {
  getXAAIdpJwks,
  resetXAAIdpKeyPairForTests,
} from "../../src/xaa/mint/keypair.js";
import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT,
  TOKEN_EXCHANGE_GRANT,
} from "../../src/oauth/client-identity.js";

vi.mock("../../src/oauth-proxy.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/oauth-proxy.js")
  >();
  return {
    ...actual,
    // The flow fixture uses global.fetch for its synthetic OAuth endpoints.
    // DNS pinning itself is tested in oauth-proxy.test.ts.
    fetchOAuthMetadata: vi.fn(
      async (url: string, _httpsOnly = false, timeoutMs?: number) => {
        const response = await global.fetch(url, {
          headers: { Accept: "application/json" },
          signal:
            timeoutMs === undefined
              ? undefined
              : AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return {
            status: response.status,
            statusText: response.statusText,
          };
        }
        return {
          metadata: (await response.json()) as Record<string, unknown>,
          finalUrl: response.url || url,
        };
      }
    ),
  };
});

// DCR + CIMD registration strategies driven through the real state machine with
// a mocked global.fetch (mirrors run-xaa-flow.test.ts). DCR is fully exercised;
// CIMD here is the public-client variant the engine supports today.

const SERVER_URL = "https://mcp.example.com/mcp";
const AS_ISSUER = "https://auth.example.com";
const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";
const ISSUER_BASE = "https://issuer.example.com/api/mcp";
const ISSUER = `${ISSUER_BASE}/xaa`;
const ISSUER_METADATA = `${ISSUER}/.well-known/openid-configuration`;
const ISSUER_JWKS = `${ISSUER}/.well-known/jwks.json`;
const DCR_CLIENT_ID = "dcr-generated-client";
const DCR_CLIENT_SECRET = "dcr-generated-secret-DO-NOT-LEAK";
const CIMD_URL = "https://client.example.com/xaa-metadata.json";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const MCP_OK = {
  jsonrpc: "2.0",
  id: "mcpjam-xaa-cli",
  result: { protocolVersion: "2025-11-25", serverInfo: {} },
};

const dcrAsMetadata = {
  issuer: AS_ISSUER,
  token_endpoint: TOKEN_ENDPOINT,
  registration_endpoint: REGISTRATION_ENDPOINT,
  authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
  grant_types_supported: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
};

const cimdAsMetadata = {
  issuer: AS_ISSUER,
  token_endpoint: TOKEN_ENDPOINT,
  client_id_metadata_document_supported: true,
  authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
  grant_types_supported: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
  token_endpoint_auth_methods_supported: ["none"],
};

const publicCimdDoc = {
  client_id: CIMD_URL,
  client_name: "Test XAA CLI",
  authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
  grant_types: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
  token_endpoint_auth_method: "none",
};

interface StubConfig {
  asMetadata: Record<string, unknown>;
  cimdDoc?: Record<string, unknown>;
  token?: { status: number; body: unknown };
  tokenResponses?: Array<{ status: number; body: unknown }>;
}

function registrationStub(config: StubConfig) {
  const counts = { registration: 0, token: 0, mcp: 0, cimdDoc: 0 };
  let tokenIdx = 0;
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      // Local IdP publication (checked first — its URL also ends in
      // openid-configuration).
      if (url === ISSUER_METADATA)
        return json({ issuer: ISSUER, jwks_uri: ISSUER_JWKS });
      if (url === ISSUER_JWKS) return json(getXAAIdpJwks());
      // Discovery.
      if (url.includes(".well-known/oauth-protected-resource"))
        return json({
          resource: SERVER_URL,
          authorization_servers: [AS_ISSUER],
        });
      if (
        url.includes(".well-known/oauth-authorization-server") ||
        url.includes(".well-known/openid-configuration")
      )
        return json(config.asMetadata);
      // DCR registration.
      if (url === REGISTRATION_ENDPOINT && method === "POST") {
        counts.registration += 1;
        return json(
          {
            client_id: DCR_CLIENT_ID,
            client_secret: DCR_CLIENT_SECRET,
            client_secret_expires_at: 0,
            token_endpoint_auth_method: "client_secret_post",
          },
          201
        );
      }
      // CIMD document (the RAS/debugger preflight fetch).
      if (url === CIMD_URL && method === "GET") {
        counts.cimdDoc += 1;
        return json(config.cimdDoc ?? {});
      }
      // ID-JAG redemption.
      if (url === TOKEN_ENDPOINT && method === "POST") {
        counts.token += 1;
        const t = config.tokenResponses?.[tokenIdx++] ??
          config.token ?? {
            status: 200,
            body: {
              access_token: "at-xyz",
              token_type: "Bearer",
              expires_in: 300,
            },
          };
        return json(t.body, t.status);
      }
      // MCP call.
      if (url === SERVER_URL && method === "POST") {
        counts.mcp += 1;
        return json(MCP_OK, 200);
      }
      return json({}, 404);
    }
  );
  return { fetchImpl, counts };
}

describe("runXaaFlow — registration strategies", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const originalFetch = global.fetch;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-reg-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
  });

  it("DCR completes without a --client-id, deriving the identity from registration", async () => {
    const { fetchImpl, counts } = registrationStub({
      asMetadata: dcrAsMetadata,
    });
    global.fetch = fetchImpl as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      scope: "mcp.access",
      registrationStrategy: "dcr",
      // no clientId
    });

    expect(result.completed).toBe(true);
    expect(result.redemption?.tokenIssued).toBe(true);
    expect(counts.registration).toBe(1);
    expect(result.registration?.strategy).toBe("dcr");
    expect(result.registration?.clientId).toBe(DCR_CLIENT_ID);
    expect(result.registration?.reused).toBe(false);
    // The ID-JAG carries the dynamically-registered client_id.
    expect(result.idJag?.claims).toMatchObject({ client_id: DCR_CLIENT_ID });
  });

  it("DCR performs exactly one registration across the negative baseline + probe", async () => {
    const { fetchImpl, counts } = registrationStub({
      asMetadata: dcrAsMetadata,
      // Baseline accepted, probe rejected.
      tokenResponses: [
        { status: 200, body: { access_token: "at-ok", token_type: "Bearer" } },
        { status: 401, body: { error: "invalid_grant" } },
      ],
    });
    global.fetch = fetchImpl as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      scope: "mcp.access",
      registrationStrategy: "dcr",
      negativeTestMode: "wrong_audience",
    });

    // Two redemption attempts (baseline + probe) but ONE registration reused.
    expect(counts.token).toBe(2);
    expect(counts.registration).toBe(1);
    expect(result.registration?.reused).toBe(true);
    expect(result.registration?.clientId).toBe(DCR_CLIENT_ID);
    // Warnings from the baseline registration must survive the probe's reuse
    // (the probe state carries none because it did not re-register).
    expect(result.registration?.warnings.length).toBeGreaterThan(0);
  });

  it("rejects a dynamic strategy combined with a pinned tokenEndpoint", async () => {
    // No fetch stub needed: the guard returns before any network call.
    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      registrationStrategy: "dcr",
      tokenEndpoint: TOKEN_ENDPOINT,
    });

    expect(result.completed).toBe(false);
    expect(result.error).toMatch(
      /requires authorization-server metadata discovery/
    );
    expect(result.registration?.strategy).toBe("dcr");
  });

  it("rejects a caller-supplied CIMD URL that resolves to a private host (SSRF guard)", async () => {
    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      registrationStrategy: "cimd",
      clientIdMetadataUrl: "https://127.0.0.1/xaa-metadata.json",
    });

    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/private or reserved|Private\/reserved/i);
  });

  it("DCR never leaks the minted client_secret into the serialized result", async () => {
    const { fetchImpl } = registrationStub({ asMetadata: dcrAsMetadata });
    global.fetch = fetchImpl as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      scope: "mcp.access",
      registrationStrategy: "dcr",
    });

    expect(JSON.stringify(result)).not.toContain(DCR_CLIENT_SECRET);
  });

  it("scrubs a DCR secret an RAS reflects in a token error from the result", async () => {
    const { fetchImpl } = registrationStub({
      asMetadata: dcrAsMetadata,
      // A hostile/buggy RAS echoes the client_secret in its error body.
      token: {
        status: 400,
        body: {
          error: "invalid_client",
          error_description: `rejected secret ${DCR_CLIENT_SECRET}`,
        },
      },
    });
    global.fetch = fetchImpl as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      scope: "mcp.access",
      registrationStrategy: "dcr",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(DCR_CLIENT_SECRET);
    expect(serialized).toContain("[REDACTED]"); // the scrub fired
  });

  it("public CIMD fetches the custom metadata URL and uses it as the ID-JAG client_id", async () => {
    const { fetchImpl } = registrationStub({
      asMetadata: cimdAsMetadata,
      token: {
        status: 200,
        body: {
          access_token: "at-cimd",
          token_type: "Bearer",
          expires_in: 300,
        },
      },
    });
    global.fetch = fetchImpl as unknown as typeof fetch;
    // The CIMD document fetch goes through the SSRF-hardened, connection-pinned
    // path (real https.request) — not global.fetch — so mock it here. Its own
    // guards are covered in oauth-proxy.test.ts.
    const pinnedSpy = vi
      .spyOn(oauthProxy, "fetchPinnedPublicDocument")
      .mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: publicCimdDoc,
        finalUrl: CIMD_URL,
      });

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      scope: "mcp.access",
      registrationStrategy: "cimd",
      clientIdMetadataUrl: CIMD_URL,
    });

    expect(pinnedSpy).toHaveBeenCalledWith(CIMD_URL, expect.anything());
    pinnedSpy.mockRestore();
    expect(result.completed).toBe(true);
    expect(result.redemption?.tokenIssued).toBe(true);
    expect(result.registration?.strategy).toBe("cimd");
    expect(result.registration?.clientId).toBe(CIMD_URL);
    // The custom URL flows unchanged into the ID-JAG client_id claim.
    expect(result.idJag?.claims).toMatchObject({ client_id: CIMD_URL });
    // Public-client CIMD must stay visibly warned.
    expect(
      result.registration?.warnings.some((w) => w.code === "public_client")
    ).toBe(true);
  });
});
