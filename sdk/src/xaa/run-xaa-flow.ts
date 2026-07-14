// Headless Cross-App Access (ID-JAG) flow driver. It self-issues an ID-JAG,
// verifies that the configured issuer actually publishes the signing key,
// redeems the assertion, and probes the protected MCP resource.
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
  validateUrl,
} from "../oauth-proxy.js";
import {
  getXAAIdpJwks,
  getXAAIssuerUrl,
  initXAAIdpKeyPair,
} from "./mint/keypair.js";
import { verifyXaaJwt } from "./mint/signer.js";
import type { XaaTokenEndpointAuthMethod } from "./mint/jwt-bearer.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type IdentityAssertionFormat,
  type NegativeTestMode,
  type SubjectIdentifierFormat,
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
  deriveCapabilityEvidence,
  selectTokenEndpointAuthMethod,
} from "./state-machines/capability-preflight.js";
import {
  createInitialXAAFlowState,
  type XAAFlowState,
  type XaaDcrCredentialCache,
  type XaaEphemeralDcrCredentials,
  type XaaRegistrationWarning,
} from "./state-machines/types.js";
import { type RegistrationStrategy } from "../registration.js";

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
  /** Pre-registered client id. Optional: DCR mints it, CIMD derives it from the
   * metadata-document URL. Required only for the `preregistered` strategy. */
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod;
  /** Client-registration strategy. Defaults to `preregistered`. */
  registrationStrategy?: RegistrationStrategy;
  /** CIMD only: the Client ID Metadata Document URL. Defaults to the hosted
   * XAA debugger document. */
  clientIdMetadataUrl?: string;
  /** Local-dev-only opt-in: permit an http:// loopback CIMD document URL (a
   * locally-run reflector). Never affects public/remote URLs. */
  allowLoopbackClientMetadata?: boolean;
  negativeTestMode?: NegativeTestMode;
  /** Input axis: assertion format the mock IdP mints ("oidc" default). */
  identityAssertionFormat?: IdentityAssertionFormat;
  /** Output axis: mint a saml-nameid `sub_id` into the ID-JAG when
   * "saml-nameid" ("oauth-sub" default). Independent of the input axis. */
  subjectIdentifierFormat?: SubjectIdentifierFormat;
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
  /** How the client identity was obtained. Secret-free: never carries the
   * DCR-minted client_secret. `warnings` surfaces non-blocking findings such as
   * the public-client CIMD warning. */
  registration?: {
    strategy: RegistrationStrategy;
    clientId?: string;
    /** A prior session registration was reused rather than minting a new one
     * (e.g. the negative probe reused the baseline's DCR client). */
    reused: boolean;
    warnings: XaaRegistrationWarning[];
  };
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

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
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
      ? ((response.body as { keys: PublishedJwk[] }).keys ?? [])
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
    ok: entry.response.status >= 200 && entry.response.status < 300 && !error,
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
    ...deriveCapabilityEvidence(state.authzMetadata),
    ...(advertisedAuthMethods
      ? { tokenEndpointAuthMethods: advertisedAuthMethods }
      : {}),
    selectedTokenEndpointAuthMethod,
  };
}

// The engine names HTTP steps by protocol operation; the CLI surfaces them in
// ID-JAG spec vocabulary. Projection-only — the engine's XAAFlowStep names are
// unchanged. Steps absent from this map pass through as-is, so the discovery
// steps keep their RFC 9728 / RFC 8414 names.
const CLI_STEP_VOCABULARY: Record<string, string> = {
  token_exchange_request: "mint_id_jag",
  jwt_bearer_request: "redeem_id_jag",
};

function projectSteps(state: XAAFlowState, prefix = ""): XaaFlowStep[] {
  return (state.httpHistory ?? []).map((entry) => ({
    step: prefix + (CLI_STEP_VOCABULARY[entry.step] ?? entry.step),
    ok:
      !entry.error &&
      !!entry.response &&
      entry.response.status >= 200 &&
      entry.response.status < 300,
    detail:
      entry.error?.message ??
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

/** Registration wiring shared across every attempt of a single runXaaFlow call:
 * one strategy, one CIMD URL, and ONE DCR credential cache so the negative
 * baseline + probe reuse a single dynamic registration instead of minting one
 * per attempt. Internal — never exposed on the public XaaFlowConfig. */
interface AttemptContext {
  registrationStrategy: RegistrationStrategy;
  clientIdMetadataUrl?: string;
  allowLoopbackClientMetadata?: boolean;
  dcrCredentialCache: XaaDcrCredentialCache;
  dcrCacheTargetKey: string;
}

/** RFC 8252 loopback host check (for the gated local-dev CIMD carve-out). */
function isLoopbackClientMetadataUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      protocol === "http:" &&
      (h === "localhost" ||
        h.endsWith(".localhost") ||
        h === "127.0.0.1" ||
        h === "::1")
    );
  } catch {
    return false;
  }
}

/** A Map-backed DCR credential cache plus a registration counter (for the
 * `reused` diagnostic) and the set of minted secrets (to scrub any reflected in
 * an RAS error body out of the result — the secret otherwise never enters it). */
function createDcrCredentialCache(): {
  cache: XaaDcrCredentialCache;
  registrations: () => number;
  secrets: () => string[];
} {
  const store = new Map<string, XaaEphemeralDcrCredentials>();
  let registrations = 0;
  return {
    cache: {
      get: (key) => store.get(key),
      set: (key, value) => {
        registrations += 1;
        store.set(key, value);
      },
      delete: (key) => {
        store.delete(key);
      },
    },
    registrations: () => registrations,
    secrets: () =>
      [...store.values()]
        .map((c) => c.clientSecret)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
  };
}

/** Deep-replace every occurrence of any `secrets` string with "[REDACTED]". */
function scrubSecrets(value: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubSecrets(v, secrets)]),
    );
  }
  return value;
}

async function runSharedAttempt(
  config: XaaFlowConfig,
  mode: NegativeTestMode,
  ctx: AttemptContext,
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
    identityAssertionFormat: config.identityAssertionFormat,
    subjectIdentifierFormat: config.subjectIdentifierFormat,
    registrationStrategy: ctx.registrationStrategy,
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
    identityAssertionFormat: config.identityAssertionFormat,
    subjectIdentifierFormat: config.subjectIdentifierFormat,
    userId: config.subject,
    email: config.email,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
    authzServerIssuer: config.authzServerIssuer,
    registrationStrategy: ctx.registrationStrategy,
    clientIdMetadataUrl: ctx.clientIdMetadataUrl,
    allowLoopbackClientMetadata: ctx.allowLoopbackClientMetadata,
    dcrCredentialCache: ctx.dcrCredentialCache,
    dcrCacheTargetKey: ctx.dcrCacheTargetKey,
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

  // One registration context (and one DCR credential cache) for the whole run,
  // so a negative baseline + probe reuse a single dynamic registration.
  const strategy: RegistrationStrategy =
    config.registrationStrategy ?? "preregistered";
  const dcr = createDcrCredentialCache();
  const ctx: AttemptContext = {
    registrationStrategy: strategy,
    clientIdMetadataUrl: config.clientIdMetadataUrl,
    allowLoopbackClientMetadata: config.allowLoopbackClientMetadata,
    dcrCredentialCache: dcr.cache,
    dcrCacheTargetKey: config.serverUrl,
  };
  let attempts = 0;
  // Registration diagnostics accumulate across attempts: the negative probe
  // reuses the baseline's cached DCR client, so its own state carries no
  // clientId/warnings — retain them from whichever attempt registered.
  let capturedClientId: string | undefined;
  let capturedWarnings: XaaRegistrationWarning[] = [];
  const captureRegistration = (state: XAAFlowState) => {
    if (state.clientId) capturedClientId = state.clientId;
    if (state.registrationWarnings && state.registrationWarnings.length > 0)
      capturedWarnings = state.registrationWarnings;
  };
  const registration = (
    state: XAAFlowState | undefined
  ): NonNullable<XaaFlowResult["registration"]> => {
    const clientId = capturedClientId ?? state?.clientId;
    const warnings =
      capturedWarnings.length > 0
        ? capturedWarnings
        : (state?.registrationWarnings ?? []);
    return {
      strategy: state?.registrationStrategy ?? strategy,
      ...(clientId ? { clientId } : {}),
      // DCR reuse: fewer registrations than attempts means a later attempt
      // reused an earlier attempt's cached client. Only DCR registers.
      reused:
        strategy === "dcr" &&
        dcr.registrations() > 0 &&
        attempts > dcr.registrations(),
      warnings,
    };
  };

  // Scrub any DCR-minted secret an RAS may have reflected into a response/error
  // body, so the returned result stays secret-free (the secret is never stored
  // in flow state, so the caller's key-based redactor can't catch it).
  const finalize = (result: XaaFlowResult): XaaFlowResult =>
    scrubSecrets(result, dcr.secrets()) as XaaFlowResult;

  // The dynamic strategies need authorization-server metadata discovery to find
  // the registration endpoint (DCR) or the client_id_metadata_document_supported
  // advertisement (CIMD). A pinned tokenEndpoint skips that discovery, so reject
  // the combination here — not only in the CLI. (`authzServerIssuer` is fine: it
  // only skips protected-resource discovery; AS metadata is still fetched.)
  if (
    (strategy === "dcr" || strategy === "cimd") &&
    config.tokenEndpoint
  ) {
    return {
      completed: false,
      issuer,
      registration: registration(undefined),
      steps: [],
      error:
        `The ${strategy} registration strategy requires authorization-server ` +
        `metadata discovery; remove tokenEndpoint, which skips the discovery ` +
        `that provides the ${
          strategy === "dcr"
            ? "registration_endpoint"
            : "client_id_metadata_document_supported flag"
        }.`,
    };
  }

  // Harden a caller-supplied CIMD metadata URL against SSRF: validate it through
  // the private-host/DNS-resolution path regardless of the local-dev `httpsOnly`
  // default, so an untrusted URL can't turn the preflight into a fetch of an
  // internal address. The hardcoded hosted default is trusted and skips this.
  const skipCimdSsrfForLoopback =
    config.allowLoopbackClientMetadata === true &&
    !!config.clientIdMetadataUrl &&
    isLoopbackClientMetadataUrl(config.clientIdMetadataUrl);
  if (config.clientIdMetadataUrl && !skipCimdSsrfForLoopback) {
    try {
      await validateUrl(config.clientIdMetadataUrl, true);
    } catch (error) {
      return {
        completed: false,
        issuer,
        registration: registration(undefined),
        steps: [],
        error:
          `The client metadata URL was rejected: ${
            error instanceof Error ? error.message : String(error)
          }. It must be an HTTPS URL that does not resolve to a private or ` +
          `reserved address.`,
      };
    }
  }

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
        registration: registration(undefined),
        steps: publicationStep,
        error:
          "The configured issuer does not publish the local signing key; " +
          "the authorization server cannot validate this ID-JAG.",
      };
    }

    const mode = config.negativeTestMode ?? DEFAULT_NEGATIVE_TEST_MODE;
    if (mode === "valid") {
      attempts += 1;
      const state = await runSharedAttempt(config, mode, ctx, false, progress);
      captureRegistration(state);
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

      return finalize({
        completed: state.currentStep === "complete",
        issuer,
        registration: registration(state),
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
      });
    }

    progress("Establishing a valid ID-JAG redemption baseline…");
    attempts += 1;
    const baselineState = await runSharedAttempt(
      config,
      "valid",
      ctx,
      true,
      progress
    );
    captureRegistration(baselineState);
    const baselineRedemption = projectRedemption(baselineState);
    const capabilities = projectCapabilities(baselineState, config);
    const baselineStatus = baselineRedemption?.status ?? 0;
    const baselineAccepted = baselineRedemption?.tokenIssued === true;
    const baselineSteps = projectSteps(baselineState, "baseline:");

    if (!baselineAccepted) {
      return finalize({
        completed: false,
        issuer,
        registration: registration(baselineState),
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
      });
    }

    attempts += 1;
    const probeState = await runSharedAttempt(config, mode, ctx, false, progress);
    captureRegistration(probeState);
    const redemption = projectRedemption(probeState);
    const idJag = projectIdJag(probeState, issuer);
    const outcome = probeState.negativeProbe?.outcome ?? "inconclusive";
    const steps = [
      ...publicationStep,
      ...baselineSteps,
      ...projectSteps(probeState, "probe:"),
    ];

    return finalize({
      completed: outcome === "rejected",
      issuer,
      registration: registration(probeState),
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
    });
  } catch (error) {
    return finalize({
      completed: false,
      issuer,
      registration: registration(undefined),
      steps: publicationStep,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
