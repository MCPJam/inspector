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
  SAML2_TOKEN_TYPE,
  XAA_DEBUG_IDP_CLIENT_ID,
} from "../../oauth/client-identity.js";
import {
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
  normalizeSubjectIdentifierFormat,
  type IdentityAssertionFormat,
  type SubjectIdentifierFormat,
} from "../constants.js";
import type { NegativeTestMode } from "../constants.js";
import {
  issueIdJag,
  issueMockIdToken,
  issueNegativeIdJag,
  validateXaaTokenExchangeSubject,
  verifyXaaJwt,
  type IdJagSubjectId,
} from "./signer.js";
import {
  decodeSamlAssertionSubjectUnsafe,
  issueMockSamlAssertion,
  verifyMockSamlAssertion,
  SAML_NAMEID_FORMAT_PERSISTENT,
} from "./saml.js";

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

/**
 * Output-axis `sub_id` per draft §3.2.2 (D5): the NameID the IdP would issue
 * for SSO TO THE TARGET RAS. `issuer` is the mock IdP's issuer URL (its SAML
 * entity ID), `nameid` the stable per-user subject just resolved,
 * `sp_name_qualifier` the target RAS's SP entity ID — in the mock, the
 * exchange's `audience`. The subject token's own NameID/audience is NEVER
 * copied in: those identify the requesting client's SSO session, not the
 * user's identity at the target RAS.
 */
function buildSamlNameIdSubjectId(
  issuer: string,
  subject: string,
  targetRasEntityId: string
): IdJagSubjectId {
  return {
    format: "saml-nameid",
    issuer,
    nameid: subject,
    sp_name_qualifier: targetRasEntityId,
    nameid_format: SAML_NAMEID_FORMAT_PERSISTENT,
  };
}

// ── /authenticate ──────────────────────────────────────────────────────────

export interface XaaAuthenticateParams {
  issuer: string;
  userId?: string;
  email?: string;
  audience?: string;
  resourceClientId?: string;
  /** Input axis: which assertion format to mint. Defaults to "oidc". */
  assertionFormat?: IdentityAssertionFormat;
}

/**
 * Mock login → identity assertion. OIDC (the default) mints an id_token with
 * a response body that MUST stay byte-identical (hosted-issuer runs forward
 * it verbatim); SAML mints a signed assertion plus structured subject
 * metadata so the browser never parses XML. Subject and email fall back to
 * the demo identity when absent, so no path can mint an empty-subject
 * assertion. Mint failures throw; the adapter owns the error-body shape.
 */
export function handleXaaAuthenticate(
  params: XaaAuthenticateParams
): XaaMintHandlerResult {
  const subject = params.userId || "user-12345";
  const email = params.email || "demo.user@example.com";

  if (
    (params.assertionFormat ?? DEFAULT_IDENTITY_ASSERTION_FORMAT) === "saml"
  ) {
    const issued = issueMockSamlAssertion({
      issuer: params.issuer,
      subject,
      email,
      // The requesting client's SP entity ID; in the mock, its IdP client id.
      spEntityId: params.audience || XAA_DEBUG_IDP_CLIENT_ID,
      resourceClientId: params.resourceClientId,
    });

    return {
      status: 200,
      body: {
        assertion: issued.assertionB64,
        assertion_format: "saml",
        token_type: "Bearer",
        expires_in: expiresInSeconds(issued.expiresAt),
        subject: issued.subject,
        user: {
          sub: subject,
          email,
        },
      },
    };
  }

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
  /** Input axis: how to decode `identityAssertion`. Defaults to "oidc". */
  assertionFormat?: IdentityAssertionFormat;
  /** Output axis: mint a saml-nameid `sub_id` when "saml-nameid".
   * Independent of the input axis. Defaults to "oauth-sub". */
  subjectIdFormat?: SubjectIdentifierFormat;
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
  let subject: string;
  let email: string | undefined;

  if (
    (params.assertionFormat ?? DEFAULT_IDENTITY_ASSERTION_FORMAT) === "saml"
  ) {
    // Lenient like the JWT path: no signature enforcement (the decode itself
    // still size-caps and rejects DTDs).
    const decoded = decodeSamlAssertionSubjectUnsafe(params.identityAssertion);
    subject = decoded.nameid.trim();
    if (!subject) {
      throw new Error("Identity assertion must contain a non-empty NameID");
    }
    email = decoded.email;
  } else {
    const identityPayload = decodeJwtPayloadUnsafe(params.identityAssertion);
    subject =
      typeof identityPayload.sub === "string" ? identityPayload.sub.trim() : "";
    if (!subject) {
      throw new Error(
        "Identity assertion payload must contain a non-empty `sub` claim"
      );
    }
    // Carry the ID token's email into the ID-JAG (spec RECOMMENDED) so the
    // Resource AS can use it for subject resolution / JIT provisioning.
    email =
      typeof identityPayload.email === "string"
        ? identityPayload.email
        : undefined;
  }

  const mintParams = {
    issuer: params.issuer,
    subject,
    email,
    audience: params.audience,
    resource: params.resource,
    clientId: params.clientId,
    scope: params.scope,
    // Output axis, independent of how the assertion above was decoded.
    ...((params.subjectIdFormat ?? DEFAULT_SUBJECT_IDENTIFIER_FORMAT) ===
    "saml-nameid"
      ? {
          subjectId: buildSamlNameIdSubjectId(
            params.issuer,
            subject,
            params.audience
          ),
        }
      : {}),
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
 * success body. Stricter than the JSON route: the subject token must be an
 * assertion THIS issuer signed, unexpired — an ID token
 * (`urn:ietf:params:oauth:token-type:id_token`) or a signed SAML 2.0
 * assertion (`urn:ietf:params:oauth:token-type:saml2`, draft §4.3).
 *
 * Mock extension: `subject_id_format=saml-nameid` asks for a `sub_id` claim
 * in the ID-JAG (output axis). A real IdP decides this from its RAS
 * registry; the mock has none, so the debugger states it explicitly. Omitted
 * (or `oauth-sub`) keeps the exchange byte-identical to the pre-SAML wire.
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
  if (
    form.subject_token_type !== ID_TOKEN_TOKEN_TYPE &&
    form.subject_token_type !== SAML2_TOKEN_TYPE
  ) {
    return oauthErrorResult(
      400,
      "invalid_request",
      `subject_token_type must be ${ID_TOKEN_TOKEN_TYPE} or ${SAML2_TOKEN_TYPE}`
    );
  }
  // Validate before routing: an unknown output-axis value is a client error,
  // never a silent fallback.
  const subjectIdFormat =
    form.subject_id_format === undefined || form.subject_id_format === ""
      ? DEFAULT_SUBJECT_IDENTIFIER_FORMAT
      : normalizeSubjectIdentifierFormat(form.subject_id_format);
  if (subjectIdFormat === undefined) {
    return oauthErrorResult(
      400,
      "invalid_request",
      "subject_id_format must be oauth-sub or saml-nameid"
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

  let subject: {
    subject: string;
    email?: string;
    resourceClientId: string;
  };
  try {
    if (form.subject_token_type === SAML2_TOKEN_TYPE) {
      // Strict SAML verification. The AudienceRestriction must name the SP
      // entity ID the IdP's registration maps the AUTHENTICATED client_id to
      // — in the mock both are the debug client id, but the mapping is a
      // lookup, not an equality between unrelated identifiers.
      const verified = verifyMockSamlAssertion(form.subject_token, {
        issuer,
        audience: clientId,
      });
      subject = {
        subject: verified.nameid,
        ...(verified.email ? { email: verified.email } : {}),
        resourceClientId: verified.resourceClientId,
      };
    } else {
      const subjectPayload = verifyXaaJwt(form.subject_token, {
        issuer,
        typ: "JWT",
      });
      subject = validateXaaTokenExchangeSubject(
        subjectPayload,
        XAA_DEBUG_IDP_CLIENT_ID
      );
    }
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
    // Output axis, independent of the subject token's format. Never derived
    // from the subject token's own NameID/audience.
    ...(subjectIdFormat === "saml-nameid"
      ? {
          subjectId: buildSamlNameIdSubjectId(
            issuer,
            subject.subject,
            form.audience
          ),
        }
      : {}),
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
