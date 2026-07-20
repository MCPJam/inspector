import type {
  OAuthDynamicRegistrationMetadata,
  OAuthHttpRequest,
  OAuthHttpResponse,
  OAuthRequestExecutor,
} from "../types.js";
import { mergeHeadersForAuthServer } from "./headers.js";

const REDACTED_VALUE = "***REDACTED***";

// Response-body fields that carry credentials an AS may include in an RFC 7591
// registration response. Redacted recursively so nested shapes can't leak.
const CREDENTIAL_FIELD_NAMES = new Set([
  "client_secret",
  "registration_access_token",
  "access_token",
  "refresh_token",
]);

export interface DynamicClientRegistrationRequestInput {
  registrationEndpoint: string;
  redirectUri: string;
  dynamicRegistrationDefaults: Partial<OAuthDynamicRegistrationMetadata>;
  /** Already-resolved scope value; scope sourcing is version/caller-specific. */
  scope?: string;
  customHeaders?: Record<string, string>;
}

/**
 * Derive the OIDC / SEP-837 `application_type` from the redirect URIs. A `"web"`
 * client requires HTTPS redirect URIs and forbids localhost; loopback and
 * custom-scheme (e.g. `mcpjam://`) redirects are `"native"`. If any redirect is
 * native-only, the whole registration is native.
 *
 * This helper is version-agnostic, but it is deliberately NOT wired into
 * `buildDynamicClientRegistrationRequest` — `application_type` is an OIDC-DCR
 * field the 2026-07-28 spec introduced as a client MUST, so only the
 * `debug-oauth-2026-07-28` machine attaches it. The three 2025 machines keep
 * their RFC-7591 registration body unchanged (fidelity to their spec version).
 */
export function deriveApplicationType(
  redirectUris: readonly string[]
): "native" | "web" {
  const isNativeRedirect = (uri: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return true; // unparseable → treat conservatively as native
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true; // custom scheme (mcpjam://, …)
    }
    const host = parsed.hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  };
  return redirectUris.some(isNativeRedirect) ? "native" : "web";
}

/**
 * Builds the RFC 7591 registration POST exactly as the debug OAuth machines
 * historically did: caller-supplied metadata defaults win, with
 * authorization-code-flavored fallbacks for anything absent. Callers that are
 * not authorization-code clients (e.g. XAA jwt-bearer clients) must build
 * their own request instead of using these fallbacks.
 */
export function buildDynamicClientRegistrationRequest(
  input: DynamicClientRegistrationRequestInput
): OAuthHttpRequest {
  const { dynamicRegistrationDefaults } = input;

  const clientMetadata: Record<string, any> = {
    ...dynamicRegistrationDefaults,
    redirect_uris: dynamicRegistrationDefaults.redirect_uris ?? [
      input.redirectUri,
    ],
    grant_types: dynamicRegistrationDefaults.grant_types ?? [
      "authorization_code",
      "refresh_token",
    ],
    response_types: dynamicRegistrationDefaults.response_types ?? ["code"],
    token_endpoint_auth_method:
      dynamicRegistrationDefaults.token_endpoint_auth_method ?? "none",
  };

  if (input.scope) {
    clientMetadata.scope = input.scope;
  }

  return {
    method: "POST",
    url: input.registrationEndpoint,
    headers: mergeHeadersForAuthServer(input.customHeaders, {
      "Content-Type": "application/json",
    }),
    body: clientMetadata,
  };
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = CREDENTIAL_FIELD_NAMES.has(key.toLowerCase())
        ? REDACTED_VALUE
        : redactValue(entry);
    }
    return result;
  }
  return value;
}

/**
 * Clones a registration response and masks every credential-bearing field.
 * This is the only response shape that may reach diagnostic surfaces
 * (lastResponse, httpHistory, info logs). Raw credentials travel exclusively
 * through DynamicClientRegistrationOutcome.credentials / clientInfo.
 */
export function redactDynamicClientRegistrationResponse(
  response: OAuthHttpResponse
): OAuthHttpResponse {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: { ...response.headers },
    body: redactValue(response.body),
  };
}

/** Minimal structural constraint so both the OAuth machines' HttpHistoryEntry
 * and the inspector's XAAHttpHistoryEntry fit; the helper never reads `step`. */
type BackfillableHistoryEntry = {
  timestamp: number;
  duration?: number;
  response?: OAuthHttpResponse;
};

export interface DynamicClientRegistrationCredentials {
  clientId?: string;
  clientSecret?: string;
  /** Raw token_endpoint_auth_method from the response. Legacy OAuth machines
   * normalize it via normalizeRegisteredClientAuthMethod at their call sites;
   * other callers validate the raw value against their own policy. */
  tokenEndpointAuthMethod?: string;
  clientSecretExpiresAt?: number;
}

export type DynamicClientRegistrationOutcome<
  THistory extends BackfillableHistoryEntry = BackfillableHistoryEntry
> =
  | {
      status: "registered";
      /** Redacted; safe for diagnostic surfaces. */
      response: OAuthHttpResponse;
      httpHistory: THistory[];
      /** Raw response body. Operational data — callers must not log it. */
      clientInfo: Record<string, any>;
      /** Raw credentials. Operational data — callers must not log them. */
      credentials: DynamicClientRegistrationCredentials;
      /** typeof clientInfo.client_id !== "string" — strict callers hard-fail. */
      missingClientId: boolean;
      /** 2xx other than 201; RFC 7591 specifies 201 Created. */
      nonCanonicalSuccessStatus: boolean;
      /** Credential-free record for info logs. */
      infoLogData: Record<string, any>;
    }
  | {
      status: "http_error" | "network_error" | "invalid_response";
      /** Redacted (http_error/invalid_response) or synthesized (network_error). */
      response: OAuthHttpResponse;
      httpHistory: THistory[];
      error: string;
      fallbackNote: string;
      errorWithFallbackHint: string;
    };

export interface ExecuteDynamicClientRegistrationInput<
  THistory extends BackfillableHistoryEntry
> {
  /** The exact pre-built request the caller has already recorded in its
   * lastRequest/history entry. Executed as-is so the displayed request and
   * the executed request cannot drift; the executor owns wire serialization. */
  request: OAuthHttpRequest;
  requestExecutor: OAuthRequestExecutor;
  httpHistory?: THistory[];
}

function backfillHistory<THistory extends BackfillableHistoryEntry>(
  httpHistory: THistory[] | undefined,
  response: OAuthHttpResponse
): THistory[] {
  const updated = [...(httpHistory || [])];
  if (updated.length > 0) {
    const last = updated[updated.length - 1];
    updated[updated.length - 1] = {
      ...last,
      response,
      duration: Date.now() - (last.timestamp || Date.now()),
    };
  }
  return updated;
}

const FALLBACK_HINT =
  "Configure a pre-registered client or enable DCR on the authorization server.";

/**
 * Executes an RFC 7591 registration POST via the caller's executor, back-fills
 * a cloned last history entry with the redacted response, and classifies the
 * result. Never calls updateState — state transitions stay caller-owned.
 * Never throws: transport failures become a "network_error" outcome.
 */
export async function executeDynamicClientRegistration<
  THistory extends BackfillableHistoryEntry
>(
  input: ExecuteDynamicClientRegistrationInput<THistory>
): Promise<DynamicClientRegistrationOutcome<THistory>> {
  let response;
  try {
    response = await input.requestExecutor(input.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const synthesized: OAuthHttpResponse = {
      status: 0,
      statusText: "Network Error",
      headers: {},
      body: { error: message },
    };
    const registrationError = `Client registration failed: ${message}`;
    return {
      status: "network_error",
      response: synthesized,
      httpHistory: backfillHistory(input.httpHistory, synthesized),
      error: registrationError,
      fallbackNote:
        "Client registration failed; using pre-registered client credentials.",
      errorWithFallbackHint: `${registrationError}. ${FALLBACK_HINT}`,
    };
  }

  const redacted = redactDynamicClientRegistrationResponse({
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
  });
  const httpHistory = backfillHistory(input.httpHistory, redacted);

  if (!response.ok) {
    const registrationError = `Dynamic Client Registration failed (${response.status}).`;
    return {
      status: "http_error",
      response: redacted,
      httpHistory,
      error: registrationError,
      fallbackNote: `Dynamic Client Registration failed (${response.status}); using pre-registered client credentials.`,
      errorWithFallbackHint: `${registrationError} ${FALLBACK_HINT}`,
    };
  }

  const clientInfo = response.body;
  if (
    !clientInfo ||
    typeof clientInfo !== "object" ||
    Array.isArray(clientInfo)
  ) {
    const registrationError =
      "Client registration failed: the registration response body was not a JSON object";
    return {
      status: "invalid_response",
      response: redacted,
      httpHistory,
      error: registrationError,
      fallbackNote:
        "Client registration failed; using pre-registered client credentials.",
      errorWithFallbackHint: `${registrationError}. ${FALLBACK_HINT}`,
    };
  }

  const infoLogData: Record<string, any> = {
    "Client ID": clientInfo.client_id,
    "Client Name": clientInfo.client_name,
    "Token Auth Method": clientInfo.token_endpoint_auth_method || "none",
    "Redirect URIs": clientInfo.redirect_uris,
    "Grant Types": clientInfo.grant_types,
    "Response Types": clientInfo.response_types,
  };

  if (clientInfo.client_secret) {
    infoLogData["Client Secret Issued"] = true;
    infoLogData["Note"] =
      "Server issued client_secret - this will be used in token requests";
  }

  return {
    status: "registered",
    response: redacted,
    httpHistory,
    clientInfo,
    credentials: {
      clientId:
        typeof clientInfo.client_id === "string"
          ? clientInfo.client_id
          : undefined,
      clientSecret:
        typeof clientInfo.client_secret === "string"
          ? clientInfo.client_secret
          : undefined,
      tokenEndpointAuthMethod:
        typeof clientInfo.token_endpoint_auth_method === "string"
          ? clientInfo.token_endpoint_auth_method
          : undefined,
      clientSecretExpiresAt:
        typeof clientInfo.client_secret_expires_at === "number"
          ? clientInfo.client_secret_expires_at
          : undefined,
    },
    missingClientId: typeof clientInfo.client_id !== "string",
    nonCanonicalSuccessStatus: response.status !== 201,
    infoLogData,
  };
}
