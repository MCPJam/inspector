import type {
  OAuthDynamicRegistrationMetadata,
  OAuthProtocolVersion,
} from "./state-machines/types.js";

export const MCPJAM_LOGO_URI = "https://www.mcpjam.com/mcp_jam_2row.png";
export const DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL =
  "https://www.mcpjam.com/.well-known/oauth/client-metadata.json";
export const MCPJAM_CLIENT_URI = "https://github.com/MCPJam/inspector";

const BROWSER_DEBUG_CLIENT_NAMES: Record<OAuthProtocolVersion, string> = {
  "2025-03-26": "MCP Inspector Debug Client",
  "2025-06-18": "MCPJam Inspector Debug Client",
  "2025-11-25": "MCPJam Inspector Debug Client",
  "2026-07-28": "MCPJam Inspector Debug Client",
};

export function getBrowserDebugDynamicRegistrationMetadata(
  protocolVersion: OAuthProtocolVersion
): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: BROWSER_DEBUG_CLIENT_NAMES[protocolVersion],
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
  };
}

export function getConformanceAuthCodeDynamicRegistrationMetadata(): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: "MCPJam SDK OAuth Conformance",
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function getConformanceClientCredentialsDynamicRegistrationMetadata(): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: "MCPJam SDK OAuth Conformance",
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "client_secret_post",
  };
}

// Cross-App Access (ID-JAG) client identity.
// Pinned to draft-ietf-oauth-identity-assertion-authz-grant-04: a client that
// advertises the ID-JAG grant profile MUST include both the Token Exchange
// grant (Client<->IdP leg) and the JWT Bearer grant (Client<->RAS leg).
export const ID_JAG_GRANT_PROFILE =
  "urn:ietf:params:oauth:grant-profile:id-jag";
export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
export const ID_TOKEN_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
// Draft §4.3 alternative subject-token type: a signed SAML 2.0 assertion
// (base64 of the XML) representing the requesting client's SSO session.
export const SAML2_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:saml2";

// The XAA debugger's Client ID Metadata Document. This is a DIFFERENT client
// identity from DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL (the authorization-code
// login client); changing that document's grants would change the login
// client, so XAA publishes its own document.
export const XAA_DEBUG_CLIENT_ID_METADATA_URL =
  "https://app.mcpjam.com/.well-known/oauth/xaa-client-metadata.json";

// Client identity registered at MCPJam's mock IdP for the RFC 8693
// Client-to-IdP exchange. This is deliberately distinct from the client
// identity carried in the resulting ID-JAG, which belongs to the RAS.
export const XAA_DEBUG_IDP_CLIENT_ID = "mcpjam-xaa-debugger";

export function getXaaDebugClientMetadata(options: {
  tokenEndpointAuthMethod: "client_secret_post" | "none" | "private_key_jwt";
  /** Public keys published for `private_key_jwt` (confidential CIMD). */
  jwks?: { keys: JsonWebKey[] };
}): Partial<OAuthDynamicRegistrationMetadata> & {
  jwks?: { keys: JsonWebKey[] };
} {
  return {
    client_name: "MCPJam XAA Debugger",
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
    authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
    grant_types: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
    token_endpoint_auth_method: options.tokenEndpointAuthMethod,
    ...(options.jwks ? { jwks: options.jwks } : {}),
    // Deliberately NO redirect_uris/response_types - jwt-bearer has no redirect.
  };
}

// Confidential CIMD (private_key_jwt): the client publishes its public key in a
// Client ID Metadata Document and signs a client_assertion with the matching
// private key. The document is served by a STATELESS hosted reflector that
// encodes the public key in the URL, so each key maps to a unique HTTPS URL with
// no server-side storage. This origin hosts that reflector (the inspector
// server, deployed at app.mcpjam.com — same host as XAA_DEBUG_CLIENT_ID_METADATA_URL).
export const XAA_CONFIDENTIAL_CIMD_ORIGIN = "https://app.mcpjam.com";
export const XAA_CONFIDENTIAL_CIMD_PATH_PREFIX =
  "/.well-known/oauth/xaa-cimd/";

// Serialize ONLY canonical public members, and refuse a private JWK outright:
// otherwise a `d` component would be embedded in the client_id URL (and thus in
// logs and the echoed client_id) before the reflector ever strips it. The
// private key must never leave the client.
function canonicalPublicJwkForUrl(jwk: JsonWebKey): JsonWebKey {
  if ((jwk as { d?: unknown }).d !== undefined) {
    throw new Error(
      "refusing to encode a private JWK into a client_id URL: pass only the " +
        "public key (no `d` component)",
    );
  }
  const { kty, crv, x, y, kid, alg, use } = jwk as JsonWebKey & {
    kid?: string;
  };
  return {
    kty,
    crv,
    x,
    y,
    ...(kid ? { kid } : {}),
    ...(alg ? { alg } : {}),
    ...(use ? { use } : {}),
  } as JsonWebKey;
}

// Browser-safe base64url of an ASCII JSON string (btoa/atob are available in
// Node 16+ and browsers; the encoded JWK is ASCII so latin1 is exact).
function encodeJwkForUrl(jwk: JsonWebKey): string {
  return btoa(JSON.stringify(canonicalPublicJwkForUrl(jwk)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Build the confidential-CIMD document URL that publishes `publicJwk`. */
export function buildConfidentialCimdUrl(
  publicJwk: JsonWebKey,
  origin: string = XAA_CONFIDENTIAL_CIMD_ORIGIN,
): string {
  return `${origin.replace(/\/+$/, "")}${XAA_CONFIDENTIAL_CIMD_PATH_PREFIX}${encodeJwkForUrl(
    publicJwk,
  )}`;
}

// A P-256 affine coordinate is 32 bytes → 43 unpadded base64url chars.
const EC_P256_COORD = /^[A-Za-z0-9_-]{43}$/;
// A conservative kid: short, printable, no structural/JSON-breaking chars.
const SAFE_KID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Decode and STRICTLY validate the URL-embedded public JWK (used by the
 * reflector). Returns a freshly reconstructed **public** EC P-256 JWK
 * (`kty/crv/x/y` + `alg/use`, and `kid` only if safe) — never the raw parsed
 * object. This rejects anything that is not an exact P-256 public key and,
 * critically, drops any private field (`d`) or unknown members an attacker may
 * have encoded, so the reflector can only ever publish a clean public key.
 * Returns null on anything malformed.
 */
export function decodeConfidentialCimdKey(encoded: string): JsonWebKey | null {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    // A document request carrying a private key is anomalous — reject it (fail
    // closed) rather than silently stripping and serving.
    if (parsed.d !== undefined) return null;
    if (parsed.kty !== "EC" || parsed.crv !== "P-256") return null;
    const { x, y, kid } = parsed;
    if (typeof x !== "string" || !EC_P256_COORD.test(x)) return null;
    if (typeof y !== "string" || !EC_P256_COORD.test(y)) return null;

    const jwk: JsonWebKey & { kid?: string } = {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      alg: "ES256",
      use: "sig",
    };
    if (typeof kid === "string" && SAFE_KID.test(kid)) jwk.kid = kid;
    return jwk;
  } catch {
    return null;
  }
}

// The reflector serves documents for ANY key anyone encodes in the URL, so its
// identity MUST be explicitly untrusted and unbranded: possession of the key
// proves control of the client_id, NOT that MCPJam issued or vouches for it.
// Branding a reflected document as the "MCPJam XAA Debugger" would let anyone
// mint a document that impersonates MCPJam to a relying party.
export const UNVERIFIED_CONFIDENTIAL_CIMD_CLIENT_NAME =
  "Unverified XAA client (self-published key; not issued or endorsed by MCPJam)";

/** Build the reflector's `private_key_jwt` document body for a decoded public
 * key. Deliberately carries NO MCPJam branding (`client_uri`/`logo_uri`). */
export function getConfidentialCimdReflectorMetadata(jwks: {
  keys: JsonWebKey[];
}): Partial<OAuthDynamicRegistrationMetadata> & {
  jwks: { keys: JsonWebKey[] };
} {
  return {
    client_name: UNVERIFIED_CONFIDENTIAL_CIMD_CLIENT_NAME,
    authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
    grant_types: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
    token_endpoint_auth_method: "private_key_jwt",
    jwks,
    // No client_uri / logo_uri: the key holder is not MCPJam.
  };
}

export type IdJagMetadataEvidence = "present" | "omitted" | "contradicted";

export interface IdJagClientMetadataEvaluation {
  profile: IdJagMetadataEvidence;
  jwtBearerGrant: IdJagMetadataEvidence;
  tokenExchangeGrant: IdJagMetadataEvidence;
  /** Raw value; auth-method policy is the caller's. */
  tokenEndpointAuthMethod: string | undefined;
}

function classifyListMembership(
  value: unknown,
  expected: string
): IdJagMetadataEvidence {
  if (value === undefined || value === null) {
    return "omitted";
  }
  if (Array.isArray(value) && value.includes(expected)) {
    return "present";
  }
  // The property exists but the expected value does not: an explicit
  // statement, not an omission.
  return "contradicted";
}

/**
 * Classifies ID-JAG client-metadata evidence in a DCR response or a Client ID
 * Metadata Document. Evidence only - policy differs by caller: RFC 7591 lets
 * an AS ignore unknown request metadata, so a DCR response may treat
 * "omitted" as a warning, while a CIMD document is the authoritative client
 * metadata and "omitted" means the document is insufficient.
 */
export function evaluateIdJagClientMetadata(
  metadata: Record<string, unknown>
): IdJagClientMetadataEvaluation {
  return {
    profile: classifyListMembership(
      metadata.authorization_grant_profiles_supported,
      ID_JAG_GRANT_PROFILE
    ),
    jwtBearerGrant: classifyListMembership(
      metadata.grant_types,
      JWT_BEARER_GRANT
    ),
    tokenExchangeGrant: classifyListMembership(
      metadata.grant_types,
      TOKEN_EXCHANGE_GRANT
    ),
    tokenEndpointAuthMethod:
      typeof metadata.token_endpoint_auth_method === "string"
        ? metadata.token_endpoint_auth_method
        : undefined,
  };
}
