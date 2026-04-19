import type { XAAFlowStep, XAAHttpHistoryEntry } from "./types";

function nestedUpstreamStatus(entry: XAAHttpHistoryEntry): number | undefined {
  const body = entry.response?.body;
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "status" in (body as Record<string, unknown>)
  ) {
    const nested = (body as Record<string, unknown>).status;
    if (typeof nested === "number") return nested;
  }
  return undefined;
}

/**
 * Returns the last HTTP entry for a step only if that final entry represents a
 * failure. If the step retried and a later attempt succeeded, returns undefined
 * — we don't want to show error guidance for a step whose outcome was success.
 *
 * For `jwt_bearer_request`, the `/proxy/token` endpoint always returns HTTP 200
 * and wraps the upstream authorization-server response in `{status, body}`, so
 * we also inspect the nested upstream status to detect failure. We scope that
 * inspection to `jwt_bearer_request` because other steps could coincidentally
 * return a body with a `status` field that doesn't mean HTTP status.
 */
export function latestErroredHttpEntry(
  httpEntries: readonly XAAHttpHistoryEntry[],
): XAAHttpHistoryEntry | undefined {
  if (httpEntries.length === 0) return undefined;
  const last = httpEntries[httpEntries.length - 1];
  if (last.error) return last;
  if (!last.response) return undefined;
  if (last.response.status < 200 || last.response.status >= 300) {
    return last;
  }
  if (last.step === "jwt_bearer_request") {
    const nested = nestedUpstreamStatus(last);
    if (nested !== undefined && (nested < 200 || nested >= 300)) {
      return last;
    }
  }
  return undefined;
}

export type XAAErrorActionIntent =
  | "configure"
  | "bootstrap"
  | "reset"
  | "link";

export interface XAAErrorAction {
  label: string;
  intent: XAAErrorActionIntent;
  href?: string;
}

export interface XAAErrorGuidance {
  title: string;
  explanation: string;
  actions: XAAErrorAction[];
  severity: "error" | "warning";
}

export interface XAAErrorGuidanceInput {
  step: XAAFlowStep;
  stateError?: string;
  httpEntry?: XAAHttpHistoryEntry;
}

const CONFIGURE: XAAErrorAction = {
  label: "Open Configure Target",
  intent: "configure",
};

const REGISTER_ISSUER: XAAErrorAction = {
  label: "Show issuer registration",
  intent: "bootstrap",
};

const RESET_FLOW: XAAErrorAction = { label: "Reset flow", intent: "reset" };

function extractUpstreamBody(entry: XAAHttpHistoryEntry | undefined): unknown {
  if (!entry?.response?.body) return undefined;
  const body = entry.response.body;
  if (body && typeof body === "object" && "body" in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>).body;
  }
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function upstreamOAuthError(entry: XAAHttpHistoryEntry | undefined): string | undefined {
  const upstream = extractUpstreamBody(entry);
  const rec = asRecord(upstream);
  const error = rec?.error;
  return typeof error === "string" ? error : undefined;
}

function messageIncludes(haystack: string | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function getXAAErrorGuidance(
  input: XAAErrorGuidanceInput,
): XAAErrorGuidance | null {
  const { step, stateError, httpEntry } = input;
  const upstreamError = upstreamOAuthError(httpEntry);

  const responseStatus = httpEntry?.response?.status;
  const upstreamStatus =
    step === "jwt_bearer_request" && httpEntry
      ? nestedUpstreamStatus(httpEntry)
      : undefined;
  const hasFailedOuterResponse =
    typeof responseStatus === "number" &&
    (responseStatus < 200 || responseStatus >= 300);
  const hasFailedUpstreamResponse =
    typeof upstreamStatus === "number" &&
    (upstreamStatus < 200 || upstreamStatus >= 300);
  const hasFailedResponse =
    hasFailedOuterResponse || hasFailedUpstreamResponse;
  const failedStatus = hasFailedUpstreamResponse
    ? upstreamStatus
    : hasFailedOuterResponse
      ? responseStatus
      : undefined;

  if (
    !stateError &&
    !upstreamError &&
    !httpEntry?.error &&
    !hasFailedResponse
  ) {
    return null;
  }

  if (step === "token_exchange_request") {
    if (messageIncludes(stateError, "client id is required")) {
      return {
        title: "Client ID required",
        explanation:
          "The ID-JAG needs a `client_id` claim identifying the OAuth client that will present the assertion. This value must also be registered at your authorization server.",
        actions: [CONFIGURE],
        severity: "error",
      };
    }
    if (messageIncludes(stateError, "no identity assertion")) {
      return {
        title: "Identity assertion missing",
        explanation:
          "The mock OIDC authentication step did not produce an ID token. Reset the flow and run it again from the start.",
        actions: [RESET_FLOW],
        severity: "error",
      };
    }
    if (messageIncludes(stateError, "no authorization server issuer")) {
      return {
        title: "Authorization server issuer missing",
        explanation:
          "The ID-JAG `aud` claim needs the target authorization server's issuer URL. Either let the MCP server's RFC 9728 metadata supply it, or set it manually in Configure Target.",
        actions: [CONFIGURE],
        severity: "error",
      };
    }
  }

  if (step === "discover_resource_metadata") {
    return {
      title: "MCP server did not return RFC 9728 metadata",
      explanation:
        "The debugger fetched `/.well-known/oauth-protected-resource` but didn't get a usable response. For XAA to work, the MCP server must publish its `resource` identifier and `authorization_servers` list at this well-known URL. You can also configure the authorization-server issuer manually as a fallback.",
      actions: [CONFIGURE],
      severity: "error",
    };
  }

  if (step === "discover_authz_metadata") {
    return {
      title: "Authorization server discovery failed",
      explanation:
        "Neither `/.well-known/oauth-authorization-server` nor `/.well-known/openid-configuration` returned a valid response at the configured issuer. Check the issuer URL for typos, or set the token endpoint manually.",
      actions: [CONFIGURE],
      severity: "error",
    };
  }

  if (step === "jwt_bearer_request") {
    // Pre-request validation: no HTTP call was made. Don't claim the AS
    // rejected anything — the state machine set an error before contact.
    if (
      messageIncludes(stateError, "missing an ID-JAG") ||
      messageIncludes(stateError, "token endpoint")
    ) {
      return {
        title: "ID-JAG or token endpoint missing",
        explanation:
          "Token exchange or authorization-server discovery hasn't completed yet, so there's nothing to send. Reset the flow and run it from the start.",
        actions: [RESET_FLOW],
        severity: "error",
      };
    }
    if (
      upstreamError === "unsupported_grant_type" ||
      messageIncludes(stateError, "unsupported_grant_type")
    ) {
      return {
        title: "Your authorization server doesn't support the jwt-bearer grant",
        explanation:
          "The AS returned `unsupported_grant_type`. XAA requires the AS to accept `urn:ietf:params:oauth:grant-type:jwt-bearer` (RFC 7523). Most ASes don't yet — Okta does natively, Auth0/Keycloak with config, WorkOS/Stytch currently don't. Common workaround: run a small bridge service that accepts the ID-JAG, validates it against MCPJam's JWKS, and mints tokens via your AS's admin API.",
        actions: [REGISTER_ISSUER],
        severity: "error",
      };
    }
    if (
      upstreamError === "invalid_client" ||
      upstreamError === "unauthorized_client" ||
      messageIncludes(stateError, "invalid_client") ||
      messageIncludes(stateError, "unauthorized_client")
    ) {
      return {
        title: "Authorization server doesn't recognize the client",
        explanation:
          "The AS rejected the `client_id` in the ID-JAG. Either it isn't registered at your AS, or it isn't authorized for the jwt-bearer grant. Register the client in the AS admin console and confirm it's allowed to present assertions.",
        actions: [CONFIGURE],
        severity: "error",
      };
    }
    if (
      upstreamError === "invalid_grant" ||
      messageIncludes(stateError, "invalid_grant")
    ) {
      return {
        title: "Authorization server rejected the ID-JAG assertion",
        explanation:
          "The AS accepted the grant type but rejected the assertion itself. Likely causes: (1) the AS doesn't trust MCPJam as an issuer — register the JWKS URL; (2) `aud` doesn't match the AS's own issuer; (3) `resource` isn't a registered resource; (4) the token is expired; (5) a negative-test mode is active.",
        actions: [REGISTER_ISSUER],
        severity: "error",
      };
    }
    if (
      upstreamError === "invalid_target" ||
      messageIncludes(stateError, "invalid_target")
    ) {
      return {
        title: "Authorization server rejected the `resource` claim",
        explanation:
          "The `resource` value in the ID-JAG isn't a resource the AS is configured to issue tokens for. Register the MCP server's canonical URL as a resource indicator at your AS.",
        actions: [CONFIGURE],
        severity: "error",
      };
    }
    // Generic jwt_bearer fallback — only claim an AS-side failure if we
    // actually made the request. Pre-condition validation errors have no
    // httpEntry and should fall through to the raw error alert so the user
    // sees the real message instead of a misleading AS-failure card.
    if (hasFailedResponse || upstreamError || httpEntry?.error) {
      return {
        title: "JWT bearer request failed at the authorization server",
        explanation:
          "The AS returned a non-success response. Expand the HTTP entry below for the raw body, then check: (1) AS supports the jwt-bearer grant, (2) AS trusts MCPJam's JWKS, (3) `client_id` is registered, (4) `resource` is recognized.",
        actions: [REGISTER_ISSUER],
        severity: "error",
      };
    }
  }

  if (step === "authenticated_mcp_request") {
    const status = httpEntry?.response?.status;
    if (status === 401 || status === 403) {
      return {
        title: "MCP server rejected the access token",
        explanation:
          "The AS issued an access token, but the MCP server won't accept it. Usually the `resource` or `aud` claim on the access token doesn't match the MCP server's canonical resource URL. Confirm the AS is binding tokens to the correct resource indicator.",
        actions: [],
        severity: "error",
      };
    }
    if (hasFailedResponse || httpEntry?.error) {
      return {
        title: "MCP server request failed",
        explanation: `The authenticated MCP call ${
          status ? `returned ${status}` : "failed with a network error"
        }. Expand the HTTP entry below for the raw response, then check the MCP server logs for why it rejected the request.`,
        actions: [],
        severity: "error",
      };
    }
  }

  // Generic HTTP failure fallback — catches any step that hit a non-2xx
  // response without a more specific case above, so users don't see a blank
  // response to a known failure.
  if (hasFailedResponse || httpEntry?.error) {
    return {
      title: "Request failed",
      explanation:
        httpEntry?.error?.message ||
        (typeof failedStatus === "number"
          ? `The request returned ${failedStatus}. Expand the HTTP entry below for details.`
          : "The request did not complete. Check network connectivity and CORS settings."),
      actions: [],
      severity: "warning",
    };
  }

  return null;
}
