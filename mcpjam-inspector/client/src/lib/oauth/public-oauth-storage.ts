import type { OAuthDiscoveryState } from "@mcpjam/sdk/browser";
import { isIssuerKeyedStore } from "./issuer-keyed-storage";

const credentialParameterNames = new Set([
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "token",
  "secret",
  "password",
  "authorization",
  "auth",
  "key",
  "sig",
  "signature",
  "bearer",
  "apitoken",
  "oauthtoken",
  "accesskey",
  "subscriptionkey",
  "credential",
  "xamzcredential",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

/** Recovery URLs must not double as credentials. Never include the URL in errors. */
export function assertPublicOAuthUrl(value: string): void {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) =>
      credentialParameterNames.has(key.toLowerCase().replace(/[-_]/g, "")),
    ) ||
    url.hash
  ) {
    throw new Error(
      "OAuth URLs must not contain credentials or fragments. Put credentials in the server's authentication headers instead.",
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only fields needed to recover client identity/auth selection belong on disk. */
export function publicClientInformation(
  value: unknown,
): Record<string, unknown> {
  const input = record(value);
  const output: Record<string, unknown> = {};
  for (const key of ["client_id", "token_endpoint_auth_method"]) {
    if (typeof input[key] === "string") output[key] = input[key];
  }
  for (const key of ["client_id_issued_at", "client_secret_expires_at"]) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) {
      output[key] = input[key];
    }
  }
  return output;
}

/** Rebuild the envelope too: neither extensions nor malformed records are copied. */
export function sanitizeStoredClientInformation(
  raw: string | null,
): string | null {
  if (!raw) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isIssuerKeyedStore(parsed)) {
      return JSON.stringify(publicClientInformation(parsed));
    }
    return JSON.stringify({
      v: 2,
      ...(typeof parsed.activeIssuer === "string"
        ? { activeIssuer: parsed.activeIssuer }
        : {}),
      byIssuer: Object.fromEntries(
        Object.entries(parsed.byIssuer).map(([issuer, value]) => [
          issuer,
          publicClientInformation(value),
        ]),
      ),
    });
  } catch {
    return null;
  }
}

function publicMetadata(value: unknown): Record<string, unknown> {
  const input = record(value);
  const output: Record<string, unknown> = {};
  // Public endpoint/identity fields used for discovery and refresh recovery.
  for (const key of [
    "issuer",
    "resource",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
    "jwks_uri",
    "revocation_endpoint",
    "introspection_endpoint",
    "userinfo_endpoint",
    "service_documentation",
    "op_policy_uri",
    "op_tos_uri",
    "resource_documentation",
    "resource_policy_uri",
    "resource_tos_uri",
  ]) {
    if (typeof input[key] === "string") {
      assertPublicOAuthUrl(input[key]);
      output[key] = input[key];
    }
  }
  if (typeof input.resource_name === "string")
    output.resource_name = input.resource_name;
  for (const key of [
    "authorization_servers",
    "scopes_supported",
    "response_types_supported",
    "response_modes_supported",
    "grant_types_supported",
    "token_endpoint_auth_methods_supported",
    "token_endpoint_auth_signing_alg_values_supported",
    "code_challenge_methods_supported",
    "bearer_methods_supported",
    "resource_signing_alg_values_supported",
    "authorization_details_types_supported",
  ]) {
    const values = input[key];
    if (
      Array.isArray(values) &&
      values.every((item) => typeof item === "string")
    ) {
      if (key === "authorization_servers") values.forEach(assertPublicOAuthUrl);
      output[key] = [...values];
    }
  }
  for (const key of [
    "client_id_metadata_document_supported",
    "authorization_response_iss_parameter_supported",
  ]) {
    if (typeof input[key] === "boolean") output[key] = input[key];
  }
  return output;
}

export function publicDiscoveryState(
  state: OAuthDiscoveryState,
): OAuthDiscoveryState {
  const output: Record<string, unknown> = {};
  for (const key of [
    "authorizationServerUrl",
    "resourceMetadataUrl",
  ] as const) {
    if (typeof state[key] === "string") {
      assertPublicOAuthUrl(state[key]);
      output[key] = state[key];
    }
  }
  for (const key of [
    "authorizationServerMetadata",
    "resourceMetadata",
  ] as const) {
    if (state[key]) output[key] = publicMetadata(state[key]);
  }
  return output as unknown as OAuthDiscoveryState;
}
