import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  evaluatePathScopedIssuer,
  validateAuthorizationResponseIssuer,
} from "../../src/oauth/state-machines/debug-oauth-2026-07-28.js";
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

  it("row 2 names both issuers so a same-looking mismatch is diagnosable", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: `${ISS}/`,
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(`\`${ISS}\``);
      expect(result.reason).toContain(`\`${ISS}/\``);
    }
  });

  it("row 2 neutralizes a hostile `iss` that tries to forge message lines", () => {
    // C0/DEL are not the only line breakers: NEL and the Unicode LINE/PARAGRAPH
    // separators also split lines when the diagnostic is rendered.
    for (const breaker of ["\n", "\r", "\u0085", "\u2028", "\u2029"]) {
      const result = validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: `https://evil.example.com${breaker}${breaker}Authorization succeeded.`,
        issParameterSupported: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain(breaker);
        expect(result.reason).toContain("https://evil.example.com");
      }
    }
  });

  it("row 2 warns instead of rejecting when the era does not enforce it", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: "https://evil.example.com",
      issParameterSupported: true,
      enforcePresentIssMismatch: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toContain(`\`${ISS}\``);
      expect(result.warning).toContain("`https://evil.example.com`");
    }
  });

  it("row 2 fails closed when the enforcement flag is omitted", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: "https://evil.example.com",
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
  });

  it("a matching iss never warns, enforced or not", () => {
    for (const enforce of [true, false]) {
      const result = validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: ISS,
        issParameterSupported: true,
        enforcePresentIssMismatch: enforce,
      });
      expect(result).toEqual({ ok: true });
    }
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

  it("empty-string iss still fails closed when the AS advertised iss support", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: "",
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
  });

  // Regression: `URLSearchParams.get("iss")` returns `null` when the param is
  // absent. Treating that null as a PRESENT iss sent every conformant AS that
  // omits `iss` (a SHOULD, not a MUST) into the mismatch branch, where
  // `quoteUntrusted(null)` crashed with "Cannot read properties of null
  // (reading 'replace')" before the code could be redeemed.
  it("row 4: a null iss from URLSearchParams is absent, not a mismatch", () => {
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: null,
        issParameterSupported: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("row 3: a null iss still rejects when the AS advertised iss support", () => {
    const result = validateAuthorizationResponseIssuer({
      recordedIssuer: ISS,
      returnedIss: null,
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/RFC 9207/);
  });

  it("null iss never crashes or warns on the non-enforcing (legacy) path", () => {
    expect(
      validateAuthorizationResponseIssuer({
        recordedIssuer: ISS,
        returnedIss: null,
        issParameterSupported: false,
        enforcePresentIssMismatch: false,
      }),
    ).toEqual({ ok: true });
  });
});

describe("evaluatePathScopedIssuer", () => {
  const ORIGIN = "https://env.scalekit.cloud";
  const DISCOVERY = `${ORIGIN}/resources/res_123`;
  const evaluate = (overrides: Record<string, unknown> = {}) =>
    evaluatePathScopedIssuer({
      advertisedIssuer: ORIGIN,
      discoveryUrl: DISCOVERY,
      tokenEndpoint: `${ORIGIN}/oauth/token`,
      registrationEndpoint: `${ORIGIN}/oauth/register`,
      allowPathScopedIssuer: true,
      ...overrides,
    });

  it("accepts the origin-root issuer of a path-scoped discovery URL", () => {
    expect(evaluate()).toEqual({ accepted: true, hint: "" });
  });

  it("rejects everything when the opt-in is off", () => {
    const verdict = evaluate({ allowPathScopedIssuer: false });
    expect(verdict.accepted).toBe(false);
    expect(verdict.hint).toContain("Path-scoped authorization server");
  });

  it("accepts an intermediate path-prefix ancestor, segment-aware", () => {
    expect(evaluate({ advertisedIssuer: `${ORIGIN}/resources` }).accepted).toBe(
      true
    );
    expect(
      evaluate({ advertisedIssuer: `${ORIGIN}/resources-evil` }).accepted
    ).toBe(false);
  });

  // RFC 8414 §2 forbids query/fragment in an issuer identifier, and the toggle
  // is documented to relax a path difference only.
  it("rejects a query or fragment on either side of the comparison", () => {
    expect(
      evaluate({ advertisedIssuer: `${ORIGIN}?tenant=evil` }).accepted
    ).toBe(false);
    expect(evaluate({ advertisedIssuer: `${ORIGIN}#evil` }).accepted).toBe(
      false
    );
    expect(
      evaluate({ discoveryUrl: `${DISCOVERY}?tenant=evil` }).accepted
    ).toBe(false);
    expect(evaluate({ discoveryUrl: `${DISCOVERY}#evil` }).accepted).toBe(
      false
    );
  });

  it("rejects endpoints that leave the advertised issuer's origin", () => {
    expect(
      evaluate({ tokenEndpoint: "https://evil.example.com/token" }).accepted
    ).toBe(false);
    expect(
      evaluate({ registrationEndpoint: "https://evil.example.com/register" })
        .accepted
    ).toBe(false);
  });

  // A truthy non-string skips a `typeof x === "string"` guard, so without an
  // explicit rule it would slip past the origin gate and fail only after
  // registration and the authorization redirect had already run.
  it("treats a present non-string endpoint as escaping, not as absent", () => {
    for (const bogus of [{ href: "https://evil.example.com" }, 42, true, []]) {
      expect(evaluate({ tokenEndpoint: bogus }).accepted).toBe(false);
      expect(evaluate({ registrationEndpoint: bogus }).accepted).toBe(false);
    }
    const verdict = evaluate({ tokenEndpoint: 42 });
    expect(verdict.hint).toContain("a non-string value");
  });

  it("rejects an unparseable endpoint string", () => {
    expect(evaluate({ tokenEndpoint: "not-a-url" }).accepted).toBe(false);
  });

  // Absent is not the same as malformed: there is nothing to bind to an origin,
  // and the caller's required-field checks reject a missing token_endpoint.
  it("allows an absent registration endpoint", () => {
    expect(evaluate({ registrationEndpoint: undefined }).accepted).toBe(true);
    expect(evaluate({ registrationEndpoint: null }).accepted).toBe(true);
  });

  it("rejects a cross-origin issuer with no path-scoped hint", () => {
    const verdict = evaluate({ advertisedIssuer: "https://evil.example.com" });
    expect(verdict).toEqual({ accepted: false, hint: "" });
  });
});

describe("debug-oauth-2026-07-28 machine — 2M-a spec steps", () => {
  const AS_URL = "https://auth.example.com";

  // Build a machine seeded at a given step with a custom request executor, run
  // one step, and return the resulting state.
  const driveOnce = async (
    overrides: Partial<OAuthFlowState>,
    executor: OAuthRequestExecutor,
    configOverrides: { allowPathScopedIssuer?: boolean } = {}
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
      ...configOverrides,
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

  describe("path-scoped authorization server opt-in", () => {
    const TENANT_ORIGIN = "https://env.scalekit.cloud";
    const TENANT_AS_URL = `${TENANT_ORIGIN}/resources/res_123`;
    const pathScopedMetadata = (overrides: Record<string, unknown> = {}) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        issuer: TENANT_ORIGIN,
        authorization_endpoint: `${TENANT_ORIGIN}/oauth/authorize`,
        token_endpoint: `${TENANT_ORIGIN}/oauth/token`,
        registration_endpoint: `${TENANT_ORIGIN}/oauth/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        ...overrides,
      },
    });

    it("still hard-rejects by default, naming the toggle in the hint", async () => {
      const getState = await driveOnce(
        {
          currentStep: "request_authorization_server_metadata",
          authorizationServerUrl: TENANT_AS_URL,
        },
        jest.fn().mockResolvedValue(pathScopedMetadata())
      );
      expect(getState().error).toMatch(/RFC 8414/);
      expect(getState().error).toMatch(/Path-scoped authorization server/);
    });

    it("accepts an origin-root issuer under the opt-in, with a warning log", async () => {
      const getState = await driveOnce(
        {
          currentStep: "request_authorization_server_metadata",
          authorizationServerUrl: TENANT_AS_URL,
        },
        jest.fn().mockResolvedValue(pathScopedMetadata()),
        { allowPathScopedIssuer: true }
      );
      expect(getState().error).toBeUndefined();
      expect(getState().currentStep).toBe(
        "received_authorization_server_metadata",
      );
      const warning = getState().infoLogs?.find(
        (log) => log.id === "path-scoped-issuer",
      );
      expect(warning).toBeDefined();
      expect(warning?.level).toBe("warning");
    });

    it("rejects an off-origin token endpoint even under the opt-in", async () => {
      const getState = await driveOnce(
        {
          currentStep: "request_authorization_server_metadata",
          authorizationServerUrl: TENANT_AS_URL,
        },
        jest.fn().mockResolvedValue(
          pathScopedMetadata({
            token_endpoint: "https://evil.example.com/oauth/token",
          })
        ),
        { allowPathScopedIssuer: true }
      );
      expect(getState().error).toMatch(/not on the same origin as its issuer/);
    });

    it("rejects a cross-origin issuer even under the opt-in", async () => {
      const getState = await driveOnce(
        {
          currentStep: "request_authorization_server_metadata",
          authorizationServerUrl: TENANT_AS_URL,
        },
        jest
          .fn()
          .mockResolvedValue(
            pathScopedMetadata({ issuer: "https://evil.example.com" })
          ),
        { allowPathScopedIssuer: true }
      );
      expect(getState().error).toMatch(/RFC 8414/);
    });

    it("rejects a same-origin sibling path (not a prefix ancestor) even under the opt-in", async () => {
      const getState = await driveOnce(
        {
          currentStep: "request_authorization_server_metadata",
          authorizationServerUrl: TENANT_AS_URL,
        },
        jest
          .fn()
          .mockResolvedValue(
            pathScopedMetadata({ issuer: `${TENANT_ORIGIN}/resources-evil` })
          ),
        { allowPathScopedIssuer: true }
      );
      expect(getState().error).toMatch(/RFC 8414/);
    });
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
