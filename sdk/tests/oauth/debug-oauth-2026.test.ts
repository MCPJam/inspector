import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { validateAuthorizationResponseIssuer } from "../../src/oauth/state-machines/debug-oauth-2026-07-28.js";
import { deriveApplicationType } from "../../src/oauth/state-machines/shared/dynamic-client-registration.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthRequestExecutor,
} from "../../src/oauth/state-machines/types.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";

describe("deriveApplicationType (SEP-837)", () => {
  it("is native for loopback and custom-scheme redirects", () => {
    for (const uri of [
      "http://localhost:3000/callback",
      "http://127.0.0.1:3000/callback",
      "http://[::1]:3000/callback",
      "mcpjam://oauth/callback",
    ]) {
      expect(deriveApplicationType([uri])).toBe("native");
    }
  });

  it("is web for HTTPS non-localhost redirects", () => {
    expect(deriveApplicationType(["https://app.example.com/callback"])).toBe(
      "web",
    );
  });

  it("is native if any redirect is native", () => {
    expect(
      deriveApplicationType([
        "https://app.example.com/callback",
        "http://localhost:3000/callback",
      ]),
    ).toBe("native");
  });

  it("classifies an https loopback as web (OIDC loopback is http-only)", () => {
    expect(deriveApplicationType(["https://localhost:3000/callback"])).toBe(
      "web",
    );
  });
});

describe("debug-oauth-2026-07-28 machine", () => {
  const build = (overrides: Partial<OAuthFlowState> = {}) => {
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      serverUrl: SERVER_URL,
      ...overrides,
    };
    const machine = createOAuthStateMachine({
      protocolVersion: "2026-07-28",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: {},
      }),
      dynamicRegistration: { client_name: "Test Client" },
    });
    return { machine, getState: () => state };
  };

  it("is buildable via the factory (no silent fallback to 2025-11-25)", () => {
    const { machine } = build();
    expect(machine).toBeDefined();
    expect(typeof machine.proceedToNextStep).toBe("function");
  });

  it("attaches application_type on the DCR registration request (native for loopback)", async () => {
    const { machine, getState } = build({
      currentStep: "received_authorization_server_metadata",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        // no client_id_metadata_document_supported → DCR path
      },
    });
    await machine.proceedToNextStep();
    const req = getState().lastRequest;
    expect(req?.url).toBe("https://auth.example.com/register");
    expect(req?.body?.application_type).toBe("native");
  });

  it("derives application_type from the caller's redirect_uris override, not the loopback default", async () => {
    // A caller-supplied redirect_uris override lands in the DCR body; the
    // application_type must be derived from that SAME effective list, so an
    // https/web override cannot ship alongside a `native` type.
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      serverUrl: SERVER_URL,
      currentStep: "received_authorization_server_metadata",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
    };
    const machine = createOAuthStateMachine({
      protocolVersion: "2026-07-28",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI, // loopback
      requestExecutor: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: {},
      }),
      // Override the redirect with a hosted https (web) URI.
      dynamicRegistration: {
        client_name: "Test Client",
        redirect_uris: ["https://hosted.example.com/callback"],
      },
    });
    await machine.proceedToNextStep();
    const req = state.lastRequest;
    expect(req?.body?.redirect_uris).toEqual([
      "https://hosted.example.com/callback",
    ]);
    expect(req?.body?.application_type).toBe("web");
  });
});

describe("validateAuthorizationResponseIssuer (RFC 9207)", () => {
  const ISS = "https://auth.example.com";

  it("row 1: present and matching → ok", () => {
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: ISS,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: true });
  });

  it("row 2: present and mismatched → reject (no error params surfaced)", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: "https://evil.example.com",
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/RFC 9207/);
  });

  it("row 3: absent but advertised supported → reject (missing required iss)", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: undefined,
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
  });

  it("row 4: absent and not advertised → ok (nothing to validate)", () => {
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: undefined,
        issParameterSupported: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("present-but-not-advertised is still validated: match → ok, mismatch → reject", () => {
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: ISS,
        issParameterSupported: false,
      }),
    ).toEqual({ ok: true });
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: "https://evil.example.com",
        issParameterSupported: false,
      }).ok,
    ).toBe(false);
  });

  it("treats an empty-string iss as absent", () => {
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: "",
        issParameterSupported: undefined,
      }),
    ).toEqual({ ok: true });
  });
});

describe("debug-oauth-2026-07-28 machine — 2M-a spec steps", () => {
  const AS_URL = "https://auth.example.com";

  // Build a machine seeded at a given step with a custom request executor, run
  // one step, and return the resulting state.
  const driveOnce = async (
    overrides: Partial<OAuthFlowState>,
    executor: OAuthRequestExecutor,
  ) => {
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      serverUrl: SERVER_URL,
      ...overrides,
    };
    const machine = createOAuthStateMachine({
      protocolVersion: "2026-07-28",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: executor,
      dynamicRegistration: { client_name: "Test Client" },
    });
    await machine.proceedToNextStep();
    return () => state;
  };

  const metadata = (issuer: string) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    body: {
      issuer,
      authorization_endpoint: `${AS_URL}/authorize`,
      token_endpoint: `${AS_URL}/token`,
      registration_endpoint: `${AS_URL}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    },
  });

  it("rejects AS metadata whose issuer ≠ the discovery URL (RFC 8414 §3.3)", async () => {
    const getState = await driveOnce(
      {
        currentStep: "request_authorization_server_metadata",
        authorizationServerUrl: AS_URL,
      },
      jest.fn().mockResolvedValue(metadata("https://evil.example.com")),
    );
    expect(getState().error).toMatch(/RFC 8414/);
  });

  it("accepts AS metadata whose issuer matches the discovery URL exactly", async () => {
    const getState = await driveOnce(
      {
        currentStep: "request_authorization_server_metadata",
        authorizationServerUrl: AS_URL,
      },
      jest.fn().mockResolvedValue(metadata(AS_URL)),
    );
    expect(getState().error).toBeUndefined();
    expect(getState().currentStep).toBe("received_authorization_server_metadata");
  });

  it("records the issuer alongside the PKCE parameters", async () => {
    const getState = await driveOnce(
      {
        currentStep: "received_client_credentials",
        clientId: "client-123",
        authorizationServerMetadata: metadata(AS_URL).body,
      },
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: {},
      }),
    );
    expect(getState().codeVerifier).toBeTruthy();
    expect(getState().recordedIssuer).toBe(AS_URL);
  });

  it("blocks the token exchange when the callback iss mismatches (RFC 9207)", async () => {
    const getState = await driveOnce(
      {
        currentStep: "received_authorization_code",
        authorizationCode: "auth-code-abc",
        recordedIssuer: AS_URL,
        authorizationResponseIss: "https://evil.example.com",
        authorizationServerMetadata: metadata(AS_URL).body,
      },
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: {},
      }),
    );
    // Stopped before building/sending the token request.
    expect(getState().currentStep).toBe("received_authorization_code");
    expect(getState().error).toMatch(/RFC 9207/);
  });

  it("logs a token-verified info entry for a tools/list verify result", async () => {
    const getState = await driveOnce(
      {
        currentStep: "authenticated_mcp_request",
        accessToken: "test-access-token",
      },
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 2,
          result: { tools: [{ name: "a" }, { name: "b" }] },
        },
      }),
    );
    expect(getState().currentStep).toBe("complete");
    const verified = (getState().infoLogs ?? []).find(
      (l) => l.id === "mcp-token-verified",
    );
    expect(verified).toBeDefined();
    expect(verified?.data?.["Tools listed"]).toBe(2);
  });

  it("post-token verification is a stateless tools/list, never initialize", async () => {
    const getState = await driveOnce(
      {
        currentStep: "received_access_token",
        accessToken: "test-access-token",
      },
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: {},
      }),
    );
    const req = getState().lastRequest;
    expect(req?.body?.method).toBe("tools/list");
    expect(JSON.stringify(req?.body)).not.toContain("initialize");
    expect(req?.headers?.["MCP-Protocol-Version"]).toBe("2026-07-28");
    expect(req?.headers?.["Mcp-Method"]).toBe("tools/list");
    // The stateless `_meta` envelope carries the protocol version.
    expect(
      req?.body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
    ).toBe("2026-07-28");
  });
});
