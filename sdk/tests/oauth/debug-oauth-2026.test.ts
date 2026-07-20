import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { deriveApplicationType } from "../../src/oauth/state-machines/shared/dynamic-client-registration.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type { OAuthFlowState } from "../../src/oauth/state-machines/types.js";

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
