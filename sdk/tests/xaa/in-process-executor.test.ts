import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createInProcessXaaExecutor } from "../../src/xaa/in-process-executor.js";
import {
  getXAAIssuerUrl,
  resetXAAIdpKeyPairForTests,
} from "../../src/xaa/mint/keypair.js";
import { verifyXaaJwt, issueMockIdToken } from "../../src/xaa/mint/signer.js";
import { decodeJWT } from "../../src/oauth/state-machines/shared/jwt.js";
import {
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  XAA_DEBUG_IDP_CLIENT_ID,
} from "../../src/oauth/client-identity.js";

const ISSUER_BASE = "https://issuer.example.com/api/mcp";
const AS_ISSUER = "https://auth.example.com";
const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token";
const RESOURCE = "https://mcp.example.com/mcp";

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("createInProcessXaaExecutor internal routes", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const originalFetch = global.fetch;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-inproc-"));
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

  it("/authenticate mints a verifiable mock id_token", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest(
      "/authenticate",
      post({ userId: "user-1", email: "u@example.com", audience: "client-1" })
    );
    expect(result.ok).toBe(true);
    const token = (result.body as { id_token: string }).id_token;
    const claims = decodeJWT(token)!;
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("u@example.com");
  });

  it("/authenticate returns the rich server-parity body", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest(
      "/authenticate",
      post({ userId: "user-1", email: "u@example.com" })
    );
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.user).toEqual({ sub: "user-1", email: "u@example.com" });
  });

  it("/authenticate applies the server's demo-identity defaults", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest("/authenticate", post({}));
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.user).toEqual({
      sub: "user-12345",
      email: "demo.user@example.com",
    });
    const claims = decodeJWT(body.id_token as string)!;
    expect(claims.sub).toBe("user-12345");
    expect(claims.email).toBe("demo.user@example.com");
  });

  it("/token-exchange decodes the assertion and mints an ID-JAG", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const issuer = getXAAIssuerUrl(ISSUER_BASE);
    const { token: idToken } = issueMockIdToken({
      issuer,
      subject: "user-1",
      email: "u@example.com",
    });

    const result = await exec.internalRequest(
      "/token-exchange",
      post({
        identityAssertion: idToken,
        audience: AS_ISSUER,
        resource: RESOURCE,
        clientId: "client-1",
        scope: "read:tools",
        negativeTestMode: "valid",
      })
    );
    expect(result.ok).toBe(true);
    const idJag = (result.body as { id_jag: string }).id_jag;
    const claims = verifyXaaJwt(idJag, { issuer, typ: "oauth-id-jag+jwt" });
    expect(claims.sub).toBe("user-1");
    expect(claims.aud).toBe(AS_ISSUER);
    expect(claims.resource).toBe(RESOURCE);
    expect(claims.client_id).toBe("client-1");
    expect(claims.email).toBe("u@example.com");
  });

  it("/token-exchange returns the rich server-parity body", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const issuer = getXAAIssuerUrl(ISSUER_BASE);
    const { token: idToken } = issueMockIdToken({
      issuer,
      subject: "user-1",
      email: "u@example.com",
    });
    const result = await exec.internalRequest(
      "/token-exchange",
      post({
        identityAssertion: idToken,
        audience: AS_ISSUER,
        clientId: "client-1",
        negativeTestMode: "wrong_audience",
      })
    );
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.token_type).toBe("N_A");
    expect(body.issued_token_type).toBe(ID_JAG_TOKEN_TYPE);
    expect(body.expires_in).toBeGreaterThan(0);
    expect(body.negative_test_mode).toBe("wrong_audience");
  });

  it("/token handles the RFC 8693 form grant", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const issuer = getXAAIssuerUrl(ISSUER_BASE);
    const { token: idToken } = issueMockIdToken({
      issuer,
      subject: "user-1",
      email: "u@example.com",
      audience: XAA_DEBUG_IDP_CLIENT_ID,
      resourceClientId: "client-1",
    });
    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      subject_token: idToken,
      subject_token_type: ID_TOKEN_TOKEN_TYPE,
      client_id: XAA_DEBUG_IDP_CLIENT_ID,
      audience: AS_ISSUER,
      resource: RESOURCE,
      scope: "read:tools",
    });

    const result = await exec.internalRequest("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    expect(result.ok).toBe(true);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers.pragma).toBe("no-cache");
    const response = result.body as {
      access_token: string;
      issued_token_type: string;
    };
    expect(response.issued_token_type).toBe(ID_JAG_TOKEN_TYPE);
    const claims = verifyXaaJwt(response.access_token, {
      issuer,
      typ: "oauth-id-jag+jwt",
    });
    expect(claims).toMatchObject({
      sub: "user-1",
      aud: AS_ISSUER,
      resource: RESOURCE,
      client_id: "client-1",
      scope: "read:tools",
    });
  });

  it("/token-exchange applies the negative-test tamper (wrong_audience)", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const issuer = getXAAIssuerUrl(ISSUER_BASE);
    const { token: idToken } = issueMockIdToken({
      issuer,
      subject: "user-1",
      email: "u@example.com",
    });
    const result = await exec.internalRequest(
      "/token-exchange",
      post({
        identityAssertion: idToken,
        audience: AS_ISSUER,
        resource: RESOURCE,
        clientId: "client-1",
        negativeTestMode: "wrong_audience",
      })
    );
    const idJag = (result.body as { id_jag: string }).id_jag;
    expect(decodeJWT(idJag)!.aud).toBe("https://wrong-audience.example.com");
  });

  it("/proxy/token redeems and wraps the upstream {status, body}", async () => {
    global.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url === TOKEN_ENDPOINT &&
          (init?.method || "").toUpperCase() === "POST"
        ) {
          return new Response(
            JSON.stringify({ access_token: "at-1", token_type: "Bearer" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 404 });
      }
    ) as unknown as typeof fetch;

    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest(
      "/proxy/token",
      post({
        tokenEndpoint: TOKEN_ENDPOINT,
        assertion: "the-id-jag",
        clientId: "client-1",
        scope: "read:tools",
        resource: RESOURCE,
      })
    );
    expect(result.ok).toBe(true);
    const wrapper = result.body as { status: number; body: any };
    expect(wrapper.status).toBe(200);
    expect(wrapper.body.access_token).toBe("at-1");
  });

  it("/token-exchange rejects a missing/malformed/subject-less assertion with 400", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    // Missing assertion.
    let r = await exec.internalRequest(
      "/token-exchange",
      post({ audience: AS_ISSUER, resource: RESOURCE, clientId: "c" })
    );
    expect(r.status).toBe(400);
    // Non-JWT garbage.
    r = await exec.internalRequest(
      "/token-exchange",
      post({ identityAssertion: "not-a-jwt", clientId: "c" })
    );
    expect(r.status).toBe(400);
    // Well-formed JWT with no `sub`.
    const subless = issueMockIdToken({
      issuer: getXAAIssuerUrl(ISSUER_BASE),
      subject: "",
      email: "u@example.com",
    }).token;
    r = await exec.internalRequest(
      "/token-exchange",
      post({ identityAssertion: subless, clientId: "c" })
    );
    expect(r.status).toBe(400);
  });

  it("/token-exchange requires the audience, clientId, and a known mode", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const identityAssertion = issueMockIdToken({
      issuer: getXAAIssuerUrl(ISSUER_BASE),
      subject: "user-1",
    }).token;
    const valid = {
      identityAssertion,
      audience: AS_ISSUER,
      resource: RESOURCE,
      clientId: "client-1",
    };

    for (const field of ["audience", "clientId"] as const) {
      const body = { ...valid, [field]: "   " };
      const result = await exec.internalRequest("/token-exchange", post(body));
      expect(result.status, field).toBe(400);
      expect((result.body as { error: string }).error).toContain(field);
    }

    const invalidMode = await exec.internalRequest(
      "/token-exchange",
      post({ ...valid, negativeTestMode: "not-a-mode" })
    );
    expect(invalidMode.status).toBe(400);
    expect((invalidMode.body as { error: string }).error).toMatch(
      /unsupported negative test mode/i
    );
  });

  it("rejects an unknown internal route with 404", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest("/nope", post({}));
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
  });

  it("drives the shared engine to completion via the in-process executor", async () => {
    global.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        const json = (b: unknown, status = 200) =>
          new Response(JSON.stringify(b), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (url.includes(".well-known/oauth-protected-resource")) {
          return json({
            resource: RESOURCE,
            authorization_servers: [AS_ISSUER],
          });
        }
        if (
          url.includes(".well-known/oauth-authorization-server") ||
          url.includes(".well-known/openid-configuration")
        ) {
          return json({
            issuer: AS_ISSUER,
            token_endpoint: TOKEN_ENDPOINT,
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          });
        }
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({
            access_token: "at-1",
            token_type: "Bearer",
            expires_in: 300,
          });
        }
        if (url === RESOURCE && method === "POST") {
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25", capabilities: {} },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const { createXAAStateMachine } = await import(
      "../../src/xaa/state-machines/state-machine.js"
    );
    const { runXaaStateMachine } = await import(
      "../../src/xaa/state-machines/runner.js"
    );
    const { createInitialXAAFlowState } = await import(
      "../../src/xaa/state-machines/types.js"
    );

    let state = createInitialXAAFlowState({
      serverUrl: RESOURCE,
      registrationStrategy: "preregistered",
      negativeTestMode: "valid",
      userId: "user-1",
      email: "u@example.com",
      clientId: "client-1",
      scope: "read:tools",
    });
    const machine = createXAAStateMachine({
      getState: () => state,
      updateState: (u) => {
        state = { ...state, ...u };
      },
      serverUrl: RESOURCE,
      issuerBaseUrl: ISSUER_BASE,
      requestExecutor: createInProcessXaaExecutor({
        issuerBaseUrl: ISSUER_BASE,
      }),
      negativeTestMode: "valid",
      userId: "user-1",
      email: "u@example.com",
      clientId: "client-1",
      scope: "read:tools",
      registrationStrategy: "preregistered",
    });

    const result = await runXaaStateMachine(machine, () => state);

    expect(result.error).toBeUndefined();
    expect(result.completed).toBe(true);
    expect(state.accessToken).toBe("at-1");
  });
});

describe("createInProcessXaaExecutor externalRequest SSRF guard", () => {
  it("enforcePublicHost blocks a private host at fetch time even when httpsOnly is false", async () => {
    const exec = createInProcessXaaExecutor({
      issuerBaseUrl: ISSUER_BASE,
      httpsOnly: false,
    });
    // The private-host / DNS guard fires before any network call, closing the
    // DNS-rebinding window for the caller-influenced CIMD document fetch.
    await expect(
      exec.externalRequest(
        "https://127.0.0.1/xaa-metadata.json",
        { method: "GET", redirect: "manual" },
        { enforcePublicHost: true }
      )
    ).rejects.toThrow(/private|reserved/i);
  });
});
