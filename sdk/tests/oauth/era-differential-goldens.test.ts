/**
 * Differential goldens across every era, registration strategy, and branch.
 *
 * `no-emulation-goldens.test.ts` covers one happy ladder per era, `dcr` only,
 * no error branches. That is enough to notice an accidental change to the
 * default path and nothing else — which is a thin basis for any consolidation
 * of the era machines, and a thin basis for trusting them in general.
 *
 * This file widens it to 4 eras × each supported registration strategy × a
 * catalog of the branches that actually differ between eras: PRM shape, PKCE
 * metadata, DCR failure and its pre-registered fallback, issuer policy,
 * resource-indicator enforcement.
 *
 * Two layers, deliberately:
 *
 *   - A snapshot of the full request sequence. Good for review — it shows what
 *     changed — and useless as a guarantee, because accepting an updated
 *     snapshot is one keystroke.
 *   - Named assertions for the MCP OAuth MUSTs. These are the gate. A snapshot
 *     update must not be able to normalize away a missing `S256`, a broken
 *     resource binding, or a credential sent to the wrong endpoint.
 */

import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthHttpRequest,
  type OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const SERVER_URL = "https://mcp-server.example.com/mcp";
const SERVER_ORIGIN = "https://mcp-server.example.com";
const RESOURCE_METADATA_URL = `${SERVER_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const AUTH_SERVER_URL = "https://auth-server.example.com";
const REDIRECT_URL = "http://localhost:3000/oauth/callback/debug";
const CLIENT_ID_METADATA_URL = "https://www.mcpjam.com/.well-known/oauth/client-metadata.json";
const ACCESS_TOKEN = "access-token";

const ALL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

/** Eras governed by the current PRM + PKCE profile. */
const CURRENT_ERAS: OAuthProtocolVersion[] = ["2025-11-25", "2026-07-28"];

type RegistrationStrategy = "dcr" | "preregistered" | "cimd";

/** CIMD arrived with 2025-11-25; the factory rejects it for older eras. */
function supportedStrategies(
  version: OAuthProtocolVersion,
): RegistrationStrategy[] {
  return CURRENT_ERAS.includes(version)
    ? ["dcr", "preregistered", "cimd"]
    : ["dcr", "preregistered"];
}

/**
 * 2025-03-26 has no protected-resource-metadata step: the authorization server
 * is discovered on the MCP server's own origin.
 */
function authServerBaseFor(version: OAuthProtocolVersion): string {
  return version === "2025-03-26" ? SERVER_ORIGIN : AUTH_SERVER_URL;
}

interface RouterKnobs {
  /** Replace the protected-resource metadata document. `null` deletes a key. */
  protectedResourceMetadata?: Record<string, unknown>;
  /** Replace the authorization-server metadata document. `null` deletes a key. */
  authorizationServerMetadata?: Record<string, unknown>;
  /** Make dynamic client registration fail. */
  registrationFails?: boolean;
  /** Advertise an issuer other than the discovery origin. */
  issuerOverride?: string;
}

function applyOverrides(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!overrides) return base;
  const merged = { ...base, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete merged[key];
  }
  return merged;
}

function buildRouter(version: OAuthProtocolVersion, knobs: RouterKnobs = {}) {
  const asBase = authServerBaseFor(version);
  const challenge =
    version === "2025-03-26"
      ? 'Bearer realm="mcp"'
      : `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

  return async (request: OAuthHttpRequest) => {
    if (
      request.url === SERVER_URL &&
      request.headers.Authorization === `Bearer ${ACCESS_TOKEN}`
    ) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body:
          version === "2026-07-28"
            ? { jsonrpc: "2.0", id: 2, result: { tools: [] } }
            : {
                jsonrpc: "2.0",
                id: 2,
                result: {
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
        body: applyOverrides(
          { resource: SERVER_URL, authorization_servers: [AUTH_SERVER_URL] },
          knobs.protectedResourceMetadata,
        ),
        ok: true,
      };
    }

    if (
      request.url.includes("/.well-known/oauth-authorization-server") ||
      request.url.includes("/.well-known/openid-configuration")
    ) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: applyOverrides(
          {
            issuer: knobs.issuerOverride ?? asBase,
            authorization_endpoint: `${asBase}/authorize`,
            token_endpoint: `${asBase}/token`,
            registration_endpoint: `${asBase}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
          },
          knobs.authorizationServerMetadata,
        ),
        ok: true,
      };
    }

    // The Client ID Metadata Document the `cimd` strategy fetches instead of
    // registering. Served here so CIMD is a real branch in the matrix rather
    // than a 404 every era fails identically on.
    if (request.url === CLIENT_ID_METADATA_URL) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          client_id: CLIENT_ID_METADATA_URL,
          client_name: "MCPJam Inspector",
          redirect_uris: [REDIRECT_URL],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        ok: true,
      };
    }

    if (request.url === `${asBase}/register`) {
      if (knobs.registrationFails) {
        return {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" },
          body: {
            error: "invalid_client_metadata",
            error_description: "Dynamic registration is disabled.",
          },
          ok: false,
        };
      }
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: { client_id: "test-client-id", token_endpoint_auth_method: "none" },
        ok: true,
      };
    }

    if (request.url === `${asBase}/token`) {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          access_token: ACCESS_TOKEN,
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

interface RunOptions {
  version: OAuthProtocolVersion;
  registrationStrategy: RegistrationStrategy;
  knobs?: RouterKnobs;
  machineConfig?: Record<string, unknown>;
  /** RFC 9207 `iss` delivered with the authorization code. */
  authorizationResponseIss?: string | null;
  /** Provide pre-registered credentials (required by the `preregistered` strategy). */
  preregisteredClientId?: string;
}

interface RunResult {
  requests: OAuthHttpRequest[];
  state: OAuthFlowState;
  /** True when the flow reached `complete` with an access token. */
  completed: boolean;
  error?: string;
}

/**
 * Drive a machine to completion or to a stop, WITHOUT throwing on error — the
 * error branches are the point of this file.
 */
async function run(options: RunOptions): Promise<RunResult> {
  const {
    version,
    registrationStrategy,
    knobs,
    machineConfig,
    preregisteredClientId,
  } = options;

  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    httpHistory: [],
    infoLogs: [],
  };
  const requests: OAuthHttpRequest[] = [];
  const route = buildRouter(version, knobs);

  const machine = createOAuthStateMachine({
    protocolVersion: version,
    registrationStrategy: registrationStrategy as never,
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: SERVER_URL,
    serverName: "differential-server",
    redirectUrl: REDIRECT_URL,
    dynamicRegistration: { client_name: "Differential Client" },
    clientIdMetadataUrl: CLIENT_ID_METADATA_URL,
    ...(preregisteredClientId
      ? {
          loadPreregisteredCredentials: async () => ({
            clientId: preregisteredClientId,
          }),
        }
      : {}),
    requestExecutor: async (request) => {
      requests.push(request);
      return route(request);
    },
    ...(machineConfig as never),
  });

  let deliveredCode = false;
  for (let index = 0; index < 40; index += 1) {
    if (state.currentStep === "complete" || state.error) break;

    // Cross the human step exactly once.
    if (state.currentStep === "authorization_request" && !deliveredCode) {
      deliveredCode = true;
      state = {
        ...state,
        currentStep: "received_authorization_code",
        authorizationCode: "mock-auth-code",
        authorizationResponseIss:
          options.authorizationResponseIss === null
            ? undefined
            : (options.authorizationResponseIss ?? authServerBaseFor(version)),
      };
      continue;
    }

    try {
      await machine.proceedToNextStep();
    } catch (error) {
      state = {
        ...state,
        error: error instanceof Error ? error.message : String(error),
      };
      break;
    }
  }

  return {
    requests,
    state,
    completed: state.currentStep === "complete" && Boolean(state.accessToken),
    error: state.error,
  };
}

function normalize(text: string, replacements: Array<[string, string]>): string {
  let result = text;
  for (const [value, placeholder] of replacements) {
    if (value) result = result.split(value).join(placeholder);
  }
  return result;
}

/** Same normalization as the existing goldens: per-run randomness → placeholders. */
function snapshotPayload(result: RunResult) {
  const replacements: Array<[string, string]> = (
    [
      [result.state.codeVerifier, "<code-verifier>"],
      [result.state.codeChallenge, "<code-challenge>"],
      [result.state.state, "<state>"],
    ] as Array<[string | undefined, string]>
  ).flatMap(([value, placeholder]) => {
    if (!value) return [];
    const formEncoded = new URLSearchParams([["v", value]]).toString().slice(2);
    return [
      ...new Set([value, encodeURIComponent(value), formEncoded]),
    ].map((variant) => [variant, placeholder] as [string, string]);
  });

  return {
    wire: result.requests.map((request) => ({
      url: normalize(request.url, replacements),
      method: request.method,
      headers: JSON.parse(
        normalize(JSON.stringify(request.headers), replacements),
      ),
      body:
        request.body == null
          ? null
          : JSON.parse(normalize(JSON.stringify(request.body), replacements)),
      redirect: request.redirect ?? null,
    })),
    authorizationUrl: result.state.authorizationUrl
      ? normalize(result.state.authorizationUrl, replacements)
      : null,
    completed: result.completed,
    error: result.error
      ? normalize(result.error, replacements)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Semantic assertions — the gate. A snapshot update cannot weaken these.
// ---------------------------------------------------------------------------

function tokenRequest(result: RunResult) {
  return result.requests.filter((request) =>
    request.url.endsWith("/token"),
  ).at(-1);
}

/**
 * Read a token request's parameters regardless of whether the machine handed
 * the executor a form-encoded string or an object. Asserting against one shape
 * only would silently pass on the eras that use the other.
 */
function tokenParams(request: OAuthHttpRequest | undefined): Record<string, string> {
  const body = request?.body;
  if (typeof body === "string") {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  if (body && typeof body === "object") {
    return body as Record<string, string>;
  }
  return {};
}

function authorizationUrl(result: RunResult): URL | undefined {
  return result.state.authorizationUrl
    ? new URL(result.state.authorizationUrl)
    : undefined;
}

/**
 * The MCP OAuth MUSTs, checked against what the machine actually sent.
 *
 * Applied to every successful run in the matrix, so a change that satisfies one
 * era/strategy pair and breaks another cannot pass.
 */
function assertWireInvariants(result: RunResult, version: OAuthProtocolVersion) {
  const authorize = authorizationUrl(result);
  const token = tokenRequest(result);
  expect(authorize, "no authorization URL").toBeTruthy();
  expect(token, "no token request").toBeTruthy();
  const tokenBody = tokenParams(token);

  // PKCE: S256 on the authorization request, verifier on the exchange.
  expect(authorize!.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize!.searchParams.get("code_challenge")).toBeTruthy();
  expect(tokenBody.code_verifier).toBeTruthy();
  expect(tokenBody.code_verifier).toBe(result.state.codeVerifier);

  // One redirect_uri, reused wherever the field applies.
  expect(authorize!.searchParams.get("redirect_uri")).toBe(REDIRECT_URL);
  expect(tokenBody.redirect_uri).toBe(REDIRECT_URL);

  // Resource binding (RFC 8707): both requests carry it, byte-identical, and
  // it is the validated canonical MCP resource — not some other audience the
  // authorization server could mint a token for. Every era does this, including
  // 2025-03-26, which has no PRM step and derives the resource from the server
  // URL instead.
  const authorizeResource = authorize!.searchParams.get("resource");
  expect(authorizeResource).toBeTruthy();
  expect(tokenBody.resource).toBe(authorizeResource);
  expect(new URL(authorizeResource!).origin).toBe(SERVER_ORIGIN);

  // A CSRF state is always issued.
  expect(authorize!.searchParams.get("state")).toBeTruthy();

  // Credentials go only to the MCP resource. A bearer token on PRM, AS
  // metadata, registration, or the token endpoint hands the resource's
  // credential to a different party.
  for (const request of result.requests) {
    if (request.url === SERVER_URL) continue;
    expect(
      JSON.stringify(request.headers ?? {}),
      `${request.method} ${request.url} carried the access token`,
    ).not.toContain(ACCESS_TOKEN);
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const ERA_STRATEGY_PAIRS = ALL_VERSIONS.flatMap((version) =>
  supportedStrategies(version).map(
    (strategy) => [version, strategy] as [OAuthProtocolVersion, RegistrationStrategy],
  ),
);

describe.each(ERA_STRATEGY_PAIRS)(
  "era %s × registration %s",
  (version, strategy) => {
    const preregisteredClientId =
      strategy === "preregistered" ? "preregistered-client-id" : undefined;

    it("happy ladder: full request sequence", async () => {
      const result = await run({
        version,
        registrationStrategy: strategy,
        preregisteredClientId,
      });

      expect(result.completed, result.error).toBe(true);
      assertWireInvariants(result, version);
      expect(snapshotPayload(result)).toMatchSnapshot();
    });

    it("registers exactly once, and only when the strategy calls for it", async () => {
      const result = await run({
        version,
        registrationStrategy: strategy,
        preregisteredClientId,
      });

      const registrations = result.requests.filter((request) =>
        request.url.endsWith("/register"),
      );
      expect(registrations.length).toBe(strategy === "dcr" ? 1 : 0);
    });
  },
);

describe.each(ALL_VERSIONS)("branch catalog (%s)", (version) => {
  const isCurrentEra = CURRENT_ERAS.includes(version);

  it("DCR failure without a fallback stops the flow", async () => {
    const result = await run({
      version,
      registrationStrategy: "dcr",
      knobs: { registrationFails: true },
    });

    expect(result.completed).toBe(false);
    expect(tokenRequest(result)).toBeUndefined();
    expect(snapshotPayload(result)).toMatchSnapshot();
  });

  it("DCR failure falls back to pre-registered credentials when available", async () => {
    const result = await run({
      version,
      registrationStrategy: "dcr",
      knobs: { registrationFails: true },
      preregisteredClientId: "fallback-client-id",
    });

    expect(result.completed, result.error).toBe(true);
    expect(result.state.clientId).toBe("fallback-client-id");
    assertWireInvariants(result, version);
    expect(snapshotPayload(result)).toMatchSnapshot();
  });

  it("strictConformance refuses the DCR fallback", async () => {
    const result = await run({
      version,
      registrationStrategy: "dcr",
      knobs: { registrationFails: true },
      preregisteredClientId: "fallback-client-id",
      machineConfig: { strictConformance: true },
    });

    expect(result.completed).toBe(false);
    expect(tokenRequest(result)).toBeUndefined();
  });

  it("a present-but-mismatched authorization-response iss is handled per era", async () => {
    const result = await run({
      version,
      registrationStrategy: "dcr",
      authorizationResponseIss: "https://different-issuer.example.com",
    });

    if (version === "2026-07-28") {
      // SEP-2468 makes the present-`iss` comparison a MUST.
      expect(result.completed).toBe(false);
      expect(tokenRequest(result)).toBeUndefined();
    } else {
      // Older eras do not mandate the check; the flow proceeds, and the wire
      // invariants still hold.
      expect(result.completed, result.error).toBe(true);
      assertWireInvariants(result, version);
    }
  });

  it("an absent authorization-response iss does not block redemption", async () => {
    const result = await run({
      version,
      registrationStrategy: "dcr",
      authorizationResponseIss: null,
    });

    // A genuinely-absent `iss` is indistinguishable from an un-captured one, so
    // no era hard-fails on it.
    expect(result.completed, result.error).toBe(true);
    assertWireInvariants(result, version);
  });

  it.each(["warn", "reject", "reject-rfc9728"] as const)(
    "resourceIndicatorEnforcement=%s on a conforming resource",
    async (enforcement) => {
      const result = await run({
        version,
        registrationStrategy: "dcr",
        machineConfig: { resourceIndicatorEnforcement: enforcement },
      });

      expect(result.completed, result.error).toBe(true);
      assertWireInvariants(result, version);
    },
  );

  it.each([true, false])(
    "allowPathScopedIssuer=%s against an exact-match issuer",
    async (allowPathScopedIssuer) => {
      const result = await run({
        version,
        registrationStrategy: "dcr",
        machineConfig: { allowPathScopedIssuer },
      });

      // The opt-in must not change behavior when the issuer already matches.
      expect(result.completed, result.error).toBe(true);
      assertWireInvariants(result, version);
    },
  );

  it("an issuer that does not match the discovery origin is handled per era", async () => {
    const result = await run({
      version,
      registrationStrategy: "dcr",
      knobs: { issuerOverride: "https://elsewhere.example.com" },
    });

    // Pinned per era rather than "whatever happens": only 2026-07-28 hard-
    // rejects the RFC 8414 §3.3 mismatch today, and `allowPathScopedIssuer`
    // exists as the opt-in for exactly that era. Naming the difference here is
    // what makes it a decision rather than an accident — and stops a shared-code
    // change from quietly giving an older era the strict behavior or taking it
    // away from the newest one.
    if (version === "2026-07-28") {
      expect(result.completed).toBe(false);
      expect(result.error).toMatch(/issuer/i);
      expect(tokenRequest(result)).toBeUndefined();
    } else {
      expect(result.completed, result.error).toBe(true);
      assertWireInvariants(result, version);
    }
    expect(snapshotPayload(result)).toMatchSnapshot();
  });

  it("allowPathScopedIssuer opts into an origin-root issuer only where the era enforces the match", async () => {
    const strict = await run({
      version,
      registrationStrategy: "dcr",
      knobs: { issuerOverride: "https://elsewhere.example.com" },
      machineConfig: { allowPathScopedIssuer: true },
    });

    // The opt-in is for a same-origin path-prefix ancestor, not for an
    // arbitrary foreign issuer — turning it on must not accept this one.
    if (version === "2026-07-28") {
      expect(strict.completed).toBe(false);
      expect(tokenRequest(strict)).toBeUndefined();
    } else {
      expect(strict.completed, strict.error).toBe(true);
    }
  });

  // --- Current-profile branches. Older eras genuinely differ here. ---

  if (isCurrentEra) {
    it("stops before authorization when the AS advertises no S256", async () => {
      const result = await run({
        version,
        registrationStrategy: "dcr",
        knobs: {
          authorizationServerMetadata: {
            code_challenge_methods_supported: ["plain"],
          },
        },
      });

      expect(result.completed).toBe(false);
      expect(result.error).toContain("S256");
      expect(authorizationUrl(result)).toBeUndefined();
      expect(tokenRequest(result)).toBeUndefined();
    });

    it("stops before authorization when the AS advertises no PKCE metadata", async () => {
      const result = await run({
        version,
        registrationStrategy: "dcr",
        knobs: {
          authorizationServerMetadata: {
            code_challenge_methods_supported: null,
          },
        },
      });

      expect(result.completed).toBe(false);
      expect(authorizationUrl(result)).toBeUndefined();
      expect(tokenRequest(result)).toBeUndefined();
    });

    it.each([
      ["empty", { authorization_servers: [] }],
      ["absent", { authorization_servers: null }],
    ])(
      "fails closed when PRM authorization_servers is %s",
      async (_label, override) => {
        const result = await run({
          version,
          registrationStrategy: "dcr",
          knobs: { protectedResourceMetadata: override },
        });

        expect(result.completed).toBe(false);
        expect(tokenRequest(result)).toBeUndefined();
        // Specifically: it did NOT silently substitute the MCP server URL.
        expect(result.state.authorizationServerMetadata).toBeFalsy();
      },
    );

    it("observe mode substitutes the server URL and records the finding", async () => {
      const result = await run({
        version,
        registrationStrategy: "dcr",
        knobs: { protectedResourceMetadata: { authorization_servers: [] } },
        machineConfig: { requiredMetadataEnforcement: "observe" },
      });

      expect(result.state.authorizationServerUrl).toBe(SERVER_URL);
      expect(JSON.stringify(result.state.infoLogs ?? [])).toContain(
        "authorization-server-substituted",
      );
    });

    it("accepts plain advertised alongside S256", async () => {
      const result = await run({
        version,
        registrationStrategy: "dcr",
        knobs: {
          authorizationServerMetadata: {
            code_challenge_methods_supported: ["plain", "S256"],
          },
        },
      });

      expect(result.completed, result.error).toBe(true);
      assertWireInvariants(result, version);
    });
  }
});
