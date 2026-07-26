import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";
const CHALLENGED_RESOURCE_METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/tenant-a/mcp";

// Spec conformance for the escalation path (MCP authorization spec,
// "Protected Resource Metadata Discovery" + "Scope Selection Strategy"):
// after an unauthenticated probe 401s, the flow MUST use the
// `resource_metadata` URL from the WWW-Authenticate challenge when present,
// and MUST treat the challenged `scope` as authoritative over
// `scopes_supported`. Guards against the escalation silently ignoring the
// challenge the server actually issued.
describe("OAuth escalation conformance to the original WWW-Authenticate challenge", () => {
  it("re-probes unauthenticated and adopts resource_metadata + scope from the 401 challenge (2025-11-25)", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_without_token" as const,
      serverUrl: SERVER_URL,
      httpHistory: [
        {
          step: "request_without_token" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: SERVER_URL,
            headers: {},
            body: { method: "initialize" },
          },
        },
      ],
      infoLogs: [],
    };

    const requestExecutor = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "www-authenticate": `Bearer resource_metadata="${CHALLENGED_RESOURCE_METADATA_URL}", scope="files:read files:write"`,
      },
      body: null,
    });

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor,
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    // The probe hit the MCP server itself, without an Authorization header.
    expect(requestExecutor).toHaveBeenCalledTimes(1);
    const probeRequest = requestExecutor.mock.calls[0][0];
    expect(probeRequest.url).toBe(SERVER_URL);
    expect(
      Object.keys(probeRequest.headers ?? {}).map((k) => k.toLowerCase()),
    ).not.toContain("authorization");

    expect(state.currentStep).toBe("received_401_unauthorized");
    expect(state.challengedScopes).toEqual(["files:read", "files:write"]);

    await machine.proceedToNextStep();

    // The challenge's resource_metadata URL is authoritative — no fallback
    // to the path-derived well-known URL.
    expect(state.resourceMetadataUrl).toBe(CHALLENGED_RESOURCE_METADATA_URL);
    expect(state.lastRequest?.url).toBe(CHALLENGED_RESOURCE_METADATA_URL);
  });

  it("prefers the challenged scope over scopes_supported when building the authorization URL (2025-11-25)", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "generate_pkce_parameters" as const,
      serverUrl: SERVER_URL,
      challengedScopes: ["files:read", "files:write"],
      resourceMetadata: {
        resource: SERVER_URL,
        scopes_supported: ["everything", "kitchen:sink"],
      },
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        scopes_supported: ["everything"],
      },
      clientId: "client-123",
      codeChallenge: "challenge-abc",
      state: "state-xyz",
      infoLogs: [],
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn(),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("authorization_request");
    const authUrl = new URL(state.authorizationUrl!);
    expect(authUrl.searchParams.get("scope")).toBe("files:read files:write");
  });

  // SEP-2350 follow-up (deferred "Finding F" from #3427): when a runtime
  // `403 insufficient_scope` challenge carried a `resource_metadata` hint, the
  // step-up re-authorization threads it into the machine as
  // `resourceMetadataUrl`. It MUST win over the value re-derived from the fresh
  // re-probe's WWW-Authenticate header, so a server whose escalation metadata
  // lives at a non-default URL (Asana) is honored instead of ignored.
  it("prefers the SEP-2350 resourceMetadataUrl override over the fresh 401's resource_metadata hint (2025-11-25)", async () => {
    const OVERRIDE_RESOURCE_METADATA_URL =
      "https://mcp.example.com/.well-known/oauth-protected-resource/tenant-b/mcp";
    const FRESH_401_RESOURCE_METADATA_URL =
      "https://mcp.example.com/.well-known/oauth-protected-resource";

    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_without_token" as const,
      serverUrl: SERVER_URL,
      httpHistory: [
        {
          step: "request_without_token" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: SERVER_URL,
            headers: {},
            body: { method: "initialize" },
          },
        },
      ],
      infoLogs: [],
    };

    const requestExecutor = jest.fn().mockImplementation((request: any) => {
      // First hop: the unauthenticated re-probe returns a 401 whose
      // WWW-Authenticate points at the DEFAULT (non-tenant) metadata URL.
      if (request.url === SERVER_URL) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "www-authenticate": `Bearer resource_metadata="${FRESH_401_RESOURCE_METADATA_URL}", scope="files:read"`,
          },
          body: null,
        });
      }
      // Second hop: the PRM GET. Whatever URL it targets is echoed back so the
      // assertion can prove which one the machine chose.
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          resource: SERVER_URL,
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["files:read", "files:write"],
        },
      });
    });

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor,
      // The step-up override (same origin as the server URL, per the client
      // guard). It must beat the fresh header's default URL below.
      resourceMetadataUrl: OVERRIDE_RESOURCE_METADATA_URL,
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    // request_without_token -> received_401_unauthorized
    await machine.proceedToNextStep();
    expect(state.currentStep).toBe("received_401_unauthorized");

    // received_401_unauthorized -> request_resource_metadata (prepares the GET)
    await machine.proceedToNextStep();

    // The override was used, NOT the fresh 401's resource_metadata hint.
    expect(state.resourceMetadataUrl).toBe(OVERRIDE_RESOURCE_METADATA_URL);
    expect(state.resourceMetadataUrl).not.toBe(FRESH_401_RESOURCE_METADATA_URL);
    expect(state.lastRequest?.url).toBe(OVERRIDE_RESOURCE_METADATA_URL);
  });

  // Explicit-vs-derived metadata URL (coderabbit Major / cubic P2). When the
  // fresh `WWW-Authenticate` header carries NO `resource_metadata` param and
  // there is NO SEP-2350 override, `state.resourceMetadataUrl` holds the
  // DERIVED well-known URL. Discovery MUST treat that as implicit (no explicit
  // `metadataOptions`) so it keeps its well-known + fallback behavior — a header
  // being present must NOT flip a derived URL into an explicit one.
  it("treats a header-without-resource_metadata URL as DERIVED, keeping discovery's well-known fallback (2025-11-25)", async () => {
    const SERVER_WITH_PATH = "https://mcp.example.com/mcp";
    const DERIVED_PATH_URL =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const ROOT_FALLBACK_URL =
      "https://mcp.example.com/.well-known/oauth-protected-resource";

    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_without_token" as const,
      serverUrl: SERVER_WITH_PATH,
      httpHistory: [
        {
          step: "request_without_token" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: SERVER_WITH_PATH,
            headers: {},
            body: { method: "initialize" },
          },
        },
      ],
      infoLogs: [],
    };

    const requestExecutor = jest.fn().mockImplementation((request: any) => {
      // Unauthenticated re-probe: 401 whose WWW-Authenticate omits
      // `resource_metadata` (only a scope), so the machine derives the PRM URL.
      if (request.url === SERVER_WITH_PATH) {
        return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "www-authenticate": `Bearer scope="files:read"`,
          },
          body: null,
        });
      }
      // Path-based well-known 404s — discovery must FALL BACK to the root
      // well-known, which only happens when the URL was NOT passed explicitly.
      if (request.url === DERIVED_PATH_URL) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: {},
          body: null,
        });
      }
      // Root well-known succeeds. Reaching this proves discovery fell back,
      // i.e. the derived URL was treated as implicit (the fix).
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          resource: SERVER_WITH_PATH,
          authorization_servers: ["https://auth.example.com"],
          scopes_supported: ["files:read", "files:write"],
        },
      });
    });

    let machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_WITH_PATH,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor,
      // No resourceMetadataUrl override — the derived path must stay implicit.
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    // request_without_token -> received_401_unauthorized
    await machine.proceedToNextStep();
    expect(state.currentStep).toBe("received_401_unauthorized");

    // received_401_unauthorized -> prepares request_resource_metadata. The URL
    // is DERIVED (built from the server URL), since the header carried none.
    await machine.proceedToNextStep();
    expect(state.resourceMetadataUrl).toBe(DERIVED_PATH_URL);

    // request_resource_metadata -> runs discovery. Because the URL was derived
    // (not header/override-sourced), discovery is invoked WITHOUT an explicit
    // metadataUrl and so falls back from the 404 path-based well-known to the
    // root well-known.
    await machine.proceedToNextStep();

    const fetchedUrls = requestExecutor.mock.calls.map((c: any[]) => c[0].url);
    // First attempt hit the derived path (404)...
    expect(fetchedUrls).toContain(DERIVED_PATH_URL);
    // ...then discovery FELL BACK to the root well-known (200). This fallback
    // only happens when the URL is implicit — with the pre-fix behavior the
    // derived URL was passed as explicit and discovery would never reach here.
    expect(fetchedUrls).toContain(ROOT_FALLBACK_URL);
  });
});
