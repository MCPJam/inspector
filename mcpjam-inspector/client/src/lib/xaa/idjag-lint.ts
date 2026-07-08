// Claim-by-claim lint for a decoded ID-JAG (Identity Assertion Authorization
// Grant). Pure functions: each claim gets a pass/warn/fail verdict with a
// spec citation, so the inspector can explain WHY a claim matters rather than
// only flagging mismatches against the configured flow.

export type IdJagLintStatus = "pass" | "warn" | "fail";

export interface IdJagLintCitation {
  spec: string;
  section: string;
}

export interface IdJagLintVerdict {
  id: "typ" | "iss" | "sub" | "aud" | "resource" | "client_id" | "jti" | "exp";
  claim: string;
  status: IdJagLintStatus;
  detail: string;
  citation: IdJagLintCitation;
  actual?: string;
}

/**
 * Expected values from the configured flow. All optional — when absent, the
 * lint degrades to presence/format checks instead of exact-match checks.
 */
export interface IdJagLintContext {
  expectedIssuer?: string;
  expectedAudience?: string;
  expectedResource?: string;
  expectedClientId?: string;
  /** Seconds-since-epoch "now"; injectable for tests. */
  nowSeconds?: number;
}

const ID_JAG_TYP = "oauth-id-jag+jwt";

// Lifetimes beyond this draw a warning: the ID-JAG is a single-use,
// immediately-redeemed artifact, so a long exp only widens the replay window.
const LONG_LIVED_THRESHOLD_S = 15 * 60;

const CITATIONS = {
  typ: { spec: "ID-JAG draft", section: "JWT typ header" },
  typBcp: { spec: "RFC 8725", section: "§3.11 explicit typing" },
  iss: { spec: "RFC 7523", section: "§3 (iss required)" },
  sub: { spec: "RFC 7523", section: "§3 (sub identifies the principal)" },
  aud: {
    spec: "RFC 7523",
    section: "§3 (aud must identify the authorization server)",
  },
  resource: { spec: "RFC 8707 / ID-JAG draft", section: "resource indicator" },
  clientId: { spec: "ID-JAG draft", section: "client_id binding" },
  jti: { spec: "RFC 7519", section: "§4.1.7 (jti replay prevention)" },
  exp: { spec: "RFC 7523", section: "§3 (exp required; reject expired)" },
} as const satisfies Record<string, IdJagLintCitation>;

function show(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function lintIdJag(
  header: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
  context: IdJagLintContext = {},
): IdJagLintVerdict[] {
  const h = header ?? {};
  const p = payload ?? {};
  const now = context.nowSeconds ?? Math.floor(Date.now() / 1000);
  const verdicts: IdJagLintVerdict[] = [];

  // typ header — explicit typing prevents this JWT from being replayed where
  // a generic JWT (or an ID token) is accepted.
  verdicts.push(
    h.typ === ID_JAG_TYP
      ? {
          id: "typ",
          claim: "typ header",
          status: "pass",
          detail: `Explicitly typed as ${ID_JAG_TYP}, so the assertion can't be confused with an ID token or generic JWT.`,
          citation: CITATIONS.typ,
          actual: show(h.typ),
        }
      : {
          id: "typ",
          claim: "typ header",
          status: "fail",
          detail: `Expected ${ID_JAG_TYP}. Without explicit typing, an authorization server may accept this token in contexts it was never meant for (token-confusion).`,
          citation: h.typ === "JWT" ? CITATIONS.typBcp : CITATIONS.typ,
          actual: show(h.typ),
        },
  );

  // iss
  if (!isNonEmptyString(p.iss)) {
    verdicts.push({
      id: "iss",
      claim: "iss",
      status: "fail",
      detail:
        "Missing issuer. The authorization server can't establish which identity provider signed the assertion.",
      citation: CITATIONS.iss,
      actual: show(p.iss),
    });
  } else if (context.expectedIssuer && p.iss !== context.expectedIssuer) {
    verdicts.push({
      id: "iss",
      claim: "iss",
      status: "fail",
      detail: `Issuer does not match the identity provider configured for this flow (${context.expectedIssuer}). The authorization server will reject the assertion as untrusted.`,
      citation: CITATIONS.iss,
      actual: p.iss,
    });
  } else {
    verdicts.push({
      id: "iss",
      claim: "iss",
      status: "pass",
      detail: "Issuer present and matches the identity provider.",
      citation: CITATIONS.iss,
      actual: p.iss,
    });
  }

  // sub
  verdicts.push(
    isNonEmptyString(p.sub)
      ? {
          id: "sub",
          claim: "sub",
          status: "pass",
          detail: "Subject identifies the user the grant was issued for.",
          citation: CITATIONS.sub,
          actual: p.sub,
        }
      : {
          id: "sub",
          claim: "sub",
          status: "fail",
          detail:
            "Missing subject. The authorization server can't tell which user this grant represents.",
          citation: CITATIONS.sub,
          actual: show(p.sub),
        },
  );

  // aud — exact match against the authorization server's issuer identifier.
  if (!isNonEmptyString(p.aud)) {
    verdicts.push({
      id: "aud",
      claim: "aud",
      status: "fail",
      detail: Array.isArray(p.aud)
        ? "Audience is an array. The ID-JAG audience must be the single issuer identifier of the authorization server it will be redeemed at."
        : "Missing audience. The assertion must name the authorization server it will be redeemed at.",
      citation: CITATIONS.aud,
      actual: show(p.aud),
    });
  } else if (context.expectedAudience && p.aud !== context.expectedAudience) {
    verdicts.push({
      id: "aud",
      claim: "aud",
      status: "fail",
      detail: `Audience must exactly match the authorization server issuer (${context.expectedAudience}). A different audience means the assertion was minted for another server and must be rejected.`,
      citation: CITATIONS.aud,
      actual: p.aud,
    });
  } else {
    verdicts.push({
      id: "aud",
      claim: "aud",
      status: "pass",
      detail:
        "Audience names the authorization server the assertion is redeemed at.",
      citation: CITATIONS.aud,
      actual: p.aud,
    });
  }

  // resource
  if (!isNonEmptyString(p.resource)) {
    verdicts.push({
      id: "resource",
      claim: "resource",
      status: "fail",
      detail:
        "Missing resource indicator. The access token's audience can't be scoped to the protected resource.",
      citation: CITATIONS.resource,
      actual: show(p.resource),
    });
  } else if (
    context.expectedResource &&
    p.resource !== context.expectedResource
  ) {
    verdicts.push({
      id: "resource",
      claim: "resource",
      status: "fail",
      detail: `Resource does not match the protected resource configured for this flow (${context.expectedResource}).`,
      citation: CITATIONS.resource,
      actual: p.resource,
    });
  } else {
    verdicts.push({
      id: "resource",
      claim: "resource",
      status: "pass",
      detail: "Resource identifies the protected resource being accessed.",
      citation: CITATIONS.resource,
      actual: p.resource,
    });
  }

  // client_id
  if (!isNonEmptyString(p.client_id)) {
    verdicts.push({
      id: "client_id",
      claim: "client_id",
      status: "fail",
      detail:
        "Missing client binding. The grant must name the client that will redeem it, so a different client can't replay it.",
      citation: CITATIONS.clientId,
      actual: show(p.client_id),
    });
  } else if (
    context.expectedClientId &&
    p.client_id !== context.expectedClientId
  ) {
    verdicts.push({
      id: "client_id",
      claim: "client_id",
      status: "fail",
      detail: `client_id does not match the client configured for this flow (${context.expectedClientId}). The authorization server must reject a grant bound to another client.`,
      citation: CITATIONS.clientId,
      actual: p.client_id,
    });
  } else {
    verdicts.push({
      id: "client_id",
      claim: "client_id",
      status: "pass",
      detail: "Grant is bound to the redeeming client.",
      citation: CITATIONS.clientId,
      actual: p.client_id,
    });
  }

  // jti
  verdicts.push(
    isNonEmptyString(p.jti)
      ? {
          id: "jti",
          claim: "jti",
          status: "pass",
          detail:
            "Unique token id present — the authorization server can detect replays of this assertion.",
          citation: CITATIONS.jti,
          actual: p.jti,
        }
      : {
          id: "jti",
          claim: "jti",
          status: "warn",
          detail:
            "No jti. Without a unique token id the authorization server can't detect a replayed assertion.",
          citation: CITATIONS.jti,
          actual: show(p.jti),
        },
  );

  // exp
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) {
    verdicts.push({
      id: "exp",
      claim: "exp",
      status: "fail",
      detail:
        "Missing or non-numeric expiration. JWT authorization grants must carry an exp and be rejected once past it.",
      citation: CITATIONS.exp,
      actual: show(p.exp),
    });
  } else if (p.exp <= now) {
    verdicts.push({
      id: "exp",
      claim: "exp",
      status: "fail",
      detail:
        "Assertion is expired. An authorization server that still issues an access token for it is not validating exp.",
      citation: CITATIONS.exp,
      actual: new Date(p.exp * 1000).toISOString(),
    });
  } else if (p.exp - now > LONG_LIVED_THRESHOLD_S) {
    verdicts.push({
      id: "exp",
      claim: "exp",
      status: "warn",
      detail:
        "Unusually long lifetime for a single-use assertion. The ID-JAG is redeemed immediately, so a short exp (minutes) keeps the replay window small.",
      citation: CITATIONS.exp,
      actual: new Date(p.exp * 1000).toISOString(),
    });
  } else {
    verdicts.push({
      id: "exp",
      claim: "exp",
      status: "pass",
      detail: "Short-lived and not yet expired.",
      citation: CITATIONS.exp,
      actual: new Date(p.exp * 1000).toISOString(),
    });
  }

  return verdicts;
}
