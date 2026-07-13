// Shared mock-IdP handler cores for the MCPJam-owned XAA mint routes. The
// inspector server (Hono routes) and the CLI's in-process executor both wrap
// these; the cores own the mint contract — status codes, error strings, and
// response-body shapes — while the adapters own everything transport-shaped:
// JSON/zod parsing, negative-test-mode resolution, org gating, hosted-issuer
// forwarding, rate limiting, and cache-control headers. Node-only (the signer
// pulls in crypto/fs); export from the node barrel, never the browser entry.
import {
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  XAA_DEBUG_IDP_CLIENT_ID,
} from "../../oauth/client-identity.js";
import type { NegativeTestMode } from "../constants.js";
import {
  issueIdJag,
  issueMockIdToken,
  issueNegativeIdJag,
  validateXaaTokenExchangeSubject,
  verifyXaaJwt,
} from "./signer.js";

/** Transport-free handler outcome; the adapter serializes it as JSON. */
export interface XaaMintHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

function expiresInSeconds(expiresAt: number): number {
  return Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
}

function oauthErrorResult(
  status: number,
  error: string,
  description: string
): XaaMintHandlerResult {
  return { status, body: { error, error_description: description } };
}

// ── /authenticate ──────────────────────────────────────────────────────────

export interface XaaAuthenticateParams {
  issuer: string;
  userId?: string;
  email?: string;
  audience?: string;
  resourceClientId?: string;
}

/**
 * Mock OIDC login → id_token. Subject and email fall back to the demo
 * identity when absent, so no path can mint an empty-subject ID token.
 * Mint failures throw; the adapter owns the error-body shape.
 */
export function handleXaaAuthenticate(
  params: XaaAuthenticateParams
): XaaMintHandlerResult {
  const subject = params.userId || "user-12345";
  const email = params.email || "demo.user@example.com";
  const issued = issueMockIdToken({
    issuer: params.issuer,
    subject,
    email,
    audience: params.audience,
    resourceClientId: params.resourceClientId,
  });

  return {
    status: 200,
    body: {
      id_token: issued.token,
      token_type: "Bearer",
      expires_in: expiresInSeconds(issued.expiresAt),
      user: {
        sub: subject,
        email,
      },
    },
  };
}

// ── /token-exchange (forgiving JSON mint route) ────────────────────────────

export interface XaaJsonTokenExchangeParams {
  issuer: string;
  identityAssertion: string;
  audience: string;
  resource?: string;
  clientId: string;
  scope?: string;
  /** Pre-validated by the adapter (zod + resolveNegativeTestMode on the
   * server, isNegativeTestMode in-process). */
  negativeTestMode: NegativeTestMode;
}

// Deliberately unsafe (no signature check): this route exists to mint the
// intentionally malformed assertions negative tests need.
function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Identity assertion must be a JWT");
  }

  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Identity assertion payload is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
}

/**
 * Token exchange → ID-JAG. Decodes the identity assertion (unverified — see
 * decodeJwtPayloadUnsafe) for sub/email, then mints, applying the
 * negative-test tamper when requested. A malformed assertion or one without a
 * subject throws; the adapter maps that to its 400 shape — never a silently
 * minted empty-subject ID-JAG.
 */
export function handleXaaJsonTokenExchange(
  params: XaaJsonTokenExchangeParams
): XaaMintHandlerResult {
  const identityPayload = decodeJwtPayloadUnsafe(params.identityAssertion);
  const subject =
    typeof identityPayload.sub === "string" ? identityPayload.sub.trim() : "";
  if (!subject) {
    throw new Error(
      "Identity assertion payload must contain a non-empty `sub` claim"
    );
  }
  // Carry the ID token's email into the ID-JAG (spec RECOMMENDED) so the
  // Resource AS can use it for subject resolution / JIT provisioning.
  const email =
    typeof identityPayload.email === "string"
      ? identityPayload.email
      : undefined;

  const mintParams = {
    issuer: params.issuer,
    subject,
    email,
    audience: params.audience,
    resource: params.resource,
    clientId: params.clientId,
    scope: params.scope,
  };
  const issued =
    params.negativeTestMode === "valid"
      ? issueIdJag(mintParams)
      : issueNegativeIdJag(mintParams, params.negativeTestMode);

  return {
    status: 200,
    body: {
      id_jag: issued.token,
      token_type: "N_A",
      issued_token_type: ID_JAG_TOKEN_TYPE,
      expires_in: expiresInSeconds(issued.expiresAt),
      negative_test_mode: params.negativeTestMode,
    },
  };
}

// ── /token (RFC 8693 token-exchange grant) ─────────────────────────────────

/**
 * Standards-track RFC 8693 token exchange over raw form params. Grant-type
 * dispatch, cross-origin checks, IP caps, and org gating are adapter
 * concerns; this core owns the OAuth-error-shaped failures and the rich
 * success body. Stricter than the JSON route: the subject token must be an ID
 * token THIS issuer signed, unexpired.
 */
export function handleXaaTokenExchangeGrant(
  issuer: string,
  form: Record<string, string>
): XaaMintHandlerResult {
  if (form.requested_token_type !== ID_JAG_TOKEN_TYPE) {
    return oauthErrorResult(
      400,
      "invalid_request",
      `requested_token_type must be ${ID_JAG_TOKEN_TYPE}`
    );
  }
  if (form.subject_token_type !== ID_TOKEN_TOKEN_TYPE) {
    return oauthErrorResult(
      400,
      "invalid_request",
      `subject_token_type must be ${ID_TOKEN_TOKEN_TYPE}`
    );
  }
  const clientId = form.client_id;
  if (!clientId) {
    return oauthErrorResult(400, "invalid_request", "client_id is required");
  }
  // This endpoint models the Client-to-IdP exchange. Its client_id is the
  // public debugger client registered at the mock IdP, not the separate
  // client identity that the RAS expects in the resulting ID-JAG.
  if (clientId !== XAA_DEBUG_IDP_CLIENT_ID) {
    return oauthErrorResult(
      401,
      "invalid_client",
      "Unknown mock IdP client_id"
    );
  }
  if (!form.subject_token || !form.audience) {
    return oauthErrorResult(
      400,
      "invalid_request",
      "subject_token and audience are required"
    );
  }

  let subjectPayload: Record<string, unknown>;
  let subject: ReturnType<typeof validateXaaTokenExchangeSubject>;
  try {
    subjectPayload = verifyXaaJwt(form.subject_token, {
      issuer,
      typ: "JWT",
    });
    subject = validateXaaTokenExchangeSubject(
      subjectPayload,
      XAA_DEBUG_IDP_CLIENT_ID
    );
  } catch (error) {
    return oauthErrorResult(
      400,
      "invalid_grant",
      error instanceof Error ? error.message : "Invalid subject_token"
    );
  }
  const issued = issueIdJag({
    issuer,
    subject: subject.subject,
    email: subject.email,
    audience: form.audience,
    resource: form.resource || undefined,
    clientId: subject.resourceClientId,
    scope: form.scope || undefined,
  });

  return {
    status: 200,
    body: {
      issued_token_type: ID_JAG_TOKEN_TYPE,
      access_token: issued.token,
      token_type: "N_A",
      expires_in: expiresInSeconds(issued.expiresAt),
      ...(form.scope ? { scope: form.scope } : {}),
    },
  };
}
