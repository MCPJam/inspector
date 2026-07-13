// Headless Cross-App Access (ID-JAG) flow driver. It self-issues an ID-JAG,
// verifies that the configured issuer actually publishes the signing key,
// redeems the assertion, and probes the protected MCP resource.
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
} from "../oauth-proxy.js";
import {
  ID_JAG_GRANT_PROFILE,
  JWT_BEARER_GRANT,
} from "../oauth/client-identity.js";
import {
  getXAAIdpJwks,
  getXAAIssuerUrl,
  initXAAIdpKeyPair,
} from "./mint/keypair.js";
import { verifyXaaJwt } from "./mint/signer.js";
import type { XaaTokenEndpointAuthMethod } from "./mint/jwt-bearer.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type NegativeTestMode,
} from "./constants.js";
import {
  buildIssuerPublicationCandidates,
  canonicalizeMcpResource,
} from "./discovery.js";
import {
  evaluateMcpInitializeResponse,
  mcpInitializeExtensionEvidence,
  type XaaCapabilityEvidence,
} from "./mcp-init.js";
import { createInProcessXaaExecutor } from "./in-process-executor.js";
import { createXAAStateMachine } from "./state-machines/state-machine.js";
import { runXaaStateMachine } from "./state-machines/runner.js";
import {
  createInitialXAAFlowState,
  type XAAFlowState,
} from "./state-machines/types.js";

const ID_JAG_TYP = "oauth-id-jag+jwt";

export type { XaaCapabilityEvidence };

export interface XaaFlowConfig {
  /** Target MCP server URL (the protected resource). */
  serverUrl: string;
  /** Explicit authorization-server issuer; skips resource discovery. */
  authzServerIssuer?: string;
  /** Explicit token endpoint; skips authorization-server discovery. */
  tokenEndpoint?: string;
  /** Base URL whose `/xaa` issuer metadata and JWKS are publicly reachable. */
  issuerBaseUrl: string;
  subject: string;
  email?: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod;
  negativeTestMode?: NegativeTestMode;
  /** Per outbound request timeout in milliseconds. */
  timeoutMs?: number;
  /** Reject non-HTTPS / private targets. Default false for local development. */
  httpsOnly?: boolean;
  onProgress?: (message: string) => void;
}
export interface XaaFlowStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface XaaRedemptionResult {
  status: number;
  tokenIssued: boolean;
  error?: string;
  body?: unknown;
}

export interface XaaFlowResult {
  completed: boolean;
  issuer: string;
  authzServerIssuer?: string;
  tokenEndpoint?: string;
  authorizationServerCapabilities?: {
    idJagProfile: XaaCapabilityEvidence;
    jwtBearerGrant: XaaCapabilityEvidence;
    tokenEndpointAuthMethods?: string[];
    selectedTokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
  };
  idJag?: {
    token: string;
    claims: Record<string, unknown>;
    verified: boolean;
    verifyError?: string;
  };
  redemption?: XaaRedemptionResult;
  negativeProbe?: {
    mode: Exclude<NegativeTestMode, "valid">;
    baselineAccepted: boolean;
    baselineStatus: number;
    baselineError?: string;
    outcome: "rejected" | "accepted" | "inconclusive";
  };
  mcp?: {
    status: number;
    ok: boolean;
    error?: string;
    xaaExtension: XaaCapabilityEvidence;
  };
  steps: XaaFlowStep[];
  error?: string;
}

type PublishedJwk = JsonWebKey & { kid?: string };

function listEvidence(value: unknown, expected: string): XaaCapabilityEvidence {
  if (value === undefined || value === null) return "unknown";
  return Array.isArray(value) && value.includes(expected)
    ? "advertised"
    : "not_advertised";
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function selectTokenEndpointAuthMethod(
  explicit: XaaTokenEndpointAuthMethod | undefined,
  clientSecret: string | undefined,
  advertised: string[] | undefined
): XaaTokenEndpointAuthMethod {
  if (explicit) return explicit;
  if (!clientSecret) return "none";
  if (advertised?.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  if (advertised?.includes("client_secret_post")) {
    return "client_secret_post";
  }
  if (advertised?.includes("none")) return "none";
  // Metadata is optional; preserve the previous behavior when it is absent.
  return "client_secret_post";
}

function publicJwkMatches(local: JsonWebKey, published: JsonWebKey): boolean {
  if (local.kty !== published.kty) return false;
  if (local.kty === "RSA") {
    return local.n === published.n && local.e === published.e;
  }
  return (
    local.crv === published.crv &&
    local.x === published.x &&
    local.y === published.y
  );
}

async function verifyIssuerPublication(
  issuer: string,
  httpsOnly: boolean,
  timeoutMs: number | undefined
): Promise<{ ok: boolean; detail: string }> {
  let metadata: Record<string, unknown> | undefined;
  for (const url of buildIssuerPublicationCandidates(issuer)) {
    const response = await fetchOAuthMetadata(url, httpsOnly, timeoutMs);
    if (!("status" in response) && response.metadata.issuer === issuer) {
      metadata = response.metadata;
      break;
    }
  }

  if (!metadata) {
    return {
      ok: false,
      detail: `No OpenID configuration with issuer ${issuer} was reachable`,
    };
  }

  const jwksUri = metadata.jwks_uri;
  if (typeof jwksUri !== "string") {
    return { ok: false, detail: "Issuer metadata does not contain jwks_uri" };
  }

  const response = await executeOAuthProxy({
    url: jwksUri,
    headers: { Accept: "application/json" },
    httpsOnly,
    timeoutMs,
  });
  const rawKeys =
    response.status >= 200 &&
    response.status < 300 &&
    response.body &&
    typeof response.body === "object" &&
    Array.isArray((response.body as { keys?: unknown }).keys)
      ? (response.body as { keys: PublishedJwk[] }).keys ?? []
      : [];
  const keys = rawKeys.filter(
    (key): key is PublishedJwk => Boolean(key) && typeof key === "object"
  );
  const localKey = getXAAIdpJwks().keys[0];
  const matchingKey = keys.find(
    (key) => key.kid === localKey.kid && publicJwkMatches(localKey, key)
  );
  if (!matchingKey) {
    return {
      ok: false,
      detail: `Published JWKS ${jwksUri} does not contain the local signing key ${localKey.kid}`,
    };
  }
  return { ok: true, detail: `${jwksUri} (${localKey.kid})` };
}
function latestHistoryEntry(state: XAAFlowState, step: string) {
  return [...(state.httpHistory ?? [])]
    .reverse()
    .find((entry) => entry.step === step);
}

function projectRedemption(
  state: XAAFlowState
): XaaRedemptionResult | undefined {
  const entry = latestHistoryEntry(state, "jwt_bearer_request");
  if (!entry?.response) return undefined;

  const wrapper =
    entry.response.body && typeof entry.response.body === "object"
      ? (entry.response.body as Record<string, unknown>)
      : {};
  const status =
    typeof wrapper.status === "number" ? wrapper.status : entry.response.status;
  const storedBody = wrapper.body;
  const body =
    storedBody && typeof storedBody === "object"
      ? {
          ...(storedBody as Record<string, unknown>),
          ...(state.accessToken ? { access_token: state.accessToken } : {}),
        }
      : storedBody;
  const record =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : undefined;
  const tokenIssued =
    status >= 200 && status < 300 && typeof state.accessToken === "string";
  const errorDescription = record?.error_description;
  const oauthError = record?.error;
  const error = !tokenIssued
    ? (typeof errorDescription === "string" ? errorDescription : undefined) ||
      (typeof oauthError === "string" ? oauthError : undefined) ||
      "Authorization server returned " + status
    : undefined;

  return {
    status,
    tokenIssued,
    ...(error ? { error } : {}),
    body,
  };
}

function projectMcpResult(state: XAAFlowState): XaaFlowResult["mcp"] {
  const entry = latestHistoryEntry(state, "authenticated_mcp_request");
  if (!entry?.response) return undefined;

  const error = evaluateMcpInitializeResponse(entry.response.body);
  return {
    status: entry.response.status,
    ok:
      entry.response.status >= 200 &&
      entry.response.status < 300 &&
      !error,
    ...(error ? { error } : {}),
    xaaExtension: mcpInitializeExtensionEvidence(entry.response.body),
  };
}

function projectIdJag(
  state: XAAFlowState,
  issuer: string
): XaaFlowResult["idJag"] {
  if (!state.idJag) return undefined;

  let verified = false;
  let verifyError: string | undefined;
  let claims =
    state.idJagDecoded?.payload &&
    typeof state.idJagDecoded.payload === "object"
      ? state.idJagDecoded.payload
      : {};
  try {
    claims = verifyXaaJwt(state.idJag, { issuer, typ: ID_JAG_TYP });
    verified = true;
  } catch (error) {
    verifyError = error instanceof Error ? error.message : String(error);
  }

  return {
    token: state.idJag,
    claims,
    verified,
    ...(verifyError ? { verifyError } : {}),
  };
}

function projectCapabilities(
  state: XAAFlowState,
  config: XaaFlowConfig
): XaaFlowResult["authorizationServerCapabilities"] {
  if (!state.authzServerIssuer || !state.tokenEndpoint) return undefined;

  const advertisedAuthMethods = stringList(
    state.authzMetadata?.token_endpoint_auth_methods_supported
  );
  const selectedTokenEndpointAuthMethod =
    state.tokenEndpointAuthMethod ??
    selectTokenEndpointAuthMethod(
      config.tokenEndpointAuthMethod,
      config.clientSecret,
      advertisedAuthMethods
    );

  return {
    idJagProfile: listEvidence(
      state.authzMetadata?.authorization_grant_profiles_supported,
      ID_JAG_GRANT_PROFILE
    ),
    jwtBearerGrant: listEvidence(
      state.authzMetadata?.grant_types_supported,
      JWT_BEARER_GRANT
    ),
    ...(advertisedAuthMethods
      ? { tokenEndpointAuthMethods: advertisedAuthMethods }
      : {}),
    selectedTokenEndpointAuthMethod,
  };
}

function projectSteps(
  state: XAAFlowState,
  prefix = ""
): XaaFlowStep[] {
  return (state.httpHistory ?? []).map((entry) => ({
    step: prefix + entry.step,
    ok:
      !entry.error &&
      !!entry.response &&
      entry.response.status >= 200 &&
      entry.response.status < 300,
    detail: entry.error?.message ??
      (entry.response ? "status " + entry.response.status : undefined),
  }));
}

function projectFlowError(state: XAAFlowState): string | undefined {
  if (!state.error) return undefined;
  if (state.currentStep === "discover_resource_metadata") {
    return (
      "Could not discover the authorization server from the MCP server's " +
      "protected-resource metadata. " +
      state.error
    );
  }
  if (state.currentStep === "discover_authz_metadata") {
    return (
      "Could not discover the authorization server's token endpoint. " +
      state.error
    );
  }
  return state.error;
}

async function runSharedAttempt(
  config: XaaFlowConfig,
  mode: NegativeTestMode,
  stopAtAccessToken = false,
  progress?: (message: string) => void
): Promise<XAAFlowState> {
  const resource = canonicalizeMcpResource(config.serverUrl);
  let state = createInitialXAAFlowState({
    serverUrl: config.serverUrl,
    resourceUrl: resource,
    authzServerIssuer: config.authzServerIssuer,
    tokenEndpoint: config.tokenEndpoint,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenEndpointAuthMethod: config.tokenEndpointAuthMethod,
    userId: config.subject,
    email: config.email,
    scope: config.scope,
    negativeTestMode: mode,
    registrationStrategy: "preregistered",
  });
  const executor = createInProcessXaaExecutor({
    issuerBaseUrl: config.issuerBaseUrl,
    httpsOnly: config.httpsOnly ?? false,
    timeoutMs: config.timeoutMs,
  });
  const reportedSteps = new Set<string>();
  const reportProgress = (nextState: XAAFlowState) => {
    const step = nextState.currentStep;
    if (reportedSteps.has(step)) return;
    reportedSteps.add(step);
    const message =
      step === "discover_resource_metadata"
        ? "Discovering protected-resource metadata (RFC 9728)…"
        : step === "discover_authz_metadata"
        ? "Discovering authorization-server metadata (RFC 8414)…"
        : step === "token_exchange_request"
        ? "Minting the ID-JAG…"
        : step === "jwt_bearer_request"
        ? mode === "valid"
          ? "Redeeming the ID-JAG at the authorization server…"
          : "Redeeming the deliberately invalid ID-JAG…"
        : step === "authenticated_mcp_request"
        ? "Calling the MCP server with the access token…"
        : undefined;
    if (message) progress?.(message);
  };
  const machine = createXAAStateMachine({
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
      reportProgress(state);
    },
    serverUrl: config.serverUrl,
    issuerBaseUrl: config.issuerBaseUrl,
    requestExecutor: executor,
    negativeTestMode: mode,
    userId: config.subject,
    email: config.email,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
    authzServerIssuer: config.authzServerIssuer,
    registrationStrategy: "preregistered",
  });

  await runXaaStateMachine(
    machine,
    () => state,
    stopAtAccessToken ? { stopAtStep: "received_access_token" } : {}
  );
  return state;
}

export async function runXaaFlow(
  config: XaaFlowConfig
): Promise<XaaFlowResult> {
  const httpsOnly = config.httpsOnly ?? false;
  const progress = (message: string) => config.onProgress?.(message);
  const issuer = getXAAIssuerUrl(config.issuerBaseUrl);
  const publicationStep: XaaFlowStep[] = [];

  try {
    progress("Verifying the configured issuer metadata and JWKS…");
    initXAAIdpKeyPair();
    const issuerPublication = await verifyIssuerPublication(
      issuer,
      httpsOnly,
      config.timeoutMs
    );
    publicationStep.push({
      step: "verify_issuer_publication",
      ok: issuerPublication.ok,
      detail: issuerPublication.detail,
    });
    if (!issuerPublication.ok) {
      return {
        completed: false,
        issuer,
        steps: publicationStep,
        error:
          "The configured issuer does not publish the local signing key; " +
          "the authorization server cannot validate this ID-JAG.",
      };
    }

    const mode = config.negativeTestMode ?? DEFAULT_NEGATIVE_TEST_MODE;
    if (mode === "valid") {
      const state = await runSharedAttempt(config, mode, false, progress);
      const capabilities = projectCapabilities(state, config);
      const idJag = projectIdJag(state, issuer);
      const redemption = projectRedemption(state);
      const mcp = projectMcpResult(state);
      const steps = [...publicationStep, ...projectSteps(state)];

      if (capabilities) {
        steps.push(
          {
            step: "authorization_server_id_jag_profile",
            ok: capabilities.idJagProfile !== "not_advertised",
            detail: capabilities.idJagProfile,
          },
          {
            step: "authorization_server_jwt_bearer_grant",
            ok: capabilities.jwtBearerGrant !== "not_advertised",
            detail: capabilities.jwtBearerGrant,
          },
          {
            step: "select_token_endpoint_auth_method",
            ok: true,
            detail: capabilities.selectedTokenEndpointAuthMethod,
          }
        );
      }
      if (mcp) {
        steps.push({
          step: "mcp_xaa_extension",
          ok: mcp.xaaExtension !== "not_advertised",
          detail: mcp.xaaExtension,
        });
      }

      return {
        completed: state.currentStep === "complete",
        issuer,
        ...(state.authzServerIssuer
          ? { authzServerIssuer: state.authzServerIssuer }
          : {}),
        ...(state.tokenEndpoint ? { tokenEndpoint: state.tokenEndpoint } : {}),
        ...(capabilities
          ? { authorizationServerCapabilities: capabilities }
          : {}),
        ...(idJag ? { idJag } : {}),
        ...(redemption ? { redemption } : {}),
        ...(mcp ? { mcp } : {}),
        steps,
        ...(projectFlowError(state) ? { error: projectFlowError(state) } : {}),
      };
    }

    progress("Establishing a valid ID-JAG redemption baseline…");
    const baselineState = await runSharedAttempt(
      config,
      "valid",
      true,
      progress
    );
    const baselineRedemption = projectRedemption(baselineState);
    const capabilities = projectCapabilities(baselineState, config);
    const baselineStatus = baselineRedemption?.status ?? 0;
    const baselineAccepted = baselineRedemption?.tokenIssued === true;
    const baselineSteps = projectSteps(baselineState, "baseline:");

    if (!baselineAccepted) {
      return {
        completed: false,
        issuer,
        ...(baselineState.authzServerIssuer
          ? { authzServerIssuer: baselineState.authzServerIssuer }
          : {}),
        ...(baselineState.tokenEndpoint
          ? { tokenEndpoint: baselineState.tokenEndpoint }
          : {}),
        ...(capabilities
          ? { authorizationServerCapabilities: capabilities }
          : {}),
        negativeProbe: {
          mode,
          baselineAccepted: false,
          baselineStatus,
          ...(baselineRedemption?.error
            ? { baselineError: baselineRedemption.error }
            : {}),
          outcome: "inconclusive",
        },
        steps: [...publicationStep, ...baselineSteps],
        error:
          projectFlowError(baselineState) ??
          "The valid baseline was not accepted, so the negative probe cannot be scored.",
      };
    }

    const probeState = await runSharedAttempt(config, mode, false, progress);
    const redemption = projectRedemption(probeState);
    const idJag = projectIdJag(probeState, issuer);
    const outcome = probeState.negativeProbe?.outcome ?? "inconclusive";
    const steps = [
      ...publicationStep,
      ...baselineSteps,
      ...projectSteps(probeState, "probe:"),
    ];

    return {
      completed: outcome === "rejected",
      issuer,
      ...(probeState.authzServerIssuer
        ? { authzServerIssuer: probeState.authzServerIssuer }
        : {}),
      ...(probeState.tokenEndpoint
        ? { tokenEndpoint: probeState.tokenEndpoint }
        : {}),
      ...(capabilities
        ? { authorizationServerCapabilities: capabilities }
        : {}),
      ...(idJag ? { idJag } : {}),
      ...(redemption ? { redemption } : {}),
      negativeProbe: {
        mode,
        baselineAccepted: true,
        baselineStatus,
        outcome,
      },
      steps,
      ...(outcome === "accepted"
        ? {
            error:
              "The authorization server accepted the deliberately invalid ID-JAG.",
          }
        : outcome === "inconclusive"
        ? {
            error:
              projectFlowError(probeState) ??
              "The negative probe did not produce a conclusive 4xx rejection.",
          }
        : {}),
    };
  } catch (error) {
    return {
      completed: false,
      issuer,
      steps: publicationStep,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
