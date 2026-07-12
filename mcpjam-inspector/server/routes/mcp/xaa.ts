import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  NEGATIVE_TEST_MODES,
  NEGATIVE_TEST_MODE_DETAILS,
  XAA_IDP_KID,
  type NegativeTestDiff,
  type NegativeTestMode,
} from "../../../shared/xaa.js";
import {
  getXAAIdpJwks,
  initXAAIdpKeyPair,
} from "../../services/xaa-idp-keypair.js";
import {
  issueAccessToken,
  issueAuthorizationCode,
  issueIdJag,
  issueMockIdToken,
  issueNegativeIdJag,
  verifyXaaJwt,
  XAA_ACCESS_TOKEN_TYP,
  XAA_CODE_JWT_TYP,
} from "../../services/xaa-idjag-signer.js";
import { createHash } from "crypto";
import {
  buildJwtBearerRequest,
  getIssuerForRequest,
  resolveServerTarget,
} from "../../services/xaa-mint.js";
import {
  executeOAuthProxy,
  fetchOAuthMetadata,
  OAuthProxyError,
  validateUrl,
} from "../../utils/oauth-proxy.js";
import {
  buildDiscoveryCandidates,
  evaluateDiscovery,
} from "../../services/xaa-discovery.js";
import { WebRouteError } from "../web/errors.js";
import {
  fetchServerClientSecret,
  fetchXaaResourceAppSecret,
} from "../../utils/server-secrets.js";
import type {
  ServerClientSecretResult,
  XaaResourceAppSecretResult,
} from "../../utils/server-secrets.js";
import { logger } from "../../utils/logger.js";
import { MCPJAM_HOSTED_ORIGIN } from "../../config.js";

const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const NEGATIVE_TEST_CASE_TIMEOUT_MS = 8_000;

// Hard per-host daily cap on negative-test runs. This is a server-side
// backstop independent of the client-side "passed a positive run" gate: even
// with the override, a single authorization-server host can't be hammered.
const NEGATIVE_TEST_DAILY_CAP = 50;
const NEGATIVE_TEST_DAY_MS = 24 * 60 * 60 * 1000;
const negativeTestHostCounters = new Map<
  string,
  { count: number; windowStart: number }
>();

function checkNegativeTestHostCap(host: string): boolean {
  const now = Date.now();
  const existing = negativeTestHostCounters.get(host);
  if (!existing || now - existing.windowStart >= NEGATIVE_TEST_DAY_MS) {
    negativeTestHostCounters.set(host, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= NEGATIVE_TEST_DAILY_CAP) {
    return false;
  }
  existing.count += 1;
  return true;
}

// Path-segment allowlist for the org-scoped issuer. The segment is embedded
// into the ID-JAG `iss`, so it must be validated before URL-embedding. Convex
// org ids are opaque strings; real ones fit [A-Za-z0-9_-], and anything else
// is rejected rather than normalized.
const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Single source of truth for what a legal org path segment looks like, shared
// by the well-known routes, the gated mint routes, and the hosted-issuer
// forward so they can never validate org ids differently.
function isValidOrgId(value: unknown): value is string {
  return typeof value === "string" && ORG_ID_RE.test(value);
}

// Validates the `:orgId` route param; returns the id or the 400 Response.
function validateOrgSegment(c: Context): string | Response {
  const orgId = c.req.param("orgId");
  if (!isValidOrgId(orgId)) {
    return toJsonError("Invalid organization id in issuer path", {
      status: 400,
      code: "VALIDATION_ERROR",
    });
  }
  return orgId;
}

// ── Mock OIDC IdP (authorization_code + userinfo) ─────────────────────────
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ID_TOKEN_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

// Best-effort per-IP sliding-window cap on the public OIDC endpoints that sign
// something (/token, /authorize/confirm). X-Forwarded-For is client-spoofable
// so this only slows casual abuse, not a determined attacker — acceptable for
// a flag-gated mock IdP that only signs low-value mock tokens. The map is
// bounded so a spoofed-key flood can't exhaust memory.
const OIDC_RATE_LIMIT_PER_MIN = 60;
const OIDC_RATE_WINDOW_MS = 60 * 1000;
const OIDC_RATE_MAX_KEYS = 10_000;
const oidcIpCounters = new Map<string, { count: number; windowStart: number }>();

function checkOidcIpCap(ip: string): boolean {
  const now = Date.now();
  // Bound the map: prune expired windows, and if it's still oversized (an
  // active spoofed-key flood where every window is fresh) drop everything so
  // memory can't grow without limit.
  if (oidcIpCounters.size >= OIDC_RATE_MAX_KEYS) {
    for (const [key, value] of oidcIpCounters) {
      if (now - value.windowStart >= OIDC_RATE_WINDOW_MS) {
        oidcIpCounters.delete(key);
      }
    }
    if (oidcIpCounters.size >= OIDC_RATE_MAX_KEYS) {
      oidcIpCounters.clear();
    }
  }
  const existing = oidcIpCounters.get(ip);
  if (!existing || now - existing.windowStart >= OIDC_RATE_WINDOW_MS) {
    oidcIpCounters.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (existing.count >= OIDC_RATE_LIMIT_PER_MIN) {
    return false;
  }
  existing.count += 1;
  return true;
}

// The client IP for rate limiting, or null when there is no proxy in front
// (local desktop): a no-proxy deployment has no public DoS surface, and
// bucketing every local request under one key would self-DoS legitimate
// bursts (test loops, batch mints).
function getClientIp(c: {
  req: { header: (name: string) => string | undefined };
}): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

// Reject cross-site browser POSTs to the state-changing OIDC endpoints. A
// legitimate caller is either our own interstitial form (same-origin Origin)
// or a relying party's server-to-server token call (no Origin header). Only a
// cross-site browser request carries a foreign Origin — blocking it stops a
// third-party page from driving /authorize/confirm (open redirect) or /token
// (unauthenticated ID-JAG mint) against the user's issuer.
function rejectCrossOriginPost(c: Context): Response | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return oauthError(403, "access_denied", "Invalid Origin header");
  }
  if (originHost !== new URL(c.req.url).host) {
    return oauthError(403, "access_denied", "Cross-origin request rejected");
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oauthError(
  status: number,
  error: string,
  description: string
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state?: string;
  nonce?: string;
  scope?: string;
  codeChallenge?: string;
  subject?: string;
  email?: string;
}

// Shared validation for GET /authorize and POST /authorize/confirm — the
// confirm form round-trips the same values, and nothing hidden is trusted
// more than the original query. Returns an error string on failure.
function parseAuthorizeParams(
  raw: Record<string, string | undefined>
): AuthorizeParams | { error: string } {
  const clientId = raw.client_id?.trim();
  if (!clientId || clientId.length > 256) {
    return { error: "client_id is required" };
  }
  const redirectUri = raw.redirect_uri?.trim();
  if (!redirectUri || redirectUri.length > 2048) {
    return { error: "redirect_uri is required" };
  }
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(redirectUri);
  } catch {
    return { error: "redirect_uri is not a valid URL" };
  }
  if (parsedRedirect.protocol !== "https:" && parsedRedirect.protocol !== "http:") {
    return { error: "redirect_uri must be http(s)" };
  }
  if (parsedRedirect.hash) {
    return { error: "redirect_uri must not contain a fragment" };
  }
  if ((raw.response_type ?? "code") !== "code") {
    return { error: "Only response_type=code is supported" };
  }
  const codeChallenge = raw.code_challenge?.trim() || undefined;
  const codeChallengeMethod = raw.code_challenge_method?.trim() || undefined;
  if (codeChallenge) {
    if (codeChallenge.length > 256) {
      return { error: "code_challenge is too long" };
    }
    if (codeChallengeMethod !== "S256") {
      return { error: "Only code_challenge_method=S256 is supported" };
    }
  } else if (codeChallengeMethod) {
    // A method without a challenge would otherwise mint a non-PKCE code under
    // a PKCE-looking request, which redeems with no verifier — reject it.
    return { error: "code_challenge_method requires code_challenge" };
  }
  for (const field of ["state", "nonce", "scope", "subject", "email"] as const) {
    const value = raw[field];
    if (value !== undefined && value.length > 512) {
      return { error: `${field} is too long` };
    }
  }
  return {
    clientId,
    redirectUri,
    state: raw.state || undefined,
    nonce: raw.nonce || undefined,
    scope: raw.scope || undefined,
    codeChallenge,
    subject: raw.subject?.trim() || undefined,
    email: raw.email?.trim() || undefined,
  };
}

// Self-contained interstitial: shows who is asking (client_id) and where the
// browser will be sent (redirect host), with an editable mock identity. It
// NEVER auto-redirects — the explicit click plus the visible destination host
// is the open-redirect mitigation for a public authorize endpoint. Every
// echoed value is HTML-escaped.
function renderAuthorizePage(args: {
  confirmUrl: string;
  params: AuthorizeParams;
}): string {
  const { confirmUrl, params } = args;
  const redirectHost = new URL(params.redirectUri).host;
  const hidden = (name: string, value: string | undefined) =>
    value
      ? `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`
      : "";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCPJam test sign-in</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .card { background: #fff; border: 1px solid #e2e2e2; border-radius: 12px; padding: 32px; max-width: 26rem; width: 100%; box-shadow: 0 4px 16px rgba(0,0,0,.06); }
    h1 { font-size: 1.1rem; margin: 0 0 8px; }
    p { font-size: .85rem; color: #555; margin: 0 0 16px; line-height: 1.45; }
    label { display: block; font-size: .75rem; font-weight: 600; color: #333; margin: 12px 0 4px; }
    input[type="text"], input[type="email"] { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; font-size: .9rem; }
    button { margin-top: 20px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #111; color: #fff; font-size: .9rem; font-weight: 600; cursor: pointer; }
    code { background: #f0f0f0; border-radius: 4px; padding: 1px 4px; font-size: .8rem; }
    .warn { font-size: .75rem; color: #777; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MCPJam test identity provider</h1>
    <p>
      <code>${escapeHtml(params.clientId)}</code> is asking to sign you in.
      Continuing sends the browser to
      <strong>${escapeHtml(redirectHost)}</strong> with a sign-in code for the
      identity below.
    </p>
    <form method="POST" action="${escapeHtml(confirmUrl)}">
      ${hidden("client_id", params.clientId)}
      ${hidden("redirect_uri", params.redirectUri)}
      ${hidden("state", params.state)}
      ${hidden("nonce", params.nonce)}
      ${hidden("scope", params.scope)}
      ${hidden("code_challenge", params.codeChallenge)}
      ${params.codeChallenge ? hidden("code_challenge_method", "S256") : ""}
      <input type="hidden" name="response_type" value="code" />
      <label for="subject">Subject (sub)</label>
      <input type="text" id="subject" name="subject" value="${escapeHtml(params.subject || "user-12345")}" />
      <label for="email">Email</label>
      <input type="email" id="email" name="email" value="${escapeHtml(params.email || "demo.user@example.com")}" />
      <button type="submit">Continue to ${escapeHtml(redirectHost)}</button>
    </form>
    <p class="warn">
      This is a mock IdP for testing — anyone can sign in as any identity.
      Never trust it with real users or production data.
    </p>
  </div>
</body>
</html>`;
}

const authenticateSchema = z.object({
  userId: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  audience: z.string().trim().min(1).optional(),
});

const tokenExchangeSchema = z.object({
  identityAssertion: z.string().trim().min(1),
  audience: z.string().trim().min(1),
  resource: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  scope: z.string().trim().min(1).optional(),
  negativeTestMode: z.string().trim().optional(),
});

const discoverAsSchema = z
  .object({
    issuer: z.string().trim().min(1).optional(),
    tokenEndpoint: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.issuer || data.tokenEndpoint, {
    message: "issuer or tokenEndpoint is required",
  });

const healthCheckSchema = z.object({
  url: z.string().trim().min(1),
});

const negativeTestsSchema = z
  .object({
    audience: z.string().trim().min(1),
    resource: z.string().trim().min(1),
    subject: z.string().trim().min(1).optional(),
    clientId: z.string().trim().min(1).optional(),
    scope: z.string().trim().min(1).optional(),
    tokenEndpoint: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    registrationId: z.string().trim().min(1).optional(),
    serverId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
  })
  .refine(
    (data) => data.registrationId || data.serverId || data.tokenEndpoint,
    {
      message: "tokenEndpoint, registrationId, or serverId is required",
    }
  );

type NegativeCaseOutcome = {
  mode: NegativeTestMode;
  label: string;
  expectedFailure: string;
  // What the authorization server did with the deliberately-broken assertion.
  outcome: "rejected" | "accepted" | "timeout" | "error";
  // pass = the AS correctly rejected the broken assertion; fail = the AS
  // issued a token for it (a real security finding); unknown = couldn't tell.
  verdict: "pass" | "fail" | "unknown";
  status?: number;
  detail?: string;
  // What the broken assertion changed vs. a valid one, for the scorecard diff.
  diff?: NegativeTestDiff;
};

// The 11 deliberately-broken modes (everything except the happy-path "valid").
const NEGATIVE_CASE_MODES: NegativeTestMode[] = NEGATIVE_TEST_MODES.filter(
  (mode): mode is NegativeTestMode => mode !== "valid"
);

// Build the "sent X / expected Y" diff from the assertion the signer actually
// emitted (header + payload), so the displayed values can't drift from the
// real mutation. `expected` is the value a valid ID-JAG would carry.
function buildNegativeDiff(
  mode: NegativeTestMode,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  expected: {
    audience: string;
    resource: string;
    clientId: string;
    subject: string;
    scope?: string;
    issuer: string;
  }
): NegativeTestDiff | undefined {
  const show = (value: unknown): string =>
    value === undefined || value === null ? "(omitted)" : String(value);

  switch (mode) {
    case "bad_signature":
      return {
        field: "signature",
        sent: "signed with a throwaway key",
        expected: "signed with the published JWKS key",
      };
    case "wrong_audience":
      return {
        field: "aud",
        sent: show(payload.aud),
        expected: expected.audience,
      };
    case "expired":
      return {
        field: "exp",
        sent: `${new Date(Number(payload.exp) * 1000).toISOString()} (past)`,
        expected: "a time in the future",
      };
    case "missing_claims":
      return {
        field: "sub, resource",
        sent: "(omitted)",
        expected: "both present",
      };
    case "invalid_type_header":
      return {
        field: "typ",
        sent: show(header.typ),
        expected: "oauth-id-jag+jwt",
      };
    case "wrong_issuer":
      return {
        field: "iss",
        sent: show(payload.iss),
        expected: expected.issuer,
      };
    case "resource_mismatch":
      return {
        field: "resource",
        sent: show(payload.resource),
        expected: expected.resource,
      };
    case "client_id_mismatch":
      return {
        field: "client_id",
        sent: show(payload.client_id),
        expected: expected.clientId,
      };
    case "unknown_kid":
      return {
        field: "kid",
        sent: show(header.kid),
        expected: XAA_IDP_KID,
      };
    case "unknown_sub":
      return {
        field: "sub",
        sent: show(payload.sub),
        expected: expected.subject,
      };
    case "scope_denial":
      return {
        field: "scope",
        sent: show(payload.scope),
        expected: expected.scope || "only the user's granted scopes",
      };
    default:
      return undefined;
  }
}

const proxyTokenSchema = z
  .object({
    tokenEndpoint: z.string().trim().min(1).optional(),
    assertion: z.string().trim().min(1),
    clientId: z.string().trim().min(1).optional(),
    clientSecret: z.string().trim().min(1).optional(),
    // How to authenticate at the token endpoint. Absent = legacy body-post
    // behavior; only the methods the debugger can actually redeem.
    tokenEndpointAuthMethod: z
      .enum(["client_secret_post", "client_secret_basic", "none"])
      .optional(),
    scope: z.string().trim().min(1).optional(),
    resource: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Registration-backed runs: the server resolves the stored secret and
    // forces the outbound URL to the registration's stored token endpoint.
    registrationId: z.string().trim().min(1).optional(),
    // Server-target runs: the server resolves the stored secret AND discovers
    // the token endpoint from the server's own config (clientId/url/issuer
    // are all pinned server-side).
    serverId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
  })
  .refine(
    (data) => data.registrationId || data.serverId || data.tokenEndpoint,
    {
      message: "tokenEndpoint, registrationId, or serverId is required",
    }
  );

interface CreateXaaRouterOptions {
  issuerBasePath: "/api/mcp" | "/api/web";
  httpsOnlyProxy: boolean;
  // When behind a TLS-terminating proxy (hosted mode), the issuer scheme must
  // be reconstructed from X-Forwarded-Proto because c.req.url is http://
  // internally. Leave false for local (no proxy) so the header can't be
  // spoofed into advertising https for a plain-http localhost run.
  trustForwardedHeaders?: boolean;
  protectedMiddlewares?: MiddlewareHandler[];
  // Resolves a registered resource app's client secret + stored token
  // endpoint server-side, using the caller's bearer to read Convex. When
  // absent, registration-backed proxy requests are rejected.
  resolveRegistrationSecret?: (args: {
    registrationId: string;
    bearerToken: string;
  }) => Promise<XaaResourceAppSecretResult>;
  // Resolves a server target's confidential client secret + non-secret config
  // (clientId/url/issuer) server-side, using the caller's bearer to read
  // Convex. When absent, server-target proxy requests are rejected.
  resolveServerSecret?: (args: {
    serverId: string;
    projectId: string;
    bearerToken: string;
  }) => Promise<ServerClientSecretResult>;
  // Confirms the caller is a member of the organization before minting under
  // the org-scoped issuer path (/o/:orgId/...). When absent, the scoped
  // routes are not registered at all — the local router has no org concept.
  authorizeOrgIssuer?: (args: {
    organizationId: string;
    bearerToken: string;
  }) => Promise<void>;
  // LOCAL-only: when a mint request carries `issuerMode: "hosted"`, forward it
  // server-to-server to this hosted origin so the token is signed by the key
  // the hosted JWKS serves and carries a publicly discoverable `iss`. The
  // origin is config, never derived from the request. The hosted router never
  // sets this — hosted IS the hosted issuer and ignores `issuerMode`.
  forwardHostedIssuer?: { origin: string };
}

type ParsedJwtPayload = {
  sub?: string;
  email?: string;
};

function toJsonError(
  message: string,
  options?: {
    status?: number;
    code?: string;
    details?: Record<string, unknown>;
  }
) {
  const status = options?.status ?? 500;
  const code = options?.code ?? "INTERNAL_ERROR";

  return Response.json(
    {
      code,
      message,
      error: message,
      ...(options?.details ? { details: options.details } : {}),
    },
    { status }
  );
}

function parseRequest<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message || "Request validation failed"
    );
  }
  return parsed.data;
}

function decodeJwtPayloadUnsafe(token: string): ParsedJwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Identity assertion must be a JWT");
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as ParsedJwtPayload;
    return payload;
  } catch (error) {
    throw new Error(
      `Identity assertion payload is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
}

function resolveNegativeTestMode(value?: string): NegativeTestMode {
  if (!value) {
    return DEFAULT_NEGATIVE_TEST_MODE;
  }

  if (!isNegativeTestMode(value)) {
    throw new Error(`Unsupported negative test mode: ${value}`);
  }

  return value;
}

export function createXaaRouter(options: CreateXaaRouterOptions): Hono {
  const router = new Hono();
  const protectedMiddlewares = options.protectedMiddlewares ?? [];
  const trustForwardedHeaders = options.trustForwardedHeaders ?? false;
  const authorizeOrgIssuer = options.authorizeOrgIssuer;

  if (protectedMiddlewares.length > 0) {
    router.use("/authenticate", ...protectedMiddlewares);
    router.use("/token-exchange", ...protectedMiddlewares);
    router.use("/proxy/token", ...protectedMiddlewares);
    router.use("/discover-as", ...protectedMiddlewares);
    router.use("/health-check", ...protectedMiddlewares);
    router.use("/negative-tests", ...protectedMiddlewares);
    if (authorizeOrgIssuer) {
      router.use("/o/:orgId/authenticate", ...protectedMiddlewares);
      router.use("/o/:orgId/token-exchange", ...protectedMiddlewares);
      router.use("/o/:orgId/negative-tests", ...protectedMiddlewares);
    }
  }

  const HOSTED_FORWARD_TIMEOUT_MS = 15_000;

  // Server-to-server relay of a mint request to the hosted issuer. The local
  // server is a pure relay: the caller's bearer is forwarded verbatim (only
  // to the fixed config origin, never to an AS or MCP server) and the hosted
  // side's middleware + Convex membership check remain the real authz. The
  // upstream response body/status surface unchanged so hosted 401/403/429
  // stay explainable in the debugger.
  const forwardToHostedIssuer = async (
    c: Context,
    path: "/authenticate" | "/token-exchange" | "/negative-tests",
    body: Record<string, unknown>
  ): Promise<Response> => {
    const origin = options.forwardHostedIssuer!.origin;
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return toJsonError(
        "Minting through the hosted issuer requires signing in",
        { status: 401, code: "UNAUTHORIZED" }
      );
    }

    const { issuerMode: _issuerMode, organizationId, ...forwardBody } = body;
    // Fail closed: the hosted issuer must be the caller's membership-gated
    // org-scoped issuer. Falling back to the unscoped issuer (mintable by
    // anyone) would silently mint a forgeable token under the wrong `iss`, so
    // a missing/invalid org is rejected rather than quietly downgraded.
    if (!isValidOrgId(organizationId)) {
      return toJsonError(
        "Hosted issuer minting requires an active organization",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }
    const scopedSegment = `/o/${organizationId}`;

    let upstream: Response;
    try {
      upstream = await fetch(
        `${origin}/api/web/xaa${scopedSegment}${path}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(HOSTED_FORWARD_TIMEOUT_MS),
        }
      );
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return toJsonError(
        isTimeout
          ? `The hosted issuer did not respond within ${HOSTED_FORWARD_TIMEOUT_MS}ms`
          : `Failed to reach the hosted issuer: ${
              error instanceof Error ? error.message : String(error)
            }`,
        { status: isTimeout ? 504 : 502, code: "SERVER_UNREACHABLE" }
      );
    }

    const upstreamText = await upstream.text();
    let upstreamJson: unknown = null;
    if (upstreamText) {
      try {
        upstreamJson = JSON.parse(upstreamText);
      } catch {
        // non-JSON body; handled below
      }
    }

    // Preserve auth-relevant upstream headers so a hosted challenge survives
    // the relay instead of being silently dropped.
    const relayHeaders: Record<string, string> = {};
    for (const name of ["www-authenticate", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value) relayHeaders[name] = value;
    }

    // Forward the hosted status verbatim. The normal case (incl. hosted's
    // own {code,message} error envelopes) is JSON and passes through. A
    // non-JSON/empty body still keeps the real status, so a hosted 401/403/429
    // is never masked as a 502 "unreachable" outage.
    if (upstreamJson !== null && typeof upstreamJson === "object") {
      return Response.json(upstreamJson, {
        status: upstream.status,
        headers: relayHeaders,
      });
    }
    if (upstream.ok) {
      return toJsonError("The hosted issuer returned a non-JSON response", {
        status: 502,
        code: "SERVER_UNREACHABLE",
      });
    }
    const message =
      upstreamText.trim().slice(0, 300) ||
      `The hosted issuer returned HTTP ${upstream.status}`;
    return Response.json(
      {
        code: upstream.status >= 500 ? "SERVER_UNREACHABLE" : "HOSTED_ISSUER_ERROR",
        message,
        error: message,
      },
      { status: upstream.status, headers: relayHeaders }
    );
  };

  // Reads the body (Hono caches it, so the handler's own c.req.json() still
  // works) and returns the forwarded Response when the request opts into the
  // hosted issuer; null means "mint locally as usual".
  const maybeForwardHostedIssuer = async (
    c: Context,
    path: "/authenticate" | "/token-exchange" | "/negative-tests"
  ): Promise<Response | null> => {
    if (!options.forwardHostedIssuer) return null;
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      (body as Record<string, unknown>).issuerMode !== "hosted"
    ) {
      return null;
    }
    return forwardToHostedIssuer(c, path, body as Record<string, unknown>);
  };

  const unscopedIssuer = (c: Context): string =>
    getIssuerForRequest(c, options.issuerBasePath, trustForwardedHeaders);

  // Gate for the org-scoped mint routes: validate the path segment (it is
  // embedded into the ID-JAG `iss`), require a bearer, and confirm org
  // membership via the backend. Returns the validated orgId, or the error
  // Response to send. Fail-closed: any backend failure blocks the mint.
  const requireScopedOrg = async (c: Context): Promise<string | Response> => {
    const orgIdOrError = validateOrgSegment(c);
    if (orgIdOrError instanceof Response) return orgIdOrError;
    const orgId = orgIdOrError;
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return toJsonError(
        "Minting under an organization issuer requires signing in",
        { status: 401, code: "UNAUTHORIZED" }
      );
    }
    try {
      await authorizeOrgIssuer!({
        organizationId: orgId,
        bearerToken: authHeader.slice("Bearer ".length),
      });
    } catch (error) {
      if (error instanceof WebRouteError) {
        return toJsonError(error.message, {
          status: error.status,
          code: error.code,
          details: error.details,
        });
      }
      logger.error("[XAA Org Issuer] authorization failed", error);
      return toJsonError("Couldn't authorize the organization issuer", {
        status: 500,
        code: "INTERNAL_ERROR",
      });
    }
    return orgId;
  };

  const serveJwks = (c: Context) => {
    initXAAIdpKeyPair();
    return c.json(getXAAIdpJwks(), 200, {
      "Cache-Control": "public, max-age=300",
    });
  };

  const serveOpenidConfiguration = (
    c: Context,
    issuer: string,
    // Whether THIS surface's /token serves the standard token-exchange grant.
    // Unscoped hosted refuses it (public token exchange would launder the
    // org-membership gate through the public /authorize mock sign-in), so its
    // doc must not advertise it — advertise only what is served.
    oidc: { tokenExchangeAtToken: boolean }
  ) => {
    initXAAIdpKeyPair();

    return c.json(
      {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        grant_types_supported: [
          "authorization_code",
          ...(oidc.tokenExchangeAtToken ? [TOKEN_EXCHANGE_GRANT] : []),
        ],
        ...(oidc.tokenExchangeAtToken
          ? {
              identity_chaining_requested_token_types_supported: [
                ID_JAG_TOKEN_TYPE,
              ],
            }
          : {}),
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email"],
        claims_supported: ["sub", "email", "email_verified"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        id_token_signing_alg_values_supported: ["RS256"],
      },
      200,
      {
        "Cache-Control": "public, max-age=300",
      }
    );
  };

  router.get("/.well-known/jwks.json", (c) => serveJwks(c));

  // Unscoped hosted /token refuses public token exchange (see handleToken);
  // its doc must not advertise it. Local (no org gate available) serves it.
  const unscopedTokenExchangeAtToken = !authorizeOrgIssuer;

  router.get("/.well-known/openid-configuration", (c) =>
    serveOpenidConfiguration(c, unscopedIssuer(c), {
      tokenExchangeAtToken: unscopedTokenExchangeAtToken,
    })
  );

  const handleAuthenticate = async (c: Context, issuer: string) => {
    try {
      const body = await c.req.json();
      const { userId, email, audience } = parseRequest(
        authenticateSchema,
        body
      );
      const subject = userId || "user-12345";
      const resolvedEmail = email || "demo.user@example.com";
      const issued = issueMockIdToken({
        issuer,
        subject,
        email: resolvedEmail,
        audience,
      });

      return c.json({
        id_token: issued.token,
        token_type: "Bearer",
        expires_in: Math.max(
          0,
          Math.floor((issued.expiresAt - Date.now()) / 1000)
        ),
        user: {
          sub: subject,
          email: resolvedEmail,
        },
      });
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid authenticate request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }
  };

  router.post("/authenticate", async (c) => {
    const forwarded = await maybeForwardHostedIssuer(c, "/authenticate");
    if (forwarded) return forwarded;
    return handleAuthenticate(c, unscopedIssuer(c));
  });

  const handleTokenExchange = async (c: Context, issuer: string) => {
    try {
      const body = await c.req.json();
      const parsed = parseRequest(tokenExchangeSchema, body);
      const negativeTestMode = resolveNegativeTestMode(parsed.negativeTestMode);
      const identityPayload = decodeJwtPayloadUnsafe(parsed.identityAssertion);
      const subject = identityPayload.sub || "user-12345";
      // Carry the ID token's email into the ID-JAG (spec RECOMMENDED) so the
      // Resource AS can use it for subject resolution / JIT provisioning.
      const email =
        typeof identityPayload.email === "string"
          ? identityPayload.email
          : undefined;

      const issued =
        negativeTestMode === "valid"
          ? issueIdJag({
              issuer,
              subject,
              email,
              audience: parsed.audience,
              resource: parsed.resource,
              clientId: parsed.clientId,
              scope: parsed.scope,
            })
          : issueNegativeIdJag(
              {
                issuer,
                subject,
                email,
                audience: parsed.audience,
                resource: parsed.resource,
                clientId: parsed.clientId,
                scope: parsed.scope,
              },
              negativeTestMode
            );

      return c.json({
        id_jag: issued.token,
        token_type: "N_A",
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        expires_in: Math.max(
          0,
          Math.floor((issued.expiresAt - Date.now()) / 1000)
        ),
        negative_test_mode: negativeTestMode,
      });
    } catch (error) {
      return toJsonError(
        error instanceof Error
          ? error.message
          : "Invalid token exchange request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }
  };

  router.post("/token-exchange", async (c) => {
    const forwarded = await maybeForwardHostedIssuer(c, "/token-exchange");
    if (forwarded) return forwarded;
    return handleTokenExchange(c, unscopedIssuer(c));
  });

  router.post("/proxy/token", async (c) => {
    try {
      const body = await c.req.json();
      const parsed = parseRequest(proxyTokenSchema, body);

      let url: string;
      let clientId = parsed.clientId;
      let clientSecret = parsed.clientSecret;
      let extraHeaders = parsed.headers;

      if (parsed.serverId) {
        const authHeader = c.req.header("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return toJsonError("Missing or invalid bearer token", {
            status: 401,
            code: "UNAUTHORIZED",
          });
        }

        // The secret AND the token endpoint are resolved/discovered from the
        // stored server config. Everything is pinned by ASSIGNMENT — the
        // client-supplied tokenEndpoint/clientId/clientSecret/headers are
        // discarded so the confidential secret can't be redirected.
        const resolved = await resolveServerTarget({
          resolveServerSecret: options.resolveServerSecret,
          httpsOnly: options.httpsOnlyProxy,
          serverId: parsed.serverId,
          projectId: parsed.projectId,
          bearerToken: authHeader.slice("Bearer ".length),
        });
        url = resolved.tokenEndpoint;
        clientId = resolved.clientId;
        clientSecret = resolved.clientSecret;
        extraHeaders = undefined;
      } else if (parsed.registrationId) {
        if (!options.resolveRegistrationSecret) {
          return toJsonError(
            "Registration-backed runs are not available on this instance",
            { status: 400, code: "VALIDATION_ERROR" }
          );
        }

        const authHeader = c.req.header("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return toJsonError("Missing or invalid bearer token", {
            status: 401,
            code: "UNAUTHORIZED",
          });
        }

        const resolved = await options.resolveRegistrationSecret({
          registrationId: parsed.registrationId,
          bearerToken: authHeader.slice("Bearer ".length),
        });

        if (!resolved.tokenEndpoint) {
          return toJsonError("The registration has no stored token endpoint", {
            status: 400,
            code: "VALIDATION_ERROR",
          });
        }

        // The stored secret is only ever posted to the registration's stored
        // token endpoint. Client-supplied tokenEndpoint/headers/clientSecret
        // are discarded so a caller can't redirect the secret elsewhere.
        url = resolved.tokenEndpoint;
        clientId = resolved.targetClientId ?? parsed.clientId;
        clientSecret = resolved.clientSecret;
        extraHeaders = undefined;
      } else {
        url = parsed.tokenEndpoint as string;
      }

      const authMethod = parsed.tokenEndpointAuthMethod;
      if (
        (authMethod === "client_secret_post" ||
          authMethod === "client_secret_basic") &&
        !clientSecret
      ) {
        return toJsonError(`${authMethod} requires a client secret`, {
          status: 400,
          code: "VALIDATION_ERROR",
        });
      }
      if (authMethod === "client_secret_basic" && !clientId) {
        return toJsonError("client_secret_basic requires a client id", {
          status: 400,
          code: "VALIDATION_ERROR",
        });
      }

      // Method-aware client auth. The generated Authorization value carries
      // the secret — it is passed only to the outbound proxy call and must
      // never be copied into logs, history, or error payloads. It is merged
      // AFTER extraHeaders so a caller-supplied header can't replace it.
      const jwtBearerRequest = buildJwtBearerRequest({
        assertion: parsed.assertion,
        clientId,
        clientSecret,
        scope: parsed.scope,
        resource: parsed.resource,
        tokenEndpointAuthMethod: authMethod,
      });

      const result = await executeOAuthProxy({
        url,
        method: "POST",
        body: jwtBearerRequest.body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(extraHeaders || {}),
          ...jwtBearerRequest.headers,
        },
        httpsOnly: options.httpsOnlyProxy,
      });

      return c.json(result);
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        return toJsonError(error.message, {
          status: error.status,
          code:
            error.status === 400 ? "VALIDATION_ERROR" : "SERVER_UNREACHABLE",
        });
      }

      if (error instanceof WebRouteError) {
        return toJsonError(error.message, {
          status: error.status,
          code: error.code,
          details: error.details,
        });
      }

      logger.error("[XAA Token Proxy] Error", error);
      return toJsonError(
        error instanceof Error ? error.message : "Unknown proxy error",
        { status: 500, code: "INTERNAL_ERROR" }
      );
    }
  });

  router.post("/discover-as", async (c) => {
    let parsed;
    try {
      parsed = parseRequest(discoverAsSchema, await c.req.json());
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid discovery request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }

    const requestedIssuer = (parsed.issuer ?? parsed.tokenEndpoint) as string;

    let candidates: string[];
    try {
      candidates = buildDiscoveryCandidates(requestedIssuer);
    } catch {
      return toJsonError("issuer or tokenEndpoint is not a valid URL", {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    try {
      const triedStatuses: Array<{ url: string; status: number }> = [];
      for (const candidate of candidates) {
        const result = await fetchOAuthMetadata(
          candidate,
          options.httpsOnlyProxy
        );
        if ("metadata" in result) {
          return c.json(
            evaluateDiscovery(result.metadata, {
              requestedIssuer,
              metadataUrl: candidate,
            })
          );
        }
        triedStatuses.push({ url: candidate, status: result.status });
      }

      return toJsonError(
        "No authorization server metadata found at the well-known endpoints",
        {
          status: 404,
          code: "DISCOVERY_NOT_FOUND",
          details: { tried: triedStatuses },
        }
      );
    } catch (error) {
      // validateUrl inside fetchOAuthMetadata rejects disallowed outbound URLs
      // (e.g. private/reserved hosts, or http in hosted mode). Every candidate
      // shares the same host, so a guard rejection is terminal.
      if (error instanceof OAuthProxyError) {
        return toJsonError("URL not allowed", {
          status: error.status,
          code: "VALIDATION_ERROR",
        });
      }
      logger.error("[XAA Discover AS] Error", error);
      return toJsonError(
        error instanceof Error ? error.message : "Discovery failed",
        { status: 502, code: "SERVER_UNREACHABLE" }
      );
    }
  });

  router.post("/health-check", async (c) => {
    let parsed;
    try {
      parsed = parseRequest(healthCheckSchema, await c.req.json());
    } catch (error) {
      return toJsonError(
        error instanceof Error ? error.message : "Invalid health check request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }

    let validatedUrl: URL;
    try {
      ({ url: validatedUrl } = await validateUrl(
        parsed.url,
        options.httpsOnlyProxy
      ));
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        return toJsonError("URL not allowed", {
          status: error.status,
          code: "VALIDATION_ERROR",
        });
      }
      return toJsonError("URL not allowed", {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(validatedUrl.toString(), {
        method: "GET",
        // In hosted mode redirects are not followed, so a redirect to an
        // internal address can never be fetched.
        redirect: options.httpsOnlyProxy ? "manual" : "follow",
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        headers: { "User-Agent": "MCP-Inspector/1.0" },
      });

      const redirected =
        options.httpsOnlyProxy &&
        response.status >= 300 &&
        response.status < 400;

      return c.json({
        ok: !redirected && response.status < 400,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
        ...(redirected ? { reason: "redirect_not_followed" } : {}),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      return c.json({
        ok: false,
        reason: isTimeout ? "timeout" : "unreachable",
        durationMs: Date.now() - startedAt,
      });
    }
  });

  // Negative-test scorecard: fire each deliberately-broken ID-JAG mode at the
  // user's authorization server and report whether the server correctly
  // rejected it (pass) or wrongly issued a token (fail — a real finding).
  const handleNegativeTests = async (c: Context, issuer: string) => {
    let parsed;
    try {
      parsed = parseRequest(negativeTestsSchema, await c.req.json());
    } catch (error) {
      return toJsonError(
        error instanceof Error
          ? error.message
          : "Invalid negative-tests request",
        { status: 400, code: "VALIDATION_ERROR" }
      );
    }

    // Resolve the authorization-server target. Registration-backed runs
    // resolve the stored secret + endpoint server-side (same hardening as
    // /proxy/token); the client-supplied endpoint/headers/secret are ignored.
    let tokenEndpoint: string;
    let clientId = parsed.clientId;
    let clientSecret = parsed.clientSecret;
    let extraHeaders = parsed.headers;

    try {
      if (parsed.serverId) {
        const authHeader = c.req.header("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return toJsonError("Missing or invalid bearer token", {
            status: 401,
            code: "UNAUTHORIZED",
          });
        }
        // Same server-side hardening as /proxy/token: secret + endpoint are
        // resolved/discovered from the stored server config and pinned by
        // assignment; client-supplied endpoint/clientId/secret/headers are
        // discarded.
        const resolved = await resolveServerTarget({
          resolveServerSecret: options.resolveServerSecret,
          httpsOnly: options.httpsOnlyProxy,
          serverId: parsed.serverId,
          projectId: parsed.projectId,
          bearerToken: authHeader.slice("Bearer ".length),
        });
        tokenEndpoint = resolved.tokenEndpoint;
        clientId = resolved.clientId;
        clientSecret = resolved.clientSecret;
        extraHeaders = undefined;
      } else if (parsed.registrationId) {
        if (!options.resolveRegistrationSecret) {
          return toJsonError(
            "Registration-backed runs are not available on this instance",
            { status: 400, code: "VALIDATION_ERROR" }
          );
        }
        const authHeader = c.req.header("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return toJsonError("Missing or invalid bearer token", {
            status: 401,
            code: "UNAUTHORIZED",
          });
        }
        const resolved = await options.resolveRegistrationSecret({
          registrationId: parsed.registrationId,
          bearerToken: authHeader.slice("Bearer ".length),
        });
        if (!resolved.tokenEndpoint) {
          // mcpjam-issuer-only registration: there is no external auth server
          // to fire broken assertions at.
          return toJsonError(
            "Negative tests require a registration with its own auth server",
            { status: 400, code: "VALIDATION_ERROR" }
          );
        }
        tokenEndpoint = resolved.tokenEndpoint;
        clientId = resolved.targetClientId ?? parsed.clientId;
        clientSecret = resolved.clientSecret;
        extraHeaders = undefined;
      } else {
        tokenEndpoint = parsed.tokenEndpoint as string;
      }
    } catch (error) {
      if (error instanceof WebRouteError) {
        return toJsonError(error.message, {
          status: error.status,
          code: error.code,
          details: error.details,
        });
      }
      throw error;
    }

    // Validate the outbound URL once (every case hits the same endpoint) and
    // enforce the per-host daily cap.
    let validated: URL;
    try {
      ({ url: validated } = await validateUrl(
        tokenEndpoint,
        options.httpsOnlyProxy
      ));
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        return toJsonError("URL not allowed", {
          status: error.status,
          code: "VALIDATION_ERROR",
        });
      }
      return toJsonError("URL not allowed", {
        status: 400,
        code: "VALIDATION_ERROR",
      });
    }

    if (!checkNegativeTestHostCap(validated.host)) {
      return toJsonError(
        "Daily negative-test limit reached for this authorization server",
        { status: 429, code: "RATE_LIMITED" }
      );
    }

    const subject = parsed.subject || "user-12345";

    const runCase = async (
      mode: NegativeTestMode
    ): Promise<NegativeCaseOutcome> => {
      const details = NEGATIVE_TEST_MODE_DETAILS[mode];
      const resolvedClientId = clientId || "mcpjam-debugger";
      let token: string;
      let diff: NegativeTestDiff | undefined;
      try {
        const issued = issueNegativeIdJag(
          {
            issuer,
            subject,
            audience: parsed.audience,
            resource: parsed.resource,
            clientId: resolvedClientId,
            scope: parsed.scope,
          },
          mode
        );
        token = issued.token;
        diff = buildNegativeDiff(mode, issued.header, issued.payload, {
          audience: parsed.audience,
          resource: parsed.resource,
          clientId: resolvedClientId,
          subject,
          scope: parsed.scope,
          issuer,
        });
      } catch (error) {
        return {
          mode,
          label: details.label,
          expectedFailure: details.expectedFailure,
          outcome: "error",
          verdict: "unknown",
          detail:
            error instanceof Error ? error.message : "Failed to mint ID-JAG",
        };
      }

      const form = new URLSearchParams();
      form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      form.set("assertion", token);
      if (clientId) form.set("client_id", clientId);
      if (clientSecret) form.set("client_secret", clientSecret);
      if (parsed.scope) form.set("scope", parsed.scope);
      form.set("resource", parsed.resource);

      try {
        const response = await fetch(validated.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "MCP-Inspector/1.0",
            ...(extraHeaders || {}),
          },
          body: form.toString(),
          redirect: options.httpsOnlyProxy ? "manual" : "follow",
          signal: AbortSignal.timeout(NEGATIVE_TEST_CASE_TIMEOUT_MS),
        });

        let body: any = null;
        try {
          body = await response.json();
        } catch {
          // non-JSON response; body stays null
        }

        const accepted =
          response.status >= 200 &&
          response.status < 300 &&
          typeof body?.access_token === "string";

        return {
          mode,
          label: details.label,
          expectedFailure: details.expectedFailure,
          outcome: accepted ? "accepted" : "rejected",
          verdict: accepted ? "fail" : "pass",
          status: response.status,
          detail: accepted
            ? `The auth server returned HTTP ${response.status} with an access token for this broken assertion. ` +
              `This test ${details.description.charAt(0).toLowerCase()}${details.description.slice(1)} ` +
              `${details.expectedFailure} Because a token was issued instead, a malformed or unauthorized ` +
              `assertion would be accepted in production.`
            : undefined,
          diff,
        };
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        return {
          mode,
          label: details.label,
          expectedFailure: details.expectedFailure,
          outcome: isTimeout ? "timeout" : "error",
          // Couldn't reach a verdict — surfaced separately from a real finding.
          verdict: "unknown",
          diff,
          detail: isTimeout
            ? `No response within ${NEGATIVE_TEST_CASE_TIMEOUT_MS}ms`
            : error instanceof Error
            ? error.message
            : "Request failed",
        };
      }
    };

    // Each case has its own timeout and resolves independently, so one slow
    // or hanging authorization server can't sink the whole scorecard.
    const results = await Promise.all(NEGATIVE_CASE_MODES.map(runCase));

    return c.json({
      results,
      failures: results.filter((r) => r.verdict === "fail").length,
    });
  };

  // Forwarding matters most here: negative tests mint AND fire in one
  // endpoint, so a local mint would carry the local `iss` and a strict AS
  // would reject every case for issuer mismatch — a scorecard that "passes"
  // without testing anything.
  router.post("/negative-tests", async (c) => {
    const forwarded = await maybeForwardHostedIssuer(c, "/negative-tests");
    if (forwarded) return forwarded;
    return handleNegativeTests(c, unscopedIssuer(c));
  });

  // Org-scoped issuer surface: the same mock IdP under /o/:orgId, where the
  // path segment becomes part of `iss` and minting requires org membership.
  // The well-known documents stay public — remote authorization servers fetch
  // them unauthenticated — and serve the same global JWKS (one signing key;
  // containment comes from gating the mint, not from key separation). Each
  // org-scoped issuer is modeled as a single-tenant issuer: `iss` alone
  // identifies the tenant, so ID-JAGs carry no `tenant` claim.
  if (authorizeOrgIssuer) {
    const scopedIssuer = (c: Context, orgId: string): string =>
      `${unscopedIssuer(c)}/o/${orgId}`;

    router.get("/o/:orgId/.well-known/jwks.json", (c) => {
      const orgIdOrError = validateOrgSegment(c);
      if (orgIdOrError instanceof Response) return orgIdOrError;
      return serveJwks(c);
    });

    router.get("/o/:orgId/.well-known/openid-configuration", (c) => {
      const orgIdOrError = validateOrgSegment(c);
      if (orgIdOrError instanceof Response) return orgIdOrError;
      // The scoped /token serves token exchange (bearer + membership gated).
      return serveOpenidConfiguration(c, scopedIssuer(c, orgIdOrError), {
        tokenExchangeAtToken: true,
      });
    });

    router.post("/o/:orgId/authenticate", async (c) => {
      const orgIdOrError = await requireScopedOrg(c);
      if (orgIdOrError instanceof Response) return orgIdOrError;
      return handleAuthenticate(c, scopedIssuer(c, orgIdOrError));
    });

    router.post("/o/:orgId/token-exchange", async (c) => {
      const orgIdOrError = await requireScopedOrg(c);
      if (orgIdOrError instanceof Response) return orgIdOrError;
      return handleTokenExchange(c, scopedIssuer(c, orgIdOrError));
    });

    router.post("/o/:orgId/negative-tests", async (c) => {
      const orgIdOrError = await requireScopedOrg(c);
      if (orgIdOrError instanceof Response) return orgIdOrError;
      return handleNegativeTests(c, scopedIssuer(c, orgIdOrError));
    });
  }

  // ── Mock OIDC IdP: real authorization_code flow + userinfo ──────────────
  // Lets external services (e.g. Scalekit Full Stack Auth) configure MCPJam
  // as a discovery-driven test OIDC IdP. Always registered. All four endpoints
  // are public front-channel/RP surfaces — every state-changing one is guarded
  // (foreign-Origin CSRF reject, S256 PKCE, per-IP rate limit, typ
  // segregation). The token-exchange grant on /token issues ID-JAGs, so it
  // inherits the same gate as the surface's mint endpoints: local = open,
  // org-scoped = bearer + membership, unscoped hosted = refused (otherwise the
  // public /authorize mock sign-in chained into a public token exchange would
  // launder the org-membership gate). A bare block keeps the handler closures
  // scoped without an enclosing conditional.
  {
    const readForm = async (
      c: Context
    ): Promise<Record<string, string> | null> => {
      try {
        const formData = await c.req.formData();
        const entries: Record<string, string> = {};
        formData.forEach((value, key) => {
          entries[key] = String(value);
        });
        return entries;
      } catch {
        return null;
      }
    };

    const handleAuthorize = (c: Context, issuer: string) => {
      const query: Record<string, string | undefined> = {
        client_id: c.req.query("client_id"),
        redirect_uri: c.req.query("redirect_uri"),
        response_type: c.req.query("response_type"),
        state: c.req.query("state"),
        nonce: c.req.query("nonce"),
        scope: c.req.query("scope"),
        code_challenge: c.req.query("code_challenge"),
        code_challenge_method: c.req.query("code_challenge_method"),
      };
      const parsed = parseAuthorizeParams(query);
      if ("error" in parsed) {
        // Never redirect on a validation failure — the redirect_uri may be
        // the invalid part. A plain error page is the safe terminal.
        return c.html(
          `<!DOCTYPE html><html><body><h1>Invalid authorization request</h1><p>${escapeHtml(parsed.error)}</p></body></html>`,
          400
        );
      }
      return c.html(
        renderAuthorizePage({
          confirmUrl: `${issuer}/authorize/confirm`,
          params: parsed,
        }),
        200,
        { "Cache-Control": "no-store" }
      );
    };

    const handleAuthorizeConfirm = async (c: Context, issuer: string) => {
      // The confirm POST issues a code and 302s to redirect_uri, so it must be
      // driven by our own interstitial, never a cross-site auto-submit (which
      // would make this a POST-triggered open redirector).
      const crossOrigin = rejectCrossOriginPost(c);
      if (crossOrigin) return crossOrigin;
      const ip = getClientIp(c);
      if (ip && !checkOidcIpCap(ip)) {
        return oauthError(429, "temporarily_unavailable", "Too many requests");
      }
      const form = await readForm(c);
      if (!form) {
        return oauthError(
          400,
          "invalid_request",
          "Body must be application/x-www-form-urlencoded"
        );
      }
      const parsed = parseAuthorizeParams(form);
      if ("error" in parsed) {
        return c.html(
          `<!DOCTYPE html><html><body><h1>Invalid authorization request</h1><p>${escapeHtml(parsed.error)}</p></body></html>`,
          400
        );
      }

      const issued = issueAuthorizationCode({
        issuer,
        subject: parsed.subject || "user-12345",
        email: parsed.email || "demo.user@example.com",
        clientId: parsed.clientId,
        redirectUri: parsed.redirectUri,
        nonce: parsed.nonce,
        codeChallenge: parsed.codeChallenge,
      });

      const redirect = new URL(parsed.redirectUri);
      redirect.searchParams.set("code", issued.token);
      if (parsed.state) {
        redirect.searchParams.set("state", parsed.state);
      }
      return c.redirect(redirect.toString(), 302);
    };

    const handleAuthorizationCodeGrant = (
      issuer: string,
      form: Record<string, string>
    ): Response => {
      const { code, redirect_uri: redirectUri, client_id: clientId } = form;
      if (!code || !redirectUri || !clientId) {
        return oauthError(
          400,
          "invalid_request",
          "code, redirect_uri and client_id are required"
        );
      }

      let payload: Record<string, unknown>;
      try {
        payload = verifyXaaJwt(code, { issuer, typ: XAA_CODE_JWT_TYP });
      } catch (error) {
        return oauthError(
          400,
          "invalid_grant",
          error instanceof Error ? error.message : "Invalid code"
        );
      }
      if (payload.client_id !== clientId || payload.redirect_uri !== redirectUri) {
        return oauthError(
          400,
          "invalid_grant",
          "client_id and redirect_uri must match the authorization request"
        );
      }
      // PKCE: enforced when the code carries a challenge, allowed absent for
      // the plain mock flow.
      if (typeof payload.code_challenge === "string") {
        const verifier = form.code_verifier;
        if (!verifier) {
          return oauthError(
            400,
            "invalid_grant",
            "code_verifier is required for a PKCE authorization code"
          );
        }
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (computed !== payload.code_challenge) {
          return oauthError(
            400,
            "invalid_grant",
            "code_verifier does not match the code_challenge"
          );
        }
      }

      const subject = String(payload.sub ?? "user-12345");
      const email = String(payload.email ?? "demo.user@example.com");
      const idToken = issueMockIdToken({
        issuer,
        subject,
        email,
        audience: clientId,
        nonce: typeof payload.nonce === "string" ? payload.nonce : undefined,
      });
      const accessToken = issueAccessToken({ issuer, subject, email, clientId });

      return Response.json(
        {
          id_token: idToken.token,
          access_token: accessToken.token,
          token_type: "Bearer",
          expires_in: Math.max(
            0,
            Math.floor((accessToken.expiresAt - Date.now()) / 1000)
          ),
          scope: "openid profile email",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    };

    const handleTokenExchangeGrant = (
      issuer: string,
      form: Record<string, string>
    ): Response => {
      if (form.requested_token_type !== ID_JAG_TOKEN_TYPE) {
        return oauthError(
          400,
          "invalid_request",
          `requested_token_type must be ${ID_JAG_TOKEN_TYPE}`
        );
      }
      if (form.subject_token_type !== ID_TOKEN_TOKEN_TYPE) {
        return oauthError(
          400,
          "invalid_request",
          `subject_token_type must be ${ID_TOKEN_TOKEN_TYPE}`
        );
      }
      const clientId = form.client_id;
      if (!clientId) {
        // The ID-JAG's client_id claim is REQUIRED by the draft.
        return oauthError(400, "invalid_request", "client_id is required");
      }
      if (!form.subject_token || !form.audience || !form.resource) {
        return oauthError(
          400,
          "invalid_request",
          "subject_token, audience and resource are required"
        );
      }

      let subjectPayload: Record<string, unknown>;
      try {
        // Stricter than the legacy JSON endpoint's unsafe decode: the subject
        // token must be an ID token THIS issuer signed, unexpired.
        subjectPayload = verifyXaaJwt(form.subject_token, {
          issuer,
          typ: "JWT",
        });
      } catch (error) {
        return oauthError(
          400,
          "invalid_grant",
          error instanceof Error ? error.message : "Invalid subject_token"
        );
      }
      // Draft §4.3.3: the assertion's audience must match the client identity
      // presenting it.
      if (
        typeof subjectPayload.aud === "string" &&
        subjectPayload.aud !== clientId
      ) {
        return oauthError(
          400,
          "invalid_grant",
          "The subject token's aud must match client_id"
        );
      }

      const issued = issueIdJag({
        issuer,
        subject: String(subjectPayload.sub ?? "user-12345"),
        email:
          typeof subjectPayload.email === "string"
            ? subjectPayload.email
            : undefined,
        audience: form.audience,
        resource: form.resource,
        clientId,
        scope: form.scope || undefined,
      });

      return Response.json(
        {
          issued_token_type: ID_JAG_TOKEN_TYPE,
          access_token: issued.token,
          token_type: "N_A",
          expires_in: Math.max(
            0,
            Math.floor((issued.expiresAt - Date.now()) / 1000)
          ),
          ...(form.scope ? { scope: form.scope } : {}),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    };

    // gateTokenExchange: null = allowed; a Response = OAuth-shaped rejection.
    const handleToken = async (
      c: Context,
      issuer: string,
      gateTokenExchange: () => Promise<Response | null>
    ): Promise<Response> => {
      // A relying party's token call is server-to-server (no Origin). Block a
      // cross-site browser POST so a third-party page can't chain the public
      // /authorize mock sign-in into an unauthenticated ID-JAG mint.
      const crossOrigin = rejectCrossOriginPost(c);
      if (crossOrigin) return crossOrigin;
      const ip = getClientIp(c);
      if (ip && !checkOidcIpCap(ip)) {
        return oauthError(429, "temporarily_unavailable", "Too many requests");
      }
      const form = await readForm(c);
      if (!form) {
        return oauthError(
          400,
          "invalid_request",
          "Body must be application/x-www-form-urlencoded"
        );
      }

      if (form.grant_type === "authorization_code") {
        return handleAuthorizationCodeGrant(issuer, form);
      }
      if (form.grant_type === TOKEN_EXCHANGE_GRANT) {
        const rejection = await gateTokenExchange();
        if (rejection) return rejection;
        return handleTokenExchangeGrant(issuer, form);
      }
      return oauthError(
        400,
        "unsupported_grant_type",
        "Supported grant types: authorization_code" +
          (unscopedTokenExchangeAtToken || c.req.param("orgId")
            ? `, ${TOKEN_EXCHANGE_GRANT}`
            : "")
      );
    };

    const handleUserinfo = (c: Context, issuer: string): Response => {
      const authHeader = c.req.header("authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : undefined;
      if (!token) {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }
      let payload: Record<string, unknown>;
      try {
        payload = verifyXaaJwt(token, { issuer, typ: XAA_ACCESS_TOKEN_TYP });
      } catch {
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        });
      }
      return Response.json(
        {
          sub: payload.sub,
          email: payload.email,
          email_verified: true,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    };

    // Unscoped surface. Token exchange is served locally (no org gate exists)
    // and refused on unscoped hosted.
    router.get("/authorize", (c) => handleAuthorize(c, unscopedIssuer(c)));
    router.post("/authorize/confirm", (c) =>
      handleAuthorizeConfirm(c, unscopedIssuer(c))
    );
    router.post("/token", (c) =>
      handleToken(c, unscopedIssuer(c), async () =>
        unscopedTokenExchangeAtToken
          ? null
          : oauthError(
              400,
              "unsupported_grant_type",
              "Standard token exchange is only served under an organization-scoped issuer (…/o/<orgId>/token)"
            )
      )
    );
    router.get("/userinfo", (c) => handleUserinfo(c, unscopedIssuer(c)));

    // Org-scoped surface: public front-channel endpoints (anyone can sign in
    // as anyone — it's a test IdP), but the token-exchange grant requires the
    // caller to be a member of the org, mapped to OAuth-shaped errors.
    if (authorizeOrgIssuer) {
      const scopedIssuerFromParam = (c: Context): string | Response => {
        const orgId = c.req.param("orgId");
        if (!orgId || !ORG_ID_RE.test(orgId)) {
          return oauthError(400, "invalid_request", "Invalid organization id");
        }
        return `${unscopedIssuer(c)}/o/${orgId}`;
      };

      router.get("/o/:orgId/authorize", (c) => {
        const issuerOrError = scopedIssuerFromParam(c);
        if (issuerOrError instanceof Response) return issuerOrError;
        return handleAuthorize(c, issuerOrError);
      });
      router.post("/o/:orgId/authorize/confirm", (c) => {
        const issuerOrError = scopedIssuerFromParam(c);
        if (issuerOrError instanceof Response) return issuerOrError;
        return handleAuthorizeConfirm(c, issuerOrError);
      });
      router.post("/o/:orgId/token", (c) => {
        const issuerOrError = scopedIssuerFromParam(c);
        if (issuerOrError instanceof Response) return issuerOrError;
        return handleToken(c, issuerOrError, async () => {
          const orgIdOrError = await requireScopedOrg(c);
          if (!(orgIdOrError instanceof Response)) return null;
          // Map the gate's JSON error shape onto OAuth token-endpoint errors.
          const status = orgIdOrError.status;
          return oauthError(
            status,
            status === 401 ? "invalid_client" : status === 403 ? "access_denied" : "invalid_request",
            "Token exchange under an organization issuer requires an org member's bearer token"
          );
        });
      });
      router.get("/o/:orgId/userinfo", (c) => {
        const issuerOrError = scopedIssuerFromParam(c);
        if (issuerOrError instanceof Response) return issuerOrError;
        return handleUserinfo(c, issuerOrError);
      });
    }
  }

  return router;
}

const xaa = createXaaRouter({
  issuerBasePath: "/api/mcp",
  // Local dev allows plain-http loopback targets (e.g. a localhost
  // xaa-mcp-server). The hosted router keeps httpsOnlyProxy: true.
  httpsOnlyProxy: false,
  // Server-target / registration runs resolve the confidential secret from
  // Convex using the caller's bearer; works locally when the user is signed in.
  resolveRegistrationSecret: (args) => fetchXaaResourceAppSecret(args),
  resolveServerSecret: (args) => fetchServerClientSecret(args),
  // Opt-in per request (issuerMode: "hosted"): mint via app.mcpjam.com so a
  // cloud AS can discover the issuer — no tunnel needed for the common
  // local-MCP-server + remote-AS setup.
  forwardHostedIssuer: { origin: MCPJAM_HOSTED_ORIGIN },
});

export default xaa;
