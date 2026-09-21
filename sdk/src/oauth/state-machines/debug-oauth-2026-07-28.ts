/**
 * OAuth 2.0 State Machine for MCP - 2026-07-28 Protocol
 *
 * This implementation follows the 2026-07-28 MCP OAuth specification:
 * - Registration priority: CIMD (SHOULD) > Pre-registered > DCR (MAY)
 * - Discovery: OAuth 2.0 (RFC8414) OR OpenID Connect Discovery 1.0 with path insertion priority
 * - PKCE: REQUIRED - MUST verify code_challenge_methods_supported
 * - Client ID Metadata Documents (CIMD) support per draft-parecki-oauth-client-id-metadata-document-03
 */

import {
  describeAuthenticatedRequestFailure,
  describeTokenRequestFailure,
} from "./shared/response-error.js";
import { decodeJWT, formatJWTTimestamp } from "./shared/jwt.js";
import { EMPTY_OAUTH_FLOW_STATE, buildResetFlowState } from "./types.js";
import type {
  BaseOAuthStateMachineConfig,
  OAuthFlowStep,
  OAuthFlowState,
  OAuthStateMachine,
  HttpHistoryEntry,
  RegistrationStrategy2026_07_28,
} from "./types.js";
import type { DiagramAction } from "./shared/types.js";
import { buildOAuthSequenceDiagramActions } from "./shared/sequence-diagram.js";
import {
  addChallengeStatusWarning,
  addInfoLog,
  markLatestHttpEntryAsError,
  toLogErrorDetails,
} from "./shared/logging.js";
import {
  mergeHeaders,
  mergeHeadersForAuthServer,
  mergeHeadersForResourceMetadataRequest,
  normalizeHeaders,
} from "./shared/headers.js";
import {
  generateRandomString,
  generateCodeChallenge,
} from "./shared/pkce.js";
import { buildResourceMetadataUrl } from "./shared/urls.js";
import {
  AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER,
  describePkceMetadataNonConformance,
  selectAuthorizationServerFromResourceMetadata,
} from "./shared/required-metadata.js";
import {
  resolveDiscoveryResourceIndicator,
  resolveFlowResourceValue,
} from "./shared/resource-indicator.js";
import { buildStatelessVerifyRequestBody } from "./shared/initialize.js";
import {
  classifyUnauthenticatedProbe,
  computeScopeUnion,
  parseBearerAuthenticateParameters,
  parseScopeString,
  UnexpectedProbeStatusError,
} from "./shared/challenges.js";
import {
  buildTokenRequestClientAuth,
  normalizeRegisteredClientAuthMethod,
  resolvePreregisteredClientAuthMethod,
} from "./shared/client-auth.js";
import {
  buildDynamicClientRegistrationRequest,
  deriveApplicationType,
  executeDynamicClientRegistration,
} from "./shared/dynamic-client-registration.js";
import { validateClientIdMetadataUrl } from "./shared/client-id-metadata.js";
import {
  applyEmulationToDcrMetadata,
  resolveEmulatedMcpVersion,
  resolveEmulatedScopeValue,
  resolveEmulatedTokenAuthMethod,
  shouldSendResourceIndicator,
} from "./shared/emulation.js";
import { discoverOAuthProtectedResourceMetadata } from "../browser-auth.js";

export type { OAuthFlowStep, OAuthFlowState };
export { EMPTY_OAUTH_FLOW_STATE };

// Configuration for creating the state machine (2026-07-28 specific)
export interface DebugOAuthStateMachineConfig
  extends BaseOAuthStateMachineConfig {
  registrationStrategy?: RegistrationStrategy2026_07_28; // cimd | dcr | preregistered
}


// Sequence-diagram previews must show the resource value the flow actually
// sends (the decision persisted at PRM discovery), not the raw server URL.
const previewResourceValue = (
  flowState: OAuthFlowState,
): string | undefined => resolveFlowResourceValue(flowState);

// SEP-2350 (display half): the authorization step shows the scopes requested,
// any scopes challenged by a later 403 insufficient_scope, and their union —
// the set a step-up re-authorization would request. The runtime step-up loop
// itself is a separate track (2R-stepup); this only visualizes the union.
function buildScopeUnionDetails(
  flowState: OAuthFlowState,
): Array<{ label: string; value: any }> {
  const requested = flowState.requestedScopes ?? [];
  const challenged = flowState.challengedScopes ?? [];
  const rows: Array<{ label: string; value: any }> = [];
  if (requested.length > 0) {
    rows.push({ label: "requested scopes", value: requested.join(" ") });
  }
  if (challenged.length > 0) {
    const union = computeScopeUnion(requested, challenged);
    rows.push({ label: "challenged scopes", value: challenged.join(" ") });
    rows.push({ label: "scope union", value: union.join(" ") });
  }
  return rows;
}

// SEP-2352 (display half): show the exact issuer the client credentials are
// bound to (the issuer recorded at discovery, which the RFC 8414 §3.3 check
// proved equals the AS URL). The storage-write half — keying persisted
// credentials by issuer and refusing cross-issuer reuse — is a separate track
// (2R-store).
function buildIssuerBindingDetails(
  flowState: OAuthFlowState,
): Array<{ label: string; value: any }> {
  const issuer =
    flowState.recordedIssuer ?? flowState.authorizationServerMetadata?.issuer;
  return issuer ? [{ label: "bound to issuer", value: issuer }] : [];
}

/**
 * Build the sequence of actions for the 2026-07-28 OAuth flow
 * This function creates the visual representation of the OAuth flow steps
 * that will be displayed in the sequence diagram.
 */
export function buildActions_2026_07_28(
  flowState: OAuthFlowState,
  registrationStrategy: "cimd" | "dcr" | "preregistered"
): DiagramAction[] {
  return buildOAuthSequenceDiagramActions(flowState, registrationStrategy, {
    protocolVersion: "2026-07-28",
    includesProtectedResourceMetadata: true,
    // Stateless era: the probe is a real call, not an `initialize` handshake.
    initialMcpMethod: "tools/list",
    authorizationServerMetadata: {
      label: "GET Authorization server metadata endpoint",
      description:
        "Try OAuth path insertion, OIDC path insertion, OIDC path appending",
    },
    pkce: {
      label: "Generate PKCE (REQUIRED)\nInclude resource parameter",
      description:
        "Client generates code verifier and challenge (REQUIRED), includes resource parameter",
    },
    resourceValue: previewResourceValue,
    dcrNotes: [
      {
        label: "Deprecated",
        value:
          "DCR is deprecated in 2026-07-28 (PR #2858). Prefer CIMD " +
          "or a pre-registered client; DCR remains a compatibility " +
          "fallback for authorization servers without CIMD support.",
      },
    ],
    clientCredentialsExtras: buildIssuerBindingDetails,
    authorizationRequestExtras: buildScopeUnionDetails,
  });
}

// Helper: Build authorization server metadata URLs to try (RFC 8414 + OIDC Discovery)
// 2026-07-28 spec: Path insertion first, then path appending (NO root fallback for paths)
function buildAuthServerMetadataUrls(authServerUrl: string): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  if (url.pathname === "/" || url.pathname === "") {
    // Root path - standard endpoints
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString()
    );
    urls.push(
      new URL("/.well-known/openid-configuration", url.origin).toString()
    );
  } else {
    // Path-aware discovery
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

    // 2026-07-28 spec: OAuth path insertion, OIDC path insertion, OIDC path appending
    // Key difference: NO root fallback
    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin
      ).toString()
    );
    urls.push(
      new URL(
        `/.well-known/openid-configuration${pathname}`,
        url.origin
      ).toString()
    );
    urls.push(
      new URL(
        `${pathname}/.well-known/openid-configuration`,
        url.origin
      ).toString()
    );
  }

  return urls;
}

export type AuthorizationResponseIssuerCheck =
  /** `warning` is set when a mismatch was found but the era does not enforce it. */
  | { ok: true; warning?: string }
  | { ok: false; reason: string };

/**
 * Render a callback-supplied value inside a diagnostic. Line-breaking
 * characters are flattened so a hostile `iss` cannot forge additional message
 * lines, and the value is capped so it cannot crowd out the diagnostic around
 * it. C0 and DEL are not sufficient on their own: NEL (U+0085) and the Unicode
 * LINE/PARAGRAPH SEPARATORs (U+2028/U+2029) also break lines when a diagnostic
 * is rendered, so they are flattened too.
 */
function quoteUntrusted(value: string): string {
  // eslint-disable-next-line no-control-regex
  const flattened = value
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ")
    .trim();
  const capped =
    flattened.length > 256 ? `${flattened.slice(0, 256)}…` : flattened;
  return `\`${capped}\``;
}

// True when `advertised` is the origin root or a path-prefix ancestor of
// `requested` on the SAME origin (scheme + host + port). Segment-aware:
// /resources is an ancestor of /resources/res_x but not of /resources-evil.
// A query or fragment on either side disqualifies the relaxation outright —
// RFC 8414 §2 forbids both in an issuer identifier, and this toggle is
// documented to relax a PATH difference and nothing else.
// Mirrors the XAA debugger's isOriginPrefix (server/services/xaa-discovery.ts).
function isOriginPrefixIssuer(advertised: string, requested: string): boolean {
  let adv: URL;
  let req: URL;
  try {
    adv = new URL(advertised);
    req = new URL(requested);
  } catch {
    return false;
  }
  if (adv.origin !== req.origin) return false;
  if (adv.search || adv.hash || req.search || req.hash) return false;
  const strip = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
  const advPath = strip(adv.pathname);
  const reqPath = strip(req.pathname);
  if (advPath === reqPath) return false;
  return advPath === "" || advPath === "/"
    ? reqPath.length > 0
    : reqPath.startsWith(`${advPath}/`);
}

function isSameOriginUrl(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// An endpoint that receives credentials must sit on the advertised issuer's own
// origin. Absent is fine — there is nothing to bind, and the required-field
// checks reject a missing token_endpoint on their own. Anything PRESENT but not
// a parseable same-origin string counts as escaping: a non-string value would
// otherwise skip this gate silently (`typeof x === "string"` is false, so a
// naive check reads it as "does not escape") and surface only much later, after
// dynamic registration and the authorization redirect have already run.
function endpointEscapesIssuerOrigin(
  endpoint: unknown,
  issuer: string
): boolean {
  if (endpoint === undefined || endpoint === null) return false;
  if (typeof endpoint !== "string") return true;
  return !isSameOriginUrl(endpoint, issuer);
}

function describeEndpoint(endpoint: unknown): string {
  return typeof endpoint === "string" ? `"${endpoint}"` : "a non-string value";
}

export interface PathScopedIssuerVerdict {
  /** True when the per-server opt-in accepts this issuer mismatch. */
  accepted: boolean;
  /**
   * Diagnostic appended to the RFC 8414 §3.3 rejection, naming why the
   * relaxation did not apply. Empty for an ordinary mismatch with nothing
   * path-scoped about it.
   */
  hint: string;
}

/**
 * Decide whether an advertised `issuer` that differs from the URL discovery
 * started from is the multi-tenant, path-scoped shape the per-server
 * "Path-scoped authorization server" opt-in accepts — issuer at the origin
 * root, endpoints scoped under a path (e.g. Scalekit's `/resources/res_x`).
 *
 * Pure and total: never throws, never fetches, so the caller owns what a
 * rejection does. With the opt-in off every mismatch is rejected, which is the
 * strict RFC 8414 §3.3 behavior.
 *
 * Two rules hold even under the opt-in. The advertised issuer must be a
 * same-origin path-prefix ancestor (segment-aware, no query or fragment), and
 * the token and registration endpoints must stay on that issuer's own origin.
 * Without the second rule a same-origin tenant — exactly the party this feature
 * extends trust to — could advertise the origin-root issuer to pass the prefix
 * check while pointing `token_endpoint` at an arbitrary public host,
 * redirecting the client secret and authorization code off-origin.
 */
export function evaluatePathScopedIssuer(input: {
  advertisedIssuer: string;
  discoveryUrl: string;
  tokenEndpoint: unknown;
  registrationEndpoint: unknown;
  allowPathScopedIssuer: boolean;
}): PathScopedIssuerVerdict {
  const {
    advertisedIssuer,
    discoveryUrl,
    tokenEndpoint,
    registrationEndpoint,
    allowPathScopedIssuer,
  } = input;

  const originPrefix = isOriginPrefixIssuer(advertisedIssuer, discoveryUrl);
  const optIn = allowPathScopedIssuer && originPrefix;
  const tokenEscapes =
    optIn && endpointEscapesIssuerOrigin(tokenEndpoint, advertisedIssuer);
  const registrationEscapes =
    optIn &&
    endpointEscapesIssuerOrigin(registrationEndpoint, advertisedIssuer);

  if (optIn && !tokenEscapes && !registrationEscapes) {
    return { accepted: true, hint: "" };
  }

  const hint = tokenEscapes
    ? ` The path-scoped authorization server's token endpoint (${describeEndpoint(tokenEndpoint)}) is not on the same origin as its issuer ("${advertisedIssuer}"); refusing to send credentials off-origin.`
    : registrationEscapes
      ? ` The path-scoped authorization server's registration endpoint (${describeEndpoint(registrationEndpoint)}) is not on the same origin as its issuer ("${advertisedIssuer}"); refusing dynamic registration off-origin.`
      : originPrefix
        ? ' The advertised issuer is the same-origin root of the discovery URL — a multi-tenant, path-scoped authorization server. Enable "Path-scoped authorization server" in the server\'s OAuth configuration (Advanced settings) to allow this.'
        : "";
  return { accepted: false, hint };
}

/**
 * RFC 9207 authorization-response `iss` validation — a 2026-07-28 requirement.
 * Four rows:
 *   1. `iss` present and equals the recorded issuer            → ok
 *   2. `iss` present and differs                               → reject
 *   3. `iss` absent but the AS advertised
 *      `authorization_response_iss_parameter_supported: true`  → reject
 *   4. `iss` absent and not advertised                         → ok
 * A present-but-not-advertised `iss` is still validated (rows 1/2): if the AS
 * sends one, it must be correct. Comparison is exact — no normalization, same
 * discipline as the RFC 8414 §3.3 issuer check. On a mismatch the caller emits
 * a fixed diagnostic and MUST NOT surface any server-supplied `error*` callback
 * parameters.
 *
 * Row 2 names both issuers, because an exact comparison fails on differences
 * too small to see (trailing slash, scheme, port) and the mismatch is otherwise
 * undiagnosable — the gate returns before anything reaches the OAuth trace. The
 * RFC 9207 prohibition covers `error`/`error_description`, which carry AS-authored
 * prose; `iss` is the compared value itself, and quoting it is what makes the
 * rejection actionable. It is still attacker-controlled, hence `quoteUntrusted`.
 *
 * `enforcePresentIssMismatch` scopes row 2 to the era that actually mandates it.
 * SEP-2468 introduces `MUST validate a present iss` in the 2026-07-28 draft;
 * 2025-11-25 and earlier never mention `iss`, so a caller on those versions
 * passes `false` to downgrade row 2 to a `warning` and let the flow continue.
 * Defaults to enforcing: an omitted flag must fail closed, and the value that
 * carries the era lives with the caller, not here.
 *
 * "Absent" means `undefined`, `null`, or the empty string. `null` is what a
 * callback boundary produces when the param is missing (`URLSearchParams.get`),
 * so it MUST land in rows 3/4, never in the present-`iss` comparison — treating
 * it as present turns every spec-conformant AS that simply omits `iss` into a
 * hard mismatch (and `quoteUntrusted(null)` crashes). An empty `iss=` is
 * likewise treated as absent rather than compared: RFC 9207 gives the value
 * issuer-URL syntax, so an empty one carries no issuer claim to validate — but
 * it still fails closed via row 3 whenever the AS advertised iss support.
 */
export function validateAuthorizationResponseIssuer(input: {
  recordedIssuer: string | undefined;
  returnedIss: string | null | undefined;
  issParameterSupported: boolean | undefined;
  enforcePresentIssMismatch?: boolean;
}): AuthorizationResponseIssuerCheck {
  const {
    recordedIssuer,
    returnedIss,
    issParameterSupported,
    enforcePresentIssMismatch = true,
  } = input;

  if (returnedIss != null && returnedIss !== "") {
    if (recordedIssuer !== undefined && returnedIss !== recordedIssuer) {
      const mismatch =
        "Authorization response `iss` does not match the issuer this flow " +
        "started with. Recorded from authorization-server metadata: " +
        `${quoteUntrusted(recordedIssuer)}; returned on the callback: ` +
        `${quoteUntrusted(returnedIss)}.`;
      if (!enforcePresentIssMismatch) {
        return {
          ok: true,
          warning:
            `${mismatch} This protocol version does not require RFC 9207 ` +
            "issuer validation, so the flow continues; on 2026-07-28 this " +
            "stops the flow before the authorization code is redeemed.",
        };
      }
      return {
        ok: false,
        reason:
          `${mismatch} Refusing to exchange the authorization code; not ` +
          "displaying any server-supplied error parameters (RFC 9207).",
      };
    }
    return { ok: true };
  }

  if (issParameterSupported === true) {
    return {
      ok: false,
      reason:
        "Authorization server advertised " +
        "`authorization_response_iss_parameter_supported: true` but the " +
        "callback did not include an `iss` parameter (RFC 9207 requires it).",
    };
  }

  return { ok: true };
}

// Factory function to create the 2026-07-28 state machine
export const createDebugOAuthStateMachine = (
  config: DebugOAuthStateMachineConfig
): OAuthStateMachine => {
  const {
    state: initialState,
    getState,
    updateState,
    serverUrl,
    serverName,
    redirectUrl,
    requestExecutor,
    scheduleAutoAdvance,
    loadPreregisteredCredentials,
    dynamicRegistration,
    clientIdMetadataUrl,
    customScopes,
    customHeaders,
    resourceMetadataUrl: overrideResourceMetadataUrl,
    authMode,
    hasClientSecret = false,
    strictConformance = false,
    allowPathScopedIssuer = false,
    resourceIndicatorEnforcement = "warn",
    requiredMetadataEnforcement = "reject",
    registrationStrategy = "cimd", // Default to CIMD for 2026-07-28
    emulation,
  } = config;

  const redirectUri = redirectUrl;
  // 2026-07-28 is stateless: there is no `initialize` handshake. The probe and
  // token-verification steps issue a stateless `tools/list`
  // (buildStatelessVerifyRequestBody) carrying the `_meta` envelope; this
  // value drives both the `MCP-Protocol-Version` header and the `_meta`
  // version for those requests — an emulated pinned client pins both.
  const statelessProtocolVersion = resolveEmulatedMcpVersion(
    emulation,
    "2026-07-28"
  );
  const sendResource = shouldSendResourceIndicator(emulation);
  const dynamicRegistrationDefaults = applyEmulationToDcrMetadata(
    dynamicRegistration ?? {},
    emulation
  );
  let cimdClientId = clientIdMetadataUrl ?? "";

  if (
    registrationStrategy === "dcr" &&
    !dynamicRegistrationDefaults.client_name
  ) {
    throw new Error("Dynamic registration metadata must include client_name");
  }

  if (registrationStrategy === "cimd" && !cimdClientId) {
    throw new Error(
      "Client ID metadata URL is required for CIMD registration",
    );
  }

  if (registrationStrategy === "cimd") {
    cimdClientId = validateClientIdMetadataUrl(cimdClientId);
  }

  // Helper to get current state (use getState if provided, otherwise use initial state)
  const getCurrentState = () => (getState ? getState() : initialState);

  // The resource indicator is decided once at PRM discovery and persisted as
  // state.resourceIndicator (see resource-policy.ts). Reading through this
  // helper keeps every request site — authorization URL, token body, token
  // POST — on the identical value, and re-evaluates lazily for flows seeded
  // past the discovery step.
  const resolveResourceParameter = (): string =>
    resolveFlowResourceValue(getCurrentState(), serverUrl);

  const executeRequest = (url: string, options: RequestInit = {}) =>
    requestExecutor({
      url,
      method: options.method || "GET",
      headers: normalizeHeaders(options.headers as HeadersInit | undefined),
      body: options.body as any,
    });

  const resolvePreregisteredClientAuth = (clientSecret?: string) => {
    const result = resolvePreregisteredClientAuthMethod({
      authorizationServerMetadata: getCurrentState()
        .authorizationServerMetadata as Record<string, unknown> | undefined,
      hasClientSecret: Boolean(clientSecret || hasClientSecret),
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    return result.method;
  };

  const loadFallbackPreregisteredClient = async (note: string) => {
    const { clientId, clientSecret } =
      (await loadPreregisteredCredentials?.({
        serverName,
        serverUrl,
      })) ?? {};

    if (!clientId) {
      return undefined;
    }

    const tokenEndpointAuthMethod =
      resolvePreregisteredClientAuth(clientSecret);
    const preregInfo: Record<string, any> = {
      "Client ID": clientId,
      "Client Secret": clientSecret || hasClientSecret
        ? "Configured"
        : "Not provided (public client)",
      "Token Auth Method": tokenEndpointAuthMethod,
      Note: note,
    };

    return {
      clientId,
      clientSecret: clientSecret || undefined,
      tokenEndpointAuthMethod,
      infoLogs: addInfoLog(
        getCurrentState(),
        "received_client_credentials",
        "preregistered-fallback",
        "Pre-registered Client",
        preregInfo,
      ),
    };
  };

  // Create machine object that can reference itself
  const machine: OAuthStateMachine = {
    state: initialState,
    updateState,

    // Proceed to next step in the flow (matches SDK's actual approach)
    proceedToNextStep: async () => {
      const state = getCurrentState();

      updateState({ isInitiatingAuth: true });

      const autoAdvance = (delayMs: number) => {
        scheduleAutoAdvance?.(() => {
          void machine.proceedToNextStep();
        }, delayMs);
      };

      try {
        switch (state.currentStep) {
          case "idle": {
            // Step 1: Make initial MCP request without token
            const initialRequestHeaders = mergeHeaders(customHeaders, {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              // 2026-07-28 stateless probe headers — no initialize handshake.
              // Mcp-Name is omitted: tools/list takes no name argument.
              "MCP-Protocol-Version": statelessProtocolVersion,
              "Mcp-Method": "tools/list",
            });
            const probeRequestBody = buildStatelessVerifyRequestBody({
              protocolVersion: statelessProtocolVersion,
              authMode,
              clientName: "MCPJam Inspector",
              clientVersion: "1.0.0",
              id: 1,
            });

            const initialRequest = {
              method: "POST",
              url: serverUrl,
              headers: initialRequestHeaders,
              body: probeRequestBody,
            };

            // Update state with the request
            updateState({
              currentStep: "request_without_token",
              serverUrl,
              lastRequest: initialRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_without_token",
                  timestamp: Date.now(),
                  request: initialRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            autoAdvance(50);
            return;
          }

          case "request_without_token":
            // Step 2: Request MCP server and expect 401 Unauthorized via backend proxy
            if (!state.serverUrl) {
              throw new Error("No server URL available");
            }

            try {
              // Use backend proxy to bypass CORS and capture all headers
              const response = await executeRequest(state.serverUrl, {
                method: "POST",
                headers: mergeHeaders(customHeaders, {
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  "MCP-Protocol-Version": statelessProtocolVersion,
                  "Mcp-Method": "tools/list",
                }),
                body: JSON.stringify(
                  buildStatelessVerifyRequestBody({
                    protocolVersion: statelessProtocolVersion,
                    authMode,
                    clientName: "MCPJam Inspector",
                    clientVersion: "1.0.0",
                    id: 1,
                  }),
                ),
              });

              // Capture response data for all status codes
              const responseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response and calculate duration
              const updatedHistory = [...(state.httpHistory || [])];
              if (updatedHistory.length > 0) {
                const lastEntry = updatedHistory[updatedHistory.length - 1];
                lastEntry.response = responseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              const probe = classifyUnauthenticatedProbe({
                status: response.status,
                statusText: response.statusText,
                wwwAuthenticateHeader: response.headers["www-authenticate"],
                serverMessage: response.body?.error?.message,
              });

              if (probe.kind === "challenged") {
                // The server issued an auth challenge: a 401, or a 403 that still
                // carried a WWW-Authenticate Bearer challenge.
                const wwwAuthenticateHeader =
                  response.headers["www-authenticate"];
                const challengeParams = parseBearerAuthenticateParameters(
                  wwwAuthenticateHeader,
                );
                const challengedScopes = parseScopeString(
                  challengeParams.scope,
                );

                // Add info log for WWW-Authenticate header
                let infoLogs = wwwAuthenticateHeader
                  ? addInfoLog(
                      state,
                      "received_401_unauthorized",
                      "www-authenticate",
                      "WWW-Authenticate Header",
                      {
                        header: wwwAuthenticateHeader,
                        ...(challengedScopes && challengedScopes.length > 0
                          ? { scope: challengedScopes.join(" ") }
                          : {}),
                        "Received from": state.serverUrl || "Unknown",
                      }
                    )
                  : state.infoLogs;

                if (!probe.specCompliant) {
                  infoLogs = addChallengeStatusWarning(
                    state,
                    infoLogs,
                    "received_401_unauthorized",
                    responseData,
                  );
                }

                updateState({
                  currentStep: "received_401_unauthorized",
                  wwwAuthenticateHeader: wwwAuthenticateHeader || undefined,
                  challengedScopes,
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                  infoLogs,
                  isInitiatingAuth: false,
                });
              } else if (probe.kind === "anonymous_allowed") {
                // Server allows anonymous access - try proactive OAuth discovery
                // Add info log explaining optional auth
                const infoLogs = addInfoLog(
                  state,
                  "received_401_unauthorized",
                  "optional-auth",
                  "Optional Authentication Detected",
                  {
                    message: "Server allows anonymous access",
                    note: "Proceeding with OAuth discovery for authenticated features",
                  }
                );

                updateState({
                  currentStep: "received_401_unauthorized", // Reuse the same flow
                  wwwAuthenticateHeader: undefined, // No WWW-Authenticate header
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                  infoLogs,
                  isInitiatingAuth: false,
                });
              } else {
                // Unexpected status code - capture response and throw error
                updateState({
                  lastResponse: responseData,
                  httpHistory: updatedHistory,
                });
                throw new UnexpectedProbeStatusError(
                  probe.message,
                  response.status
                );
              }
            } catch (error) {
              // The server replied; relabelling that as a request failure hides
              // what it actually said.
              if (error instanceof UnexpectedProbeStatusError) {
                throw error;
              }
              throw new Error(
                `Failed to request MCP server: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            break;

          case "received_401_unauthorized": {
            // Step 3: Extract resource metadata URL and prepare request
            const challengeParams = parseBearerAuthenticateParameters(
              state.wwwAuthenticateHeader,
            );
            // SEP-2350: a caller-supplied PRM URL (the step-up challenge's
            // `resource_metadata` hint) wins over the value re-derived from the
            // fresh `WWW-Authenticate` header, so a server that points its
            // metadata elsewhere is honored on re-authorization. Absent an
            // override this is exactly today's behavior.
            let extractedResourceMetadataUrl =
              overrideResourceMetadataUrl || challengeParams.resource_metadata;

            // Fallback to building the URL if not found in header
            if (!extractedResourceMetadataUrl && state.serverUrl) {
              extractedResourceMetadataUrl = buildResourceMetadataUrl(
                state.serverUrl
              );
            }

            if (!extractedResourceMetadataUrl) {
              throw new Error("Could not determine resource metadata URL");
            }

            const resourceMetadataRequest = {
              method: "GET",
              url: extractedResourceMetadataUrl,
              headers: mergeHeaders(customHeaders, {}),
            };

            // Update state with the URL and request
            updateState({
              currentStep: "request_resource_metadata",
              resourceMetadataUrl: extractedResourceMetadataUrl,
              lastRequest: resourceMetadataRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_resource_metadata",
                  timestamp: Date.now(),
                  request: resourceMetadataRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            autoAdvance(50);
            return;
          }

          case "request_resource_metadata":
            // Step 2: Fetch and parse resource metadata using official SDK helper
            if (!state.serverUrl) {
              throw new Error("No server URL available");
            }

            const historyWithoutPlaceholder = [...(state.httpHistory || [])];
            let pendingHistoryEntry =
              historyWithoutPlaceholder.length > 0 &&
              historyWithoutPlaceholder[historyWithoutPlaceholder.length - 1]
                ?.step === "request_resource_metadata" &&
              !historyWithoutPlaceholder[historyWithoutPlaceholder.length - 1]
                ?.response
                ? historyWithoutPlaceholder.pop()
                : undefined;

            const attempts: HttpHistoryEntry[] = [];

            const loggingFetch: typeof fetch = async (url, init = {}) => {
              const requestUrl = typeof url === "string" ? url : url.toString();
              // Protected resource metadata discovery can use an explicit
              // resourceMetadataUrl from WWW-Authenticate, which may hop
              // cross-origin. Strip MCP-server Authorization headers when it does.
              const mergedHeaders = mergeHeadersForResourceMetadataRequest(
                serverUrl,
                requestUrl,
                customHeaders,
                normalizeHeaders(init.headers as HeadersInit | undefined)
              );

              const historyEntry: HttpHistoryEntry = pendingHistoryEntry
                ? {
                    ...pendingHistoryEntry,
                    timestamp: Date.now(),
                    request: {
                      method: init.method || "GET",
                      url: requestUrl,
                      headers: mergedHeaders,
                      body: init.body,
                    },
                  }
                : {
                    step: "request_resource_metadata",
                    timestamp: Date.now(),
                    request: {
                      method: init.method || "GET",
                      url: requestUrl,
                      headers: mergedHeaders,
                      body: init.body,
                    },
                  };

              pendingHistoryEntry = undefined;
              attempts.push(historyEntry);

              try {
                const response = await executeRequest(requestUrl, {
                  method: init.method || "GET",
                  headers: mergedHeaders,
                  body: init.body as any,
                });

                historyEntry.response = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                  body: response.body,
                };
                historyEntry.duration = Date.now() - historyEntry.timestamp;

                const responseInit: ResponseInit = {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                };
                const responseBody =
                  typeof response.body === "string"
                    ? response.body
                    : JSON.stringify(response.body ?? {});
                return new Response(responseBody, responseInit);
              } catch (fetchError) {
                historyEntry.error = toLogErrorDetails(fetchError);
                historyEntry.duration = Date.now() - historyEntry.timestamp;
                throw fetchError;
              }
            };

            try {
              // Pass an explicit metadata URL to discovery ONLY when it was
              // EXPLICITLY sourced — a SEP-2350 caller override, OR the fresh
              // `WWW-Authenticate` header's own `resource_metadata` param — not
              // when it was DERIVED from the server URL. A `WWW-Authenticate`
              // header can be present yet omit `resource_metadata`, in which
              // case `state.resourceMetadataUrl` holds the derived well-known
              // URL; passing that as an explicit option would defeat discovery's
              // well-known + fallback behavior, so leave `metadataOptions`
              // undefined for a derived URL.
              const explicitResourceMetadataUrl =
                overrideResourceMetadataUrl ||
                parseBearerAuthenticateParameters(state.wwwAuthenticateHeader)
                  .resource_metadata;
              const metadataOptions =
                explicitResourceMetadataUrl && state.resourceMetadataUrl
                  ? { resourceMetadataUrl: state.resourceMetadataUrl }
                  : undefined;

              const resourceMetadata =
                await discoverOAuthProtectedResourceMetadata(
                  state.serverUrl,
                  metadataOptions,
                  loggingFetch
                );

              const finalHistory = [...historyWithoutPlaceholder, ...attempts];

              const lastAttempt = attempts[attempts.length - 1];
              // RFC 9728 `authorization_servers` is where the resource names
              // who may issue tokens for it. Substituting the MCP server's own
              // URL invents an authorization server the resource never named,
              // and does it invisibly — so under the current profile the
              // substitution is an error, not a fallback.
              const authorizationServerSelection =
                selectAuthorizationServerFromResourceMetadata({
                  authorizationServers: resourceMetadata.authorization_servers,
                  fallbackServerUrl: serverUrl,
                  protocolVersion: "2026-07-28",
                });
              const authorizationServerUrl =
                authorizationServerSelection.authorizationServerUrl;

              if (
                authorizationServerSelection.error &&
                requiredMetadataEnforcement !== "observe"
              ) {
                updateState({
                  resourceMetadata,
                  resourceMetadataUrl:
                    lastAttempt?.request?.url || state.resourceMetadataUrl,
                  lastRequest: lastAttempt?.request,
                  lastResponse: lastAttempt?.response,
                  httpHistory: finalHistory,
                  error: authorizationServerSelection.error,
                  isInitiatingAuth: false,
                });
                return;
              }

              // The response card is the complete protected-resource metadata.
              // Keep existing logs only for distinct findings, such as a
              // resource identifier mismatch below.
              let infoLogs = state.infoLogs ?? [];

              // Only reachable under `"observe"`. The substitution is not a
              // silent fallback even there — the debugger's whole value is
              // showing that this server did not name an authorization server.
              if (authorizationServerSelection.error) {
                infoLogs = addInfoLog(
                  { ...getCurrentState(), infoLogs },
                  "received_resource_metadata",
                  "authorization-server-substituted",
                  "Derived: Authorization Server (not advertised)",
                  {
                    Finding: authorizationServerSelection.error,
                    "Using instead": authorizationServerUrl,
                  }
                );
              }

              // Resolve the resource indicator ONCE (rejecting/warning per
              // the surface's enforcement mode); every later request and
              // preview site reads state.resourceIndicator instead of
              // re-deriving it.
              const discoveryResource = resolveDiscoveryResourceIndicator({
                state,
                fallbackServerUrl: serverUrl,
                prmResource: resourceMetadata.resource,
                enforcement: resourceIndicatorEnforcement,
                infoLogs,
              });
              const resourceIndicator = discoveryResource.resourceIndicator;
              infoLogs = discoveryResource.infoLogs;

              updateState({
                currentStep: "received_resource_metadata",
                resourceMetadata,
                resourceIndicator,
                resourceMetadataUrl:
                  lastAttempt?.request?.url || state.resourceMetadataUrl,
                authorizationServerUrl,
                lastRequest: lastAttempt?.request,
                lastResponse: lastAttempt?.response,
                httpHistory: finalHistory,
                infoLogs,
                isInitiatingAuth: false,
              });
            } catch (error) {
              const updatedHistory = markLatestHttpEntryAsError(
                [...historyWithoutPlaceholder, ...attempts],
                toLogErrorDetails(error)
              );

              updateState({
                lastResponse: attempts[attempts.length - 1]?.response,
                httpHistory: updatedHistory,
              });

              throw new Error(
                `Failed to request resource metadata: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            break;

          case "received_resource_metadata":
            // Step 3: Request Authorization Server Metadata
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const authServerUrls = buildAuthServerMetadataUrls(
              state.authorizationServerUrl
            );

            const authServerRequest = {
              method: "GET",
              url: authServerUrls[0], // Show the first URL we'll try
              headers: mergeHeadersForAuthServer(customHeaders, {}),
            };

            // Update state with the request
            updateState({
              currentStep: "request_authorization_server_metadata",
              lastRequest: authServerRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "request_authorization_server_metadata",
                  timestamp: Date.now(),
                  request: authServerRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            autoAdvance(50);
            return;

          case "request_authorization_server_metadata":
            // Step 4: Fetch authorization server metadata (try multiple endpoints) via backend proxy
            if (!state.authorizationServerUrl) {
              throw new Error("No authorization server URL available");
            }

            const urlsToTry = buildAuthServerMetadataUrls(
              state.authorizationServerUrl
            );
            let authServerMetadata = null;
            let lastError = null;
            let finalResponseHeaders: Record<string, string> = {};
            let finalResponseData: any = null;

            for (const url of urlsToTry) {
              try {
                const requestHeaders = mergeHeadersForAuthServer(
                  customHeaders,
                  {}
                );

                // Update request URL as we try different endpoints
                const updatedHistoryForRetry = [...(state.httpHistory || [])];
                if (updatedHistoryForRetry.length > 0) {
                  updatedHistoryForRetry[
                    updatedHistoryForRetry.length - 1
                  ].request = {
                    method: "GET",
                    url: url,
                    headers: requestHeaders,
                  };
                }

                updateState({
                  lastRequest: {
                    method: "GET",
                    url: url,
                    headers: requestHeaders,
                  },
                  httpHistory: updatedHistoryForRetry,
                });

                // Use backend proxy to bypass CORS
                const response = await executeRequest(url, {
                  method: "GET",
                  headers: mergeHeadersForAuthServer(customHeaders, {}),
                });

                if (response.ok) {
                  authServerMetadata = response.body;
                  finalResponseHeaders = response.headers;
                  finalResponseData = response;

                  break;
                } else if (response.status >= 400 && response.status < 500) {
                  // Client error, try next URL
                  continue;
                } else {
                  // Server error, might be temporary
                  lastError = new Error(`HTTP ${response.status} from ${url}`);
                }
              } catch (error) {
                lastError = error;
                continue;
              }
            }

            if (!authServerMetadata || !finalResponseData) {
              throw new Error(
                `Could not discover authorization server metadata. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
              );
            }

            // Validate required AS metadata fields per RFC 8414
            if (!authServerMetadata.issuer) {
              throw new Error(
                AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER
              );
            }

            // RFC 8414 §3.3 (a 2026-07-28 MUST): the returned `issuer` MUST be
            // identical to the issuer identifier into which the well-known
            // string was inserted to build the metadata URL — i.e. the AS URL
            // the flow started discovery from. Exact string comparison, NO
            // normalization (a trailing-slash or case difference is a real
            // finding, not something to paper over). This binds the metadata
            // document to the issuer and is the anchor every later issuer check
            // (record_issuer, callback `iss`) trusts.
            // A same-origin path-prefix "mismatch" is the multi-tenant AS shape
            // (issuer at the origin root, endpoints scoped under a path). Only
            // the per-server "Path-scoped authorization server" opt-in accepts
            // it — mirroring the XAA debugger's toggle.
            if (authServerMetadata.issuer !== state.authorizationServerUrl) {
              const pathScoped = evaluatePathScopedIssuer({
                advertisedIssuer: authServerMetadata.issuer,
                discoveryUrl: state.authorizationServerUrl,
                tokenEndpoint: authServerMetadata.token_endpoint,
                registrationEndpoint: authServerMetadata.registration_endpoint,
                allowPathScopedIssuer,
              });
              if (!pathScoped.accepted) {
                throw new Error(
                  "Authorization server metadata `issuer` does not match the " +
                    "authorization server URL it was discovered from " +
                    `(expected "${state.authorizationServerUrl}", got ` +
                    `"${authServerMetadata.issuer}"). RFC 8414 §3.3 requires an ` +
                    "exact match; refusing to continue." +
                    pathScoped.hint
                );
              }
            }
            if (!authServerMetadata.authorization_endpoint) {
              throw new Error(
                "Authorization server metadata missing 'authorization_endpoint'"
              );
            }
            if (!authServerMetadata.token_endpoint) {
              throw new Error(
                "Authorization server metadata missing 'token_endpoint'"
              );
            }
            if (
              !authServerMetadata.response_types_supported?.includes("code")
            ) {
              throw new Error(
                "Authorization server does not support 'code' response type"
              );
            }

            const authServerResponseData = {
              status: finalResponseData.status,
              statusText: finalResponseData.statusText,
              headers: finalResponseHeaders,
              body: authServerMetadata,
            };

            // Update the last history entry with the response
            const updatedHistoryFinal = [...(state.httpHistory || [])];
            if (updatedHistoryFinal.length > 0) {
              const lastEntry =
                updatedHistoryFinal[updatedHistoryFinal.length - 1];
              lastEntry.response = authServerResponseData;
              lastEntry.duration =
                Date.now() - (lastEntry.timestamp || Date.now());
            }

            // Validate PKCE support (REQUIRED for 2026-07-28).
            //
            // The MCP client requirement is to VERIFY S256 support before
            // proceeding, so both shapes of failure — no advertised methods at
            // all, and a list that omits S256 — stop the flow. BOTH go through
            // the one enforcement branch below rather than one throwing here:
            // the debugger's whole purpose is showing what a nonconforming
            // server did, and "advertises no PKCE metadata" is precisely such a
            // server. Connect still fails closed; only `"observe"` continues.
            const supportedMethods =
              authServerMetadata.code_challenge_methods_supported || [];
            const pkceNonConformance = describePkceMetadataNonConformance(
              supportedMethods,
              "2026-07-28",
            );

            // The response card already shows the complete metadata document.
            // Keep only the CIMD decision, which is derived from an absent-or-
            // boolean field and therefore is not otherwise visible in raw JSON.
            const cimdSupported =
              typeof authServerMetadata.client_id_metadata_document_supported ===
              "boolean"
                ? authServerMetadata.client_id_metadata_document_supported
                : "false (not advertised, defaults to false per spec)";
            let infoLogs = addInfoLog(
              getCurrentState(),
              "received_authorization_server_metadata",
              "cimd-support",
              "Derived: CIMD Support",
              { "CIMD Supported": cimdSupported }
            );

            // Reaching here with an issuer that differs from the discovery URL
            // means the path-scoped opt-in accepted it — every other mismatch
            // threw above, so the inequality IS the acceptance signal.
            if (authServerMetadata.issuer !== state.authorizationServerUrl) {
              infoLogs = addInfoLog(
                { ...getCurrentState(), infoLogs },
                "received_authorization_server_metadata",
                "path-scoped-issuer",
                "Path-scoped authorization server",
                {
                  "Discovery URL": state.authorizationServerUrl,
                  "Advertised issuer": authServerMetadata.issuer,
                  Note:
                    "The advertised issuer is the same-origin root of the discovery URL. " +
                    'Accepted because "Path-scoped authorization server" is enabled for this server; ' +
                    "strict RFC 8414 §3.3 conformance requires an exact issuer match, and strict " +
                    "MCP clients may refuse to connect.",
                },
                { level: "warning" }
              );
            }

            if (pkceNonConformance) {
              // Fail closed unless the caller explicitly asked to observe a
              // nonconforming server. Continuing without S256 is a silent PKCE
              // downgrade, and the downgrade is invisible on the wire.
              if (strictConformance || requiredMetadataEnforcement !== "observe") {
                updateState({
                  lastResponse: authServerResponseData,
                  httpHistory: updatedHistoryFinal,
                  infoLogs,
                  error: pkceNonConformance,
                  isInitiatingAuth: false,
                });
                return;
              }

              console.warn(
                "Authorization server may not support S256 PKCE method. Supported methods:",
                supportedMethods
              );
              // Add warning to state but continue
              updateState({
                currentStep: "received_authorization_server_metadata",
                authorizationServerMetadata: authServerMetadata,
                lastResponse: authServerResponseData,
                httpHistory: updatedHistoryFinal,
                infoLogs,
                error:
                  "Warning: Authorization server may not support S256 PKCE method",
                isInitiatingAuth: false,
              });
            } else {
              updateState({
                currentStep: "received_authorization_server_metadata",
                authorizationServerMetadata: authServerMetadata,
                lastResponse: authServerResponseData,
                httpHistory: updatedHistoryFinal,
                infoLogs,
                isInitiatingAuth: false,
              });
            }
            break;

          case "received_authorization_server_metadata":
            // Step 5: Client Registration (CIMD > Pre-registered > DCR)
            if (!state.authorizationServerMetadata) {
              throw new Error("No authorization server metadata available");
            }

            // Check registration strategy - 2026-07-28 priority: CIMD > Pre-registered > DCR
            if (registrationStrategy === "cimd") {
              // Per spec: clients SHOULD check client_id_metadata_document_supported
              // before using CIMD. Fail early instead of redirecting to an AS that
              // will reject the URL-formatted client_id.
              if (
                state.authorizationServerMetadata
                  .client_id_metadata_document_supported !== true
              ) {
                updateState({
                  error:
                    "The authorization server does not support Client ID Metadata Documents " +
                    "(client_id_metadata_document_supported is not advertised in AS metadata). " +
                    "Try using 'dcr' or 'preregistered' registration strategy instead.",
                  isInitiatingAuth: false,
                });
                return;
              }

              // CIMD Step 1: Prepare client_id URL
              updateState({
                currentStep: "cimd_prepare",
                clientId: cimdClientId,
                isInitiatingAuth: false,
              });

              // Auto-proceed to next step
              autoAdvance(800);
              return;
            } else if (registrationStrategy === "preregistered") {
              // Skip DCR - use injected pre-registered client credentials
              const { clientId, clientSecret } =
                (await loadPreregisteredCredentials?.({
                  serverName,
                  serverUrl,
                })) ?? {};

              if (!clientId) {
                updateState({
                  error:
                    "Pre-registered client ID is required. Please configure OAuth credentials in the server settings.",
                  isInitiatingAuth: false,
                });
                return;
              }

              const tokenEndpointAuthMethod =
                resolvePreregisteredClientAuth(clientSecret);

              // Add info log for pre-registered client
              const preregInfo: Record<string, any> = {
                "Client ID": clientId,
                "Client Secret": clientSecret || hasClientSecret
                  ? "Configured"
                  : "Not provided (public client)",
                "Token Auth Method": tokenEndpointAuthMethod,
                Note: "Using pre-registered client credentials from server config (skipped DCR)",
              };

              const infoLogs = addInfoLog(
                getCurrentState(),
                "received_client_credentials",
                "dcr",
                "Pre-registered Client",
                preregInfo
              );

              updateState({
                currentStep: "received_client_credentials",
                clientId,
                clientSecret: clientSecret || undefined,
                tokenEndpointAuthMethod,
                infoLogs,
                isInitiatingAuth: false,
              });
            } else if (
              state.authorizationServerMetadata.registration_endpoint
            ) {
              // Dynamic Client Registration (DCR)
              // Prepare client metadata with scopes if available
              const scopesSupported =
                state.resourceMetadata?.scopes_supported ||
                state.authorizationServerMetadata.scopes_supported;
              const requestedScopeValue = resolveEmulatedScopeValue(emulation, {
                customScopes,
                challengedScopes: state.challengedScopes,
                supportedScopes: scopesSupported,
              });

              const registrationRequest = buildDynamicClientRegistrationRequest({
                registrationEndpoint:
                  state.authorizationServerMetadata.registration_endpoint,
                redirectUri,
                dynamicRegistrationDefaults: {
                  ...dynamicRegistrationDefaults,
                  // SEP-837 (2026-07-28 MUST): register an appropriate
                  // application_type so an OIDC-strict AS accepts loopback /
                  // custom-scheme redirects. Native for the local debugger
                  // redirect; an explicit caller value wins. Derive from the
                  // SAME effective redirect_uris the builder sends (a caller
                  // override wins there too), so a `web` redirect override can't
                  // ship alongside a `native` type.
                  application_type:
                    dynamicRegistrationDefaults.application_type ??
                    deriveApplicationType(
                      dynamicRegistrationDefaults.redirect_uris ?? [redirectUri],
                    ),
                },
                scope: requestedScopeValue,
                customHeaders,
              });

              // 2026-07-28 deprecates DCR as a registration mechanism
              // (PR #2858); surface a warning while still performing it, since
              // it stays a supported compatibility fallback.
              const dcrDeprecationLogs = addInfoLog(
                getCurrentState(),
                "request_client_registration",
                "dcr-deprecated",
                "DCR is deprecated in 2026-07-28",
                {
                  Note:
                    "Dynamic Client Registration (RFC 7591) is deprecated as a " +
                    "registration mechanism in 2026-07-28 (PR #2858). It remains " +
                    "a compatibility fallback; prefer CIMD or a pre-registered " +
                    "client where the authorization server supports it.",
                },
                { level: "warning" }
              );

              // Update state with the request
              updateState({
                currentStep: "request_client_registration",
                lastRequest: registrationRequest,
                lastResponse: undefined,
                infoLogs: dcrDeprecationLogs,
                httpHistory: [
                  ...(state.httpHistory || []),
                  {
                    step: "request_client_registration",
                    timestamp: Date.now(),
                    request: registrationRequest,
                  },
                ],
                isInitiatingAuth: false,
              });

              // Automatically proceed to make the actual request
              autoAdvance(50);
              return;
            } else {
              if (strictConformance) {
                updateState({
                  error:
                    "Authorization server metadata does not include a registration_endpoint required for DCR conformance.",
                  isInitiatingAuth: false,
                });
                return;
              }

              const fallbackClient =
                await loadFallbackPreregisteredClient(
                  "Authorization server did not advertise registration_endpoint; using pre-registered client credentials.",
                );

              if (!fallbackClient) {
                updateState({
                  error:
                    "Authorization server metadata does not include a registration_endpoint. Configure a pre-registered client or use a different registration strategy.",
                  isInitiatingAuth: false,
                });
                return;
              }

              updateState({
                currentStep: "received_client_credentials",
                clientId: fallbackClient.clientId,
                clientSecret: fallbackClient.clientSecret,
                tokenEndpointAuthMethod:
                  fallbackClient.tokenEndpointAuthMethod,
                infoLogs: fallbackClient.infoLogs,
                error: undefined,
                isInitiatingAuth: false,
              });
            }
            break;

          case "request_client_registration":
            // Step 6: Dynamic Client Registration (RFC 7591)
            if (!state.authorizationServerMetadata?.registration_endpoint) {
              throw new Error("No registration endpoint available");
            }

            if (!state.lastRequest?.body) {
              throw new Error("No client metadata in request");
            }

            {
              // Execute the exact request recorded in lastRequest so the
              // displayed request and the executed request cannot drift.
              const dcr = await executeDynamicClientRegistration({
                request: state.lastRequest,
                requestExecutor,
                httpHistory: state.httpHistory,
              });

              if (dcr.status !== "registered") {
                // Update state with error but continue with fallback
                updateState({
                  lastResponse: dcr.response,
                  httpHistory: dcr.httpHistory,
                  error: dcr.error,
                  isInitiatingAuth: false,
                });

                if (strictConformance) {
                  return;
                }

                const fallbackClient = await loadFallbackPreregisteredClient(
                  dcr.fallbackNote,
                );

                if (!fallbackClient) {
                  updateState({
                    error: dcr.errorWithFallbackHint,
                    isInitiatingAuth: false,
                  });
                  return;
                }

                updateState({
                  currentStep: "received_client_credentials",
                  clientId: fallbackClient.clientId,
                  clientSecret: fallbackClient.clientSecret,
                  tokenEndpointAuthMethod:
                    fallbackClient.tokenEndpointAuthMethod,
                  infoLogs: fallbackClient.infoLogs,
                  error: undefined,
                  isInitiatingAuth: false,
                });
                break;
              }

              // Registration successful.
              // RFC 7591: a successful (2xx) registration response MUST carry a
              // client_id. Without one there is no client identity to proceed
              // with, so reject regardless of strictConformance — accepting it
              // would carry an undefined clientId into the authorization leg.
              if (dcr.missingClientId) {
                updateState({
                  lastResponse: dcr.response,
                  httpHistory: dcr.httpHistory,
                  error:
                    "Dynamic Client Registration response is missing a client_id.",
                  isInitiatingAuth: false,
                });
                return;
              }

              const infoLogs = addInfoLog(
                getCurrentState(),
                "received_client_credentials",
                "dcr",
                "Dynamic Client Registration",
                dcr.infoLogData
              );

              updateState({
                currentStep: "received_client_credentials",
                clientId: dcr.credentials.clientId,
                clientSecret: dcr.credentials.clientSecret,
                tokenEndpointAuthMethod: normalizeRegisteredClientAuthMethod(
                  dcr.clientInfo,
                ),
                lastResponse: dcr.response,
                httpHistory: dcr.httpHistory,
                infoLogs,
                error: undefined,
                isInitiatingAuth: false,
              });
            }
            break;

          case "cimd_prepare":
            // CIMD Step 2: Simulate server detecting URL-formatted client_id and fetching metadata
            updateState({
              currentStep: "cimd_fetch_request",
              isInitiatingAuth: false,
            });

            // Auto-proceed to next step
            autoAdvance(800);
            return;

          case "cimd_fetch_request":
            // CIMD Step 3: Fetch the CIMD document ONCE and record it as the
            // response shown in the trace. The validation step reads this exact
            // recorded document rather than re-fetching, so the AS cannot serve
            // one document here and a different one at validation time.
            try {
              const cimdRequest = {
                method: "GET",
                url: cimdClientId,
                headers: normalizeHeaders(undefined),
              };
              // Capture request start BEFORE issuing the fetch so the trace
              // entry's timestamp reflects request start and carries the
              // round-trip duration, matching every other fetch step.
              const cimdRequestStart = Date.now();
              const cimdResponse = await executeRequest(cimdClientId, {
                method: "GET",
              });

              if (!cimdResponse.ok) {
                throw new Error(
                  `CIMD endpoint returned HTTP ${cimdResponse.status}`
                );
              }

              // Record the fetched document as lastResponse + a history entry so
              // the validation step (and the trace) reads exactly these bytes.
              const cimdResponseData = {
                status: cimdResponse.status,
                statusText: cimdResponse.statusText,
                headers: cimdResponse.headers,
                body: cimdResponse.body,
              };
              updateState({
                currentStep: "cimd_metadata_response",
                lastRequest: cimdRequest,
                lastResponse: cimdResponseData,
                httpHistory: [
                  ...(state.httpHistory || []),
                  {
                    step: "cimd_fetch_request",
                    timestamp: cimdRequestStart,
                    duration: Date.now() - cimdRequestStart,
                    request: cimdRequest,
                    response: cimdResponseData,
                  },
                ],
                isInitiatingAuth: false,
              });

              // Auto-proceed to validation step
              autoAdvance(800);
              return;
            } catch (error) {
              updateState({
                error:
                  `CIMD metadata fetch failed: ${error instanceof Error ? error.message : String(error)}. ` +
                  "Try using 'dcr' or 'preregistered' registration strategy instead.",
                isInitiatingAuth: false,
              });
              return;
            }

          case "cimd_metadata_response":
            // CIMD Step 4: Validate the metadata fetched in the previous step
            // (no re-fetch) and complete registration.
            try {
              const cimdDoc = state.lastResponse?.body;

              if (!cimdDoc || typeof cimdDoc !== "object") {
                throw new Error("CIMD metadata document was not available");
              }

              // Validate CIMD document
              if (cimdDoc.client_id !== cimdClientId) {
                throw new Error("CIMD client_id mismatch");
              }

              // Add info log for CIMD validation
              const cimdSupported = (state.authorizationServerMetadata as any)
                ?.client_id_metadata_document_supported;

              const cimdInfo: Record<string, any> = {
                "Client ID": cimdClientId,
                "Registration Method": "Client ID Metadata Document (CIMD)",
                "Client Name": cimdDoc.client_name || "MCPJam",
                "Redirect URIs": cimdDoc.redirect_uris || [],
                "Token Auth Method":
                  cimdDoc.token_endpoint_auth_method || "none",
                Validation: "✓ Metadata fetched and validated",
                Note: "Server fetched and validated client metadata from URL",
              };

              if (cimdSupported) {
                cimdInfo["Server Support"] =
                  "✓ Advertised in metadata (client_id_metadata_document_supported: true)";
              } else {
                cimdInfo["Server Support"] =
                  "⚠ Not advertised (attempting anyway)";
              }

              const infoLogs = addInfoLog(
                getCurrentState(),
                "received_client_credentials",
                "cimd",
                "Client ID Metadata Document",
                cimdInfo
              );

              updateState({
                currentStep: "received_client_credentials",
                clientId: cimdClientId,
                clientSecret: undefined, // Public client with CIMD
                tokenEndpointAuthMethod: "none",
                infoLogs,
                isInitiatingAuth: false,
              });
            } catch (error) {
              updateState({
                error:
                  `CIMD validation failed: ${error instanceof Error ? error.message : String(error)}. ` +
                  "Try using 'dcr' or 'preregistered' registration strategy instead.",
                isInitiatingAuth: false,
              });
              return;
            }
            break;

          case "received_client_credentials":
            // Step 7: Generate PKCE parameters

            // Generate PKCE parameters (simplified for demo)
            const codeVerifier = generateRandomString(43);
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            // Add info log for PKCE parameters
            const pkceInfoLogs = addInfoLog(
              getCurrentState(),
              "generate_pkce_parameters",
              "pkce-generation",
              "Generate PKCE Parameters",
              {
                code_challenge: codeChallenge,
                method: "S256",
                ...(sendResource
                  ? { resource: resolveResourceParameter() }
                  : {
                      resource:
                        "(omitted — emulated client does not send RFC 8707 resource)",
                    }),
              }
            );

            updateState({
              currentStep: "generate_pkce_parameters",
              codeVerifier,
              codeChallenge,
              codeChallengeMethod: "S256",
              ...(sendResource ? {} : { resourceIndicatorSuppressed: true }),
              state: generateRandomString(16),
              // RFC 9207: record the issuer the flow is anchored to at the same
              // moment we mint the PKCE verifier/state. The exact-match check at
              // discovery already proved `issuer === authorizationServerUrl`, so
              // recording the metadata `issuer` binds the returned `iss` to the
              // exact string the flow began with.
              recordedIssuer: getCurrentState().authorizationServerMetadata
                ?.issuer,
              infoLogs: pkceInfoLogs,
              isInitiatingAuth: false,
            });
            break;

          case "generate_pkce_parameters":
            // Step 8: Build authorization URL
            if (
              !state.authorizationServerMetadata?.authorization_endpoint ||
              !state.clientId
            ) {
              throw new Error("Missing authorization endpoint or client ID");
            }

            const authUrl = new URL(
              state.authorizationServerMetadata.authorization_endpoint
            );
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("client_id", state.clientId);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set(
              "code_challenge",
              state.codeChallenge || ""
            );
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("state", state.state || "");
            if (sendResource) {
              authUrl.searchParams.set("resource", resolveResourceParameter());
            }

            const requestedScopeValue = resolveEmulatedScopeValue(emulation, {
              customScopes,
              challengedScopes: state.challengedScopes,
              supportedScopes:
                state.resourceMetadata?.scopes_supported ||
                state.authorizationServerMetadata.scopes_supported,
            });
            if (requestedScopeValue) {
              authUrl.searchParams.set("scope", requestedScopeValue);
            }

            // Add info log for Authorization URL
            const authUrlInfoLogs = addInfoLog(
              getCurrentState(),
              "authorization_request",
              "auth-url",
              "Authorization URL",
              {
                url: authUrl.toString(),
              }
            );

            updateState({
              currentStep: "authorization_request",
              authorizationUrl: authUrl.toString(),
              authorizationCode: undefined, // Clear any old authorization code
              accessToken: undefined, // Clear any old tokens
              refreshToken: undefined,
              tokenType: undefined,
              expiresIn: undefined,
              // Retain the requested scope set (SEP-2350 display half) so a later
              // step-up challenge can be shown as prior ∪ challenged scopes.
              requestedScopes: requestedScopeValue
                ? requestedScopeValue.split(/\s+/).filter(Boolean)
                : undefined,
              infoLogs: authUrlInfoLogs,
              isInitiatingAuth: false,
            });
            break;

          case "authorization_request":
            // Step 9: Authorization URL is ready - user should open it in browser

            // Move to the next step where user can enter the authorization code
            updateState({
              currentStep: "received_authorization_code",
              isInitiatingAuth: false,
            });
            break;

          case "received_authorization_code": {
            // Step 10: Validate authorization code and prepare for token exchange

            if (
              !state.authorizationCode ||
              state.authorizationCode.trim() === ""
            ) {
              updateState({
                error:
                  "Authorization code is required. Please paste the code you received from the authorization server.",
                isInitiatingAuth: false,
              });
              return;
            }

            if (!state.authorizationServerMetadata?.token_endpoint) {
              throw new Error("Missing token endpoint");
            }

            // RFC 9207 (2026-07-28): validate the authorization-response issuer
            // BEFORE touching the token endpoint. On failure, stop the flow with
            // a fixed diagnostic — never echo attacker-controlled callback
            // `error*` parameters (the machine deliberately does not read them).
            //
            // Scope seam: `issParameterSupported` is deliberately NOT passed
            // here. That flag drives the "advertised-but-absent iss → reject"
            // row, which can only be enforced safely once the callback boundary
            // actually captures `iss` (the 2R-iss track threads it into
            // `authorizationResponseIss`). Until then, a genuinely-absent `iss`
            // is indistinguishable from an un-captured one, so enforcing that
            // row now would hard-fail every AS that advertises iss support.
            // What IS safe today: reject a PRESENT-but-mismatched `iss`.
            const issCheck = validateAuthorizationResponseIssuer({
              recordedIssuer: state.recordedIssuer,
              returnedIss: state.authorizationResponseIss,
              issParameterSupported: undefined,
              // This machine IS the 2026-07-28 era, where SEP-2468 makes the
              // present-`iss` comparison a MUST. Stated explicitly rather than
              // leaning on the default, so the era rule is visible here.
              enforcePresentIssMismatch: true,
            });
            if (!issCheck.ok) {
              updateState({
                error: issCheck.reason,
                isInitiatingAuth: false,
              });
              return;
            }

            // Build the token request body as an object (will be shown in HTTP history)
            const previewClientAuth = buildTokenRequestClientAuth({
              clientId: state.clientId,
              clientSecret: state.clientSecret,
              tokenEndpointAuthMethod: resolveEmulatedTokenAuthMethod(
                emulation,
                state.tokenEndpointAuthMethod
              ),
            });

            const tokenRequestBodyObj: Record<string, string> = {
              grant_type: "authorization_code",
              code: state.authorizationCode,
              redirect_uri: redirectUri,
              ...previewClientAuth.bodyParams,
            };

            if (state.codeVerifier) {
              tokenRequestBodyObj.code_verifier = state.codeVerifier;
            }

            if (sendResource) {
              tokenRequestBodyObj.resource = resolveResourceParameter();
            }

            const tokenRequest = {
              method: "POST",
              url: state.authorizationServerMetadata.token_endpoint,
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                ...previewClientAuth.headers,
              },
              body: tokenRequestBodyObj,
            };

            // Update state with the request (clear old tokens)
            updateState({
              currentStep: "token_request",
              lastRequest: tokenRequest,
              lastResponse: undefined,
              ...(sendResource ? {} : { resourceIndicatorSuppressed: true }),
              accessToken: undefined, // Clear old token
              refreshToken: undefined, // Clear old refresh token
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "token_request",
                  timestamp: Date.now(),
                  request: tokenRequest,
                },
              ],
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            autoAdvance(50);
            return;
          }

          case "token_request":
            // Step 11: Exchange authorization code for access token
            if (!state.authorizationServerMetadata?.token_endpoint) {
              throw new Error("Missing token endpoint");
            }

            if (!state.authorizationCode) {
              throw new Error("Missing authorization code");
            }

            if (!state.codeVerifier) {
              throw new Error(
                "PKCE code_verifier is missing - cannot exchange token"
              );
            }

            try {
              // Prepare token request body (form-urlencoded)
              const clientAuth = buildTokenRequestClientAuth({
                clientId: state.clientId,
                clientSecret: state.clientSecret,
                tokenEndpointAuthMethod: resolveEmulatedTokenAuthMethod(
                  emulation,
                  state.tokenEndpointAuthMethod
                ),
              });

              const tokenRequestBody = new URLSearchParams({
                grant_type: "authorization_code",
                code: state.authorizationCode,
                redirect_uri: redirectUri,
                code_verifier: state.codeVerifier || "",
                ...clientAuth.bodyParams,
              });

              // Add resource parameter (per RFC 8707; prefers the PRM-advertised
              // resource identifier, falling back to the canonical server URL)
              if (sendResource) {
                tokenRequestBody.set("resource", resolveResourceParameter());
              }

              // Make the token request via backend proxy. The client-auth
              // Authorization header is applied AFTER the merge: the merge
              // strips user-configured Authorization headers so MCP-server
              // credentials never leak to the AS, but the Basic credential
              // here IS addressed to the AS (client_secret_basic).
              const response = await executeRequest(
                state.authorizationServerMetadata.token_endpoint,
                {
                  method: "POST",
                  headers: {
                    ...mergeHeadersForAuthServer(customHeaders, {
                      "Content-Type": "application/x-www-form-urlencoded",
                    }),
                    ...clientAuth.headers,
                  },
                  body: tokenRequestBody.toString(),
                }
              );

              const tokenResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response
              const updatedHistoryToken = [...(state.httpHistory || [])];
              if (updatedHistoryToken.length > 0) {
                const lastEntry =
                  updatedHistoryToken[updatedHistoryToken.length - 1];
                lastEntry.response = tokenResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                // Token request failed
                updateState({
                  lastResponse: tokenResponseData,
                  httpHistory: updatedHistoryToken,
                  // Clear the authorization code so it won't be retried
                  authorizationCode: undefined,
                  error: describeTokenRequestFailure(response),
                  isInitiatingAuth: false,
                });
                return;
              }

              // Token request successful
              const tokens = response.body;

              // Start with existing logs, filtering out any token-related logs we're about to add
              // to prevent duplicates
              const existingLogs = (getCurrentState().infoLogs || []).filter(
                (log) =>
                  log.id !== "auth-code" &&
                  log.id !== "oauth-tokens" &&
                  log.id !== "token"
              );

              let tokenInfoLogs = existingLogs;

              // Add Authorization Code log
              if (state.authorizationCode) {
                tokenInfoLogs = [
                  ...tokenInfoLogs,
                  {
                    id: "auth-code",
                    level: "info",
                    step: "authorization_request",
                    label: "Authorization Code",
                    data: {
                      code: state.authorizationCode,
                    },
                    timestamp: Date.now(),
                  },
                ];
              }

              if (tokens.access_token) {
                const tokenData: Record<string, any> = {
                  access_token: tokens.access_token,
                };

                if (tokens.refresh_token) {
                  tokenData.refresh_token = tokens.refresh_token;
                }

                tokenInfoLogs = [
                  ...tokenInfoLogs,
                  {
                    id: "oauth-tokens",
                    level: "info",
                    step: "token_request",
                    label: "OAuth Tokens",
                    data: tokenData,
                    timestamp: Date.now(),
                  },
                ];
              }

              // Decode and add access token JWT log
              if (tokens.access_token) {
                const decoded = decodeJWT(tokens.access_token);
                if (decoded) {
                  const formatted = { ...decoded };
                  // Format timestamp fields
                  if (formatted.exp) {
                    formatted.exp = `${formatted.exp} (${formatJWTTimestamp(formatted.exp)})`;
                  }
                  if (formatted.iat) {
                    formatted.iat = `${formatted.iat} (${formatJWTTimestamp(formatted.iat)})`;
                  }
                  if (formatted.nbf) {
                    formatted.nbf = `${formatted.nbf} (${formatJWTTimestamp(formatted.nbf)})`;
                  }

                  // Add audience validation note
                  const audienceNote: Record<string, any> = {
                    ...formatted,
                  };

                  // Check if audience claim exists and validate it
                  if (formatted.aud) {
                    const expectedResource = state.serverUrl;
                    const audArray = Array.isArray(formatted.aud)
                      ? formatted.aud
                      : [formatted.aud];

                    const isValidAudience = audArray.some(
                      (aud: string) => aud === expectedResource
                    );

                    audienceNote._validation = {
                      expected_audience: expectedResource,
                      audience_matches: isValidAudience,
                      note: isValidAudience
                        ? "✓ Token audience matches MCP server"
                        : "⚠ Token audience does not match MCP server (security risk)",
                    };
                  } else {
                    audienceNote._validation = {
                      note: "⚠ No audience claim found - server should validate token binding",
                    };
                  }

                  tokenInfoLogs = [
                    ...tokenInfoLogs,
                    {
                      id: "token",
                      level: "info",
                      step: "token_request",
                      label: "Access Token (Decoded JWT)",
                      data: audienceNote,
                      timestamp: Date.now(),
                    },
                  ];
                }
              }

              // Decode and add ID token JWT log (OIDC flows)
              if (tokens.id_token) {
                const decodedIdToken = decodeJWT(tokens.id_token);
                if (decodedIdToken) {
                  const formattedIdToken = { ...decodedIdToken };
                  // Format timestamp fields
                  if (formattedIdToken.exp) {
                    formattedIdToken.exp = `${formattedIdToken.exp} (${formatJWTTimestamp(formattedIdToken.exp)})`;
                  }
                  if (formattedIdToken.iat) {
                    formattedIdToken.iat = `${formattedIdToken.iat} (${formatJWTTimestamp(formattedIdToken.iat)})`;
                  }
                  if (formattedIdToken.nbf) {
                    formattedIdToken.nbf = `${formattedIdToken.nbf} (${formatJWTTimestamp(formattedIdToken.nbf)})`;
                  }
                  if (formattedIdToken.auth_time) {
                    formattedIdToken.auth_time = `${formattedIdToken.auth_time} (${formatJWTTimestamp(formattedIdToken.auth_time)})`;
                  }

                  // Add OIDC-specific validation note
                  formattedIdToken._note =
                    "OIDC ID Token - Used for user identity verification";

                  tokenInfoLogs = [
                    ...tokenInfoLogs,
                    {
                      id: "id-token",
                      level: "info",
                      step: "token_request",
                      label: "ID Token (OIDC - Decoded JWT)",
                      data: formattedIdToken,
                      timestamp: Date.now(),
                    },
                  ];
                }
              }

              updateState({
                currentStep: "received_access_token",
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                tokenType: tokens.token_type || "Bearer",
                expiresIn: tokens.expires_in,
                lastResponse: tokenResponseData,
                httpHistory: updatedHistoryToken,
                infoLogs: tokenInfoLogs,
                error: undefined,
                isInitiatingAuth: false,
              });
            } catch (error) {
              // Capture the error
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: {},
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                const lastEntry =
                  updatedHistoryError[updatedHistoryError.length - 1];
                lastEntry.response = errorResponse;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                error: `Token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
                isInitiatingAuth: false,
              });
            }
            break;

          case "received_access_token":
            // Step 12: Make an authenticated stateless MCP request to verify the
            // token. 2026-07-28 has no `initialize`/session handshake, so this is
            // a plain `tools/list` carrying the `_meta` envelope + bearer token.
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            const authenticatedRequest = {
              method: "POST",
              url: state.serverUrl,
              headers: {
                Authorization: `Bearer ${state.accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "MCP-Protocol-Version": statelessProtocolVersion,
                "Mcp-Method": "tools/list",
              },
              body: buildStatelessVerifyRequestBody({
                protocolVersion: statelessProtocolVersion,
                authMode,
                clientName: "MCPJam Inspector",
                clientVersion: "1.0.0",
                id: 2,
              }),
            };

            // Add info log for the authenticated stateless verify request
            const authenticatedRequestInfoLogs = addInfoLog(
              getCurrentState(),
              "authenticated_mcp_request",
              "authenticated-verify",
              "Authenticated MCP Verify Request (tools/list)",
              {
                Request: "Stateless tools/list with OAuth bearer token",
                "Protocol Version": "2026-07-28",
                Client: "MCPJam Inspector v1.0.0",
                Endpoint: state.serverUrl,
              }
            );

            // Update state with the request
            updateState({
              currentStep: "authenticated_mcp_request",
              lastRequest: authenticatedRequest,
              lastResponse: undefined,
              httpHistory: [
                ...(state.httpHistory || []),
                {
                  step: "authenticated_mcp_request",
                  timestamp: Date.now(),
                  request: authenticatedRequest,
                },
              ],
              infoLogs: authenticatedRequestInfoLogs,
              isInitiatingAuth: false,
            });

            // Automatically proceed to make the actual request
            autoAdvance(50);
            return;

          case "authenticated_mcp_request":
            // Step 13: Execute the authenticated stateless verify request
            // (tools/list with the bearer token). No initialize/session step.
            if (!state.serverUrl || !state.accessToken) {
              throw new Error("Missing server URL or access token");
            }

            try {
              const response = await executeRequest(state.serverUrl, {
                method: "POST",
                headers: mergeHeaders(customHeaders, {
                  Authorization: `Bearer ${state.accessToken}`,
                  "Content-Type": "application/json",
                  Accept: "application/json, text/event-stream",
                  "MCP-Protocol-Version": statelessProtocolVersion,
                  "Mcp-Method": "tools/list",
                }),
                body: JSON.stringify(
                  buildStatelessVerifyRequestBody({
                    protocolVersion: statelessProtocolVersion,
                    authMode,
                    clientName: "MCPJam Inspector",
                    clientVersion: "1.0.0",
                    id: 2,
                  }),
                ),
              });

              const mcpResponseData = {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.body,
              };

              // Update the last history entry with the response
              const updatedHistoryMcp = [...(state.httpHistory || [])];
              if (updatedHistoryMcp.length > 0) {
                const lastEntry =
                  updatedHistoryMcp[updatedHistoryMcp.length - 1];
                lastEntry.response = mcpResponseData;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              if (!response.ok) {
                updateState({
                  lastResponse: mcpResponseData,
                  httpHistory: updatedHistoryMcp,
                  error: describeAuthenticatedRequestFailure(response),
                  isInitiatingAuth: false,
                });
                return;
              }

              // Add info log for MCP protocol version
              let mcpInfoLogs = getCurrentState().infoLogs || [];

              // Check if response is SSE (Streamable HTTP transport)
              const contentType = response.headers["content-type"] || "";
              const isSSE = contentType.includes("text/event-stream");

              // Extract MCP response from body (could be direct JSON or parsed SSE)
              let mcpResponse = null;
              // Handle structured SSE response from debug proxy
              if (isSSE && response.body?.transport === "sse") {
                // SSE response - extract MCP response from parsed events
                mcpResponse = response.body.mcpResponse;
              } else {
                // Direct JSON response
                mcpResponse = response.body;
              }

              if (isSSE && mcpResponse?.result?.protocolVersion) {
                // SSE streaming response with parsed MCP response
                const protocolInfo: Record<string, any> = {
                  Transport: "Streamable HTTP",
                  "Response Format": "Server-Sent Events (streaming)",
                  "Protocol Version": mcpResponse.result.protocolVersion,
                };

                // Include server info if available
                if (mcpResponse.result.serverInfo) {
                  protocolInfo["Server Name"] =
                    mcpResponse.result.serverInfo.name;
                  protocolInfo["Server Version"] =
                    mcpResponse.result.serverInfo.version;
                }

                // Include capabilities if available
                if (mcpResponse.result.capabilities) {
                  protocolInfo["Capabilities"] =
                    mcpResponse.result.capabilities;
                }

                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-protocol",
                  "MCP Server Information",
                  protocolInfo
                );
              } else if (isSSE) {
                // SSE streaming response but no MCP response parsed yet
                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-transport",
                  "MCP Transport Detected",
                  {
                    Transport: "Streamable HTTP",
                    "Response Format": "Server-Sent Events (streaming)",
                    "Content-Type": contentType,
                    Note: "Server returned streaming response. tools/list verify response delivered via SSE stream.",
                    Events: response.body?.events
                      ? `${response.body.events.length} events parsed`
                      : "No events parsed",
                  }
                );
              } else if (mcpResponse?.result?.protocolVersion) {
                // JSON response - extract protocol version from response body
                const protocolInfo: Record<string, any> = {
                  Transport: "Streamable HTTP",
                  "Response Format": "JSON",
                  "Protocol Version": mcpResponse.result.protocolVersion,
                };

                // Include server info if available
                if (mcpResponse.result.serverInfo) {
                  protocolInfo["Server Name"] =
                    mcpResponse.result.serverInfo.name;
                  protocolInfo["Server Version"] =
                    mcpResponse.result.serverInfo.version;
                }

                // Include capabilities if available
                if (mcpResponse.result.capabilities) {
                  protocolInfo["Capabilities"] =
                    mcpResponse.result.capabilities;
                }

                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-protocol",
                  "MCP Server Information",
                  protocolInfo
                );
              } else if (mcpResponse?.result) {
                // 2026-07-28 stateless verify: the request is `tools/list`, so a
                // successful result has no `initialize` protocolVersion/serverInfo
                // to report — it simply proves the bearer token is accepted.
                // Surface that (with a tool count when present) instead of
                // logging nothing.
                const toolCount = Array.isArray(mcpResponse.result.tools)
                  ? mcpResponse.result.tools.length
                  : undefined;
                mcpInfoLogs = addInfoLog(
                  getCurrentState(),
                  "authenticated_mcp_request",
                  "mcp-token-verified",
                  "Access token verified (tools/list)",
                  {
                    Transport: "Streamable HTTP",
                    "Response Format": "JSON",
                    Result: "Bearer token accepted; tools/list succeeded",
                    ...(toolCount !== undefined
                      ? { "Tools listed": toolCount }
                      : {}),
                  }
                );
              }

              updateState({
                currentStep: "complete",
                lastResponse: mcpResponseData,
                httpHistory: updatedHistoryMcp,
                infoLogs: mcpInfoLogs,
                error: undefined,
                isInitiatingAuth: false,
              });
            } catch (error) {
              // Capture the error
              const errorResponse = {
                status: 0,
                statusText: "Network Error",
                headers: {},
                body: {
                  error: error instanceof Error ? error.message : String(error),
                },
              };

              const updatedHistoryError = [...(state.httpHistory || [])];
              if (updatedHistoryError.length > 0) {
                const lastEntry =
                  updatedHistoryError[updatedHistoryError.length - 1];
                lastEntry.response = errorResponse;
                lastEntry.duration =
                  Date.now() - (lastEntry.timestamp || Date.now());
              }

              updateState({
                lastResponse: errorResponse,
                httpHistory: updatedHistoryError,
                error: `Authenticated MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
                isInitiatingAuth: false,
              });
            }
            break;

          case "complete":
            // Terminal state
            updateState({ isInitiatingAuth: false });
            break;

          default:
            updateState({ isInitiatingAuth: false });
            break;
        }
      } catch (error) {
        const currentState = getCurrentState();
        const errorDetails = toLogErrorDetails(error);
        const infoLogs = addInfoLog(
          currentState,
          currentState.currentStep,
          `error-${currentState.currentStep}-${Date.now()}`,
          "Step failed",
          {
            step: currentState.currentStep,
            request: currentState.lastRequest,
            response: currentState.lastResponse,
            error: errorDetails,
          },
          { level: "error", error: errorDetails }
        );
        const updatedHistory = markLatestHttpEntryAsError(
          currentState.httpHistory,
          errorDetails
        );

        const updates: Partial<OAuthFlowState> = {
          error: errorDetails.message,
          infoLogs,
          isInitiatingAuth: false,
        };

        if (updatedHistory) {
          updates.httpHistory = updatedHistory;
        }

        updateState(updates);
      }
    },

    // Start the guided flow from the beginning
    startGuidedFlow: async () => {
      updateState({
        currentStep: "idle",
        isInitiatingAuth: false,
      });
    },

    // Reset the flow to initial state
    resetFlow: () => {
      // Reset to a fully-cleared flow. updateState MERGES, so every field must
      // be explicitly cleared — buildResetFlowState enumerates them all so no
      // stored client, token, discovery result, or recorded issuer survives.
      updateState(buildResetFlowState());
    },
  };

  return machine;
};
