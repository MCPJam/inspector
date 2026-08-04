/**
 * Wire-level assertions for the OAuth client-emulation knobs (HP-43 step 4).
 *
 * Each knob is exercised across all four state machines through a full
 * recorded ladder (same harness shape as no-emulation-goldens.test.ts —
 * which separately pins that an ABSENT emulation config changes nothing).
 */
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthHttpRequest,
  type OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";
import type { OAuthEmulationConfig } from "../../src/oauth/emulation/types.js";
import { deriveOAuthEmulation } from "../../src/oauth/emulation/derive.js";
import { verified } from "../support/oauth-profiles.js";

const SERVER_URL = "https://mcp-server.example.com/mcp";
const SERVER_ORIGIN = "https://mcp-server.example.com";
const RESOURCE_METADATA_URL = `${SERVER_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const AUTH_SERVER_URL = "https://auth-server.example.com";
const REDIRECT_URL = "http://localhost:3000/oauth/callback/debug";

const ALL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

function authServerBaseFor(version: OAuthProtocolVersion): string {
  return version === "2025-03-26" ? SERVER_ORIGIN : AUTH_SERVER_URL;
}

function buildMockRouter(version: OAuthProtocolVersion) {
  const asBase = authServerBaseFor(version);
  const challenge =
    version === "2025-03-26"
      ? 'Bearer realm="mcp"'
      : `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

  return async (request: OAuthHttpRequest) => {
    if (
      request.url === SERVER_URL &&
      request.headers.Authorization === "Bearer access-token"
    ) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 2,
          result:
            version === "2026-07-28"
              ? { tools: [] }
              : {
                  protocolVersion: version,
                  serverInfo: { name: "mock", version: "1.0.0" },
                  capabilities: {},
                },
        },
        ok: true,
      };
    }

    if (request.url === SERVER_URL) {
      return {
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": challenge },
        body: null,
        ok: false,
      };
    }

    if (request.url === RESOURCE_METADATA_URL) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          resource: SERVER_URL,
          authorization_servers: [AUTH_SERVER_URL],
        },
        ok: true,
      };
    }

    if (request.url.includes("/.well-known/oauth-authorization-server")) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          issuer: asBase,
          authorization_endpoint: `${asBase}/authorize`,
          token_endpoint: `${asBase}/token`,
          registration_endpoint: `${asBase}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          // Advertised so the DEFAULT (non-emulated) flow sends a scope —
          // the omit/fixed assertions below prove the knob overrides it.
          scopes_supported: ["as:advertised"],
          token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_basic",
            "client_secret_post",
          ],
        },
        ok: true,
      };
    }

    if (request.url === `${asBase}/register`) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          client_id: "test-client-id",
          // A secret is issued with client_secret_basic — the default flow
          // sends it as a Basic header; forced methods relocate or drop it.
          // (secret + "none" is NOT usable here: that contradiction
          // deliberately normalizes to the legacy secret-in-body shape,
          // see normalizeRegisteredClientAuthMethod / #2505.)
          client_secret: "registered-secret",
          token_endpoint_auth_method: "client_secret_basic",
        },
        ok: true,
      };
    }

    if (request.url === `${asBase}/token`) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          access_token: "access-token",
          token_type: "Bearer",
          expires_in: 3600,
        },
        ok: true,
      };
    }

    return {
      status: 404,
      statusText: "Not Found",
      headers: {},
      body: null,
      ok: false,
    };
  };
}

function createRecordingMachine(
  version: OAuthProtocolVersion,
  emulation?: OAuthEmulationConfig
) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    httpHistory: [],
    infoLogs: [],
  };
  const requests: OAuthHttpRequest[] = [];
  const route = buildMockRouter(version);

  const machine = createOAuthStateMachine({
    protocolVersion: version,
    registrationStrategy: "dcr",
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: SERVER_URL,
    serverName: "emulation-server",
    redirectUrl: REDIRECT_URL,
    dynamicRegistration: { client_name: "Harness Baseline Client" },
    emulation,
    requestExecutor: async (request) => {
      requests.push(request);
      return route(request);
    },
  });

  return {
    machine,
    getState: () => state,
    updateState: (updates: Partial<OAuthFlowState>) => {
      state = { ...state, ...updates };
    },
    requests,
  };
}

async function stepUntil(
  machine: { proceedToNextStep: () => Promise<void> },
  getState: () => OAuthFlowState,
  targetStep: string,
  maxSteps = 30
) {
  for (let index = 0; index < maxSteps; index += 1) {
    if (getState().currentStep === targetStep) return;
    if (getState().error) {
      throw new Error(
        `Flow errored at ${getState().currentStep}: ${getState().error}`
      );
    }
    await machine.proceedToNextStep();
  }
  if (getState().currentStep === targetStep) return;
  throw new Error(
    `Did not reach step "${targetStep}" within ${maxSteps} steps ` +
      `(at ${getState().currentStep})`
  );
}

async function runFullLadder(
  version: OAuthProtocolVersion,
  emulation?: OAuthEmulationConfig
) {
  const { machine, getState, updateState, requests } = createRecordingMachine(
    version,
    emulation
  );
  await stepUntil(machine, getState, "authorization_request");
  updateState({
    currentStep: "received_authorization_code",
    authorizationCode: "mock-auth-code",
    authorizationResponseIss: authServerBaseFor(version),
  });
  await stepUntil(machine, getState, "complete");
  return { requests, state: getState() };
}

const tokenRequestOf = (requests: OAuthHttpRequest[], asBase: string) =>
  requests.find((r) => r.url === `${asBase}/token`);
const registerRequestOf = (requests: OAuthHttpRequest[], asBase: string) =>
  requests.find((r) => r.url === `${asBase}/register`);

describe("emulation wire knobs — resource indicator", () => {
  it.each(ALL_VERSIONS)(
    "sendResourceIndicator:false omits resource everywhere (%s)",
    async (version) => {
      const { requests, state } = await runFullLadder(version, {
        sendResourceIndicator: false,
      });

      expect(state.authorizationUrl).toBeDefined();
      expect(new URL(state.authorizationUrl!).searchParams.get("resource")).toBe(
        null
      );
      const token = tokenRequestOf(requests, authServerBaseFor(version));
      expect(token).toBeDefined();
      expect(String(token!.body)).not.toContain("resource=");
      // Display surfaces must not echo a resource the wire never carried.
      expect(state.resourceIndicatorSuppressed).toBe(true);
      const echoed = (state.infoLogs ?? []).some((log) =>
        JSON.stringify(log.data ?? {}).includes(`"resource":"${SERVER_URL}"`)
      );
      expect(echoed).toBe(false);
    }
  );

  it.each(ALL_VERSIONS)(
    "sendResourceIndicator:true matches default behavior (%s)",
    async (version) => {
      const explicit = await runFullLadder(version, {
        sendResourceIndicator: true,
      });
      expect(
        new URL(explicit.state.authorizationUrl!).searchParams.get("resource")
      ).toBe(SERVER_URL);
      expect(explicit.state.resourceIndicatorSuppressed).toBeUndefined();
    }
  );
});

describe("emulation wire knobs — pinned MCP protocol version", () => {
  it.each(ALL_VERSIONS)(
    "mcpProtocolVersion pins headers and bodies on MCP-leg requests only (%s)",
    async (version) => {
      const { requests } = await runFullLadder(version, {
        mcpProtocolVersion: "2024-11-05",
      });

      const mcpRequests = requests.filter((r) => r.url === SERVER_URL);
      expect(mcpRequests.length).toBeGreaterThan(0);
      for (const request of mcpRequests) {
        const header = request.headers["MCP-Protocol-Version"];
        if (header !== undefined) {
          expect(header).toBe("2024-11-05");
        }
        // Initialize body / stateless _meta version rides along with the pin.
        expect(JSON.stringify(request.body ?? {})).not.toContain(version);
      }
      // Where the pin lands depends on the machine's real wire shape:
      // 2025-03-26's ladder never issues the unauthenticated probe (idle
      // jumps straight to same-origin discovery) and its authenticated
      // replay carries no MCP-Protocol-Version header today — and emulation
      // never ADDS the header where absent. Every later machine sends it on
      // the probe, so the pin must appear there.
      const headerCarrying = mcpRequests.filter(
        (r) => r.headers["MCP-Protocol-Version"] !== undefined
      );
      if (version === "2025-03-26") {
        expect(headerCarrying).toEqual([]);
      } else {
        expect(
          headerCarrying.some(
            (r) => r.headers["MCP-Protocol-Version"] === "2024-11-05"
          )
        ).toBe(true);
      }

      // Discovery-leg requests are NOT pinned: whatever header value they
      // carry today stays (the ladder itself is selected by machine version).
      const discoveryRequests = requests.filter((r) => r.url !== SERVER_URL);
      for (const request of discoveryRequests) {
        expect(request.headers["MCP-Protocol-Version"]).not.toBe("2024-11-05");
      }
    }
  );
});

describe("emulation wire knobs — scope policy", () => {
  it.each(ALL_VERSIONS)(
    "scopeRequest omit strips scope from authorize URL and DCR (%s)",
    async (version) => {
      const asBase = authServerBaseFor(version);
      // Default behavior WOULD send the advertised scope — prove it first.
      const baseline = await runFullLadder(version);
      expect(
        new URL(baseline.state.authorizationUrl!).searchParams.get("scope")
      ).toBe("as:advertised");

      const omitted = await runFullLadder(version, {
        scopeRequest: { mode: "omit" },
      });
      expect(
        new URL(omitted.state.authorizationUrl!).searchParams.get("scope")
      ).toBe(null);
      const register = registerRequestOf(omitted.requests, asBase);
      expect(register).toBeDefined();
      expect(JSON.stringify(register!.body)).not.toContain("as:advertised");
    }
  );

  it.each(ALL_VERSIONS)(
    "scopeRequest fixed sends the captured list byte-exactly, in order (%s)",
    async (version) => {
      const asBase = authServerBaseFor(version);
      const { requests, state } = await runFullLadder(version, {
        scopeRequest: { mode: "fixed", scopes: ["z:second", "a:first"] },
      });
      expect(
        new URL(state.authorizationUrl!).searchParams.get("scope")
      ).toBe("z:second a:first");
      const register = registerRequestOf(requests, asBase);
      expect((register!.body as Record<string, unknown>).scope).toBe(
        "z:second a:first"
      );
    }
  );

  it.each(ALL_VERSIONS)(
    "scopeRequest challenge with no challenged scopes omits scope (%s)",
    async (version) => {
      const { state } = await runFullLadder(version, {
        scopeRequest: { mode: "challenge" },
      });
      // The mock 401 challenge carries no scope parameter → nothing to echo,
      // and NO fallback to the advertised scopes (that is the knob's point).
      expect(
        new URL(state.authorizationUrl!).searchParams.get("scope")
      ).toBe(null);
    }
  );

  it.each(ALL_VERSIONS)(
    "scopeRequest all-supported sends the advertised scopes (%s)",
    async (version) => {
      const { state } = await runFullLadder(version, {
        scopeRequest: { mode: "all-supported" },
      });
      expect(
        new URL(state.authorizationUrl!).searchParams.get("scope")
      ).toBe("as:advertised");
    }
  );
});

describe("emulation wire knobs — DCR identity", () => {
  it.each(ALL_VERSIONS)(
    "dcrClientName replaces client_name byte-exactly; userAgent rides every request (%s)",
    async (version) => {
      const asBase = authServerBaseFor(version);
      const { requests } = await runFullLadder(version, {
        dcrClientName: "Emulated Real Client",
        userAgent: "EmuClient/9.9 (real-client-replay)",
      });

      const register = registerRequestOf(requests, asBase);
      expect((register!.body as Record<string, unknown>).client_name).toBe(
        "Emulated Real Client"
      );
      for (const request of requests) {
        expect(request.headers["User-Agent"]).toBe(
          "EmuClient/9.9 (real-client-replay)"
        );
      }
    }
  );
});

describe("emulation wire knobs — token endpoint auth method", () => {
  it.each(ALL_VERSIONS)(
    "forced client_secret_post moves the secret from Basic header to body (%s)",
    async (version) => {
      const asBase = authServerBaseFor(version);
      // Registered method is client_secret_basic → default flow uses the
      // Basic header, never the body.
      const baseline = await runFullLadder(version);
      const baselineToken = tokenRequestOf(baseline.requests, asBase);
      expect(baselineToken!.headers.Authorization).toMatch(/^Basic /);
      expect(String(baselineToken!.body)).not.toContain("registered-secret");

      const forced = await runFullLadder(version, {
        tokenEndpointAuthMethod: "client_secret_post",
      });
      const forcedToken = tokenRequestOf(forced.requests, asBase);
      expect(forcedToken!.headers.Authorization).toBeUndefined();
      expect(String(forcedToken!.body)).toContain(
        "client_secret=registered-secret"
      );
      const register = registerRequestOf(forced.requests, asBase);
      expect(
        (register!.body as Record<string, unknown>).token_endpoint_auth_method
      ).toBe("client_secret_post");
    }
  );

  it.each(ALL_VERSIONS)(
    "forced none never transmits the issued secret (%s)",
    async (version) => {
      const asBase = authServerBaseFor(version);
      const { requests } = await runFullLadder(version, {
        tokenEndpointAuthMethod: "none",
      });
      const token = tokenRequestOf(requests, asBase);
      expect(token!.headers.Authorization).toBeUndefined();
      expect(String(token!.body)).not.toContain("registered-secret");
      expect(String(token!.body)).toContain("client_id=test-client-id");
    }
  );
});

describe("emulation — derive → machine integration", () => {
  it("a derived profile drives ladder selection and every knob end-to-end", async () => {
    const derived = deriveOAuthEmulation({
      profileVersion: 2,
      oauthSpecVersion: verified({
        basis: "constant" as const,
        revisions: ["2025-06-18"],
      }),
      protocolVersionPinning: verified({
        mode: "pinned" as const,
        version: "2025-03-26",
      }),
      sendsResourceIndicator: verified(false),
      scopeRequest: verified({ mode: "omit" as const }),
      dcrIdentity: verified({
        clientName: "Split Revision Client",
        userAgent: "SplitRev/2.0",
      }),
      tokenEndpointAuthMethod: verified("none" as const),
      authModel: verified(["oauth2-dcr"]),
    });

    expect(derived.protocolVersion).toBe("2025-06-18");
    expect(derived.coverageSummary).toBe("complete");

    const { requests, state } = await runFullLadder(
      derived.protocolVersion,
      derived.emulation
    );

    // Goose shape: PRM-era OAuth ladder, MCP wire pinned to 2025-03-26.
    const probe = requests.find((r) => r.url === SERVER_URL);
    expect(probe!.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
    expect(new URL(state.authorizationUrl!).searchParams.get("resource")).toBe(
      null
    );
    expect(new URL(state.authorizationUrl!).searchParams.get("scope")).toBe(
      null
    );
    const register = registerRequestOf(requests, AUTH_SERVER_URL);
    expect((register!.body as Record<string, unknown>).client_name).toBe(
      "Split Revision Client"
    );
    expect(register!.headers["User-Agent"]).toBe("SplitRev/2.0");
  });
});
