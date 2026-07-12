import {
  buildDynamicClientRegistrationRequest,
  executeDynamicClientRegistration,
  redactDynamicClientRegistrationResponse,
} from "../../src/oauth/state-machines/shared/dynamic-client-registration.js";
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type { OAuthProtocolVersion } from "../../src/oauth/state-machines/types.js";
import { validateClientIdMetadataUrl } from "../../src/oauth/state-machines/shared/client-id-metadata.js";
import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
  evaluateIdJagClientMetadata,
  getXaaDebugClientMetadata,
} from "../../src/oauth/client-identity.js";
import type { OAuthHttpRequest } from "../../src/oauth/state-machines/types.js";

const REGISTRATION_ENDPOINT = "https://auth.example.com/register";
const REDIRECT_URI = "https://client.example.com/callback";
const SECRET = "super-secret-client-secret-value";

const okResult = (body: unknown, status = 201) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 201 ? "Created" : "OK",
  headers: { "content-type": "application/json" },
  body,
});

const buildRequest = (
  overrides: Partial<
    Parameters<typeof buildDynamicClientRegistrationRequest>[0]
  > = {}
): OAuthHttpRequest =>
  buildDynamicClientRegistrationRequest({
    registrationEndpoint: REGISTRATION_ENDPOINT,
    redirectUri: REDIRECT_URI,
    dynamicRegistrationDefaults: { client_name: "Test Client" },
    ...overrides,
  });

describe("buildDynamicClientRegistrationRequest", () => {
  it("applies authorization-code fallbacks when defaults omit fields", () => {
    const request = buildRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe(REGISTRATION_ENDPOINT);
    expect(request.headers["Content-Type"]).toBe("application/json");
    expect(request.body).toEqual({
      client_name: "Test Client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("lets caller-supplied defaults win over fallbacks", () => {
    const request = buildRequest({
      dynamicRegistrationDefaults: {
        client_name: "Test Client",
        redirect_uris: ["https://other.example.com/cb"],
        grant_types: ["client_credentials"],
        response_types: [],
        token_endpoint_auth_method: "client_secret_post",
      },
    });
    expect(request.body).toEqual({
      client_name: "Test Client",
      redirect_uris: ["https://other.example.com/cb"],
      grant_types: ["client_credentials"],
      response_types: [],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  it("adds scope only when truthy", () => {
    expect(buildRequest({ scope: "read write" }).body.scope).toBe("read write");
    expect(buildRequest({ scope: "" }).body.scope).toBeUndefined();
    expect(buildRequest().body.scope).toBeUndefined();
  });

  it("strips Authorization from custom headers", () => {
    const request = buildRequest({
      customHeaders: { Authorization: "Bearer leaked", "X-Custom": "yes" },
    });
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.headers["X-Custom"]).toBe("yes");
  });
});

describe("redactDynamicClientRegistrationResponse", () => {
  it("masks credential fields recursively and leaves metadata inspectable", () => {
    const redacted = redactDynamicClientRegistrationResponse({
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json" },
      body: {
        client_id: "abc",
        client_secret: SECRET,
        registration_access_token: "reg-token-value-1",
        nested: {
          access_token: "access-token-value-2",
          list: [{ refresh_token: "refresh-token-value-3" }, "plain"],
        },
        client_name: "Test Client",
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("reg-token-value-1");
    expect(serialized).not.toContain("access-token-value-2");
    expect(serialized).not.toContain("refresh-token-value-3");
    expect(redacted.body.client_id).toBe("abc");
    expect(redacted.body.client_name).toBe("Test Client");
    expect(redacted.body.client_secret).toBe("***REDACTED***");
    expect(redacted.body.nested.list[1]).toBe("plain");
    expect(redacted.status).toBe(201);
  });
});

describe("executeDynamicClientRegistration", () => {
  const history = () => [
    {
      timestamp: Date.now() - 5,
      request: buildRequest(),
    },
  ];

  it("passes the caller's exact request to the executor unchanged", async () => {
    const request = buildRequest();
    const executor = jest.fn().mockResolvedValue(okResult({ client_id: "c" }));
    await executeDynamicClientRegistration({
      request,
      requestExecutor: executor,
      httpHistory: history(),
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toBe(request);
  });

  it("parses a successful registration and keeps raw credentials out of diagnostics", async () => {
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest.fn().mockResolvedValue(
        okResult({
          client_id: "generated-client",
          client_secret: SECRET,
          client_secret_expires_at: 1234567890,
          token_endpoint_auth_method: "client_secret_post",
          client_name: "Test Client",
          grant_types: ["authorization_code"],
        })
      ),
      httpHistory: history(),
    });

    expect(outcome.status).toBe("registered");
    if (outcome.status !== "registered") return;
    expect(outcome.credentials).toEqual({
      clientId: "generated-client",
      clientSecret: SECRET,
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecretExpiresAt: 1234567890,
    });
    expect(outcome.missingClientId).toBe(false);
    expect(outcome.nonCanonicalSuccessStatus).toBe(false);

    const diagnostics = JSON.stringify({
      response: outcome.response,
      httpHistory: outcome.httpHistory,
      infoLogData: outcome.infoLogData,
    });
    expect(diagnostics).not.toContain(SECRET);
    expect(diagnostics).not.toContain(SECRET.substring(0, 8));
    expect(outcome.infoLogData["Client Secret Issued"]).toBe(true);
    expect(outcome.infoLogData["Client ID"]).toBe("generated-client");
  });

  it("back-fills a cloned last history entry without mutating the caller's", async () => {
    const callerHistory = history();
    const callerEntry = callerHistory[0];
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest
        .fn()
        .mockResolvedValue(okResult({ client_id: "c" })),
      httpHistory: callerHistory,
    });
    expect(callerEntry.response).toBeUndefined();
    if (outcome.status !== "registered") throw new Error("expected success");
    expect(outcome.httpHistory[0].response?.status).toBe(201);
    expect(typeof outcome.httpHistory[0].duration).toBe("number");
  });

  it("is a no-op on empty history", async () => {
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest
        .fn()
        .mockResolvedValue(okResult({ client_id: "c" })),
      httpHistory: [],
    });
    expect(outcome.httpHistory).toEqual([]);
  });

  it("surfaces missingClientId and non-201 success", async () => {
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest
        .fn()
        .mockResolvedValue(okResult({ client_name: "No ID" }, 200)),
      httpHistory: history(),
    });
    if (outcome.status !== "registered") throw new Error("expected success");
    expect(outcome.missingClientId).toBe(true);
    expect(outcome.nonCanonicalSuccessStatus).toBe(true);
    expect(outcome.credentials.clientId).toBeUndefined();
  });

  it("keeps the historical http_error strings byte-stable", async () => {
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: { error: "invalid_client_metadata" },
      }),
      httpHistory: history(),
    });
    expect(outcome.status).toBe("http_error");
    if (outcome.status === "registered") return;
    expect(outcome.error).toBe("Dynamic Client Registration failed (400).");
    expect(outcome.fallbackNote).toBe(
      "Dynamic Client Registration failed (400); using pre-registered client credentials."
    );
    expect(outcome.errorWithFallbackHint).toBe(
      "Dynamic Client Registration failed (400). Configure a pre-registered client or enable DCR on the authorization server."
    );
  });

  it("synthesizes a status-0 network_error on executor rejection", async () => {
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest.fn().mockRejectedValue(new Error("boom")),
      httpHistory: history(),
    });
    expect(outcome.status).toBe("network_error");
    if (outcome.status === "registered") return;
    expect(outcome.response).toEqual({
      status: 0,
      statusText: "Network Error",
      headers: {},
      body: { error: "boom" },
    });
    expect(outcome.error).toBe("Client registration failed: boom");
    expect(outcome.errorWithFallbackHint).toBe(
      "Client registration failed: boom. Configure a pre-registered client or enable DCR on the authorization server."
    );
  });

  it.each([null, "not an object", [1, 2]])(
    "classifies a 2xx %p body as invalid_response",
    async (body) => {
      const outcome = await executeDynamicClientRegistration({
        request: buildRequest(),
        requestExecutor: jest.fn().mockResolvedValue(okResult(body, 200)),
        httpHistory: history(),
      });
      expect(outcome.status).toBe("invalid_response");
      if (outcome.status === "registered") return;
      expect(outcome.error).toBe(
        "Client registration failed: the registration response body was not a JSON object"
      );
    }
  );

  it("redacts credentials in error-response diagnostics too", async () => {
    const outcome = await executeDynamicClientRegistration({
      request: buildRequest(),
      requestExecutor: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: { error: "bad", echoed: { client_secret: SECRET } },
      }),
      httpHistory: history(),
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});

describe("getXaaDebugClientMetadata + evaluateIdJagClientMetadata", () => {
  it.each(["client_secret_post", "none"] as const)(
    "builder output with %s self-evaluates to all-present",
    (method) => {
      const metadata = getXaaDebugClientMetadata({
        tokenEndpointAuthMethod: method,
      });
      expect(metadata.redirect_uris).toBeUndefined();
      expect(metadata.response_types).toBeUndefined();
      const evaluation = evaluateIdJagClientMetadata(
        metadata as Record<string, unknown>
      );
      expect(evaluation.profile).toBe("present");
      expect(evaluation.jwtBearerGrant).toBe("present");
      expect(evaluation.tokenExchangeGrant).toBe("present");
      expect(evaluation.tokenEndpointAuthMethod).toBe(method);
    }
  );

  it("classifies omitted vs contradicted for each field", () => {
    expect(evaluateIdJagClientMetadata({})).toEqual({
      profile: "omitted",
      jwtBearerGrant: "omitted",
      tokenExchangeGrant: "omitted",
      tokenEndpointAuthMethod: undefined,
    });

    const contradicted = evaluateIdJagClientMetadata({
      authorization_grant_profiles_supported: ["urn:other:profile"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "private_key_jwt",
    });
    expect(contradicted.profile).toBe("contradicted");
    expect(contradicted.jwtBearerGrant).toBe("contradicted");
    expect(contradicted.tokenExchangeGrant).toBe("contradicted");
    expect(contradicted.tokenEndpointAuthMethod).toBe("private_key_jwt");

    const partial = evaluateIdJagClientMetadata({
      grant_types: [
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "authorization_code",
      ],
    });
    expect(partial.jwtBearerGrant).toBe("present");
    expect(partial.tokenExchangeGrant).toBe("contradicted");
    expect(partial.profile).toBe("omitted");
  });

  it("treats a non-array property value as an explicit contradiction", () => {
    const evaluation = evaluateIdJagClientMetadata({
      authorization_grant_profiles_supported: "not-a-list",
      grant_types: 42,
    });
    expect(evaluation.profile).toBe("contradicted");
    expect(evaluation.jwtBearerGrant).toBe("contradicted");
  });
});

describe("validateClientIdMetadataUrl (CIMD draft-02)", () => {
  it("returns the original string unchanged (simple string identity)", () => {
    const url = "https://example.com:443/client%2Fmetadata.json";
    expect(validateClientIdMetadataUrl(url)).toBe(url);
  });

  it("accepts the existing default and XAA URLs", () => {
    expect(
      validateClientIdMetadataUrl(DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL)
    ).toBe(DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL);
    expect(validateClientIdMetadataUrl(XAA_DEBUG_CLIENT_ID_METADATA_URL)).toBe(
      XAA_DEBUG_CLIENT_ID_METADATA_URL
    );
  });

  it("accepts a query component (SHOULD NOT, not MUST NOT)", () => {
    const url = "https://example.com/client.json?v=1";
    expect(validateClientIdMetadataUrl(url)).toBe(url);
  });

  it("accepts a root path (NOT RECOMMENDED per draft-02 §3, but valid)", () => {
    const url = "https://example.com/";
    expect(validateClientIdMetadataUrl(url)).toBe(url);
  });

  it.each([
    ["not-a-url", "valid absolute URL"],
    ["http://example.com/client.json", "absolute HTTPS URL"],
    ["https://user:pw@example.com/client.json", "userinfo"],
    // Empty userinfo: WHATWG URL normalizes username/password to "" (falsy),
    // so this must be caught on the raw authority, not the parsed fields.
    ["https://@example.com/client.json", "userinfo"],
    // Transport-normalized spellings new URL() accepts but fetch would request
    // differently — rejected up front so the returned string is what fetch uses.
    ["https:/example.com/client.json", "literal https"], // single-slash scheme
    ["https:/user@example.com/client.json", "literal https"],
    ["\thttps://example.com/client.json", "literal https"], // leading tab
    ["https://example.com/cli ent.json", "whitespace"], // literal space
    ["https://example.com\\client.json", "backslashes"], // backslash path sep
    // Extra slashes after the scheme: new URL() promotes the next token to the
    // host, so the raw identity string wouldn't name the host fetch hits.
    ["https:///169.254.169.254/latest", "host"],
    ["https:////example.com/client.json", "host"],
    ["https://example.com/client.json#frag", "fragment"],
    // No path component at all (a bare authority) is rejected; a root "/" is
    // accepted above.
    ["https://example.com", "path component"],
    ["https://example.com/a/../client.json", "dot path segments"],
    ["https://example.com/./client.json", "dot path segments"],
    ["https://example.com/a/..", "dot path segments"],
    // Percent-encoded dot segments: WHATWG decodes %2e (any case) during
    // dot-segment detection, so these collapse exactly like literal dots.
    ["https://example.com/a/%2e%2e/client.json", "dot path segments"],
    ["https://example.com/a/%2E./client.json", "dot path segments"],
    ["https://example.com/.%2e/client.json", "dot path segments"],
    ["https://example.com/%2e/client.json", "dot path segments"],
  ])("rejects %s", (url, messageFragment) => {
    expect(() => validateClientIdMetadataUrl(url)).toThrow(
      new RegExp(messageFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    );
  });
});

describe("state machine DCR diagnostic surfaces", () => {
  const SERVER_URL = "https://mcp.example.com/mcp";
  const REDIRECT = "http://127.0.0.1:3333/callback";

  const runMachineAtRegistration = async (
    protocolVersion: OAuthProtocolVersion
  ) => {
    const registrationRequest = buildRequest();
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: registrationRequest,
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: registrationRequest,
        },
      ],
      infoLogs: [],
    };

    const machine = createOAuthStateMachine({
      protocolVersion,
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates: any) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT,
      requestExecutor: jest.fn().mockResolvedValue(
        okResult({
          client_id: "minted-client",
          client_secret: SECRET,
          token_endpoint_auth_method: "client_secret_post",
          client_name: "Test Client",
        })
      ),
      dynamicRegistration: { client_name: "Test Client" },
    } as any);

    await machine.proceedToNextStep();
    return state;
  };

  it.each(["2025-03-26", "2025-06-18", "2025-11-25"] as const)(
    "%s keeps the issued secret out of lastResponse/httpHistory/infoLogs",
    async (version) => {
      const state = await runMachineAtRegistration(version);
      expect(state.currentStep).toBe("received_client_credentials");
      // Operational path: the machine still holds the raw secret for the
      // token request...
      expect((state as any).clientSecret).toBe(SECRET);
      expect((state as any).clientId).toBe("minted-client");
      // ...but no diagnostic surface may contain even a prefix of it.
      const diagnostics = JSON.stringify({
        lastResponse: (state as any).lastResponse,
        httpHistory: state.httpHistory,
        infoLogs: state.infoLogs,
      });
      expect(diagnostics).not.toContain(SECRET);
      expect(diagnostics).not.toContain(SECRET.substring(0, 8));
    }
  );

  it("2025-11-25 default CIMD URL remains valid through the shared validator", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "received_authorization_server_metadata" as const,
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        client_id_metadata_document_supported: true,
      },
      httpHistory: [],
      infoLogs: [],
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
      clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
      state,
      getState: () => state,
      updateState: (updates: any) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT,
      requestExecutor: jest.fn(),
    } as any);

    await machine.proceedToNextStep();
    expect(state.currentStep).toBe("cimd_prepare");
    // Simple-string identity: the client_id is the exact configured URL.
    expect((state as any).clientId).toBe(DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL);
  });
});
