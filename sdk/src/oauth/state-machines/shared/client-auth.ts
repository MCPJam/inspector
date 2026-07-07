export type PreregisteredClientAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

export type PreregisteredClientAuthResolution =
  | {
      ok: true;
      method: PreregisteredClientAuthMethod;
      supportedMethods: string[];
    }
  | {
      ok: false;
      message: string;
      supportedMethods: string[];
    };

export function normalizeTokenEndpointAuthMethods(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const raw = metadata?.token_endpoint_auth_methods_supported;
  if (!Array.isArray(raw) || raw.length === 0) {
    return ["client_secret_basic"];
  }

  const filtered = raw.filter(
    (method): method is string => typeof method === "string",
  );
  return filtered.length > 0 ? filtered : ["client_secret_basic"];
}

export function resolvePreregisteredClientAuthMethod(input: {
  authorizationServerMetadata: Record<string, unknown> | undefined;
  hasClientSecret: boolean;
}): PreregisteredClientAuthResolution {
  const supportedMethods = normalizeTokenEndpointAuthMethods(
    input.authorizationServerMetadata,
  );

  if (input.hasClientSecret) {
    if (supportedMethods.includes("client_secret_basic")) {
      return { ok: true, method: "client_secret_basic", supportedMethods };
    }
    if (supportedMethods.includes("client_secret_post")) {
      return { ok: true, method: "client_secret_post", supportedMethods };
    }
    if (supportedMethods.includes("none")) {
      return { ok: true, method: "none", supportedMethods };
    }
    return {
      ok: false,
      message: `Unsupported OAuth client authentication method: ${
        supportedMethods.join(", ") || "none advertised"
      }.`,
      supportedMethods,
    };
  }

  // Public preregistered client: send no client auth at the token endpoint and
  // let the AS reject if it actually requires a secret. Pre-flight blocking
  // breaks CLI flows (e.g. --client-id only) against ASes that don't advertise
  // "none" but accept unauthenticated public-client requests.
  return { ok: true, method: "none", supportedMethods };
}

export interface TokenRequestClientAuth {
  /**
   * Headers to add to the token request. Contains `Authorization: Basic …`
   * for `client_secret_basic`; empty otherwise. Must be applied AFTER
   * `mergeHeadersForAuthServer`, which strips user-configured Authorization
   * headers — this protocol-required credential is the one exception.
   */
  headers: Record<string, string>;
  /** `client_id` / `client_secret` body parameters, per the resolved method. */
  bodyParams: Record<string, string>;
}

/**
 * Translate the resolved token-endpoint auth method into how the client
 * credential is actually transmitted (#3034 — previously the secret always
 * went in the body regardless of the resolved method):
 *
 * - `client_secret_basic` → `Authorization: Basic` header, nothing in the
 *   body (per RFC 6749 §2.3.1 the id and secret are each form-urlencoded
 *   before base64; the id is carried by the header, not the body).
 * - `client_secret_post` → `client_id` + `client_secret` body parameters.
 * - `none` → `client_id` only; a secret is never transmitted.
 * - method absent with a secret → body parameters (legacy shape for
 *   DCR-issued secrets whose registration response omitted the method).
 */
export function buildTokenRequestClientAuth(input: {
  clientId?: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;
}): TokenRequestClientAuth {
  const { clientId, clientSecret, tokenEndpointAuthMethod } = input;

  if (clientSecret && tokenEndpointAuthMethod === "client_secret_basic") {
    const credentials = btoa(
      `${encodeURIComponent(clientId ?? "")}:${encodeURIComponent(clientSecret)}`,
    );
    return {
      headers: { Authorization: `Basic ${credentials}` },
      bodyParams: {},
    };
  }

  const bodyParams: Record<string, string> = {};
  if (clientId) {
    bodyParams.client_id = clientId;
  }
  if (clientSecret && tokenEndpointAuthMethod !== "none") {
    bodyParams.client_secret = clientSecret;
  }
  return { headers: {}, bodyParams };
}
