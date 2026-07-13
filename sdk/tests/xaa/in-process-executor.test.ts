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
      post({ userId: "user-1", email: "u@example.com", audience: "client-1" }),
    );
    expect(result.ok).toBe(true);
    const token = (result.body as { id_token: string }).id_token;
    const claims = decodeJWT(token)!;
    expect(claims.sub).toBe("user-1");
    expect(claims.email).toBe("u@example.com");
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
      }),
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
      }),
    );
    const idJag = (result.body as { id_jag: string }).id_jag;
    expect(decodeJWT(idJag)!.aud).toBe("https://wrong-audience.example.com");
  });

  it("/proxy/token redeems and wraps the upstream {status, body}", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === TOKEN_ENDPOINT && (init?.method || "").toUpperCase() === "POST") {
        return new Response(
          JSON.stringify({ access_token: "at-1", token_type: "Bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest(
      "/proxy/token",
      post({
        tokenEndpoint: TOKEN_ENDPOINT,
        assertion: "the-id-jag",
        clientId: "client-1",
        scope: "read:tools",
        resource: RESOURCE,
      }),
    );
    expect(result.ok).toBe(true);
    const wrapper = result.body as { status: number; body: any };
    expect(wrapper.status).toBe(200);
    expect(wrapper.body.access_token).toBe("at-1");
  });

  it("rejects an unknown internal route with 404", async () => {
    const exec = createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE });
    const result = await exec.internalRequest("/nope", post({}));
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
  });

  it("drives the shared engine to completion via the in-process executor", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes(".well-known/oauth-protected-resource")) {
        return json({ resource: RESOURCE, authorization_servers: [AS_ISSUER] });
      }
      if (
        url.includes(".well-known/oauth-authorization-server") ||
        url.includes(".well-known/openid-configuration")
      ) {
        return json({
          issuer: AS_ISSUER,
          token_endpoint: TOKEN_ENDPOINT,
          grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
        });
      }
      if (url === TOKEN_ENDPOINT && method === "POST") {
        return json({ access_token: "at-1", token_type: "Bearer", expires_in: 300 });
      }
      if (url === RESOURCE && method === "POST") {
        return json({ jsonrpc: "2.0", id: "xaa", result: { capabilities: {} } });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

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
      registrationStrategy: "pre_registered",
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
      requestExecutor: createInProcessXaaExecutor({ issuerBaseUrl: ISSUER_BASE }),
      negativeTestMode: "valid",
      userId: "user-1",
      email: "u@example.com",
      clientId: "client-1",
      scope: "read:tools",
      registrationStrategy: "pre_registered",
    });

    const result = await runXaaStateMachine(machine, () => state);

    expect(result.error).toBeUndefined();
    expect(result.completed).toBe(true);
    expect(state.accessToken).toBe("at-1");
  });
});
