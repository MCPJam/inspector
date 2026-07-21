import { createHash, randomUUID } from "node:crypto";
import {
  evaluateIdJagClientMetadata,
  executeDynamicClientRegistration,
  getXaaConnectClientMetadata,
  type XaaTokenEndpointAuthMethod,
} from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import { executeOAuthProxy, validateUrl } from "../utils/oauth-proxy.js";
import { postToConvexAuthorized } from "../utils/server-secrets.js";
import { logger } from "../utils/logger.js";

const DCR_ROUTE = "/web/xaa/server/dcr-registration";
const DCR_REQUEST_TIMEOUT_MS = 15_000;
const DCR_REUSE_EXPIRY_SKEW_MS = 30_000;
const DCR_POLL_ATTEMPTS = 20;
const DCR_POLL_INTERVAL_MS = 250;
const RFC_7591_RETRYABLE_ERRORS = new Set([
  "invalid_redirect_uri",
  "invalid_client_metadata",
  "invalid_software_statement",
  "unapproved_software_statement",
]);

export interface XaaDcrRegistration {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
}

interface StoredDcrState {
  clientId: string | null;
  tokenEndpointAuthMethod: XaaTokenEndpointAuthMethod | null;
  issuer: string | null;
  clientSecretExpiresAt: number | null;
  fingerprint: string | null;
  registeredAt: number | null;
  status: "registered" | "registering" | "uncertain" | null;
  attemptFingerprint: string | null;
  attemptStartedAt: number | null;
  leaseExpiresAt: number | null;
}

interface DcrBackendArgs {
  bearerToken: string;
  projectId: string;
  serverId: string;
}

export interface XaaDcrAuthorizedTarget {
  serverUrl: string;
  xaaAuthzIssuer?: string;
  xaaAllowPathScopedIssuer: boolean;
}

function dcrBackendPost(
  args: DcrBackendArgs,
  body: Record<string, unknown>
): Promise<any> {
  return postToConvexAuthorized({
    path: DCR_ROUTE,
    bearerToken: args.bearerToken,
    body: {
      projectId: args.projectId,
      serverId: args.serverId,
      ...body,
    },
    serviceName: "XAA DCR persistence service",
    requireInspectorServiceToken: true,
  });
}

async function fetchRegistration(args: DcrBackendArgs): Promise<{
  state: StoredDcrState;
  clientSecret?: string;
}> {
  const body = await dcrBackendPost(args, { action: "get" });
  return {
    state: body.state as StoredDcrState,
    ...(typeof body.clientSecret === "string"
      ? { clientSecret: body.clientSecret }
      : {}),
  };
}

/** Resolve the non-secret stored target through the same project-scoped
 * authorization gate used for all DCR state operations. */
export async function fetchXaaDcrAuthorizedTarget(
  args: DcrBackendArgs
): Promise<XaaDcrAuthorizedTarget> {
  const body = await dcrBackendPost(args, { action: "get" });
  const target = body?.target as Record<string, unknown> | undefined;
  const serverUrl =
    typeof target?.serverUrl === "string" ? target.serverUrl.trim() : "";
  if (!serverUrl) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The server has no URL to use as the XAA protected resource"
    );
  }
  return {
    serverUrl,
    ...(typeof target?.xaaAuthzIssuer === "string" &&
    target.xaaAuthzIssuer.trim()
      ? { xaaAuthzIssuer: target.xaaAuthzIssuer.trim() }
      : {}),
    xaaAllowPathScopedIssuer: target?.xaaAllowPathScopedIssuer === true,
  };
}

export function normalizeXaaDcrScope(scope: string | undefined): string {
  return Array.from(
    new Set(
      (scope ?? "")
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)
    )
  )
    .sort()
    .join(" ");
}

export function buildXaaConnectDcrFingerprint(args: {
  resource: string;
  registrationEndpoint: string;
  scope?: string;
}): string {
  const canonical = [
    "connect-v1",
    args.resource,
    args.registrationEndpoint,
    normalizeXaaDcrScope(args.scope),
  ].join("\0");
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

function canonicalIssuerIdentity(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
  } catch {
    const trimmed = value.trim();
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

function reusableRegistration(
  fetched: Awaited<ReturnType<typeof fetchRegistration>>,
  fingerprint: string,
  issuer: string
): XaaDcrRegistration | null {
  const { state, clientSecret } = fetched;
  if (
    state.status !== "registered" ||
    state.fingerprint !== fingerprint ||
    !state.clientId ||
    !state.tokenEndpointAuthMethod
  ) {
    return null;
  }
  if (
    state.tokenEndpointAuthMethod !== "none" &&
    state.clientSecretExpiresAt != null &&
    state.clientSecretExpiresAt <= Date.now() + DCR_REUSE_EXPIRY_SKEW_MS
  ) {
    return null;
  }
  if (
    !state.issuer ||
    canonicalIssuerIdentity(state.issuer) !== canonicalIssuerIdentity(issuer)
  ) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      'The stored XAA DCR client belongs to a different authorization server issuer. Use "Register a new client" before connecting.'
    );
  }
  if (state.tokenEndpointAuthMethod !== "none" && !clientSecret) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "The stored XAA DCR registration is missing its client secret. Register a new client."
    );
  }
  if (state.tokenEndpointAuthMethod === "none" && clientSecret) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "The stored XAA DCR registration is inconsistent. Register a new client."
    );
  }
  return {
    clientId: state.clientId,
    tokenEndpointAuthMethod: state.tokenEndpointAuthMethod,
    ...(clientSecret ? { clientSecret } : {}),
  };
}

function uncertainError(): WebRouteError {
  return new WebRouteError(
    409,
    ErrorCode.VALIDATION_ERROR,
    'The previous XAA registration attempt may have created a remote client. Use "Register a new client" before retrying.'
  );
}

function registrationErrorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const value = body as Record<string, unknown>;
  const code = typeof value.error === "string" ? value.error : undefined;
  const description =
    typeof value.error_description === "string"
      ? value.error_description.slice(0, 300)
      : undefined;
  return [code, description].filter(Boolean).join(": ") || undefined;
}

function isRetryableRfc7591Rejection(outcome: {
  response: { status: number; body: unknown };
}): boolean {
  const { status, body } = outcome.response;
  if (status < 400 || status >= 500 || !body || typeof body !== "object") {
    return false;
  }
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && RFC_7591_RETRYABLE_ERRORS.has(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureXaaDcrRegistration(
  args: DcrBackendArgs & {
    resource: string;
    registrationEndpoint: string;
    issuer: string;
    scope?: string;
    httpsOnly: boolean;
  }
): Promise<XaaDcrRegistration> {
  if (!process.env.CONVEX_HTTP_URL || !process.env.INSPECTOR_SERVICE_TOKEN) {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "XAA DCR persistence is not configured on this Inspector instance"
    );
  }
  if (!args.resource || !args.registrationEndpoint) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "The authorization server does not advertise a registration_endpoint. Choose pre-registered credentials or CIMD."
    );
  }
  const normalizedScope = normalizeXaaDcrScope(args.scope);
  const fingerprint = buildXaaConnectDcrFingerprint({
    resource: args.resource,
    registrationEndpoint: args.registrationEndpoint,
    scope: normalizedScope,
  });
  const initial = await fetchRegistration(args);
  const initialReusable = reusableRegistration(
    initial,
    fingerprint,
    args.issuer
  );
  if (initialReusable) return initialReusable;
  if (initial.state.status === "uncertain") throw uncertainError();

  // Resolve DNS and apply the same URL/SSRF policy as the eventual POST only
  // after ruling out a reusable registration. Reconnects never contact the
  // registration endpoint, so its current reachability must not block minting
  // with an already-issued client.
  await validateUrl(args.registrationEndpoint, args.httpsOnly);

  const holderId = randomUUID();
  const claim = await dcrBackendPost(args, {
    action: "claim",
    fingerprint,
    holderId,
  });
  if (claim.reason === "uncertain") throw uncertainError();
  if (claim.reason === "registered") {
    const fetched = await fetchRegistration(args);
    const registration = reusableRegistration(
      fetched,
      fingerprint,
      args.issuer
    );
    if (registration) return registration;
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "The shared XAA DCR registration changed while it was being loaded"
    );
  }
  if (!claim.acquired) {
    for (let attempt = 0; attempt < DCR_POLL_ATTEMPTS; attempt += 1) {
      await delay(DCR_POLL_INTERVAL_MS);
      const fetched = await fetchRegistration(args);
      const registration = reusableRegistration(
        fetched,
        fingerprint,
        args.issuer
      );
      if (registration) return registration;
      if (fetched.state.status === "uncertain") throw uncertainError();
    }
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "Another XAA client registration is still in progress. Try connecting again shortly."
    );
  }

  const request = {
    method: "POST",
    url: args.registrationEndpoint,
    headers: { "Content-Type": "application/json" },
    body: getXaaConnectClientMetadata({
      scope: normalizedScope || undefined,
    }),
    redirect: "manual" as const,
  };
  const started = await dcrBackendPost(args, {
    action: "markStarted",
    fingerprint,
    holderId,
  });
  if (!started.started) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "The XAA DCR lease expired before registration started"
    );
  }

  const markUncertain = async (reason: string): Promise<void> => {
    try {
      await dcrBackendPost(args, {
        action: "markUncertain",
        fingerprint,
        holderId,
        reason,
      });
    } catch (error) {
      logger.error(
        "[XAA connect] failed to persist uncertain DCR state",
        error,
        {
          serverId: args.serverId,
          projectId: args.projectId,
          reason,
        }
      );
      // The durable started-at marker still makes an expired lease uncertain.
    }
  };
  const failAmbiguous = async (
    reason: string,
    message: string
  ): Promise<never> => {
    await markUncertain(reason);
    throw new WebRouteError(409, ErrorCode.VALIDATION_ERROR, message);
  };

  const outcome = await executeDynamicClientRegistration({
    request,
    requestExecutor: async (registrationRequest) => {
      const response = await executeOAuthProxy({
        url: registrationRequest.url,
        method: registrationRequest.method,
        headers: registrationRequest.headers,
        body: registrationRequest.body,
        redirect: "manual",
        httpsOnly: args.httpsOnly,
        timeoutMs: DCR_REQUEST_TIMEOUT_MS,
      });
      return {
        ...response,
        ok: response.status >= 200 && response.status < 300,
      };
    },
  });

  if (outcome.status !== "registered") {
    if (
      outcome.status === "http_error" &&
      isRetryableRfc7591Rejection(outcome)
    ) {
      await dcrBackendPost(args, {
        action: "release",
        fingerprint,
        holderId,
      });
      const detail = registrationErrorDetail(outcome.response.body);
      throw new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        `The authorization server rejected dynamic client registration${
          detail ? `: ${detail}` : ""
        }`
      );
    }
    return failAmbiguous(
      outcome.status,
      `${outcome.error}. The result is uncertain; register a new client before retrying.`
    );
  }

  const clientId = outcome.credentials.clientId?.trim();
  if (!clientId) {
    return failAmbiguous(
      "missing_client_id",
      "Registration succeeded without a usable client_id. Register a new client before retrying."
    );
  }
  const evaluation = evaluateIdJagClientMetadata(outcome.clientInfo);
  if (evaluation.profile === "contradicted") {
    return failAmbiguous(
      "id_jag_profile_contradicted",
      "Registration succeeded, but the authorization server substituted a non-ID-JAG client profile."
    );
  }
  if (evaluation.jwtBearerGrant === "contradicted") {
    return failAmbiguous(
      "jwt_bearer_grant_contradicted",
      "Registration succeeded, but the registered client cannot use the JWT Bearer grant."
    );
  }
  if (
    evaluation.profile === "omitted" ||
    evaluation.jwtBearerGrant === "omitted"
  ) {
    logger.warn(
      "[XAA connect] DCR response omitted requested ID-JAG metadata",
      {
        serverId: args.serverId,
        projectId: args.projectId,
        profileEvidence: evaluation.profile,
        jwtBearerEvidence: evaluation.jwtBearerGrant,
      }
    );
  }

  const clientSecret = outcome.credentials.clientSecret;
  const rawMethod = outcome.clientInfo.token_endpoint_auth_method;
  let tokenEndpointAuthMethod: XaaTokenEndpointAuthMethod;
  if (rawMethod === undefined) {
    tokenEndpointAuthMethod = clientSecret ? "client_secret_post" : "none";
    logger.warn("[XAA connect] DCR response omitted client auth method", {
      serverId: args.serverId,
      projectId: args.projectId,
      inferredMethod: tokenEndpointAuthMethod,
    });
  } else if (
    rawMethod === "client_secret_post" ||
    rawMethod === "client_secret_basic" ||
    rawMethod === "none"
  ) {
    tokenEndpointAuthMethod = rawMethod;
  } else {
    return failAmbiguous(
      "unsupported_client_auth_method",
      "Registration succeeded with an unsupported client authentication method."
    );
  }
  if (tokenEndpointAuthMethod !== "none" && !clientSecret) {
    return failAmbiguous(
      "missing_client_secret",
      "Registration succeeded with a secret-based authentication method but no client_secret."
    );
  }
  if (tokenEndpointAuthMethod === "none" && clientSecret) {
    return failAmbiguous(
      "secret_for_public_client",
      'Registration returned a client_secret together with token_endpoint_auth_method "none".'
    );
  }

  const expiresAtSeconds = outcome.credentials.clientSecretExpiresAt;
  if (
    expiresAtSeconds !== undefined &&
    (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds < 0)
  ) {
    return failAmbiguous(
      "invalid_secret_expiry",
      "Registration returned an invalid client_secret_expires_at value."
    );
  }
  if (
    clientSecret &&
    expiresAtSeconds !== undefined &&
    expiresAtSeconds !== 0 &&
    expiresAtSeconds <= Math.floor(Date.now() / 1000)
  ) {
    return failAmbiguous(
      "expired_client_secret",
      "Registration returned a client_secret that is already expired."
    );
  }
  const clientSecretExpiresAt =
    expiresAtSeconds && expiresAtSeconds > 0
      ? expiresAtSeconds * 1000
      : undefined;

  try {
    await dcrBackendPost(args, {
      action: "store",
      fingerprint,
      holderId,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(typeof outcome.clientInfo.registration_access_token === "string"
        ? {
            registrationAccessToken:
              outcome.clientInfo.registration_access_token,
          }
        : {}),
      ...(typeof outcome.clientInfo.registration_client_uri === "string"
        ? { registrationClientUri: outcome.clientInfo.registration_client_uri }
        : {}),
      tokenEndpointAuthMethod,
      issuer: args.issuer,
      ...(clientSecretExpiresAt ? { clientSecretExpiresAt } : {}),
    });
  } catch (error) {
    await markUncertain("store_failed");
    throw error;
  }

  return {
    clientId,
    tokenEndpointAuthMethod,
    ...(clientSecret ? { clientSecret } : {}),
  };
}
