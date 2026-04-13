import { canonicalizeResourceUrl } from "../../oauth/state-machines/shared/urls.js";
import { getConformanceAuthCodeDynamicRegistrationMetadata } from "../../oauth/client-identity.js";
import type { OAuthFlowState } from "../../oauth/state-machines/types.js";
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
    body: Record<string, unknown>;
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

function buildJsonRequestHeaders(
  config: NormalizedOAuthConformanceConfig,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.customHeaders ?? {}),
  };
}

function buildTokenRequestBody(
  input: OAuthNegativeCheckInput,
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const body: Record<string, string> = {};
  const state = input.state;

  if (input.config.auth.mode === "client_credentials") {
    body.grant_type = "client_credentials";
    body.client_id = state.clientId ?? input.config.auth.clientId;
    body.client_secret = state.clientSecret ?? input.config.auth.clientSecret;
    if (input.config.scopes) {
      body.scope = input.config.scopes;
    }
    body.resource = canonicalizeResourceUrl(input.config.serverUrl);
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
