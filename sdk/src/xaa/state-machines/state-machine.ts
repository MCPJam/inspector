import {
  evaluateIdJagClientMetadata,
  getXaaDebugClientMetadata,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  SAML2_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT,
  XAA_DEBUG_IDP_CLIENT_ID,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
} from "../../oauth/client-identity.js";
import { validateClientIdMetadataUrl } from "../../oauth/state-machines/shared/client-id-metadata.js";
import { executeDynamicClientRegistration } from "../../oauth/state-machines/shared/dynamic-client-registration.js";
import type {
  InfoLogLevel,
  LogErrorDetails,
} from "../../oauth/state-machines/types.js";
import {
  decodeJWTParts,
  formatJWTTimestamp,
} from "../../oauth/state-machines/shared/jwt.js";
import { NEGATIVE_TEST_MODE_DETAILS } from "../negative-test-modes.js";
import { type NegativeTestMode, XAA_IDP_KID } from "../constants.js";
import type {
  BaseXAAStateMachineConfig,
  RegistrationStrategy,
  XaaRegistrationWarning,
  XaaTokenEndpointAuthMethod,
  XAADecodedJwt,
  XAAFlowState,
  XAAFlowStep,
  XAAJWTInspectionIssue,
  XAAInfoLogEntry,
  XAARequestResult,
  XAAStateMachine,
} from "./types.js";
import { createInitialXAAFlowState } from "./types.js";
import {
  analyzeAsCompatibility,
  selectTokenEndpointAuthMethod,
  type XAACompatibilityReport,
} from "./capability-preflight.js";
import {
  buildMcpInitializeRequest,
  evaluateMcpInitializeResponse,
  mcpInitializeExtensionEvidence,
} from "../mcp-init.js";
import {
  buildAuthorizationServerMetadataCandidates,
  buildProtectedResourceMetadataCandidates,
} from "../discovery.js";

/** What the HTTP history shows in place of a client secret — the real value
 * is sent on the wire but never enters the logged request. */
export const CLIENT_SECRET_MASK = "••••••••";

const SENSITIVE_DIAGNOSTIC_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "clientsecret",
  "clientassertion",
  "identityassertion",
  "assertion",
  "idtoken",
  "idjag",
  "accesstoken",
  "refreshtoken",
  "subjecttoken",
  "actortoken",
]);

function diagnosticKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactDiagnosticValue(
  value: unknown,
  knownSecrets: ReadonlyArray<string> = []
): any {
  const redactString = (input: string): string => {
    let redacted = input;
    for (const secret of knownSecrets) {
      if (secret && secret !== CLIENT_SECRET_MASK) {
        redacted = redacted.split(secret).join(CLIENT_SECRET_MASK);
      }
    }
    return redacted.replace(
      /(\b(?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;"'}]+/gi,
      `$1${CLIENT_SECRET_MASK}`
    );
  };

  const visit = (current: unknown, key?: string): any => {
    if (key && SENSITIVE_DIAGNOSTIC_KEYS.has(diagnosticKey(key))) {
      if (
        current === CLIENT_SECRET_MASK ||
        current === "***REDACTED***" ||
        current === "[REDACTED]"
      ) {
        return current;
      }
      return CLIENT_SECRET_MASK;
    }
    if (typeof current === "string") return redactString(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));
    if (!current || typeof current !== "object") return current;

    return Object.fromEntries(
      Object.entries(current).map(([childKey, childValue]) => [
        childKey,
        visit(childValue, childKey),
      ])
    );
  };

  return visit(value);
}

function sanitizeDiagnosticUpdates(
  state: Partial<XAAFlowState>,
  updates: Partial<XAAFlowState>
): Partial<XAAFlowState> {
  const knownSecrets = [
    state.clientSecret,
    state.identityAssertion,
    state.idJag,
    state.accessToken,
    updates.clientSecret,
    updates.identityAssertion,
    updates.idJag,
    updates.accessToken,
  ].filter((value): value is string => typeof value === "string" && !!value);
  const sanitized = { ...updates };

  for (const key of [
    "lastRequest",
    "lastResponse",
    "httpHistory",
    "infoLogs",
    "error",
  ] as const) {
    if (key in sanitized) {
      (sanitized as Record<string, unknown>)[key] = redactDiagnosticValue(
        sanitized[key],
        knownSecrets
      );
    }
  }

  return sanitized;
}

interface AddInfoLogOptions {
  level?: InfoLogLevel;
  error?: LogErrorDetails;
}

function addInfoLog(
  state: XAAFlowState,
  step: XAAFlowStep,
  id: string,
  label: string,
  data: any,
  options: AddInfoLogOptions = {}
): Array<XAAInfoLogEntry> {
  const { level = "info", error } = options;

  return [
    ...(state.infoLogs || []),
    {
      id,
      step,
      label,
      data,
      timestamp: Date.now(),
      level,
      error,
    },
  ];
}

function toLogErrorDetails(error: unknown): LogErrorDetails {
  if (error instanceof Error) {
    return {
      message: error.message,
      details: {
        name: error.name,
        stack: error.stack,
      },
    };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return {
    message: "Unexpected error",
    details: error,
  };
}

function mergeHeadersForAuthServer(
  customHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> = {}
): Record<string, string> {
  const merged: Record<string, string> = {};
  const keysByLowercase = new Map<string, string>();

  const applyHeaders = (headers: Record<string, string> | undefined) => {
    if (!headers) return;

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      const previousKey = keysByLowercase.get(lowerKey);

      if (previousKey && previousKey !== key) {
        delete merged[previousKey];
      }

      keysByLowercase.set(lowerKey, key);
      merged[key] = value;
    }
  };

  applyHeaders(customHeaders);
  applyHeaders(requestHeaders);

  for (const key of Object.keys(merged)) {
    if (key.toLowerCase() === "authorization") {
      delete merged[key];
    }
  }

  return merged;
}

/** Rank an issuer-matching authorization-server candidate by its advertised
 * ID-JAG capability, using the two SPECIFIC compatibility checks — never the
 * vendor-influenced `overall` verdict. Draft-04: advertising the ID-JAG grant
 * profile requires also advertising the jwt-bearer grant, so the only valid
 * "partial" is jwt-bearer present with the ID-JAG profile omitted.
 *   1 = jwt-bearer AND ID-JAG profile advertised (best)
 *   2 = jwt-bearer advertised, ID-JAG profile omitted (draft-04 SHOULD)
 *   3 = otherwise — jwt-bearer unconfirmed, or ID-JAG explicitly unsupported.
 * Rank 3 is the historical "first issuer-matching wins" fallback: capability
 * advertisement is a preference heuristic, never a hard filter, since a server
 * may accept the grant without advertising it. */
function rankAuthServerCandidate(
  report: XAACompatibilityReport | null
): 1 | 2 | 3 {
  if (!report) return 3;
  const jwtBearer = report.checks.find(
    (c) => c.id === "jwt_bearer_grant"
  )?.status;
  if (jwtBearer !== "pass") return 3;
  const idJag = report.checks.find((c) => c.id === "id_jag_profile")?.status;
  if (idJag === "pass") return 1;
  if (idJag === "warn") return 2;
  return 3;
}

function extractErrorMessage(body: any, fallback: string): string {
  if (typeof body === "string" && body.trim()) {
    return body;
  }

  if (!body || typeof body !== "object") {
    return fallback;
  }

  return (
    body.error_description ||
    body.error ||
    body.message ||
    body.statusText ||
    fallback
  );
}

function asRecord(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }

  return value as Record<string, any>;
}

function formatClaimValue(value: unknown): string {
  if (typeof value === "number") {
    return `${value} (${formatJWTTimestamp(value)})`;
  }

  if (value === undefined) {
    return "(missing)";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function buildIdJagInspection(
  token: string,
  expected: {
    issuer: string;
    audience: string;
    resource: string;
    clientId: string;
    scope?: string;
    negativeTestMode: NegativeTestMode;
  }
): XAADecodedJwt {
  const decoded = decodeJWTParts(token);
  const issues: XAAJWTInspectionIssue[] = [];

  if (!decoded) {
    return {
      header: null,
      payload: null,
      signature: "",
      issues: [
        {
          section: "payload",
          field: "token",
          label: "JWT parsing",
          expected: "A well-formed three-part JWT",
          actual: "The returned assertion could not be decoded.",
        },
      ],
    };
  }

  const header = decoded.header || {};
  const payload = decoded.payload || {};

  const addIssue = (
    section: XAAJWTInspectionIssue["section"],
    field: string,
    label: string,
    expectedValue: unknown,
    actualValue: unknown
  ) => {
    issues.push({
      section,
      field,
      label,
      expected: formatClaimValue(expectedValue),
      actual: formatClaimValue(actualValue),
    });
  };

  if (header.typ !== "oauth-id-jag+jwt") {
    addIssue("header", "typ", "JWT type", "oauth-id-jag+jwt", header.typ);
  }

  if (header.kid !== XAA_IDP_KID) {
    addIssue("header", "kid", "Key identifier", XAA_IDP_KID, header.kid);
  }

  if (payload.iss !== expected.issuer) {
    addIssue("payload", "iss", "Issuer", expected.issuer, payload.iss);
  }

  if (payload.sub !== undefined && String(payload.sub).trim() === "") {
    addIssue("payload", "sub", "Subject", "Non-empty subject", payload.sub);
  }

  if (payload.sub === undefined) {
    addIssue("payload", "sub", "Subject", "Present", payload.sub);
  }

  if (payload.aud !== expected.audience) {
    addIssue("payload", "aud", "Audience", expected.audience, payload.aud);
  }

  if (payload.resource !== expected.resource) {
    addIssue(
      "payload",
      "resource",
      "Resource",
      expected.resource,
      payload.resource
    );
  }

  if (payload.client_id !== expected.clientId) {
    addIssue(
      "payload",
      "client_id",
      "Client ID",
      expected.clientId,
      payload.client_id
    );
  }

  if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) {
    addIssue("payload", "exp", "Expiration", "A future timestamp", payload.exp);
  }

  if (expected.scope && payload.scope !== expected.scope) {
    addIssue(
      "payload",
      "scope",
      "Requested scopes",
      expected.scope,
      payload.scope
    );
  }

  if (expected.negativeTestMode === "bad_signature") {
    addIssue(
      "signature",
      "signature",
      "Signature / JWKS",
      "Signed by the published XAA issuer key",
      "Signed with a throwaway private key"
    );
  }

  return {
    header: decoded.header,
    payload: decoded.payload,
    signature: decoded.signature,
    issues,
  };
}

// 14 distinct steps with a couple of paired sub-advances; 32 leaves headroom
// without risking a hot loop if a step ever stops progressing silently.
const XAA_RUN_ALL_MAX_ADVANCES = 32;

export function createXAAStateMachine(
  config: BaseXAAStateMachineConfig
): XAAStateMachine {
  const {
    state: initialState,
    getState,
    updateState,
    serverUrl,
    issuerBaseUrl,
    mintPathPrefix = "",
    issuerMode,
    organizationId,
    issuerKind,
    specTokenEndpointAvailable = true,
    requestExecutor,
    negativeTestMode,
    identityAssertionFormat,
    subjectIdentifierFormat,
    userId,
    email,
    clientId,
    clientSecret,
    scope,
    authzServerIssuer,
    registrationId,
    serverId,
    projectId,
    registrationStrategy: requestedRegistrationStrategy = "preregistered",
    dcrCredentialCache,
    dcrCacheTargetKey,
    clientIdMetadataUrl,
  } = config;

  // registrationId / serverId runs skip AS discovery entirely, so the dynamic
  // strategies (which need the discovered registration_endpoint / CIMD
  // advertisement) are forced back to pre-registered.
  const registrationStrategy: RegistrationStrategy =
    registrationId || serverId
      ? "preregistered"
      : requestedRegistrationStrategy;

  // Body fields the LOCAL server uses to forward the mint to the hosted
  // issuer (server-to-server); stripped before the upstream call. Hosted
  // routers ignore them.
  const hostedIssuerBodyExtras =
    issuerMode === "hosted"
      ? {
          issuerMode,
          ...(organizationId ? { organizationId } : {}),
          ...(issuerKind === "anonymous"
            ? { issuerKind: "anonymous" as const }
            : {}),
        }
      : {};

  const state: Partial<XAAFlowState> = initialState ?? {};

  const machine: XAAStateMachine = {
    state: createInitialXAAFlowState({
      ...state,
      serverUrl: state.serverUrl || serverUrl,
      resourceUrl: state.resourceUrl || serverUrl,
      issuerBaseUrl: state.issuerBaseUrl || issuerBaseUrl,
      negativeTestMode: state.negativeTestMode || negativeTestMode,
      identityAssertionFormat:
        state.identityAssertionFormat || identityAssertionFormat,
      subjectIdentifierFormat:
        state.subjectIdentifierFormat || subjectIdentifierFormat,
      userId: state.userId || userId,
      email: state.email || email,
      clientId: state.clientId || clientId,
      clientSecret: state.clientSecret || clientSecret,
      scope: state.scope || scope,
      authzServerIssuer: state.authzServerIssuer || authzServerIssuer,
      // Config-resolved, not snapshot-carried: after initialization the
      // state value is authoritative and only a rebuild can change it.
      registrationStrategy,
    }),
    updateState: (updates) => {
      const sanitizedUpdates = sanitizeDiagnosticUpdates(
        machine.state,
        updates
      );
      machine.state = { ...machine.state, ...sanitizedUpdates };
      updateState(sanitizedUpdates);
    },
    proceedToNextStep: async () => {},
    runAll: async () => {},
    resetFlow: () => {},
  };

  const currentState = (): XAAFlowState => getState?.() ?? machine.state;

  const pushInfo = (
    step: XAAFlowState["currentStep"],
    id: string,
    label: string,
    data: any,
    options?: AddInfoLogOptions
  ) => {
    machine.updateState({
      infoLogs: addInfoLog(currentState(), step, id, label, data, options),
    });
  };

  const runRequest = async (
    step: XAAFlowState["currentStep"],
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: any;
    },
    executor: () => Promise<XAARequestResult>
  ): Promise<XAARequestResult> => {
    machine.updateState({
      currentStep: step,
      isBusy: true,
      error: undefined,
      negativeProbe: undefined,
      lastRequest: request,
      lastResponse: undefined,
    });

    const startedAt = Date.now();

    try {
      const result = await executor();
      const response = {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
      };

      machine.updateState({
        isBusy: false,
        lastResponse: response,
        httpHistory: [
          ...(currentState().httpHistory || []),
          {
            step,
            timestamp: startedAt,
            duration: Date.now() - startedAt,
            request,
            response,
          },
        ],
      });

      return result;
    } catch (error) {
      const details = toLogErrorDetails(error);

      machine.updateState({
        isBusy: false,
        error: details.message,
        httpHistory: [
          ...(currentState().httpHistory || []),
          {
            step,
            timestamp: startedAt,
            duration: Date.now() - startedAt,
            request,
            error: details,
          },
        ],
      });

      pushInfo(step, `${step}-error-${startedAt}`, "Request failed", request, {
        level: "error",
        error: details,
      });

      throw error;
    }
  };

  const discoverResourceMetadata = async () => {
    const state = currentState();
    const activeServerUrl = state.serverUrl || serverUrl;

    // RFC 9728 protected-resource metadata discovery only exists to learn
    // which authorization server protects the resource. In XAA the requesting
    // app already knows its target AS — so when the issuer is configured (a
    // registration, or entered manually) there is nothing to discover. Skip
    // the request entirely rather than firing a spurious (often 404ing) probe.
    if (state.authzServerIssuer) {
      machine.updateState({
        currentStep: "received_resource_metadata",
        resourceUrl: state.resourceUrl || activeServerUrl,
        error: undefined,
      });
      pushInfo(
        "received_resource_metadata",
        "xaa-resource-metadata-skipped",
        "Resource metadata discovery skipped",
        {
          reason:
            "Authorization server issuer is already configured; RFC 9728 discovery is not part of the XAA grant and isn't needed.",
          authz_server_issuer: state.authzServerIssuer,
        }
      );
      return;
    }

    const candidateUrls =
      buildProtectedResourceMetadataCandidates(activeServerUrl);
    let lastError = "Failed to discover resource metadata";

    for (const resourceMetadataUrl of candidateUrls) {
      const request = {
        method: "GET",
        url: resourceMetadataUrl,
        headers: {
          Accept: "application/json",
        },
      };

      try {
        const result = await runRequest(
          "discover_resource_metadata",
          request,
          () => requestExecutor.externalRequest(resourceMetadataUrl, request)
        );

        if (!result.ok) {
          lastError = extractErrorMessage(
            result.body,
            `Resource metadata request failed with ${result.status}`
          );
          continue;
        }

        const resourceMetadata = asRecord(result.body, "Resource metadata");

        // RFC 9728: the metadata's `resource` MUST identify the protected
        // resource we fetched it for. Reject a mismatched (or absent) resource
        // so a compromised/misconfigured well-known can't redirect us to a
        // different authorization server; try the next candidate instead.
        const requestedResource = activeServerUrl;
        const metadataResource =
          typeof resourceMetadata.resource === "string"
            ? resourceMetadata.resource
            : undefined;
        if (!metadataResource || metadataResource !== requestedResource) {
          lastError = `Protected-resource metadata at ${resourceMetadataUrl} does not identify ${requestedResource}.`;
          continue;
        }
        const resolvedResource = metadataResource;

        const resolvedAuthzIssuer = Array.isArray(
          resourceMetadata.authorization_servers
        )
          ? resourceMetadata.authorization_servers[0]
          : undefined;
        if (!resolvedAuthzIssuer) {
          throw new Error(
            "Resource metadata did not include `authorization_servers`, and no Authorization Server issuer was configured manually."
          );
        }

        machine.updateState({
          currentStep: "received_resource_metadata",
          resourceMetadataUrl,
          resourceMetadata:
            resourceMetadata as XAAFlowState["resourceMetadata"],
          resourceUrl: resolvedResource,
          authzServerIssuer: resolvedAuthzIssuer,
          error: undefined,
        });

        pushInfo(
          "received_resource_metadata",
          "xaa-resource-metadata",
          "Resource metadata",
          {
            resource: resolvedResource,
            authorization_servers: resourceMetadata.authorization_servers,
          }
        );
        return;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error.message
            : "Failed to discover resource metadata";
      }
    }

    machine.updateState({
      currentStep: "discover_resource_metadata",
      error: lastError,
    });
  };

  const discoverAuthzMetadata = async () => {
    const state = currentState();
    const issuer = state.authzServerIssuer;

    // RFC 8414 authorization-server metadata discovery only exists to learn
    // the token endpoint. A registration-backed run resolves the stored
    // endpoint server-side, and a manually-set token endpoint is already
    // known — in either case skip the probe and advance.
    if (registrationId || serverId || state.tokenEndpoint) {
      machine.updateState({
        currentStep: "received_authz_metadata",
        error: undefined,
      });
      pushInfo(
        "received_authz_metadata",
        "xaa-authz-metadata-skipped",
        "Authorization metadata discovery skipped",
        {
          reason: registrationId
            ? "The registered resource's token endpoint is resolved server-side; RFC 8414 discovery isn't needed."
            : "The token endpoint is already configured; RFC 8414 discovery isn't needed.",
          ...(state.tokenEndpoint
            ? { token_endpoint: state.tokenEndpoint }
            : {}),
        }
      );
      return;
    }

    if (!issuer) {
      machine.updateState({
        currentStep: "discover_authz_metadata",
        error:
          "Authorization Server issuer is missing. Configure it manually or retry resource metadata discovery.",
      });
      return;
    }

    const issuerCandidates = authzServerIssuer
      ? [issuer]
      : [
          ...new Set(
            [
              issuer,
              ...(state.resourceMetadata?.authorization_servers ?? []),
            ].filter((candidate): candidate is string => !!candidate)
          ),
        ];
    let lastError = "Authorization server metadata discovery failed.";

    // Adopt a chosen candidate's metadata as the authorization server: record
    // the token endpoint, the pre-registered client-auth method, and the
    // compatibility report, and log the discovery.
    const adoptAuthServer = (
      metadata: Record<string, unknown>,
      resolvedIssuer: string,
      compatibilityReport: XAACompatibilityReport | null
    ) => {
      machine.updateState({
        currentStep: "received_authz_metadata",
        authzMetadata: metadata as XAAFlowState["authzMetadata"],
        authzServerIssuer: resolvedIssuer,
        tokenEndpoint: metadata.token_endpoint as string,
        ...(registrationStrategy === "preregistered"
          ? {
              tokenEndpointAuthMethod: selectTokenEndpointAuthMethod(
                state.tokenEndpointAuthMethod,
                state.clientSecret,
                metadata.token_endpoint_auth_methods_supported
              ),
            }
          : {}),
        compatibilityReport: compatibilityReport ?? undefined,
        error: undefined,
      });

      pushInfo(
        "received_authz_metadata",
        "xaa-authz-metadata",
        "Authorization metadata",
        {
          issuer: resolvedIssuer,
          token_endpoint: metadata.token_endpoint,
          grant_types_supported: metadata.grant_types_supported,
          registration_endpoint: metadata.registration_endpoint,
          client_id_metadata_document_supported:
            metadata.client_id_metadata_document_supported,
          authorization_grant_profiles_supported:
            metadata.authorization_grant_profiles_supported,
          compatibility: compatibilityReport
            ? {
                overall: compatibilityReport.overall,
                vendor: compatibilityReport.vendor,
              }
            : undefined,
        }
      );
    };

    // A confidential client's secret is registered at one specific RAS, so
    // capability ranking must NOT redirect it to a different advertised issuer
    // than it would have reached before — pin such runs to the first
    // issuer-matching candidate (pre-ranking behavior). Public clients (no
    // secret) may rank freely. An explicitly-configured issuer is already a
    // hard pin above (issuerCandidates collapses to a single entry).
    const allowRankSwitch = !state.clientSecret;

    type AsCandidate = {
      metadata: Record<string, unknown>;
      issuer: string;
      report: XAACompatibilityReport | null;
    };
    let firstIssuerMatch: AsCandidate | undefined;
    let jwtBearerOnly: AsCandidate | undefined;

    for (const candidateIssuer of issuerCandidates) {
      const urls = buildAuthorizationServerMetadataCandidates(candidateIssuer);
      for (const url of urls) {
        const request = {
          method: "GET",
          url,
          headers: mergeHeadersForAuthServer(undefined, {
            Accept: "application/json",
          }),
        };

        try {
          const result = await runRequest(
            "discover_authz_metadata",
            request,
            () => requestExecutor.externalRequest(url, request)
          );

          if (!result.ok) {
            lastError = extractErrorMessage(
              result.body,
              `Auth server metadata request failed with ${result.status}`
            );
            continue;
          }

          const metadata = asRecord(result.body, "Authorization metadata");
          if (typeof metadata.token_endpoint !== "string") {
            throw new Error(
              "Authorization metadata did not include a token_endpoint."
            );
          }

          // RFC 8414 §3.3: the metadata's `issuer` MUST match the one we asked
          // for. A mismatched (or absent) issuer means its token endpoint can't
          // be trusted with the signed assertion + any client secret — continue
          // to the next candidate rather than adopting a foreign issuer.
          if (
            typeof metadata.issuer !== "string" ||
            metadata.issuer !== candidateIssuer
          ) {
            lastError = `Authorization metadata at ${url} advertises issuer "${String(
              metadata.issuer
            )}", which does not match the requested issuer "${candidateIssuer}".`;
            continue;
          }
          const resolvedIssuer = metadata.issuer;

          const compatibilityReport = analyzeAsCompatibility({
            ...(metadata as XAAFlowState["authzMetadata"]),
            issuer: resolvedIssuer,
          });

          // Confidential run: pin to the first issuer-matching candidate,
          // preserving pre-ranking behavior so no secret moves issuers.
          if (!allowRankSwitch) {
            adoptAuthServer(metadata, resolvedIssuer, compatibilityReport);
            return;
          }

          const candidate: AsCandidate = {
            metadata,
            issuer: resolvedIssuer,
            report: compatibilityReport,
          };
          const rank = rankAuthServerCandidate(compatibilityReport);
          if (rank === 1) {
            // Both jwt-bearer and ID-JAG advertised — can't do better; adopt.
            adoptAuthServer(metadata, resolvedIssuer, compatibilityReport);
            return;
          }
          if (rank === 2 && !jwtBearerOnly) jwtBearerOnly = candidate;
          if (!firstIssuerMatch) firstIssuerMatch = candidate;
          // keep scanning the remaining candidates for a rank-1 server
        } catch (error) {
          lastError =
            error instanceof Error ? error.message : "Metadata request failed";
        }
      }
    }

    // No rank-1 candidate: prefer a jwt-bearer-capable one (rank 2), else fall
    // back to the first issuer-matching candidate (historical behavior).
    const chosen = jwtBearerOnly ?? firstIssuerMatch;
    if (chosen) {
      adoptAuthServer(chosen.metadata, chosen.issuer, chosen.report);
      return;
    }

    machine.updateState({
      currentStep: "discover_authz_metadata",
      error: lastError,
    });
  };

  // --- Dynamic client-identity strategies (dcr / cimd) ----------------------

  // Scope is part of the registered client's metadata, so a client registered
  // under one scope must NOT be reused when the run's scope changes — key the
  // cache on it too (a scope change then forces a fresh registration). Each
  // component is encodeURIComponent-escaped (which escapes ":") so a "::" inside
  // any component can't collide with the "::" delimiter between components.
  const dcrCacheKeyFor = (registrationEndpoint: string) =>
    [
      dcrCacheTargetKey ?? serverUrl,
      registrationEndpoint,
      currentState().scope ?? "",
    ]
      .map(encodeURIComponent)
      .join("::");

  const dcrSecretExpired = (creds: {
    clientSecret?: string;
    clientSecretExpiresAt?: number;
  }) =>
    Boolean(creds.clientSecret) &&
    typeof creds.clientSecretExpiresAt === "number" &&
    creds.clientSecretExpiresAt !== 0 &&
    creds.clientSecretExpiresAt <= Math.floor(Date.now() / 1000);

  const registerClientDynamically = async () => {
    const state = currentState();

    const registrationEndpoint = state.authzMetadata?.registration_endpoint;
    if (!registrationEndpoint) {
      machine.updateState({
        currentStep: "request_client_registration",
        isBusy: false,
        error:
          "The authorization server metadata does not advertise a registration_endpoint, so open Dynamic Client Registration is not available. That is a readiness finding in itself — switch to pre-registered credentials to continue.",
      });
      return;
    }

    const cacheKey = dcrCacheKeyFor(registrationEndpoint);
    const cached = dcrCredentialCache?.get(cacheKey);
    if (cached && dcrSecretExpired(cached)) {
      // The registered remote client still exists; only its secret died.
      // Replacing it means minting ANOTHER remote client, so gate that behind
      // the same "Register another client" confirmation as every other
      // duplicate-creating path rather than silently re-registering.
      dcrCredentialCache?.delete(cacheKey);
      machine.updateState({
        currentStep: "request_client_registration",
        isBusy: false,
        error:
          'This session\'s dynamic client secret has expired. Confirm "Register another client" to register a replacement.',
        dcrRetryMayCreateDuplicate: true,
      });
      return;
    } else if (cached) {
      // Reuse this browser session's registration instead of minting another
      // remote client on every Run all / Reset.
      machine.updateState({
        currentStep: "received_client_credentials",
        clientId: cached.clientId,
        tokenEndpointAuthMethod: cached.tokenEndpointAuthMethod,
        dcrRegistrationReused: true,
        error: undefined,
      });
      pushInfo(
        "received_client_credentials",
        "xaa-dcr-reused",
        "Reusing this session's dynamic registration",
        {
          "Client ID": cached.clientId,
          "Token Auth Method": cached.tokenEndpointAuthMethod,
        }
      );
      return;
    }

    // No reusable session registration, but a prior POST may already have
    // created a remote client (timeout, 5xx, refusal, or an unusable 2xx set
    // dcrRetryMayCreateDuplicate). Gate on that here — regardless of how we
    // arrived (parked retry OR a from-idle run after an ordinary reset that
    // re-seeded the flag) — so we never silently mint a second remote client.
    // The UI clears the flag only through the confirmed "Register another
    // client" action.
    if (state.dcrRetryMayCreateDuplicate) {
      machine.updateState({
        currentStep: "request_client_registration",
        isBusy: false,
        error:
          'The previous registration attempt may have created a client at the authorization server. Confirm "Register another client" to register again.',
      });
      return;
    }

    const clientMetadata = {
      ...getXaaDebugClientMetadata({
        tokenEndpointAuthMethod: "client_secret_post",
      }),
      ...(state.scope ? { scope: state.scope } : {}),
    };

    // One immutable request object: the displayed request (lastRequest /
    // history) and the executed request are the same value, so they cannot
    // drift. The executor owns wire serialization.
    const request = {
      method: "POST",
      url: registrationEndpoint,
      headers: mergeHeadersForAuthServer(undefined, {
        "Content-Type": "application/json",
      }),
      body: clientMetadata,
    };

    machine.updateState({
      currentStep: "request_client_registration",
      isBusy: true,
      error: undefined,
      negativeProbe: undefined,
      dcrRegistrationReused: false,
      lastRequest: request,
      lastResponse: undefined,
      httpHistory: [
        ...(currentState().httpHistory || []),
        {
          step: "request_client_registration",
          timestamp: Date.now(),
          request,
        },
      ],
    });

    // The SDK helper owns execution, history back-fill, and credential
    // redaction; it never throws (transport failures become outcomes).
    const outcome = await executeDynamicClientRegistration({
      request,
      requestExecutor: (req) =>
        requestExecutor.externalRequest(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body as BodyInit,
        }),
      httpHistory: currentState().httpHistory,
    });

    const parkRegistration = (error: string) => {
      machine.updateState({
        currentStep: "request_client_registration",
        isBusy: false,
        lastResponse: outcome.response,
        httpHistory: outcome.httpHistory,
        error,
        // Any POST that did not yield a reusable registration may still have
        // created a remote client. Retry needs explicit confirmation.
        dcrRetryMayCreateDuplicate: true,
      });
    };

    if (outcome.status !== "registered") {
      const framing =
        outcome.status === "http_error"
          ? "The authorization server did not accept open Dynamic Client Registration (no initial access token was sent). A protected registration endpoint is a valid deployment choice — this does not prove the server lacks DCR."
          : outcome.status === "invalid_response"
          ? "The registration response could not be parsed as a client registration."
          : "The registration request did not reach the authorization server.";
      parkRegistration(
        `${outcome.error} ${framing} Switch to pre-registered credentials to continue.`
      );
      return;
    }

    // A 2xx with a client id is not automatically usable for the pinned
    // ID-JAG profile: validate before caching or advancing. Evidence comes
    // from the SDK evaluator; only the park/warn policy lives here.
    const clientId = outcome.credentials.clientId;
    if (outcome.missingClientId || !clientId) {
      parkRegistration(
        "The registration response is missing a client_id, so the registration is unusable. Switch to pre-registered credentials to continue."
      );
      return;
    }

    const warnings: XaaRegistrationWarning[] = [];
    const evaluation = evaluateIdJagClientMetadata(outcome.clientInfo);

    if (evaluation.profile === "contradicted") {
      parkRegistration(
        "The authorization server returned authorization_grant_profiles_supported without the ID-JAG profile — it explicitly substituted the requested draft-04 client profile. Switch to pre-registered credentials to continue."
      );
      return;
    }
    if (evaluation.profile === "omitted") {
      warnings.push({
        code: "profile_metadata_not_echoed",
        message:
          "The registration response did not echo authorization_grant_profiles_supported. RFC 7591 lets a server ignore unknown metadata, so this is a conformance warning, not a rejection — JWT Bearer redemption is the operational verdict.",
      });
    }

    if (evaluation.jwtBearerGrant === "contradicted") {
      parkRegistration(
        "The authorization server returned grant_types without the JWT Bearer grant — the registered client cannot redeem an ID-JAG at this server. Switch to pre-registered credentials to continue."
      );
      return;
    }
    if (
      evaluation.jwtBearerGrant === "omitted" &&
      evaluation.tokenExchangeGrant === "omitted"
    ) {
      warnings.push({
        code: "grant_types_not_echoed",
        message:
          "The registration response did not echo grant_types. Continuing — JWT Bearer redemption will show whether the grant is actually enabled.",
      });
    } else if (
      evaluation.jwtBearerGrant === "present" &&
      evaluation.tokenExchangeGrant !== "present"
    ) {
      warnings.push({
        code: "token_exchange_grant_not_echoed",
        message:
          "The registration echoed the JWT Bearer grant but not the Token Exchange grant. Token Exchange is the Client-to-IdP leg, so redemption at this server can still proceed; draft-04 expects both to be registered together.",
      });
    }

    // Read the RAW response member, not credentials.tokenEndpointAuthMethod
    // (the SDK collapses a non-string value to undefined) — so a genuinely
    // ABSENT member gets the RFC 7591 fallback while a malformed present-but-
    // non-string member stays parked.
    const rawMethodMember = outcome.clientInfo.token_endpoint_auth_method;
    let method: XaaTokenEndpointAuthMethod;
    if (rawMethodMember === undefined) {
      // RFC 7591 SHOULD echo token_endpoint_auth_method, but some servers omit
      // it. We requested client_secret_post and the token proxy treats an
      // absent method as body-post, so default to that when a secret was
      // issued (or a public client when not) rather than blocking usable
      // credentials — and warn so the conformance gap stays visible.
      method = outcome.credentials.clientSecret ? "client_secret_post" : "none";
      warnings.push({
        code: "auth_method_not_echoed",
        message: outcome.credentials.clientSecret
          ? "The registration response omitted token_endpoint_auth_method (RFC 7591 SHOULD echo it); assuming the requested client_secret_post."
          : "The registration response omitted token_endpoint_auth_method and issued no secret; treating the client as public (none).",
      });
    } else if (
      rawMethodMember === "client_secret_post" ||
      rawMethodMember === "client_secret_basic" ||
      rawMethodMember === "none"
    ) {
      method = rawMethodMember;
    } else if (typeof rawMethodMember === "string") {
      parkRegistration(
        `Registration succeeded, but this debugger cannot use the returned client-auth method ("${rawMethodMember}"). This is a debugger limitation, not authorization-server unreadiness.`
      );
      return;
    } else {
      parkRegistration(
        "The registration returned a non-string token_endpoint_auth_method — a malformed registration response. Switch to pre-registered credentials to continue."
      );
      return;
    }

    const secret = outcome.credentials.clientSecret;
    if (
      (method === "client_secret_post" || method === "client_secret_basic") &&
      !secret
    ) {
      parkRegistration(
        `The registration returned token_endpoint_auth_method "${method}" without a client_secret — an inconsistent registration response. Switch to pre-registered credentials to continue.`
      );
      return;
    }
    if (method === "none" && secret) {
      parkRegistration(
        'The registration returned a client_secret together with token_endpoint_auth_method "none" — an inconsistent registration response. Switch to pre-registered credentials to continue.'
      );
      return;
    }
    if (method === "none") {
      warnings.push({
        code: "public_client",
        message:
          "The registered client is public (no client authentication). Draft-04 recommends Cross-App Access for confidential clients; the flow can continue, but this does not match the recommended deployment posture.",
      });
    }

    if (secret) {
      const expiresAt = outcome.credentials.clientSecretExpiresAt;
      if (
        typeof expiresAt === "number" &&
        expiresAt !== 0 &&
        expiresAt <= Math.floor(Date.now() / 1000)
      ) {
        parkRegistration(
          "The issued client_secret is already expired. Switch to pre-registered credentials to continue."
        );
        return;
      }
      if (typeof expiresAt !== "number") {
        warnings.push({
          code: "missing_secret_expiry",
          message:
            "The registration response omitted client_secret_expires_at, which RFC 7591 requires whenever a secret is issued.",
        });
      }
    }

    if (outcome.nonCanonicalSuccessStatus) {
      warnings.push({
        code: "non_201_success",
        message: `The registration returned ${outcome.response.status} instead of the RFC 7591 201 Created.`,
      });
    }
    const responseContentType = outcome.response.headers["content-type"] || "";
    if (!responseContentType.includes("json")) {
      warnings.push({
        code: "non_json_content_type",
        message: `The registration response parsed as JSON but was served as "${
          responseContentType || "(none)"
        }".`,
      });
    }
    const cacheControl = outcome.response.headers["cache-control"] || "";
    if (!cacheControl.includes("no-store")) {
      warnings.push({
        code: "missing_no_store",
        message:
          "The registration response is missing Cache-Control: no-store, which RFC 7591 requires for responses carrying credentials.",
      });
    }

    // The raw credential goes ONLY to the target-scoped session cache — never
    // into XAAFlowState, history, or logs.
    dcrCredentialCache?.set(cacheKey, {
      clientId,
      clientSecret: secret,
      tokenEndpointAuthMethod: method,
      clientSecretExpiresAt: outcome.credentials.clientSecretExpiresAt,
      registrationEndpoint,
    });

    machine.updateState({
      currentStep: "received_client_credentials",
      clientId,
      tokenEndpointAuthMethod: method,
      registrationWarnings: warnings,
      dcrRegistrationReused: false,
      dcrRetryMayCreateDuplicate: false,
      lastResponse: outcome.response,
      httpHistory: outcome.httpHistory,
      isBusy: false,
      error: undefined,
    });

    pushInfo(
      "received_client_credentials",
      "xaa-dcr",
      "Dynamic Client Registration",
      outcome.infoLogData
    );
  };

  const adoptClientMetadataDocument = async () => {
    const state = currentState();
    const supported =
      state.authzMetadata?.client_id_metadata_document_supported;

    // Gate before any fetch, like the 2025-11-25 OAuth machine: the CIMD
    // draft defines this advertisement specifically so clients don't enter
    // an unsupported flow. Parking here IS the readiness finding.
    if (supported !== true) {
      machine.updateState({
        currentStep: "fetch_client_metadata_document",
        isBusy: false,
        error:
          supported === false
            ? "The authorization server explicitly advertises client_id_metadata_document_supported: false — it does not accept Client ID Metadata Document client_ids. That is the readiness finding; switch to pre-registered credentials to continue."
            : "The authorization server metadata does not advertise client_id_metadata_document_supported, so the CIMD draft directs clients not to attempt the flow. That is the readiness finding; switch to pre-registered credentials to continue.",
      });
      return;
    }

    let documentUrl: string;
    try {
      documentUrl = validateClientIdMetadataUrl(
        clientIdMetadataUrl ?? XAA_DEBUG_CLIENT_ID_METADATA_URL
      );
    } catch (error) {
      machine.updateState({
        currentStep: "fetch_client_metadata_document",
        isBusy: false,
        error:
          error instanceof Error
            ? error.message
            : "Invalid client metadata URL",
      });
      return;
    }

    // Debugger preflight only — the RAS performs its own fetch or metadata
    // association. redirect:"manual" keeps a 3xx observable, since draft-02
    // forbids the authorization server from following redirects.
    const request = {
      method: "GET",
      url: documentUrl,
      headers: mergeHeadersForAuthServer(undefined, {
        Accept: "application/json",
      }),
    };

    let result: XAARequestResult;
    try {
      result = await runRequest("fetch_client_metadata_document", request, () =>
        requestExecutor.externalRequest(
          documentUrl,
          {
            method: "GET",
            headers: request.headers,
            redirect: "manual",
          },
          // The CIMD document URL is caller-influenced; enforce the private-host
          // / DNS guard at fetch time (not just any upstream one-shot check) to
          // close the DNS-rebinding window regardless of the httpsOnly default.
          { enforcePublicHost: true }
        )
      );
    } catch {
      // runRequest already recorded the failure and set the error; the step
      // stays at fetch_client_metadata_document and retries freely.
      return;
    }

    const park = (error: string) => {
      machine.updateState({
        currentStep: "fetch_client_metadata_document",
        error: `${error} This is a document preflight/validation failure; retry freely or switch strategy.`,
      });
    };

    if (result.status !== 200) {
      park(
        result.status >= 300 && result.status < 400
          ? `The client metadata URL answered with a ${result.status} redirect; draft-02 requires a direct 200 and forbids the authorization server from following redirects.`
          : `The client metadata URL answered ${result.status}; draft-02 requires a direct 200 OK.`
      );
      return;
    }
    // Compare the media-type ESSENCE (type/subtype before any ";" parameters,
    // trimmed + lowercased), anchored — an unanchored substring test wrongly
    // accepts "application/jsonp", "text/application/json", "application/+json".
    // Allow exactly application/json, or a structured suffix application/<x>+json
    // where <x> is a valid RFC 6838 subtype tree: it must START with an
    // alphanumeric (rejects "-+json"/"+json") and may use restricted-name chars
    // including "_" (accepts "vnd_acme+json"). The SDK proxy parses valid +json.
    const contentType = result.headers["content-type"] || "";
    const mediaTypeEssence = contentType.split(";", 1)[0].trim().toLowerCase();
    const isJsonMediaType =
      mediaTypeEssence === "application/json" ||
      /^application\/[a-z0-9][a-z0-9!#$&^_.+-]*\+json$/.test(mediaTypeEssence);
    if (!isJsonMediaType) {
      park(
        `The client metadata document was served as "${
          contentType || "(none)"
        }", not a JSON media type.`
      );
      return;
    }
    const doc = result.body;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      park("The client metadata document body is not a JSON object.");
      return;
    }
    if (doc.client_id !== documentUrl) {
      park(
        "The document's client_id does not exactly equal the fetched URL — draft-02 compares Client Identifier URLs with simple string comparison, no normalization."
      );
      return;
    }

    // The document IS the registration: no RFC 7591 echo-tolerance applies.
    const evaluation = evaluateIdJagClientMetadata(doc);
    if (
      evaluation.profile !== "present" ||
      evaluation.jwtBearerGrant !== "present" ||
      evaluation.tokenExchangeGrant !== "present"
    ) {
      park(
        "The hosted client metadata document does not declare the ID-JAG grant profile plus both required grants — the document is insufficient for XAA. This points at the hosted document, not the authorization server."
      );
      return;
    }
    if (evaluation.tokenEndpointAuthMethod !== "none") {
      const authMethod = evaluation.tokenEndpointAuthMethod ?? "";
      park(
        authMethod.startsWith("client_secret")
          ? "The client metadata document declares a shared-secret auth method, which CIMD draft-02 forbids — the document is malformed."
          : "The client metadata document declares a key-based auth method this debugger cannot exercise yet (confidential CIMD is a follow-up)."
      );
      return;
    }

    machine.updateState({
      currentStep: "received_client_metadata",
      clientId: documentUrl,
      tokenEndpointAuthMethod: "none",
      registrationWarnings: [
        {
          code: "public_client",
          message:
            "Public-client CIMD (token_endpoint_auth_method \"none\"): interoperability is exercised, but the security posture is NOT recommended — ID-JAG draft-04 §9.1 recommends confidential clients. Anyone can present this URL as their client_id; findings show the RAS accepted the URL identity, not proof of client authentication. Use private_key_jwt (confidential CIMD) for a production posture.",
        },
      ],
      error: undefined,
    });

    pushInfo(
      "received_client_metadata",
      "xaa-cimd",
      "Client ID Metadata Document ready",
      {
        "Client ID": documentUrl,
        "Client Name": (doc as Record<string, any>).client_name,
        Note: "Debugger preflight only — the RAS performs its own fetch or metadata association; JWT Bearer redemption is the operational verdict.",
      }
    );
  };

  const authenticateUser = async () => {
    const state = currentState();
    // Read the simulated identity from the live machine config, not the flow
    // snapshot. The machine is rebuilt whenever the identity changes, so the
    // config always holds the latest sub/email — whereas state.userId is the
    // value captured when the flow was last (re)built and can lag an edit made
    // mid-run. `??` (not `||`) so a deliberately-cleared field stays empty
    // rather than silently reviving the stale snapshot value.
    const activeUserId = userId ?? state.userId;
    const activeEmail = email ?? state.email;
    // Sticky state value (like negativeTestMode): authoritative once the
    // machine is initialized; changing it requires a flow reset.
    const assertionFormat = state.identityAssertionFormat;
    const request = {
      method: "POST",
      url: `${mintPathPrefix}/authenticate`,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        userId: activeUserId,
        email: activeEmail,
        audience: XAA_DEBUG_IDP_CLIENT_ID,
        resourceClientId: state.clientId,
        assertionFormat,
        ...hostedIssuerBodyExtras,
      },
    };

    try {
      const result = await runRequest("user_authentication", request, () =>
        requestExecutor.internalRequest(`${mintPathPrefix}/authenticate`, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        })
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `Mock authentication failed with ${result.status}`
          )
        );
      }

      const body = asRecord(result.body, "Authentication response");

      if (assertionFormat === "saml") {
        // Hard requirements, mirroring the id_token check: an issuer that
        // ignored the requested format (e.g. an older hosted issuer) minted
        // an OIDC token instead — fail loudly, never adopt the wrong format.
        if (typeof body.assertion !== "string") {
          throw new Error(
            "Authentication response did not include an `assertion`. The issuer may not support SAML assertions yet."
          );
        }
        const subject = body.subject as Record<string, unknown> | undefined;
        if (
          !subject ||
          typeof subject !== "object" ||
          typeof subject.issuer !== "string" ||
          typeof subject.nameid !== "string"
        ) {
          throw new Error(
            "Authentication response did not include the SAML `subject` metadata."
          );
        }

        machine.updateState({
          currentStep: "received_identity_assertion",
          identityAssertion: body.assertion,
          identityAssertionSubject: {
            issuer: subject.issuer,
            nameid: subject.nameid,
            ...(typeof subject.nameidFormat === "string"
              ? { nameidFormat: subject.nameidFormat }
              : {}),
            ...(typeof subject.spNameQualifier === "string"
              ? { spNameQualifier: subject.spNameQualifier }
              : {}),
          },
          error: undefined,
        });

        pushInfo(
          "received_identity_assertion",
          "xaa-identity-assertion",
          "SAML assertion issued",
          {
            userId: activeUserId,
            email: activeEmail,
            nameid: subject.nameid,
            nameid_format: subject.nameidFormat,
            sp_name_qualifier: subject.spNameQualifier,
          }
        );
        return;
      }

      if (typeof body.id_token !== "string") {
        throw new Error(
          "Authentication response did not include an `id_token`."
        );
      }

      machine.updateState({
        currentStep: "received_identity_assertion",
        identityAssertion: body.id_token,
        error: undefined,
      });

      pushInfo(
        "received_identity_assertion",
        "xaa-identity-assertion",
        "Identity assertion issued",
        {
          userId: activeUserId,
          email: activeEmail,
        }
      );
    } catch (error) {
      machine.updateState({
        currentStep: "user_authentication",
        error:
          error instanceof Error ? error.message : "Mock authentication failed",
      });
    }
  };

  const exchangeIdTokenForIdJag = async () => {
    const state = currentState();

    if (!state.identityAssertion) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error:
          "No identity assertion is available. Complete mock authentication first.",
      });
      return;
    }

    if (!state.authzServerIssuer) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error:
          "No authorization server issuer is available for the ID-JAG audience.",
      });
      return;
    }

    if (!state.clientId) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error: "Client ID is required for the ID-JAG `client_id` claim.",
      });
      return;
    }

    const useSpecEndpoint =
      state.negativeTestMode === "valid" && specTokenEndpointAvailable;
    // Sticky state values (like negativeTestMode). Input and output axes are
    // independent: a SAML assertion may mint a plain-`sub` ID-JAG and an OIDC
    // ID token may mint a saml-nameid `sub_id` one.
    const assertionFormat = state.identityAssertionFormat;
    const subjectIdFormat = state.subjectIdentifierFormat;

    try {
      // The JSON fallback mints from an UNSIGNED assertion parse. That is fine
      // for OIDC (the ID token is a JWT we verify) and for negative tamper
      // modes, but a valid SAML run must never skip signature verification —
      // require the strict RFC 8693 token endpoint rather than silently
      // minting an ID-JAG from an unverified SAML assertion.
      if (
        assertionFormat === "saml" &&
        state.negativeTestMode === "valid" &&
        !useSpecEndpoint
      ) {
        throw new Error(
          "SAML identity assertions require the authorization server's RFC 8693 token endpoint for signed-assertion verification, but it is not available. Use an OIDC assertion or an authorization server that advertises the token endpoint.",
        );
      }
      if (useSpecEndpoint) {
        const params: Record<string, string> = {
          grant_type: TOKEN_EXCHANGE_GRANT,
          requested_token_type: ID_JAG_TOKEN_TYPE,
          subject_token: state.identityAssertion,
          subject_token_type:
            assertionFormat === "saml" ? SAML2_TOKEN_TYPE : ID_TOKEN_TOKEN_TYPE,
          client_id: XAA_DEBUG_IDP_CLIENT_ID,
          audience: state.authzServerIssuer,
          ...(state.resourceUrl || state.serverUrl
            ? { resource: state.resourceUrl || state.serverUrl }
            : {}),
          ...(state.scope ? { scope: state.scope } : {}),
          // Mock-extension output-axis request; omitted for oauth-sub so a
          // valid OIDC exchange stays byte-identical to the pre-SAML wire.
          ...(subjectIdFormat === "saml-nameid"
            ? { subject_id_format: subjectIdFormat }
            : {}),
        };
        const request = {
          method: "POST",
          url: `${mintPathPrefix}/token`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params,
        };
        const transportHeaders =
          issuerMode === "hosted"
            ? {
                "x-mcpjam-issuer-mode": "hosted",
                ...(organizationId
                  ? { "x-mcpjam-organization-id": organizationId }
                  : {}),
                ...(issuerKind === "anonymous"
                  ? { "x-mcpjam-issuer-kind": "anonymous" }
                  : {}),
              }
            : {};

        const result = await runRequest("token_exchange_request", request, () =>
          requestExecutor.internalRequest(`${mintPathPrefix}/token`, {
            method: "POST",
            headers: { ...request.headers, ...transportHeaders },
            body: new URLSearchParams(params).toString(),
          })
        );

        if (!result.ok) {
          throw new Error(
            extractErrorMessage(
              result.body,
              `Token exchange failed with ${result.status}`
            )
          );
        }

        const body = asRecord(result.body, "Token exchange response");
        if (typeof body.access_token !== "string") {
          throw new Error(
            "Token exchange response did not include an `access_token`."
          );
        }

        machine.updateState({
          currentStep: "received_id_jag",
          idJag: body.access_token,
          idJagDecoded: null,
          error: undefined,
        });

        pushInfo("received_id_jag", "xaa-id-jag", "ID-JAG issued", {
          negativeTestMode: state.negativeTestMode,
          expectedFailure:
            NEGATIVE_TEST_MODE_DETAILS[state.negativeTestMode].expectedFailure,
          issued_token_type: body.issued_token_type,
          token_type: body.token_type,
        });

        if (body.issued_token_type !== ID_JAG_TOKEN_TYPE) {
          pushInfo(
            "received_id_jag",
            "xaa-id-jag-issued-token-type",
            "Unexpected issued_token_type",
            {
              expected: ID_JAG_TOKEN_TYPE,
              actual: body.issued_token_type,
              detail:
                "The token-exchange response did not declare the minted token as an ID-JAG.",
            },
            { level: "warning" }
          );
        }
        return;
      }

      const request = {
        method: "POST",
        url: `${mintPathPrefix}/token-exchange`,
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          identityAssertion: state.identityAssertion,
          audience: state.authzServerIssuer,
          ...(state.resourceUrl || state.serverUrl
            ? { resource: state.resourceUrl || state.serverUrl }
            : {}),
          clientId: state.clientId,
          scope: state.scope,
          negativeTestMode: state.negativeTestMode,
          assertionFormat,
          subjectIdFormat,
          ...hostedIssuerBodyExtras,
        },
      };

      const result = await runRequest("token_exchange_request", request, () =>
        requestExecutor.internalRequest(`${mintPathPrefix}/token-exchange`, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        })
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `Token exchange failed with ${result.status}`
          )
        );
      }

      const body = asRecord(result.body, "Token exchange response");
      if (typeof body.id_jag !== "string") {
        throw new Error("Token exchange response did not include an `id_jag`.");
      }

      machine.updateState({
        currentStep: "received_id_jag",
        idJag: body.id_jag,
        idJagDecoded: null,
        error: undefined,
      });

      pushInfo("received_id_jag", "xaa-id-jag", "ID-JAG issued", {
        negativeTestMode: state.negativeTestMode,
        expectedFailure:
          NEGATIVE_TEST_MODE_DETAILS[state.negativeTestMode].expectedFailure,
      });
    } catch (error) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error: error instanceof Error ? error.message : "Token exchange failed",
      });
    }
  };

  const inspectIdJag = () => {
    const state = currentState();
    if (!state.idJag || !state.authzServerIssuer || !state.clientId) {
      machine.updateState({
        currentStep: "inspect_id_jag",
        error:
          "A complete ID-JAG, authorization server issuer, and client ID are required before inspection.",
      });
      return;
    }

    const inspection = buildIdJagInspection(state.idJag, {
      issuer: issuerBaseUrl,
      audience: state.authzServerIssuer,
      resource: state.resourceUrl || state.serverUrl || serverUrl,
      clientId: state.clientId,
      scope: state.scope,
      negativeTestMode: state.negativeTestMode,
    });

    machine.updateState({
      currentStep: "inspect_id_jag",
      idJagDecoded: inspection,
      issuerBaseUrl,
      error: undefined,
    });

    pushInfo("inspect_id_jag", "xaa-id-jag-inspection", "ID-JAG inspection", {
      issues: inspection.issues,
      mode: state.negativeTestMode,
    });
  };

  const requestAccessToken = async () => {
    const state = currentState();

    if (
      !state.idJag ||
      (!state.tokenEndpoint && !registrationId && !serverId)
    ) {
      machine.updateState({
        currentStep: "jwt_bearer_request",
        error:
          "The flow is missing an ID-JAG or token endpoint. Finish discovery and token exchange first.",
      });
      return;
    }

    // Dynamic strategies resolve their credentials outside the flow snapshot:
    // DCR reads the target-scoped session cache (the secret never enters
    // XAAFlowState), CIMD is public by construction.
    let manualClientSecret = state.clientSecret;
    let manualAuthMethod = state.tokenEndpointAuthMethod;
    if (!registrationId && !serverId) {
      if (registrationStrategy === "dcr") {
        const registrationEndpoint = state.authzMetadata?.registration_endpoint;
        const cacheKey = registrationEndpoint
          ? dcrCacheKeyFor(registrationEndpoint)
          : undefined;
        const cached = cacheKey ? dcrCredentialCache?.get(cacheKey) : undefined;
        if (!cached || cached.clientId !== state.clientId) {
          machine.updateState({
            currentStep: "jwt_bearer_request",
            error:
              "This session's dynamic registration credentials are no longer available (the page may have reloaded). Register another client to continue.",
            // A remote client was already registered this session; its secret
            // is just gone. Set the gate so the "Register another client"
            // action this error points at is actually visible.
            dcrRetryMayCreateDuplicate: true,
          });
          return;
        }
        // The secret can expire between registration and redemption. Redeeming
        // with an expired secret surfaces as a confusing token-endpoint
        // failure, so discard it and ask to register again instead. Set the
        // duplicate-risk flag too: a remote client already exists (with a dead
        // secret), so registering another is what recovery requires — and the
        // flag is what keeps the "Register another client" action visible, which
        // this error tells the user to use.
        if (dcrSecretExpired(cached)) {
          if (cacheKey) dcrCredentialCache?.delete(cacheKey);
          machine.updateState({
            currentStep: "jwt_bearer_request",
            error:
              "This session's dynamic client secret has expired. Register another client to continue.",
            dcrRetryMayCreateDuplicate: true,
          });
          return;
        }
        manualClientSecret = cached.clientSecret;
        manualAuthMethod = cached.tokenEndpointAuthMethod;
      } else if (registrationStrategy === "cimd") {
        manualClientSecret = undefined;
        manualAuthMethod = "none";
      }
    }

    // Registration- and server-target runs send only an opaque id: the server
    // resolves the stored secret and forces the outbound URL server-side, so
    // neither the secret nor the destination ever rides in from the browser.
    // Manual runs may carry a profile-configured secret — confidential-client
    // servers reject the jwt-bearer grant without one.
    const tokenRequestBody = registrationId
      ? {
          registrationId,
          assertion: state.idJag,
          scope: state.scope,
          resource: state.resourceUrl || state.serverUrl,
        }
      : serverId
        ? {
            serverId,
            ...(projectId ? { projectId } : {}),
            assertion: state.idJag,
            scope: state.scope,
            resource: state.resourceUrl || state.serverUrl,
          }
        : {
            tokenEndpoint: state.tokenEndpoint,
            assertion: state.idJag,
            clientId: state.clientId,
            ...(manualClientSecret ? { clientSecret: manualClientSecret } : {}),
            ...(manualAuthMethod
              ? { tokenEndpointAuthMethod: manualAuthMethod }
              : {}),
            scope: state.scope,
            resource: state.resourceUrl || state.serverUrl,
          };

    // The request object lands verbatim in the HTTP history panel (and any
    // export of it), so the logged copy masks the secret. Only
    // `tokenRequestBody` is ever sent.
    const request = {
      method: "POST",
      url: "/proxy/token",
      headers: {
        "Content-Type": "application/json",
      },
      body:
        "clientSecret" in tokenRequestBody
          ? { ...tokenRequestBody, clientSecret: CLIENT_SECRET_MASK }
          : tokenRequestBody,
    };

    try {
      const result = await runRequest("jwt_bearer_request", request, () =>
        requestExecutor.internalRequest("/proxy/token", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(tokenRequestBody),
        })
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `JWT bearer proxy failed with ${result.status}`
          )
        );
      }

      const proxyBody = asRecord(result.body, "JWT bearer response");
      const upstreamStatus =
        typeof proxyBody.status === "number" ? proxyBody.status : undefined;
      const upstreamPayload = proxyBody.body;

      if (!upstreamStatus || upstreamStatus < 200 || upstreamStatus >= 300) {
        // In a negative-test mode the broken assertion SHOULD be rejected — a
        // clean rejection here is the expected, correct outcome, not a flow
        // failure. (A missing/non-numeric status is a genuine proxy error and
        // still falls through to the error path below.)
        if (
          state.negativeTestMode !== "valid" &&
          typeof upstreamStatus === "number"
        ) {
          machine.updateState({
            currentStep: "jwt_bearer_request",
            error: undefined,
            negativeProbe: { outcome: "rejected", status: upstreamStatus },
          });
          pushInfo(
            "jwt_bearer_request",
            "xaa-negative-rejected",
            "Authorization server correctly rejected the broken assertion",
            { status: upstreamStatus, mode: state.negativeTestMode }
          );
          return;
        }

        const detail = extractErrorMessage(
          upstreamPayload,
          `Authorization server returned ${
            proxyBody.status ?? "an unknown status"
          }.`
        );
        machine.updateState({
          currentStep: "jwt_bearer_request",
          error: `${detail} Does the authorization server trust the synthetic issuer JWKS and support \`urn:ietf:params:oauth:grant-type:jwt-bearer\`?`,
        });
        pushInfo(
          "jwt_bearer_request",
          "xaa-jwt-bearer-failure",
          "JWT bearer request failed",
          {
            status: proxyBody.status,
            body: upstreamPayload,
          },
          { level: "error" }
        );
        return;
      }

      const tokenResponse = asRecord(
        upstreamPayload,
        "JWT bearer token response"
      );
      if (typeof tokenResponse.access_token !== "string") {
        throw new Error(
          "Authorization server response did not include an `access_token`."
        );
      }

      // In a negative-test mode the assertion was deliberately broken, so a
      // token here means the server accepted something it should have rejected
      // — the security risk the test probes for. Stop rather than using it.
      if (state.negativeTestMode !== "valid") {
        machine.updateState({
          currentStep: "received_access_token",
          accessToken: tokenResponse.access_token,
          tokenType:
            typeof tokenResponse.token_type === "string"
              ? tokenResponse.token_type
              : "Bearer",
          expiresIn:
            typeof tokenResponse.expires_in === "number"
              ? tokenResponse.expires_in
              : undefined,
          grantedScope:
            typeof tokenResponse.scope === "string"
              ? tokenResponse.scope
              : undefined,
          error: undefined,
          negativeProbe: { outcome: "accepted", status: upstreamStatus },
        });
        pushInfo(
          "received_access_token",
          "xaa-negative-accepted",
          "Authorization server issued a token for a broken assertion",
          { status: upstreamStatus, mode: state.negativeTestMode },
          { level: "error" }
        );
        return;
      }

      machine.updateState({
        currentStep: "received_access_token",
        accessToken: tokenResponse.access_token,
        tokenType:
          typeof tokenResponse.token_type === "string"
            ? tokenResponse.token_type
            : "Bearer",
        expiresIn:
          typeof tokenResponse.expires_in === "number"
            ? tokenResponse.expires_in
            : undefined,
        grantedScope:
          typeof tokenResponse.scope === "string"
            ? tokenResponse.scope
            : undefined,
        error: undefined,
      });

      pushInfo(
        "received_access_token",
        "xaa-access-token",
        "Access token issued",
        {
          token_type: tokenResponse.token_type,
          expires_in: tokenResponse.expires_in,
        }
      );
    } catch (error) {
      machine.updateState({
        currentStep: "jwt_bearer_request",
        error:
          error instanceof Error ? error.message : "JWT bearer request failed",
      });
    }
  };

  const callAuthenticatedMcp = async () => {
    const state = currentState();

    if (!state.accessToken || !state.serverUrl) {
      machine.updateState({
        currentStep: "authenticated_mcp_request",
        error:
          "An access token and MCP server URL are required before the final authenticated request.",
      });
      return;
    }

    // Shared initialize request: advertises the enterprise-managed
    // authorization extension and sends the MCP-Protocol-Version header (some
    // 2025-11-25 servers enforce it), matching the CLI probe.
    const mcpRequest = buildMcpInitializeRequest(state.accessToken);
    const request = {
      method: "POST",
      url: state.serverUrl,
      headers: mcpRequest.headers,
      body: mcpRequest.body,
    };

    try {
      const result = await runRequest(
        "authenticated_mcp_request",
        request,
        () =>
          requestExecutor.externalRequest(state.serverUrl!, {
            method: "POST",
            headers: mcpRequest.headers,
            body: JSON.stringify(mcpRequest.body),
          })
      );

      if (!result.ok) {
        machine.updateState({
          currentStep: "authenticated_mcp_request",
          error: extractErrorMessage(
            result.body,
            `Authenticated MCP request failed with ${result.status}`
          ),
        });
        return;
      }

      // A 2xx alone can carry a JSON-RPC error, an SSE parse failure, or a
      // non-MCP body — require a genuine JSON-RPC initialize result.
      const mcpError = evaluateMcpInitializeResponse(result.body);
      if (mcpError) {
        machine.updateState({
          currentStep: "authenticated_mcp_request",
          error: mcpError,
        });
        return;
      }

      machine.updateState({
        currentStep: "complete",
        error: undefined,
      });

      pushInfo(
        "complete",
        "xaa-authenticated-mcp",
        "Authenticated MCP response",
        {
          status: result.status,
          xaa_extension: mcpInitializeExtensionEvidence(result.body),
          body: result.body,
        }
      );
    } catch (error) {
      machine.updateState({
        currentStep: "authenticated_mcp_request",
        error:
          error instanceof Error
            ? error.message
            : "Authenticated MCP request failed",
      });
    }
  };

  machine.proceedToNextStep = async () => {
    const step = currentState().currentStep;

    switch (step) {
      case "idle":
      case "discover_resource_metadata":
        await discoverResourceMetadata();
        return;
      case "received_resource_metadata":
      case "discover_authz_metadata":
        await discoverAuthzMetadata();
        return;
      case "received_authz_metadata":
        // The config-resolved strategy (which already forces preregistered
        // for registrationId/serverId runs) is authoritative; the state copy
        // exists for display surfaces.
        if (registrationStrategy === "dcr") {
          await registerClientDynamically();
          return;
        }
        if (registrationStrategy === "cimd") {
          await adoptClientMetadataDocument();
          return;
        }
        await authenticateUser();
        return;
      case "request_client_registration":
        // First attempt or retry (retry is gated on the duplicate-client
        // confirmation inside registerClientDynamically).
        await registerClientDynamically();
        return;
      case "fetch_client_metadata_document":
        // First attempt or freely-retryable CIMD preflight.
        await adoptClientMetadataDocument();
        return;
      case "received_client_credentials":
      case "received_client_metadata":
      case "user_authentication":
        await authenticateUser();
        return;
      case "received_identity_assertion":
      case "token_exchange_request":
        await exchangeIdTokenForIdJag();
        return;
      case "received_id_jag":
      case "inspect_id_jag":
        if (step === "received_id_jag") {
          inspectIdJag();
          return;
        }
        await requestAccessToken();
        return;
      case "jwt_bearer_request":
        await requestAccessToken();
        return;
      case "received_access_token":
      case "authenticated_mcp_request":
        await callAuthenticatedMcp();
        return;
      case "complete":
        return;
      default: {
        const exhaustive: never = step;
        throw new Error(`Unhandled XAA flow step: ${exhaustive}`);
      }
    }
  };

  // Drive the flow to completion: keep advancing until the state machine
  // reaches `complete`, records an error, or stops making progress (safety
  // valve — every successful advance changes `currentStep`).
  machine.runAll = async () => {
    const MAX_ADVANCES = XAA_RUN_ALL_MAX_ADVANCES;
    for (let i = 0; i < MAX_ADVANCES; i += 1) {
      const before = currentState();
      if (
        before.currentStep === "complete" ||
        before.error ||
        before.negativeProbe
      ) {
        return;
      }

      await machine.proceedToNextStep();

      const after = currentState();
      if (
        after.error ||
        after.currentStep === "complete" ||
        after.negativeProbe
      ) {
        return;
      }
      if (after.currentStep === before.currentStep) {
        // No progress and no error — bail rather than loop forever.
        return;
      }
    }
  };

  machine.resetFlow = () => {
    machine.updateState(
      createInitialXAAFlowState({
        serverUrl: currentState().serverUrl || serverUrl,
        resourceUrl: currentState().serverUrl || serverUrl,
        issuerBaseUrl: currentState().issuerBaseUrl || issuerBaseUrl,
        negativeTestMode: currentState().negativeTestMode || negativeTestMode,
        identityAssertionFormat:
          currentState().identityAssertionFormat || identityAssertionFormat,
        subjectIdentifierFormat:
          currentState().subjectIdentifierFormat || subjectIdentifierFormat,
        userId: currentState().userId || userId,
        email: currentState().email || email,
        clientId: currentState().clientId || clientId,
        scope: currentState().scope || scope,
        authzServerIssuer:
          currentState().authzServerIssuer || authzServerIssuer,
        // Config-resolved strategy survives reset; the target-scoped DCR
        // credential cache lives outside flow state, so Run all after a reset
        // reuses this session's registration instead of minting another.
        registrationStrategy,
      })
    );
  };

  return machine;
}
