/**
 * No-emulation wire goldens.
 *
 * Snapshots EVERY request each of the four debug OAuth state machines sends
 * over a full ladder (probe → discovery → DCR → token → authenticated
 * verification), with no emulation configured. These are the baseline the
 * OAuth client-emulation work is measured against: emulation is opt-in, so
 * the default wire behavior captured here must never change. A failure in
 * this file means a change to shared machine code leaked into the
 * no-emulation path.
 *
 * Registration strategy is pinned to "dcr" for all four versions (the one
 * strategy every machine supports) so the register request is part of the
 * baseline. Non-deterministic values (PKCE verifier/challenge, CSRF state)
 * are normalized to stable placeholders before snapshotting.
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

const ALL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

/**
 * 2025-03-26 has no protected-resource-metadata step: the authorization
 * server is discovered on the MCP server's own origin. Later revisions
 * discover it via PRM on a separate origin.
 */
function authServerBaseFor(version: OAuthProtocolVersion): string {
  return version === "2025-03-26" ? SERVER_ORIGIN : AUTH_SERVER_URL;
}

function buildMockRouter(version: OAuthProtocolVersion) {
  const asBase = authServerBaseFor(version);
  const challenge =
    version === "2025-03-26"
      ? "Bearer realm=\"mcp\""
      : `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;

  return async (request: OAuthHttpRequest) => {
    // Authenticated MCP verification (bearer present).
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

    // Unauthenticated MCP probe.
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
          token_endpoint_auth_method: "none",
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

function createRecordingMachine(version: OAuthProtocolVersion) {
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
    serverName: "golden-server",
    redirectUrl: REDIRECT_URL,
    dynamicRegistration: { client_name: "Golden Baseline Client" },
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
  maxSteps = 30,
) {
  for (let index = 0; index < maxSteps; index += 1) {
    if (getState().currentStep === targetStep) {
      return;
    }
    if (getState().error) {
      throw new Error(
        `Flow errored at ${getState().currentStep}: ${getState().error}`,
      );
    }
    await machine.proceedToNextStep();
  }
  // The loop checks the target before stepping, so the final transition of
  // the budget lands after the last check — re-check before declaring failure.
  if (getState().currentStep === targetStep) {
    return;
  }
  throw new Error(
    `Did not reach step "${targetStep}" within ${maxSteps} steps. ` +
      `Current step: ${getState().currentStep}; error: ${getState().error ?? "none"}`,
  );
}

/**
 * Replace the per-run random values (PKCE verifier/challenge, CSRF state)
 * with stable placeholders wherever they appear — authorize-URL params,
 * token-request bodies, and echoed body objects.
 */
function normalize(text: string, replacements: Array<[string, string]>): string {
  let result = text;
  for (const [value, placeholder] of replacements) {
    if (value) {
      result = result.split(value).join(placeholder);
    }
  }
  return result;
}

function snapshotPayload(
  requests: OAuthHttpRequest[],
  finalState: OAuthFlowState,
) {
  // Each value is replaced in both raw and percent-encoded form: the
  // authorize URL and the form-encoded token body carry the URL-encoded
  // variant (e.g. `~` → `%7E`), and matching only the raw string would let
  // encoded values leak into the snapshot non-deterministically.
  const replacements: Array<[string, string]> = (
    [
      [finalState.codeVerifier, "<code-verifier>"],
      [finalState.codeChallenge, "<code-challenge>"],
      [finalState.state, "<state>"],
    ] as Array<[string | undefined, string]>
  ).flatMap(([value, placeholder]) => {
    if (!value) return [];
    // application/x-www-form-urlencoded encoding (URLSearchParams) differs
    // from encodeURIComponent — e.g. `~` → `%7E` only in the former — and
    // both machines' authorize URLs and token bodies use URLSearchParams.
    const formEncoded = new URLSearchParams([["v", value]])
      .toString()
      .slice(2);
    const variants = new Set([value, encodeURIComponent(value), formEncoded]);
    return [...variants].map(
      (variant) => [variant, placeholder] as [string, string],
    );
  });
  const wire = requests.map((request) => ({
    url: normalize(request.url, replacements),
    method: request.method,
    headers: JSON.parse(normalize(JSON.stringify(request.headers), replacements)),
    body:
      request.body === undefined || request.body === null
        ? null
        : JSON.parse(normalize(JSON.stringify(request.body), replacements)),
    // Part of the wire contract: a machine switching a request between
    // followed and manual redirects must trip the golden.
    redirect: request.redirect ?? null,
  }));
  return {
    wire,
    authorizationUrl: finalState.authorizationUrl
      ? normalize(finalState.authorizationUrl, replacements)
      : null,
  };
}

describe("no-emulation wire goldens (baseline for OAuth client emulation)", () => {
  it.each(ALL_VERSIONS)(
    "full-ladder requests are unchanged (%s)",
    async (version) => {
      const { machine, getState, updateState, requests } =
        createRecordingMachine(version);

      await stepUntil(machine, getState, "authorization_request");

      // Cross the human step: deliver the authorization code (with the
      // RFC 9207 issuer for machines that validate it).
      updateState({
        currentStep: "received_authorization_code",
        authorizationCode: "mock-auth-code",
        authorizationResponseIss: authServerBaseFor(version),
      });

      await stepUntil(machine, getState, "complete");

      expect(snapshotPayload(requests, getState())).toMatchSnapshot();
    },
  );
});
