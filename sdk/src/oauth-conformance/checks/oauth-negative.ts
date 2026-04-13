import { canonicalizeResourceUrl } from "../../oauth/state-machines/shared/urls.js";
import { getConformanceAuthCodeDynamicRegistrationMetadata } from "../../oauth/client-identity.js";
import type { OAuthFlowState } from "../../oauth/state-machines/types.js";
import {
  buildInitializeRequestBody,
  resolveInitializeProtocolVersion,
} from "../../oauth/state-machines/shared/initialize.js";
import { resolveRequestedScopeValue } from "../../oauth/state-machines/shared/challenges.js";
import type {
  NormalizedOAuthConformanceConfig,
  OAuthConformanceCheckId,
  StepResult,
  TrackedRequestFn,
} from "../types.js";

type OAuthNegativeCheckStep = Extract<
  OAuthConformanceCheckId,
  | "oauth_dcr_http_redirect_uri"
  | "oauth_invalid_client"
  | "oauth_invalid_authorize_redirect"
  | "oauth_invalid_token"
  | "oauth_invalid_redirect"
>;

export interface OAuthNegativeCheckOutcome {
  step: OAuthNegativeCheckStep;
  status: StepResult["status"];
  durationMs: number;
  error?: StepResult["error"];
}

interface OAuthNegativeCheckInput {
  config: NormalizedOAuthConformanceConfig;
  state: OAuthFlowState;
  trackedRequest: TrackedRequestFn;
  redirectUrl: string;
}

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function buildTransportFailure(
  step: OAuthNegativeCheckStep,
  startedAt: number,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: Record<string, unknown>;
  },
  error: unknown,
  messagePrefix = "Token endpoint request failed",
): OAuthNegativeCheckOutcome {
  return {
    step,
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: {
      message: `${messagePrefix}: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        request,
        error: errorDetails(error),
      },
    },
  };
}

function buildTokenRequestHeaders(
  config: NormalizedOAuthConformanceConfig,
): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(config.customHeaders ?? {}),
  };
}

function buildInvalidTokenMcpRequest(
  input: OAuthNegativeCheckInput,
): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const headers: Record<string, string> = {
    ...(input.config.customHeaders ?? {}),
    Authorization: "Bearer invalid-access-token",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (input.config.protocolVersion !== "2025-03-26") {
    headers["MCP-Protocol-Version"] = input.config.protocolVersion;
  }

  return {
    method: "POST",
    url: input.config.serverUrl,
    headers,
    body: buildInitializeRequestBody({
      protocolVersion: resolveInitializeProtocolVersion(
        input.config.protocolVersion,
      ),
      authMode: input.config.auth.mode,
      clientName: "MCPJam SDK OAuth Conformance",
      clientVersion: "1.0.0",
      id: 999,
    }),
  };
}

function buildJsonRequestHeaders(
  config: NormalizedOAuthConformanceConfig,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.customHeaders ?? {}),
  };
}

function buildAuthorizeRequestHeaders(
  config: NormalizedOAuthConformanceConfig,
): Record<string, string> {
  return {
    Accept: "text/html, application/json",
    ...(config.customHeaders ?? {}),
  };
}

function buildTokenRequestBody(
  input: OAuthNegativeCheckInput,
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const body: Record<string, string> = {};
  const resource = canonicalizeResourceUrl(input.config.serverUrl);
  const state = input.state;

  if (input.config.auth.mode === "client_credentials") {
    body.grant_type = "client_credentials";
    body.client_id = state.clientId ?? input.config.auth.clientId;
    body.client_secret = state.clientSecret ?? input.config.auth.clientSecret;
    if (input.config.scopes) {
      body.scope = input.config.scopes;
    }
    body.resource = resource;
  } else {
    body.grant_type = "authorization_code";
    body.client_id = state.clientId ?? "unknown-client";
    if (state.clientSecret) {
      body.client_secret = state.clientSecret;
    }
    body.code = state.authorizationCode ?? "missing-authorization-code";
    body.redirect_uri = input.redirectUrl;
    if (state.codeVerifier) {
      body.code_verifier = state.codeVerifier;
    }
    body.resource = resource;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete body[key];
    } else {
      body[key] = value;
    }
  }

  return body;
}

function responseLooksRejected(response: {
  ok: boolean;
  status: number;
  body: unknown;
}): boolean {
  if (!response.ok || response.status >= 400) {
    return true;
  }

  return (
    !!response.body &&
    typeof response.body === "object" &&
    "error" in response.body
  );
}

function summarizeResponseBody(body: unknown): string | undefined {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string") {
    return body;
  }

  if (typeof body !== "object") {
    return String(body);
  }

  const record = body as Record<string, unknown>;
  const prioritizedKeys = [
    "error_description",
    "error",
    "message",
    "title",
    "detail",
    "description",
  ];

  for (const key of prioritizedKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function rejectionLooksRedirectSpecific(response: {
  body: unknown;
}): boolean {
  const summary = summarizeResponseBody(response.body)?.toLowerCase();
  if (!summary) {
    return false;
  }

  return (
    summary.includes("redirect_uri") ||
    summary.includes("redirect uri") ||
    summary.includes("redirect")
  );
}

function redirectLocationTargetsUri(
  location: string,
  redirectUri: string,
): boolean {
  try {
    const normalizedLocation = new URL(location);
    const normalizedRedirect = new URL(redirectUri);

    if (
      normalizedLocation.origin !== normalizedRedirect.origin ||
      normalizedLocation.pathname !== normalizedRedirect.pathname
    ) {
      return false;
    }

    for (const [key, value] of normalizedRedirect.searchParams.entries()) {
      if (normalizedLocation.searchParams.get(key) !== value) {
        return false;
      }
    }

    return true;
  } catch {
    return (
      location === redirectUri ||
      location.startsWith(`${redirectUri}?`) ||
      location.startsWith(`${redirectUri}&`) ||
      location.startsWith(`${redirectUri}#`)
    );
  }
}

export async function runDcrHttpRedirectUriCheck(
  input: OAuthNegativeCheckInput,
): Promise<OAuthNegativeCheckOutcome> {
  const registrationEndpoint =
    input.state.authorizationServerMetadata?.registration_endpoint;
  const startedAt = Date.now();

  if (!registrationEndpoint) {
    return {
      step: "oauth_dcr_http_redirect_uri",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "Registration endpoint is unavailable for redirect URI policy testing",
      },
    };
  }

  const redirectUri = "http://evil.example/callback";
  const request = {
    method: "POST",
    url: registrationEndpoint,
    headers: buildJsonRequestHeaders(input.config),
    body: {
      ...getConformanceAuthCodeDynamicRegistrationMetadata(),
      redirect_uris: [redirectUri],
    },
  };
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_dcr_http_redirect_uri",
      startedAt,
      request,
      error,
      "Dynamic client registration request failed",
    );
  }

  if (responseLooksRejected(response)) {
    const rejectionSummary = summarizeResponseBody(response.body);
    if (!rejectionLooksRedirectSpecific(response)) {
      return {
        step: "oauth_dcr_http_redirect_uri",
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: {
          message: rejectionSummary
            ? `Dynamic client registration was rejected for a non-redirect reason: ${rejectionSummary}`
            : "Dynamic client registration was rejected, but redirect_uri validation was not isolated.",
          details: {
            redirectUri,
            response: response.body,
            evidence: rejectionSummary
              ? `Received ${response.status} ${response.statusText} with ${rejectionSummary}.`
              : `Received ${response.status} ${response.statusText} without a redirect-specific error.`,
          },
        },
      };
    }

    return {
      step: "oauth_dcr_http_redirect_uri",
      status: "passed",
      durationMs: Date.now() - startedAt,
    };
  }

  const clientId =
    response.body &&
    typeof response.body === "object" &&
    typeof (response.body as Record<string, unknown>).client_id === "string"
      ? ((response.body as Record<string, unknown>).client_id as string)
      : undefined;

  return {
    step: "oauth_dcr_http_redirect_uri",
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: {
      message:
        "Authorization server accepted a non-loopback http redirect_uri during dynamic client registration",
      details: {
        redirectUri,
        clientId,
        response: response.body,
        evidence: clientId
          ? `Registered redirect_uri ${redirectUri} was accepted and returned client_id ${clientId}.`
          : `Registered redirect_uri ${redirectUri} was accepted.`,
      },
    },
  };
}

export async function runInvalidClientCheck(
  input: OAuthNegativeCheckInput,
): Promise<OAuthNegativeCheckOutcome> {
  const tokenEndpoint = input.state.authorizationServerMetadata?.token_endpoint;
  const startedAt = Date.now();

  if (!tokenEndpoint) {
    return {
      step: "oauth_invalid_client",
      status: "skipped",
      durationMs: 0,
      error: {
        message: "Token endpoint is unavailable for invalid-client testing",
      },
    };
  }

  const request = {
    method: "POST",
    url: tokenEndpoint,
    headers: buildTokenRequestHeaders(input.config),
    body: buildTokenRequestBody(input, {
      client_id: "invalid-client-id",
    }),
  };
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_invalid_client",
      startedAt,
      request,
      error,
    );
  }

  if (!responseLooksRejected(response)) {
    return {
      step: "oauth_invalid_client",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        message: "Authorization server accepted a token request with an invalid client_id",
        details: response.body,
      },
    };
  }

  return {
    step: "oauth_invalid_client",
    status: "passed",
    durationMs: Date.now() - startedAt,
  };
}

export async function runInvalidAuthorizeRedirectCheck(
  input: OAuthNegativeCheckInput,
): Promise<OAuthNegativeCheckOutcome> {
  const authorizationEndpoint =
    input.state.authorizationServerMetadata?.authorization_endpoint;
  const startedAt = Date.now();

  if (!authorizationEndpoint) {
    return {
      step: "oauth_invalid_authorize_redirect",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "Authorization endpoint is unavailable for invalid redirect_uri testing",
      },
    };
  }

  if (input.config.auth.mode === "client_credentials") {
    return {
      step: "oauth_invalid_authorize_redirect",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "redirect_uri validation at the authorization endpoint does not apply to client_credentials flows",
      },
    };
  }

  const clientId = input.state.clientId;
  if (!clientId) {
    return {
      step: "oauth_invalid_authorize_redirect",
      status: "skipped",
      durationMs: 0,
      error: {
        message:
          "Client identifier is unavailable for invalid redirect_uri authorization testing",
      },
    };
  }

  const invalidRedirectUri = `${input.redirectUrl}?invalid=1`;
  const authorizeUrl = new URL(authorizationEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", invalidRedirectUri);
  authorizeUrl.searchParams.set(
    "code_challenge",
    input.state.codeChallenge ?? "invalid-redirect-check-challenge",
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set(
    "state",
    input.state.state ?? "invalid-redirect-check-state",
  );
  authorizeUrl.searchParams.set(
    "resource",
    canonicalizeResourceUrl(input.config.serverUrl),
  );

  const requestedScopeValue = resolveRequestedScopeValue({
    customScopes: input.config.scopes,
    challengedScopes: input.state.challengedScopes,
    supportedScopes:
      input.state.resourceMetadata?.scopes_supported ??
      input.state.authorizationServerMetadata?.scopes_supported,
  });
  if (requestedScopeValue) {
    authorizeUrl.searchParams.set("scope", requestedScopeValue);
  }

  const request = {
    method: "GET",
    url: authorizeUrl.toString(),
    headers: buildAuthorizeRequestHeaders(input.config),
  };
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request, { redirect: "manual" });
  } catch (error) {
    return buildTransportFailure(
      "oauth_invalid_authorize_redirect",
      startedAt,
      request,
      error,
      "Authorization request failed",
    );
  }

  const location = response.headers.location;
  if (typeof location === "string") {
    if (redirectLocationTargetsUri(location, invalidRedirectUri)) {
      return {
        step: "oauth_invalid_authorize_redirect",
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: {
          message:
            "Authorization server redirected the user agent to an invalid redirect_uri",
          details: {
            redirectUri: invalidRedirectUri,
            location,
            evidence: `Authorization endpoint responded with Location: ${location}.`,
          },
        },
      };
    }

    return {
      step: "oauth_invalid_authorize_redirect",
      status: "skipped",
      durationMs: Date.now() - startedAt,
      error: {
        message:
          "Authorization request redirected elsewhere before redirect_uri validation was isolated",
        details: {
          redirectUri: invalidRedirectUri,
          location,
        },
      },
    };
  }

  const rejectionSummary = summarizeResponseBody(response.body);
  if (responseLooksRejected(response)) {
    if (!rejectionLooksRedirectSpecific(response)) {
      return {
        step: "oauth_invalid_authorize_redirect",
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: {
          message: rejectionSummary
            ? `Authorization request was rejected for a non-redirect reason: ${rejectionSummary}`
            : "Authorization request was rejected, but redirect_uri validation was not isolated.",
          details: {
            redirectUri: invalidRedirectUri,
            response: response.body,
            evidence: rejectionSummary
              ? `Received ${response.status} ${response.statusText} with ${rejectionSummary}.`
              : `Received ${response.status} ${response.statusText} without a redirect-specific error.`,
          },
        },
      };
    }

    return {
      step: "oauth_invalid_authorize_redirect",
      status: "passed",
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    step: "oauth_invalid_authorize_redirect",
    status: "skipped",
    durationMs: Date.now() - startedAt,
    error: {
      message:
        "Authorization request did not produce an explicit redirect_uri validation error",
      details: {
        redirectUri: invalidRedirectUri,
        status: response.status,
        statusText: response.statusText,
        response: response.body,
      },
    },
  };
}

export async function runInvalidTokenCheck(
  input: OAuthNegativeCheckInput,
): Promise<OAuthNegativeCheckOutcome> {
  const startedAt = Date.now();
  const request = buildInvalidTokenMcpRequest(input);
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_invalid_token",
      startedAt,
      request,
      error,
      "Authenticated MCP request failed",
    );
  }

  if (response.status === 401) {
    return {
      step: "oauth_invalid_token",
      status: "passed",
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    step: "oauth_invalid_token",
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: {
      message: `MCP server accepted or mishandled an invalid bearer token (expected HTTP 401, received ${response.status})`,
      details: {
        response: response.body,
        status: response.status,
        statusText: response.statusText,
      },
    },
  };
}

export async function runInvalidRedirectCheck(
  input: OAuthNegativeCheckInput,
): Promise<OAuthNegativeCheckOutcome> {
  const tokenEndpoint = input.state.authorizationServerMetadata?.token_endpoint;
  const startedAt = Date.now();

  if (!tokenEndpoint) {
    return {
      step: "oauth_invalid_redirect",
      status: "skipped",
      durationMs: 0,
      error: {
        message: "Token endpoint is unavailable for invalid-redirect testing",
      },
    };
  }

  if (input.config.auth.mode === "client_credentials") {
    return {
      step: "oauth_invalid_redirect",
      status: "skipped",
      durationMs: 0,
      error: {
        message: "redirect_uri validation does not apply to client_credentials flows",
      },
    };
  }

  const request = {
    method: "POST",
    url: tokenEndpoint,
    headers: buildTokenRequestHeaders(input.config),
    body: buildTokenRequestBody(input, {
      redirect_uri: `${input.redirectUrl}?invalid=1`,
    }),
  };
  let response: Awaited<ReturnType<TrackedRequestFn>>;

  try {
    response = await input.trackedRequest(request);
  } catch (error) {
    return buildTransportFailure(
      "oauth_invalid_redirect",
      startedAt,
      request,
      error,
    );
  }

  if (!responseLooksRejected(response)) {
    return {
      step: "oauth_invalid_redirect",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        message:
          "Authorization server accepted a token request with a mismatched redirect_uri",
        details: response.body,
      },
    };
  }

  const rejectionSummary = summarizeResponseBody(response.body);
  if (!rejectionLooksRedirectSpecific(response)) {
    return {
      step: "oauth_invalid_redirect",
      status: "skipped",
      durationMs: Date.now() - startedAt,
      error: {
        message: rejectionSummary
          ? `Token request was rejected for a non-redirect reason: ${rejectionSummary}`
          : "Token request was rejected, but redirect_uri validation was not isolated.",
        details: {
          response: response.body,
          evidence: rejectionSummary
            ? `Received ${response.status} ${response.statusText} with ${rejectionSummary}.`
            : `Received ${response.status} ${response.statusText} without a redirect-specific error.`,
        },
      },
    };
  }

  return {
    step: "oauth_invalid_redirect",
    status: "passed",
    durationMs: Date.now() - startedAt,
  };
}
