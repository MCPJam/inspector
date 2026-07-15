import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type { OAuthProtocolVersion } from "../../src/oauth/state-machines/types.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

describe("OAuth state machine regressions", () => {
  it("clears stale challengedScopes when optional auth is detected in 2025-06-18", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_without_token" as const,
      serverUrl: SERVER_URL,
      challengedScopes: ["stale-scope"],
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

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-06-18",
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
        body: {
          jsonrpc: "2.0",
          result: {},
        },
      }),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("received_401_unauthorized");
    expect(state.challengedScopes).toBeUndefined();
    expect(state.isInitiatingAuth).toBe(false);
  });

  it("clears isInitiatingAuth when strict DCR fails with an HTTP error in 2025-11-25", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: {
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        headers: {},
        body: { client_name: "Test Client" },
      },
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: REGISTRATION_ENDPOINT,
            headers: {},
            body: { client_name: "Test Client" },
          },
        },
      ],
      infoLogs: [],
      isInitiatingAuth: true,
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      strictConformance: true,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: {
          error: "invalid_client_metadata",
        },
      }),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.error).toBe("Dynamic Client Registration failed (400).");
    expect(state.isInitiatingAuth).toBe(false);
  });

  it("clears isInitiatingAuth when strict DCR fails with a transport error in 2025-11-25", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: {
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        headers: {},
        body: { client_name: "Test Client" },
      },
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: REGISTRATION_ENDPOINT,
            headers: {},
            body: { client_name: "Test Client" },
          },
        },
      ],
      infoLogs: [],
      isInitiatingAuth: true,
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      strictConformance: true,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn().mockRejectedValue(new Error("boom")),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.error).toBe("Client registration failed: boom");
    expect(state.isInitiatingAuth).toBe(false);
  });

  it("does not continue to authorization with a fake client id when DCR fails without preregistered credentials", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: {
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        headers: {},
        body: { client_name: "Test Client" },
      },
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: REGISTRATION_ENDPOINT,
            headers: {},
            body: { client_name: "Test Client" },
          },
        },
      ],
      infoLogs: [],
      isInitiatingAuth: true,
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
      requestExecutor: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: {
          error_type: "dynamic_client_registration_not_enabled",
          error_message: "DCR is disabled",
        },
      }),
      dynamicRegistration: {
        client_name: "Test Client",
      },
      loadPreregisteredCredentials: jest.fn().mockResolvedValue({}),
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("request_client_registration");
    expect(state.clientId).toBeUndefined();
    expect(state.error).toBe(
      "Dynamic Client Registration failed (400). Configure a pre-registered client or enable DCR on the authorization server.",
    );
    expect(state.isInitiatingAuth).toBe(false);
  });

  it("falls back to configured preregistered credentials when DCR fails in 2025-11-25", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: {
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        headers: {},
        body: { client_name: "Test Client" },
      },
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: REGISTRATION_ENDPOINT,
            headers: {},
            body: { client_name: "Test Client" },
          },
        },
      ],
      infoLogs: [],
      isInitiatingAuth: true,
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
      requestExecutor: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: {
          error_type: "dynamic_client_registration_not_enabled",
          error_message: "DCR is disabled",
        },
      }),
      dynamicRegistration: {
        client_name: "Test Client",
      },
      loadPreregisteredCredentials: jest.fn().mockResolvedValue({
        clientId: "configured-client-id",
        clientSecret: "configured-secret",
      }),
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("received_client_credentials");
    expect(state.clientId).toBe("configured-client-id");
    expect(state.clientSecret).toBe("configured-secret");
    expect(state.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(state.error).toBeUndefined();
    expect(state.isInitiatingAuth).toBe(false);
  });

  it.each<OAuthProtocolVersion>([
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
  ])(
    "lets preregistered %s public clients proceed even when the AS omits 'none'",
    async (protocolVersion) => {
      // CLI flows that worked pre-PR (e.g. --client-id only against an AS that
      // only advertises confidential methods but actually accepts public-client
      // requests) must keep working. Let the AS do the real rejection.
      let state = {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "received_authorization_server_metadata" as const,
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
        } as any,
        infoLogs: [],
        isInitiatingAuth: true,
      };

      const machine = createOAuthStateMachine({
        protocolVersion,
        registrationStrategy: "preregistered" as any,
        state,
        getState: () => state,
        updateState: (updates) => {
          state = { ...state, ...updates };
        },
        serverUrl: SERVER_URL,
        serverName: "Test Server",
        redirectUrl: REDIRECT_URI,
        requestExecutor: jest.fn(),
        loadPreregisteredCredentials: jest.fn().mockResolvedValue({
          clientId: "configured-client-id",
        }),
      });

      await machine.proceedToNextStep();

      expect(state.currentStep).toBe("received_client_credentials");
      expect(state.clientId).toBe("configured-client-id");
      expect(state.clientSecret).toBeUndefined();
      expect(state.tokenEndpointAuthMethod).toBe("none");
      expect(state.error).toBeUndefined();
    },
  );

  it.each<OAuthProtocolVersion>([
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
  ])("allows preregistered %s public clients when none is supported", async (protocolVersion) => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "received_authorization_server_metadata" as const,
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      } as any,
      infoLogs: [],
      isInitiatingAuth: true,
    };

    const machine = createOAuthStateMachine({
      protocolVersion,
      registrationStrategy: "preregistered" as any,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn(),
      loadPreregisteredCredentials: jest.fn().mockResolvedValue({
        clientId: "configured-client-id",
      }),
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("received_client_credentials");
    expect(state.clientId).toBe("configured-client-id");
    expect(state.tokenEndpointAuthMethod).toBe("none");
    expect(state.error).toBeUndefined();
  });

  it.each<[boolean | undefined, boolean | string]>([
    [true, true],
    [false, false],
    [undefined, "false (not advertised, defaults to false per spec)"],
  ])(
    "2025-11-25 preserves the derived CIMD decision when the field is %s",
    async (advertised, expectedRow) => {
      const asMetadata: Record<string, unknown> = {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      };
      if (advertised !== undefined) {
        asMetadata.client_id_metadata_document_supported = advertised;
      }

      let state = {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "request_authorization_server_metadata" as const,
        authorizationServerUrl: "https://auth.example.com",
        httpHistory: [
          {
            step: "request_authorization_server_metadata" as const,
            timestamp: Date.now(),
            request: {
              method: "GET",
              url: "https://auth.example.com/.well-known/oauth-authorization-server",
              headers: {},
            },
          },
        ],
        infoLogs: [],
        isInitiatingAuth: true,
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
        requestExecutor: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: asMetadata,
        }),
        dynamicRegistration: {
          client_name: "Test Client",
        },
      });

      await machine.proceedToNextStep();

      expect(state.currentStep).toBe("received_authorization_server_metadata");
      expect(
        state.infoLogs?.find((log) => log.id === "as-metadata")
      ).toBeUndefined();
      const cimdSupport = state.infoLogs?.find(
        (log) => log.id === "cimd-support"
      );
      expect(cimdSupport?.data["CIMD Supported"]).toBe(expectedRow);
    },
  );

  // Regression (Codex review, PR #3138): a strict-conformance 2xx registration
  // response with a non-object body is classified invalid_response by the
  // shared helper. The old success-path strict missing-client_id branch cleared
  // isInitiatingAuth for that exact body shape, so the reclassification must
  // still clear it — otherwise the flow is left "initiating" after failing.
  it.each(["2025-03-26", "2025-06-18"] as const)(
    "clears isInitiatingAuth on a strict invalid_response DCR body in %s",
    async (protocolVersion) => {
      let state = {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "request_client_registration" as const,
        authorizationServerMetadata: {
          registration_endpoint: REGISTRATION_ENDPOINT,
        },
        lastRequest: {
          method: "POST",
          url: REGISTRATION_ENDPOINT,
          headers: {},
          body: { client_name: "Test Client" },
        },
        httpHistory: [
          {
            step: "request_client_registration" as const,
            timestamp: Date.now(),
            request: {
              method: "POST",
              url: REGISTRATION_ENDPOINT,
              headers: {},
              body: { client_name: "Test Client" },
            },
          },
        ],
        infoLogs: [],
        isInitiatingAuth: true,
      };

      const machine = createOAuthStateMachine({
        protocolVersion,
        registrationStrategy: "dcr",
        strictConformance: true,
        state,
        getState: () => state,
        updateState: (updates) => {
          state = { ...state, ...updates };
        },
        serverUrl: SERVER_URL,
        serverName: "Test Server",
        redirectUrl: REDIRECT_URI,
        // 2xx with a non-object body → invalid_response.
        requestExecutor: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: "not-json",
        }),
        dynamicRegistration: { client_name: "Test Client" },
      });

      await machine.proceedToNextStep();

      expect(state.error).toBeTruthy();
      expect(state.isInitiatingAuth).toBe(false);
    },
  );

  // Regression for #2119: the OAuth `resource` indicator must honour the
  // identifier advertised in the server's Protected Resource Metadata (which may
  // be a URN, not the MCP endpoint URL) instead of being overwritten with the
  // server URL. The authorization request and token request must also agree.
  const RESOURCE_URN = "urn:example:my-resource";

  const seedAuthorizationStart = (
    resourceMetadata?: { resource: string },
  ) => ({
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "received_client_credentials" as const,
    serverUrl: SERVER_URL,
    clientId: "test-client",
    authorizationServerMetadata: {
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
    } as any,
    ...(resourceMetadata ? { resourceMetadata } : {}),
    infoLogs: [],
  });

  const seedTokenExchange = (resourceMetadata?: { resource: string }) => ({
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "received_authorization_code" as const,
    serverUrl: SERVER_URL,
    clientId: "test-client",
    codeVerifier: "test-code-verifier",
    authorizationCode: "test-auth-code",
    authorizationServerMetadata: {
      token_endpoint: "https://auth.example.com/token",
    } as any,
    ...(resourceMetadata ? { resourceMetadata } : {}),
    infoLogs: [],
  });

  it.each<OAuthProtocolVersion>(["2025-06-18", "2025-11-25"])(
    "uses the PRM-advertised resource for the authorization request in %s",
    async (protocolVersion) => {
      let state: any = seedAuthorizationStart({ resource: RESOURCE_URN });

      const machine = createOAuthStateMachine({
        protocolVersion,
        registrationStrategy: "preregistered" as any,
        state,
        getState: () => state,
        updateState: (updates) => {
          state = { ...state, ...updates };
        },
        serverUrl: SERVER_URL,
        serverName: "Test Server",
        redirectUrl: REDIRECT_URI,
        requestExecutor: jest.fn(),
      });

      await machine.proceedToNextStep(); // generate PKCE parameters
      await machine.proceedToNextStep(); // build authorization URL

      const authUrl = new URL(state.authorizationUrl);
      expect(authUrl.searchParams.get("resource")).toBe(RESOURCE_URN);
    },
  );

  it.each<OAuthProtocolVersion>(["2025-06-18", "2025-11-25"])(
    "uses the PRM-advertised resource for the token request in %s",
    async (protocolVersion) => {
      let state: any = seedTokenExchange({ resource: RESOURCE_URN });

      const machine = createOAuthStateMachine({
        protocolVersion,
        registrationStrategy: "preregistered" as any,
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
          body: { access_token: "token" },
        }),
      });

      await machine.proceedToNextStep(); // prepare token request body

      expect(state.lastRequest?.body?.resource).toBe(RESOURCE_URN);
    },
  );

  it.each<OAuthProtocolVersion>(["2025-06-18", "2025-11-25"])(
    "falls back to the server URL when no PRM resource is advertised in %s",
    async (protocolVersion) => {
      let state: any = seedTokenExchange();

      const machine = createOAuthStateMachine({
        protocolVersion,
        registrationStrategy: "preregistered" as any,
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
          body: { access_token: "token" },
        }),
      });

      await machine.proceedToNextStep(); // prepare token request body

      expect(state.lastRequest?.body?.resource).toBe(SERVER_URL);
    },
  );

  // The debugger honors a PRM resource that strict clients (Quick OAuth, the
  // official MCP SDK) would reject, so it must surface a warning when the
  // advertised identifier fails the strict origin/path-prefix validation.
  const seedResourceMetadataFetch = () => ({
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "request_resource_metadata" as const,
    serverUrl: SERVER_URL,
    httpHistory: [],
    infoLogs: [],
  });

  const prmExecutor = (resource: string) =>
    jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: {
        resource,
        authorization_servers: ["https://auth.example.com"],
      },
    });

  const runResourceMetadataStep = async (
    protocolVersion: OAuthProtocolVersion,
    resource: string,
  ) => {
    let state: any = seedResourceMetadataFetch();

    const machine = createOAuthStateMachine({
      protocolVersion,
      registrationStrategy: "preregistered" as any,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: prmExecutor(resource),
    });

    await machine.proceedToNextStep(); // fetch protected resource metadata

    return state;
  };

  it.each<OAuthProtocolVersion>(["2025-06-18", "2025-11-25"])(
    "keeps resource metadata only in the HTTP response card in %s",
    async (protocolVersion) => {
      const state = await runResourceMetadataStep(protocolVersion, SERVER_URL);

      expect(
        state.infoLogs?.find(
          (log: any) => log.id === "authorization-servers",
        ),
      ).toBeUndefined();
      expect(state.httpHistory.at(-1)?.response?.body).toEqual({
        resource: SERVER_URL,
        authorization_servers: ["https://auth.example.com"],
      });
    },
  );

  it.each<OAuthProtocolVersion>(["2025-06-18", "2025-11-25"])(
    "warns when the PRM resource fails strict validation in %s",
    async (protocolVersion) => {
      const state = await runResourceMetadataStep(
        protocolVersion,
        RESOURCE_URN,
      );

      expect(state.resourceMetadata?.resource).toBe(RESOURCE_URN);
      const warning = state.infoLogs?.find(
        (log: any) => log.id === "resource-identifier-mismatch",
      );
      expect(warning).toBeDefined();
      expect(warning.level).toBe("warning");
    },
  );

  it.each<OAuthProtocolVersion>(["2025-06-18", "2025-11-25"])(
    "does not warn when the PRM resource matches the server URL in %s",
    async (protocolVersion) => {
      const state = await runResourceMetadataStep(protocolVersion, SERVER_URL);

      expect(state.resourceMetadata?.resource).toBe(SERVER_URL);
      expect(
        state.infoLogs?.find(
          (log: any) => log.id === "resource-identifier-mismatch",
        ),
      ).toBeUndefined();
    },
  );
});
