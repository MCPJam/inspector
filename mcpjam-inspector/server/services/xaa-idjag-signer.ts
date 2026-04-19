import {
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "crypto";
import {
  getXAAIdpPrivateKey,
  initXAAIdpKeyPair,
} from "./xaa-idp-keypair.js";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  type NegativeTestMode,
  XAA_IDP_KID,
} from "../../shared/xaa.js";

const ID_JAG_TTL_S = 5 * 60;
const ID_TOKEN_TTL_S = 5 * 60;

type JwtHeader = Record<string, unknown>;
type JwtPayload = Record<string, unknown>;

export interface IssueIdJagParams {
  issuer: string;
  subject: string;
  audience: string;
  resource: string;
  clientId: string;
  scope?: string;
}

export interface IssueMockIdTokenParams {
  issuer: string;
  subject: string;
  email: string;
  audience?: string;
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
    nonce: randomUUID(),
  };
  const token = signJwt(header, payload, getXAAIdpPrivateKey());

  return {
    token,
    header,
    payload,
    expiresAt: (payload.exp as number) * 1000,
  };
}
