import { canonicalizeResourceUrl } from "../../oauth/state-machines/shared/urls.js";
import type { OAuthFlowState } from "../../oauth/state-machines/types.js";
import type {
  NormalizedOAuthConformanceConfig,
  OAuthConformanceCheckId,
  StepResult,
  TrackedRequestFn,
} from "../types.js";

type OAuthNegativeCheckStep = Extract<
  OAuthConformanceCheckId,
  "oauth_invalid_client" | "oauth_invalid_redirect"
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
    body: Record<string, string>;
  },
  error: unknown,
): OAuthNegativeCheckOutcome {
  return {
    step,
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: {
      message: `Token endpoint request failed: ${error instanceof Error ? error.message : String(error)}`,
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

  return {
    step: "oauth_invalid_redirect",
    status: "passed",
    durationMs: Date.now() - startedAt,
  };
}
