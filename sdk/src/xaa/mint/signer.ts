import {
  createSign,
  createVerify,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "crypto";
import {
  getXAAIdpPrivateKey,
  getXAAIdpPublicKeyObject,
  initXAAIdpKeyPair,
} from "./keypair.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type NegativeTestMode,
  XAA_IDP_KID,
} from "../constants.js";

const ID_JAG_TTL_S = 5 * 60;
const ID_TOKEN_TTL_S = 5 * 60;
const AUTHORIZATION_CODE_TTL_S = 60;
const ACCESS_TOKEN_TTL_S = 5 * 60;

// Distinct `typ` per token kind so nothing can be cross-redeemed: a code
// can't be replayed as an access token, an ID-JAG can't be a code, etc.
// verifyXaaJwt asserts the expected typ.
export const XAA_CODE_JWT_TYP = "xaa-code+jwt";
export const XAA_ACCESS_TOKEN_TYP = "at+jwt";

type JwtHeader = Record<string, unknown>;
type JwtPayload = Record<string, unknown>;

export interface IssueIdJagParams {
  issuer: string;
  subject: string;
  audience: string;
  resource: string;
  clientId: string;
  scope?: string;
  /**
   * End-user email. The spec RECOMMENDS the ID-JAG carry an `email` (and/or
   * `aud_sub`) claim so the Resource Authorization Server can resolve/provision
   * the subject. Optional — omitted from the payload when absent.
   */
  email?: string;
}

export interface IssueMockIdTokenParams {
  issuer: string;
  subject: string;
  email: string;
  audience?: string;
  /** OIDC code flow: echo the RP's nonce into the id_token. When absent a
   * random one is invented (the debugger's mock SSO has no RP nonce). */
  nonce?: string;
}

function base64url(input: string | Buffer): string {
  const buffer = typeof input === "string" ? Buffer.from(input) : input;
  return buffer.toString("base64url");
}

function signJwt(
  header: JwtHeader,
  payload: JwtPayload,
  signingKey: KeyObject,
): string {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(signingKey, "base64url");

  return `${signingInput}.${signature}`;
}

function createValidIdJagPayload(
  params: IssueIdJagParams,
  now: number,
): JwtPayload {
  return {
    iss: params.issuer,
    sub: params.subject,
    aud: params.audience,
    resource: params.resource,
    client_id: params.clientId,
    jti: randomUUID(),
    iat: now,
    exp: now + ID_JAG_TTL_S,
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.email ? { email: params.email } : {}),
  };
}

function createValidIdJagHeader(): JwtHeader {
  return {
    alg: "RS256",
    typ: "oauth-id-jag+jwt",
    kid: XAA_IDP_KID,
  };
}

export function issueIdJag(params: IssueIdJagParams): {
  token: string;
  header: JwtHeader;
  payload: JwtPayload;
  expiresAt: number;
} {
  initXAAIdpKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const header = createValidIdJagHeader();
  const payload = createValidIdJagPayload(params, now);
  const token = signJwt(header, payload, getXAAIdpPrivateKey());

  return {
    token,
    header,
    payload,
    expiresAt: (payload.exp as number) * 1000,
  };
}

export function issueNegativeIdJag(
  params: IssueIdJagParams,
  mode: NegativeTestMode = DEFAULT_NEGATIVE_TEST_MODE,
): {
  token: string;
  header: JwtHeader;
  payload: JwtPayload;
  expiresAt: number;
} {
  if (mode === "valid") {
    return issueIdJag(params);
  }

  initXAAIdpKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const header = createValidIdJagHeader();
  const payload = createValidIdJagPayload(params, now);
  let signingKey = getXAAIdpPrivateKey();

  switch (mode) {
    case "bad_signature": {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      signingKey = pair.privateKey;
      break;
    }
    case "wrong_audience":
      payload.aud = "https://wrong-audience.example.com";
      break;
    case "expired":
      payload.iat = now - 2 * 60 * 60;
      payload.exp = now - 60 * 60;
      break;
    case "missing_claims":
      delete payload.sub;
      delete payload.resource;
      break;
    case "invalid_type_header":
      header.typ = "JWT";
      break;
    case "wrong_issuer":
      payload.iss = "https://wrong-issuer.example.com";
      break;
    case "resource_mismatch":
      payload.resource = "https://wrong-resource.example.com";
      break;
    case "client_id_mismatch":
      payload.client_id = "wrong-client-id";
      break;
    case "unknown_kid":
      header.kid = "nonexistent-key-id";
      break;
    case "unknown_sub":
      payload.sub = "unknown-user-00000";
      break;
    case "scope_denial":
      payload.scope = "admin:superuser offline_access";
      break;
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported XAA negative test mode: ${exhaustive}`);
    }
  }

  const token = signJwt(header, payload, signingKey);

  return {
    token,
    header,
    payload,
    expiresAt: Number(payload.exp) * 1000,
  };
}

export function issueMockIdToken(params: IssueMockIdTokenParams): {
  token: string;
  header: JwtHeader;
  payload: JwtPayload;
  expiresAt: number;
} {
  initXAAIdpKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const header: JwtHeader = {
    alg: "RS256",
    typ: "JWT",
    kid: XAA_IDP_KID,
  };
  const payload: JwtPayload = {
    iss: params.issuer,
    sub: params.subject,
    aud: params.audience || "mcpjam-xaa-debugger",
    email: params.email,
    iat: now,
    exp: now + ID_TOKEN_TTL_S,
    auth_time: now,
    // Echo the RP's nonce; omit it when none was requested. Inventing a nonce
    // the RP never sent trips strict OIDC clients that validate its absence.
    ...(params.nonce ? { nonce: params.nonce } : {}),
  };
  const token = signJwt(header, payload, getXAAIdpPrivateKey());

  return {
    token,
    header,
    payload,
    expiresAt: (payload.exp as number) * 1000,
  };
}

export interface IssueAuthorizationCodeParams {
  issuer: string;
  subject: string;
  email: string;
  clientId: string;
  redirectUri: string;
  nonce?: string;
  /** S256 PKCE challenge. When present, redeeming the code requires the
   * matching code_verifier. */
  codeChallenge?: string;
}

/**
 * Stateless OIDC authorization code: a short-TTL signed JWT, so it validates
 * on any replica without shared storage. One-time use is NOT enforced — a
 * 60-second code on a mock test IdP doesn't warrant a replay store; the
 * limitation is documented in the mock-OIDC doc.
 */
export function issueAuthorizationCode(params: IssueAuthorizationCodeParams): {
  token: string;
  payload: JwtPayload;
  expiresAt: number;
} {
  initXAAIdpKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const header: JwtHeader = {
    alg: "RS256",
    typ: XAA_CODE_JWT_TYP,
    kid: XAA_IDP_KID,
  };
  const payload: JwtPayload = {
    iss: params.issuer,
    sub: params.subject,
    email: params.email,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    jti: randomUUID(),
    iat: now,
    exp: now + AUTHORIZATION_CODE_TTL_S,
    ...(params.nonce ? { nonce: params.nonce } : {}),
    ...(params.codeChallenge ? { code_challenge: params.codeChallenge } : {}),
  };
  const token = signJwt(header, payload, getXAAIdpPrivateKey());

  return { token, payload, expiresAt: (payload.exp as number) * 1000 };
}

export interface IssueAccessTokenParams {
  issuer: string;
  subject: string;
  email: string;
  clientId: string;
}

/** Access token redeemable only at the mock IdP's own /userinfo. */
export function issueAccessToken(params: IssueAccessTokenParams): {
  token: string;
  payload: JwtPayload;
  expiresAt: number;
} {
  initXAAIdpKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const header: JwtHeader = {
    alg: "RS256",
    typ: XAA_ACCESS_TOKEN_TYP,
    kid: XAA_IDP_KID,
  };
  const payload: JwtPayload = {
    iss: params.issuer,
    sub: params.subject,
    email: params.email,
    aud: params.clientId,
    scope: "openid profile email",
    jti: randomUUID(),
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_S,
  };
  const token = signJwt(header, payload, getXAAIdpPrivateKey());

  return { token, payload, expiresAt: (payload.exp as number) * 1000 };
}

/**
 * Verify a JWT this IdP minted: RS256 signature against the IdP key, exact
 * `typ`, exact `iss`, unexpired. Throws on any failure; returns the payload.
 */
export function verifyXaaJwt(
  token: string,
  expected: { issuer: string; typ: string },
): JwtPayload {
  initXAAIdpKeyPair();

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }
  const [encodedHeader, encodedPayload, signature] = parts;

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
  } catch {
    throw new Error("Malformed token");
  }

  if (header.alg !== "RS256") {
    throw new Error("Unexpected token algorithm");
  }
  if (header.typ !== expected.typ) {
    throw new Error("Unexpected token type");
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  if (!verifier.verify(getXAAIdpPublicKeyObject(), signature, "base64url")) {
    throw new Error("Invalid token signature");
  }

  if (payload.iss !== expected.issuer) {
    throw new Error("Unexpected token issuer");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("Token expired");
  }

  return payload;
}
